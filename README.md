# PTE Prep Hub

A NotebookLM-style study app for the PTE Academic handbook (Ultimate Language Academy), backed by OpenAI. The handbook content lives in `knowledge.js` and is used as grounding context for every chat answer. The OpenAI API key lives only on the server, in a `.env` file — it's never sent to or stored in the browser.

Three panels, like NotebookLM, plus a calendar:
- **Sources** (left) — the handbook, broken into sections.
- **Chat** (center) — ask anything; answers are grounded only in the handbook.
- **Studio** (right) — three tabs:
  - **Dashboard** — two circular progress rings (Roadmap completion, Task completion), a quick stats card (notes saved, tasks scheduled), and the original quick-facts / task-weight reference.
  - **Roadmap** — a step-by-step, phase-by-phase study plan built from the handbook's own task-priority data, with a checklist you can tick off as you go.
  - **Notebook** — save any chat reply with one click, or write your own notes. Everything persists on the server.
- **Calendar** (opens from the top bar, on any screen size) — a month view where students can add tasks to specific days, check them off, and delete them. Task counts show as dots on each day; completion feeds the Dashboard's "Tasks" ring.

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
├── server.js         Express server — loads .env, calls OpenAI, serves the frontend, exposes the API
├── knowledge.js       The handbook content, split into named sections
├── roadmap.js          The step-by-step study plan (phases + steps + "why it matters")
├── storage.js           Tiny JSON-file read/write helpers for notes, roadmap progress, and tasks
├── index.html             Frontend (Sources / Chat / Studio: Dashboard, Roadmap, Notebook / Calendar modal)
├── data/                    Created automatically at runtime — notes.json, progress.json, tasks.json (gitignored)
├── .env.example         Template for your local .env (copy, don't edit directly)
├── .env                  Your real secrets — gitignored, created by you
└── package.json
```

Note: the server only exposes `index.html` itself over HTTP (via `GET /`) — it does not serve the project directory as a whole, so `server.js`, `knowledge.js`, and `.env` are never reachable by a browser.

## How it works

- The frontend never talks to OpenAI directly. It calls local endpoints only:
  - `POST /api/chat` — sends the conversation, gets back a grounded reply
  - `GET /api/health` — reports whether a server-side key is configured (no key value is ever returned)
  - `GET /api/sources` — returns just the section titles for the left panel
  - `GET /api/roadmap` — returns the study plan with each step's current done/not-done state
  - `POST /api/roadmap/progress` — toggles one step (`{ stepId, done }`)
  - `GET /api/notes` — returns all saved notes, newest first
  - `POST /api/notes` — saves a note (`{ title, content, type }`, where `type` is `"manual"` or `"chat"`)
  - `DELETE /api/notes/:id` — deletes a note
  - `GET /api/tasks` — returns all calendar tasks
  - `POST /api/tasks` — creates a task (`{ date: "YYYY-MM-DD", title }`)
  - `PUT /api/tasks/:id` — updates a task (`{ done }` and/or `{ title }` and/or `{ date }`)
  - `DELETE /api/tasks/:id` — deletes a task
- `server.js` builds a system prompt from `knowledge.js` on every chat request and sends it to OpenAI's Chat Completions API using the key from `.env`.
- Because the key stays server-side, this is safe to deploy publicly (e.g. Render, Railway, Fly.io, a VPS) without exposing your OpenAI key to visitors.
- Notes and roadmap progress are stored in flat JSON files under `data/` via `storage.js`, and are shared by anyone using the deployed app (there's no login system — this is built for one student's own instance, not multi-tenant use).

## A note on data persistence

`data/notes.json`, `data/progress.json`, and `data/tasks.json` live on the server's local disk. That's fine for local use or a VPS with a persistent volume, but **on Render's free tier the disk is ephemeral** — it resets on every redeploy or restart, which would wipe saved notes and roadmap progress. If you want that data to survive redeploys:
- Attach a [Render persistent disk](https://render.com/docs/disks) (paid) mounted at the `data/` path, or
- Swap `storage.js` for a real database (e.g. a free-tier Postgres or SQLite-on-a-volume) — the rest of the app doesn't need to change, since everything already goes through the small `getNotes` / `saveNotes` / `getProgress` / `saveProgress` interface in `storage.js`.

## Extending this later

The `.env` file is a natural place to add more configuration as this grows — for example:
- A different model per environment (`OPENAI_MODEL`)
- Rate limiting or auth settings
- A database URL if you add persistent chat history
- Alternate providers (Anthropic, etc.) if you want to switch or add options

Just add new keys to `.env.example` (with placeholder values) and `.env` (with real ones), then read them in `server.js` via `process.env.YOUR_KEY`.
