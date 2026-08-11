const fs = require('fs');

// A small stopword list keeps keyword search from matching on filler words.
const STOPWORDS = new Set([
  'the','a','an','is','are','was','were','be','been','being','of','to','and','in','on','for',
  'how','what','why','when','where','do','does','did','i','my','me','can','you','your','please',
  'should','with','this','that','it','as','at','by','from','or','but','if','so','not','no','yes',
  'give','tell','about','get','got','have','has','had','will','would','could','which','who','into'
]);

function tokenize(text) {
  return (text.toLowerCase().match(/[a-z0-9']+/g) || []);
}

function extractQueryTerms(query) {
  const terms = tokenize(query).filter(t => t.length > 2 && !STOPWORDS.has(t));
  return [...new Set(terms)];
}

/**
 * Reads a PDF from disk and returns an array of per-page plain text.
 * The PDF itself is never written anywhere else — this only reads it
 * into memory long enough to build a searchable index.
 */
async function parsePdfPages(filePath) {
  const pdfParse = require('pdf-parse');
  const buffer = fs.readFileSync(filePath);
  const pages = [];

  function pagerender(pageData) {
    return pageData.getTextContent().then(tc => {
      const text = tc.items.map(item => item.str).join(' ');
      pages.push(text);
      return text;
    });
  }

  await pdfParse(buffer, { pagerender });
  return pages;
}

/** Turns raw per-page text into { page, text } chunks, skipping blank pages. */
function buildChunks(pages) {
  const chunks = [];
  pages.forEach((text, idx) => {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (clean) chunks.push({ page: idx + 1, text: clean });
  });
  return chunks;
}

/**
 * Very small keyword-overlap search — no external services, no embeddings.
 * Returns the top few chunks that share the most distinct query terms.
 */
function searchChunks(query, chunks, topK = 3) {
  const queryTerms = extractQueryTerms(query);
  if (!queryTerms.length || !chunks.length) return [];

  const scored = chunks
    .map(c => {
      const lower = c.text.toLowerCase();
      let score = 0;
      for (const term of queryTerms) {
        if (lower.includes(term)) score += 1;
      }
      return { ...c, score };
    })
    .filter(c => c.score > 0);

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

/**
 * Builds a short, hard-capped excerpt block from matched chunks.
 * maxChars caps the TOTAL excerpt content returned for a single question —
 * this is what keeps the feature to "a couple of short paragraphs for
 * context" rather than ever approaching bulk reproduction of the source.
 */
function buildExcerptBlock(matches, maxChars = 900) {
  let used = 0;
  const parts = [];
  for (const m of matches) {
    if (used >= maxChars) break;
    const remaining = maxChars - used;
    let text = m.text;
    if (text.length > remaining) text = text.slice(0, remaining).trim() + '…';
    parts.push(`[Reference, p.${m.page}] ${text}`);
    used += text.length;
  }
  return parts.join('\n\n');
}

module.exports = { parsePdfPages, buildChunks, searchChunks, buildExcerptBlock };
