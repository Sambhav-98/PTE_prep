require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { SOURCES } = require('./knowledge');
const { ROADMAP } = require('./roadmap');
const storage = require('./storage');

const app = express();
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

app.use(express.json());

// Serve only index.html — not the whole project directory — so files like
// server.js, knowledge.js, and .env are never reachable over HTTP.
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

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

  try {
    const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'system', content: buildSystemPrompt() }, ...messages],
        temperature: 1
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
});
