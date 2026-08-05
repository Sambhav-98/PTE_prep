# PTE Prep Hub

A NotebookLM-style chat interface over the PTE Academic handbook (Ultimate Language Academy), backed by OpenAI. The handbook content lives in `knowledge.js` and is used as grounding context for every answer. The OpenAI API key lives only on the server, in a `.env` file — it's never sent to or stored in the browser.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Create your `.env` file from the example:
   ```bash
   cp .env.example .env
   ```

3. Open `.env` and add your OpenAI API key:
   ```
   OPENAI_API_KEY=sk-your-real-key-here
   OPENAI_MODEL=gpt-4o-mini
   PORT=3000
   ```

4. Start the server:
   ```bash
   npm start
   ```

5. Open [http://localhost:3000](http://localhost:3000) in your browser.

## Project structure

```
pte-prep-hub/
├── server.js         Express server — loads .env, calls OpenAI, serves the frontend
├── knowledge.js       The handbook content, split into named sections
├── index.html          Frontend (Sources / Chat / Studio layout)
├── .env.example         Template for your local .env (copy, don't edit directly)
├── .env                  Your real secrets — gitignored, created by you
└── package.json
```

Note: the server only exposes `index.html` itself over HTTP (via `GET /`) — it does not serve the project directory as a whole, so `server.js`, `knowledge.js`, and `.env` are never reachable by a browser.

## How it works

- The frontend never talks to OpenAI directly. It calls two local endpoints:
  - `POST /api/chat` — sends the conversation, gets back a grounded reply
  - `GET /api/health` — reports whether a server-side key is configured (no key value is ever returned)
  - `GET /api/sources` — returns just the section titles for the left panel
- `server.js` builds a system prompt from `knowledge.js` on every request and sends it to OpenAI's Chat Completions API using the key from `.env`.
- Because the key stays server-side, this is safe to deploy publicly (e.g. Render, Railway, Fly.io, a VPS) without exposing your OpenAI key to visitors.

## Extending this later

The `.env` file is a natural place to add more configuration as this grows — for example:
- A different model per environment (`OPENAI_MODEL`)
- Rate limiting or auth settings
- A database URL if you add persistent chat history
- Alternate providers (Anthropic, etc.) if you want to switch or add options

Just add new keys to `.env.example` (with placeholder values) and `.env` (with real ones), then read them in `server.js` via `process.env.YOUR_KEY`.
