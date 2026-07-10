# Matrix — backend proxy

A thin Node/Express service that gives the Matrix app:

- **Live prices / candles / news** (Yahoo Finance, cached) — Yahoo can't be called from the browser (CORS + crumb auth), so it's proxied here.
- **Ask Matrix / Deep Analysis / plain-language interpretation** via an LLM. Tries **Groq → OpenRouter → Gemini → Anthropic** (first key found wins).
- **Login** (phone + PIN) and **per-user persistence** stored in flat JSON files.

Keys never touch the browser — they live only as environment variables on the server.

## Endpoints
- `GET  /api/quote?symbols=NVDA,RELIANCE.NS` — batched live quotes
- `GET  /api/history?symbol=NVDA&range=6mo&interval=1d` — OHLC candles
- `GET  /api/news?symbol=NVDA` — recent headlines
- `POST /api/ask` — `{ messages, system, max_tokens }` → `{ text, engine }`
- `POST /api/register` — `{ phone, pin, name? }` → `{ ok, userId }`
- `POST /api/login` — `{ phone, pin }` → `{ ok, userId, name }`
- `POST /api/trades` / `GET /api/trades?userId=&from=&to=` — trade history
- `POST /api/state` / `GET /api/state?userId=` — per-user app state

## Environment variables
Set **one** LLM key (free tiers first):

| Variable | Purpose |
|---|---|
| `GROQ_API_KEY` | **Recommended, free.** Groq (console.groq.com). |
| `OPENROUTER_API_KEY` | OpenRouter (has free `:free` models). |
| `GEMINI_API_KEY` | Google Gemini free tier. |
| `ANTHROPIC_API_KEY` | Anthropic (paid). |
| `GROQ_MODEL` | optional, default `llama-3.3-70b-versatile` |
| `NEWS_API_KEY` | optional, enables richer news |
| `PORT` | set automatically by Render |

Data files (`trades.json`, `users.json`, `state.json`) are created next to `server.js`.
On Render's free tier the disk is **ephemeral** (wiped on redeploy/restart) — fine for a demo;
add a Render Disk or a real database (SQLite/Postgres) for durable storage.

## Run locally
```bash
cd matrix-backend
npm install
GROQ_API_KEY=gsk_xxx node server.js      # http://localhost:8787
```

## Deploy on Render
1. Push this `matrix-backend` folder to a GitHub repo.
2. Render → **New → Web Service** → connect the repo.
3. **Root Directory:** `matrix-backend` · **Build:** `npm install` · **Start:** `npm start`
4. **Environment → Add** `GROQ_API_KEY` (and optionally `NEWS_API_KEY`).
5. Deploy, then copy the service URL (e.g. `https://matrix-backend-xxxx.onrender.com`).
6. In the frontend `src/Matrix.jsx`, set `const BACKEND_URL = "https://matrix-backend-xxxx.onrender.com";` (no trailing slash).

**Smoke test:** open `https://<your-url>/api/quote?symbols=NVDA` — real JSON = working.
