/**
 * Matrix — live-data backend proxy (spec / starter)
 * --------------------------------------------------
 * Why this exists: the app can't hold API keys or call market-data APIs
 * directly from the browser (CORS + secrets). This thin proxy holds the keys,
 * fetches from Yahoo Finance + a news source, caches results, and exposes a
 * clean JSON API the React app calls instead of using mock data.
 *
 * Run:  npm i express cors  &&  node server.js   (Node 18+ for global fetch)
 * Env:  ANTHROPIC_API_KEY=...   NEWS_API_KEY=...(optional)   PORT=8787
 *
 * NOTE: Yahoo's endpoints are unofficial and rate-limited; for production,
 * license official data (NSE/Twelve Data/Alpha Vantage) and keep this shape.
 */
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const db = require("./db");   // Postgres when DATABASE_URL is set, else flat files

const app = express();
app.use(cors());            // lock to your app's origin in prod: cors({ origin: "https://yourapp.com" })
app.use(express.json());

const PORT = process.env.PORT || 8787;
const YF = "https://query1.finance.yahoo.com";
const UA = { "User-Agent": "Mozilla/5.0 (MatrixProxy)" };
db.initDb().catch((e) => console.error("[db] init failed:", e.message));

/* ------------------------------- trade store ------------------------------ */
// Save a completed/opened trade:  POST /api/trades   body: { userId, trade }
app.post("/api/trades", async (req, res) => {
  try {
    const { userId, trade } = req.body || {};
    if (!userId || !trade || !trade.sym) return res.status(400).json({ error: "userId and trade required" });
    const rec = { id: trade.id || `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, ...trade };
    await db.saveTrade(userId, rec);
    res.json({ ok: true, trade: rec });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Fetch trade history:  GET /api/trades?userId=&from=<ms>&to=<ms>
app.get("/api/trades", async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: "userId required" });
    const from = req.query.from ? +req.query.from : 0;
    const to = req.query.to ? +req.query.to : Date.now();
    res.json({ trades: await db.getTrades(userId, from, to) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ----------------------- users (phone + PIN) & state ---------------------- */
// PINs are SHA-256 hashed. Fine for a virtual-trading demo; use a real auth
// provider (and rate-limiting) before handling anything sensitive.
const hashPin = (pin) => crypto.createHash("sha256").update(String(pin) + "|matrix").digest("hex");
const cleanPhone = (p) => String(p || "").replace(/[^0-9]/g, "");

app.post("/api/register", async (req, res) => {
  try {
    const phone = cleanPhone(req.body && req.body.phone), pin = req.body && req.body.pin, name = (req.body && req.body.name) || "";
    if (phone.length < 6 || !pin || String(pin).length < 4) return res.status(400).json({ error: "Enter a valid phone and a 4+ digit PIN." });
    if (await db.getUser(phone)) return res.status(409).json({ error: "That number is already registered — please log in." });
    await db.createUser(phone, hashPin(pin), name);
    res.json({ ok: true, userId: phone, name });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/login", async (req, res) => {
  try {
    const phone = cleanPhone(req.body && req.body.phone), pin = req.body && req.body.pin;
    const u = await db.getUser(phone);
    if (!u || u.pin !== hashPin(pin)) return res.status(401).json({ error: "Wrong phone or PIN." });
    res.json({ ok: true, userId: phone, name: u.name || "" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Save/load a user's app state blob (automations, watchlists, wallets, profile).
app.post("/api/state", async (req, res) => {
  try {
    const { userId, state } = req.body || {};
    if (!userId) return res.status(400).json({ error: "userId required" });
    await db.saveState(userId, state || {});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/state", async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: "userId required" });
    res.json({ state: await db.getState(userId) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ----------------------------- tiny TTL cache ----------------------------- */
const cache = new Map();
function memo(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return Promise.resolve(hit.v);
  return Promise.resolve(fn()).then((v) => { cache.set(key, { v, t: Date.now() }); return v; });
}
const j = async (url) => {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`upstream ${r.status}`);
  return r.json();
};

/* ------------------------------- /api/quote ------------------------------- */
// e.g. /api/quote?symbols=RELIANCE.NS,AAPL,BTC-USD,^NSEI
// Uses the v8 chart endpoint per symbol (no crumb/cookie needed → reliable).
// Run async fn over items with limited concurrency (avoids Yahoo 429s on big lists).
async function mapLimit(arr, limit, fn) {
  const out = new Array(arr.length);
  let i = 0;
  const workers = Array(Math.min(limit, arr.length || 1)).fill(0).map(async () => {
    while (i < arr.length) { const idx = i++; out[idx] = await fn(arr[idx], idx); }
  });
  await Promise.all(workers);
  return out;
}
app.get("/api/quote", async (req, res) => {
  const symbols = String(req.query.symbols || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!symbols.length) return res.status(400).json({ error: "symbols required" });
  try {
    const quotes = await memo(`q:${symbols.join(",")}`, 15_000, async () => {
      const rows = await mapLimit(symbols, 6, async (sym) => {
        try {
          const d = await j(`${YF}/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1d`);
          const m = d.chart?.result?.[0]?.meta;
          if (!m || m.regularMarketPrice == null) return null;
          const price = m.regularMarketPrice;
          const prev = m.chartPreviousClose ?? m.previousClose ?? price;
          const chg = prev ? (price / prev - 1) * 100 : 0;
          return { sym, name: m.symbol || sym, price, chg: +chg.toFixed(2), currency: m.currency };
        } catch { return null; }
      });
      return rows.filter(Boolean);
    });
    res.json({ quotes });
  } catch (e) { res.status(502).json({ error: String(e.message) }); }
});

/* ------------------------------ /api/history ------------------------------ */
// e.g. /api/history?symbol=RELIANCE.NS&range=6mo&interval=1d  -> OHLC candles
app.get("/api/history", async (req, res) => {
  const symbol = String(req.query.symbol || "").trim();
  const range = String(req.query.range || "6mo");
  const interval = String(req.query.interval || "1d");
  if (!symbol) return res.status(400).json({ error: "symbol required" });
  try {
    const data = await memo(`h:${symbol}:${range}:${interval}`, 60_000, () =>
      j(`${YF}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`));
    const r = data.chart?.result?.[0];
    const ts = r?.timestamp || [];
    const q = r?.indicators?.quote?.[0] || {};
    const candles = ts.map((t, i) => ({
      t: t * 1000,
      o: q.open?.[i], h: q.high?.[i], l: q.low?.[i], c: q.close?.[i], v: q.volume?.[i],
    })).filter((d) => d.c != null);
    res.json({ symbol, candles });
  } catch (e) { res.status(502).json({ error: String(e.message) }); }
});

/* -------------------------------- /api/news ------------------------------- */
// e.g. /api/news?symbol=RELIANCE.NS  (Yahoo) — swap for NewsAPI if NEWS_API_KEY set
app.get("/api/news", async (req, res) => {
  const symbol = String(req.query.symbol || req.query.q || "").trim();
  if (!symbol) return res.status(400).json({ error: "symbol/q required" });
  try {
    const items = await memo(`n:${symbol}`, 120_000, async () => {
      if (process.env.NEWS_API_KEY) {
        const u = `https://newsapi.org/v2/everything?q=${encodeURIComponent(symbol)}&sortBy=publishedAt&pageSize=8&apiKey=${process.env.NEWS_API_KEY}`;
        const d = await j(u);
        return (d.articles || []).map((a) => ({ t: a.title, d: a.publishedAt, src: a.source?.name, url: a.url }));
      }
      // Fallback: Yahoo search news
      const d = await j(`${YF}/v1/finance/search?q=${encodeURIComponent(symbol)}&newsCount=8&quotesCount=0`);
      return (d.news || []).map((n) => ({ t: n.title, d: new Date(n.providerPublishTime * 1000).toISOString(), src: n.publisher, url: n.link }));
    });
    res.json({ symbol, news: items });
  } catch (e) { res.status(502).json({ error: String(e.message) }); }
});

/* -------------------------------- /api/ask -------------------------------- */
// Server-side Ask Matrix. Tries providers in order and FALLS THROUGH on failure,
// so a bad model name or rate-limit on one provider doesn't kill the request.
// Set any of: GROQ_API_KEY (free, recommended) / OPENROUTER_API_KEY / GEMINI_API_KEY / ANTHROPIC_API_KEY
const GROQ_MODELS = () => [process.env.GROQ_MODEL, "llama-3.3-70b-versatile", "llama-3.1-8b-instant", "openai/gpt-oss-20b"].filter(Boolean);

async function callGroq(system, messages, max_tokens) {
  let lastErr = "";
  for (const model of GROQ_MODELS()) {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({ model, max_tokens, messages: [{ role: "system", content: system }, ...messages] }),
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok) return (data.choices?.[0]?.message?.content || "").trim();
    lastErr = data.error?.message || `groq ${r.status}`;
    console.error(`[ask] groq model ${model} failed: ${lastErr}`);
  }
  throw new Error(lastErr || "groq failed");
}
async function callOpenRouter(system, messages, max_tokens) {
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
    body: JSON.stringify({ model: process.env.OPENROUTER_MODEL || "meta-llama/llama-3.3-70b-instruct:free", max_tokens, messages: [{ role: "system", content: system }, ...messages] }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error?.message || `openrouter ${r.status}`);
  return (data.choices?.[0]?.message?.content || "").trim();
}
async function callGemini(system, messages, max_tokens) {
  const model = process.env.GEMINI_MODEL || "gemini-2.0-flash";
  const contents = messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: typeof m.content === "string" ? m.content : (m.content || []).map((c) => c.text || "").join("\n") }] }));
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ system_instruction: { parts: [{ text: system }] }, contents, generationConfig: { maxOutputTokens: max_tokens } }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error?.message || `gemini ${r.status}`);
  return (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("\n").trim();
}
async function callAnthropic(system, messages, max_tokens) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens, system, messages }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error?.message || `anthropic ${r.status}`);
  return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
}

// Which providers are configured (also used by /api/health)
const providers = () => [
  process.env.GROQ_API_KEY && { name: "groq", fn: callGroq },
  process.env.OPENROUTER_API_KEY && { name: "openrouter", fn: callOpenRouter },
  process.env.GEMINI_API_KEY && { name: "gemini", fn: callGemini },
  process.env.ANTHROPIC_API_KEY && { name: "anthropic", fn: callAnthropic },
].filter(Boolean);

app.get("/api/health", (req, res) => {
  res.json({ ok: true, engines: providers().map((p) => p.name), db: db.USING_PG ? "postgres" : "flat-file" });
});

app.post("/api/ask", async (req, res) => {
  const { messages = [], context = "", system: sysOverride, max_tokens = 1000 } = req.body || {};
  const DEFAULT = `You are Matrix — the world's sharpest stock-market research assistant, fluent in fundamental, technical and macro analysis. Be crisp and structured; give bull case, bear case and key levels rather than a bare command. End with a one-line reminder that this is educational research, not financial advice.`;
  const system = sysOverride ? sysOverride : (DEFAULT + (context ? "\n\nCONTEXT:\n" + context : ""));
  const chain = providers();
  if (!chain.length) return res.status(500).json({ error: "No LLM key set. Add GROQ_API_KEY (free) in your Render environment." });
  const errors = [];
  for (const p of chain) {
    try {
      const text = await p.fn(system, messages, max_tokens);
      if (text) return res.json({ text, engine: p.name });
      errors.push(`${p.name}: empty response`);
    } catch (e) {
      errors.push(`${p.name}: ${e.message}`);
      console.error(`[ask] ${p.name} failed:`, e.message);
    }
  }
  res.status(502).json({ error: errors.join(" | ") });
});

app.get("/health", (_, res) => res.json({ ok: true }));
app.listen(PORT, () => console.log(`Matrix proxy on :${PORT}`));
