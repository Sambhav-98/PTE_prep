require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { SOURCES } = require('./knowledge');
const { ROADMAP } = require('./roadmap');
const storage = require('./storage');
const reference = require('./reference');

const app = express();
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const REFERENCE_PDF_PATH = process.env.REFERENCE_PDF_PATH;
const REFERENCE_PDF_DRIVE_URL = process.env.REFERENCE_PDF_DRIVE_URL;

// Holds the parsed reference index in memory once loaded. Stays empty if
// nothing is configured, or if loading fails — the app works fine either
// way.
let referenceChunks = [];
let referencePageCount = 0;
let referenceReady = false;
let referenceSource = null; // 'local' | 'gdrive' | null

app.use(express.json());

// Serve only index.html — not the whole project directory — so files like
// server.js, knowledge.js, and .env are never reachable over HTTP.
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

/**
 * Loads a personal reference PDF, if configured. The PDF itself is never
 * copied anywhere else, and the text extracted from it is kept only in
 * this running process's memory — nothing derived from it is written to
 * disk. Re-parsing on each start takes a few seconds even for a 200+ page
 * file, which is a fine trade-off for keeping zero persisted copies around.
 * If nothing is configured, this silently no-ops and the app runs exactly
 * as it did before.
 */
/**
 * Loads a personal reference PDF, if configured. Two sources are supported,
 * tried in this order:
 *   1. REFERENCE_PDF_PATH — a local file. Best when the server has real
 *      persistent storage (your own VPS, or a Render paid instance with a
 *      persistent disk attached).
 *   2. REFERENCE_PDF_DRIVE_URL — a Google Drive share link or file ID.
 *      Fetched fresh into memory on every start. Works on free hosting
 *      tiers with no persistent disk at all (e.g. Render's free plan),
 *      since nothing needs to survive a restart.
 *
 * Either way, nothing derived from the PDF is ever written to disk —
 * it's parsed into memory and stays only in this running process. If
 * neither is configured (or loading fails), this silently no-ops and the
 * app runs exactly as it did before.
 */
async function initReference() {
  try {
    let pages;

    if (REFERENCE_PDF_PATH && fs.existsSync(REFERENCE_PDF_PATH)) {
      console.log('Reference material: parsing local PDF (in memory only)...');
      pages = await reference.parsePdfPages(REFERENCE_PDF_PATH);
      referenceSource = 'local';
    } else if (REFERENCE_PDF_DRIVE_URL) {
      const fileId = reference.extractDriveFileId(REFERENCE_PDF_DRIVE_URL);
      if (!fileId) {
        console.log('Reference material: could not extract a file ID from REFERENCE_PDF_DRIVE_URL.');
        return;
      }
      console.log('Reference material: fetching PDF from Google Drive (in memory only)...');
      const buffer = await reference.fetchGoogleDriveFile(fileId);
      pages = await reference.parsePdfBuffer(buffer);
      referenceSource = 'gdrive';
    } else {
      if (REFERENCE_PDF_PATH) {
        console.log(`Reference material: REFERENCE_PDF_PATH is set but no file was found at ${REFERENCE_PDF_PATH}`);
      }
      return;
    }

    referenceChunks = reference.buildChunks(pages);
    referencePageCount = pages.length;
    referenceReady = true;
    console.log(`Reference material: ready — ${pages.length} pages indexed in memory (source: ${referenceSource}).`);
  } catch (err) {
    console.log(`Reference material: failed to load — ${err.message}`);
  }
}

function buildSystemPrompt() {
  const kb = SOURCES.map(s => `## ${s.title}\n${s.content.trim()}`).join('\n\n');
  return `You are the study assistant embedded in "PTE Prep Hub," built on a single source document: the PTE Academic Handbook by Ultimate Language Academy. Answer the user's questions using ONLY the handbook content provided below.

Rules:
- Ground every answer in the handbook content below. Do not invent facts, numbers, or templates that aren't in it.
- If the answer isn't covered in the handbook, say so plainly and suggest the closest related section instead of guessing.
- Be concise, practical, and exam-focused — this is for a student actively preparing for the PTE Academic test.
- When helpful, format with short paragraphs or bullet points (use "- " for bullets, "**text**" for bold). Don't use headers.
- When you draw from a specific section, you can mention its name naturally (e.g. "As covered in Read Aloud...").

HANDBOOK CONTENT:
${kb}`;
}

// Lets the frontend show a simple "connected / not connected" indicator
// without ever exposing the key itself.
app.get('/api/health', (req, res) => {
  res.json({ connected: Boolean(OPENAI_API_KEY), model: MODEL });
});

// Exposes just the section titles for the Sources panel.
app.get('/api/sources', (req, res) => {
  res.json(SOURCES.map(s => ({ title: s.title })));
});

// Lets the frontend show whether a personal reference PDF is connected,
// without exposing its path, filename, or any of its content.
app.get('/api/reference-status', (req, res) => {
  res.json({ available: referenceReady, pages: referencePageCount, source: referenceSource });
});

app.post('/api/chat', async (req, res) => {
  if (!OPENAI_API_KEY) {
    return res.status(500).json({
      error: 'The server has no OPENAI_API_KEY configured. Add one to your .env file and restart the server.'
    });
  }

  const { messages } = req.body;
  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: 'Request body must include a "messages" array.' });
  }

  let systemContent = buildSystemPrompt();

  // If a personal reference PDF is loaded, pull a couple of short, capped
  // excerpts relevant to the student's latest message — never the whole
  // document. This keeps the reference material as light supporting
  // context rather than something that gets bulk-reproduced.
  if (referenceReady && referenceChunks.length) {
    const lastUserMessage = [...messages].reverse().find(m => m.role === 'user');
    if (lastUserMessage && lastUserMessage.content) {
      const matches = reference.searchChunks(lastUserMessage.content, referenceChunks, 3);
      if (matches.length) {
        const excerpt = reference.buildExcerptBlock(matches, 900);
        systemContent += `\n\nADDITIONAL PERSONAL REFERENCE MATERIAL (from a practice-test book the student personally owns — separate from the handbook above). These are short, capped excerpts included only for extra context on this specific question:\n\n${excerpt}\n\nWhen drawing on this material: paraphrase it in your own words rather than quoting it at length, refer to it generically as "your reference material" (not by title or publisher), and never reproduce more of it than what's shown above.`;
      }
    }
  }

  try {
    const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'system', content: systemContent }, ...messages],
        temperature: 0.3
      })
    });

    const data = await openaiRes.json();

    if (!openaiRes.ok) {
      const message = (data && data.error && data.error.message) || `OpenAI request failed (${openaiRes.status})`;
      return res.status(openaiRes.status).json({ error: message });
    }

    const reply = data.choices?.[0]?.message?.content || "I couldn't generate a response — please try again.";
    res.json({ reply });
  } catch (err) {
    res.status(500).json({ error: `Server error contacting OpenAI: ${err.message}` });
  }
});

// ---- Study roadmap -------------------------------------------------

app.get('/api/roadmap', async (req, res) => {
  try {
    const progress = await storage.getProgress();
    const roadmap = ROADMAP.map(phase => ({
      ...phase,
      steps: phase.steps.map(step => ({ ...step, done: Boolean(progress[step.id]) }))
    }));
    res.json({ roadmap });
  } catch (err) {
    res.status(500).json({ error: `Could not load roadmap: ${err.message}` });
  }
});

app.post('/api/roadmap/progress', async (req, res) => {
  const { stepId, done } = req.body || {};
  if (!stepId) return res.status(400).json({ error: 'stepId is required.' });
  try {
    const progress = await storage.getProgress();
    progress[stepId] = Boolean(done);
    await storage.saveProgress(progress);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: `Could not save progress: ${err.message}` });
  }
});

// ---- Notebook (saved notes + saved chat replies) -------------------

app.get('/api/notes', async (req, res) => {
  try {
    const notes = await storage.getNotes();
    res.json({ notes });
  } catch (err) {
    res.status(500).json({ error: `Could not load notes: ${err.message}` });
  }
});

app.post('/api/notes', async (req, res) => {
  const { title, content, type, sourceSection } = req.body || {};
  if (!content || !content.trim()) {
    return res.status(400).json({ error: 'Note content is required.' });
  }
  try {
    const notes = await storage.getNotes();
    const note = {
      id: crypto.randomUUID(),
      title: (title && title.trim()) || 'Untitled note',
      content: content.trim(),
      type: type === 'chat' ? 'chat' : 'manual',
      sourceSection: sourceSection || null,
      createdAt: new Date().toISOString()
    };
    notes.unshift(note);
    await storage.saveNotes(notes);
    res.json({ note });
  } catch (err) {
    res.status(500).json({ error: `Could not save note: ${err.message}` });
  }
});

app.delete('/api/notes/:id', async (req, res) => {
  try {
    const notes = await storage.getNotes();
    const filtered = notes.filter(n => n.id !== req.params.id);
    await storage.saveNotes(filtered);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: `Could not delete note: ${err.message}` });
  }
});

// ---- Calendar (student tasks) ---------------------------------------

app.get('/api/tasks', async (req, res) => {
  try {
    const tasks = await storage.getTasks();
    res.json({ tasks });
  } catch (err) {
    res.status(500).json({ error: `Could not load tasks: ${err.message}` });
  }
});

app.post('/api/tasks', async (req, res) => {
  const { date, title } = req.body || {};
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'A valid date (YYYY-MM-DD) is required.' });
  }
  if (!title || !title.trim()) {
    return res.status(400).json({ error: 'Task title is required.' });
  }
  try {
    const tasks = await storage.getTasks();
    const task = {
      id: crypto.randomUUID(),
      date,
      title: title.trim(),
      done: false,
      createdAt: new Date().toISOString()
    };
    tasks.push(task);
    await storage.saveTasks(tasks);
    res.json({ task });
  } catch (err) {
    res.status(500).json({ error: `Could not save task: ${err.message}` });
  }
});

app.put('/api/tasks/:id', async (req, res) => {
  const { done, title, date } = req.body || {};
  try {
    const tasks = await storage.getTasks();
    const idx = tasks.findIndex(t => t.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Task not found.' });
    if (done !== undefined) tasks[idx].done = Boolean(done);
    if (title !== undefined && title.trim()) tasks[idx].title = title.trim();
    if (date !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(date)) tasks[idx].date = date;
    await storage.saveTasks(tasks);
    res.json({ task: tasks[idx] });
  } catch (err) {
    res.status(500).json({ error: `Could not update task: ${err.message}` });
  }
});

app.delete('/api/tasks/:id', async (req, res) => {
  try {
    const tasks = await storage.getTasks();
    const filtered = tasks.filter(t => t.id !== req.params.id);
    await storage.saveTasks(filtered);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: `Could not delete task: ${err.message}` });
  }
});

app.listen(PORT, () => {
  console.log(`PTE Prep Hub running at http://localhost:${PORT}`);
  console.log(OPENAI_API_KEY ? `OpenAI key loaded. Using model: ${MODEL}` : 'WARNING: No OPENAI_API_KEY found in .env');
  initReference();
});
