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
const bcrypt = require("bcryptjs");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());            // lock to your app's origin in prod: cors({ origin: "https://yourapp.com" })
app.use(express.json());

const PORT = process.env.PORT || 8787;
const YF = "https://query1.finance.yahoo.com";
const UA = { "User-Agent": "Mozilla/5.0 (MatrixProxy)" };

/* ------------------------------ user store --------------------------------
 * NOTE: this is a simple JSON-file store — fine for a hobby project, but
 * Render's free-tier disk is wiped on every new deploy (not on sleep/wake).
 * For anything real, swap this for a proper database (e.g. Supabase,
 * MongoDB Atlas free tier) and keep the same function signatures below. */
const USERS_FILE = path.join(__dirname, "users.json");
function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, "utf8")); } catch { return {}; }
}
function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}
function normId(identifier) {
  return String(identifier || "").trim().toLowerCase();
}

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
app.get("/api/quote", async (req, res) => {
  const symbols = String(req.query.symbols || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!symbols.length) return res.status(400).json({ error: "symbols required" });
  try {
    const quotes = await memo(`q:${symbols.join(",")}`, 15_000, async () => {
      const rows = await Promise.all(symbols.map(async (sym) => {
        try {
          const d = await j(`${YF}/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1d`);
          const m = d.chart?.result?.[0]?.meta;
          if (!m || m.regularMarketPrice == null) return null;
          const price = m.regularMarketPrice;
          const prev = m.chartPreviousClose ?? m.previousClose ?? price;
          const chg = prev ? (price / prev - 1) * 100 : 0;
          return { sym, name: m.symbol || sym, price, chg: +chg.toFixed(2), currency: m.currency };
        } catch { return null; }
      }));
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
// Server-side Ask Matrix: keeps your Anthropic key off the client.
app.post("/api/ask", async (req, res) => {
  const { messages = [], context = "", system: sysOverride, max_tokens = 1000 } = req.body || {};
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });
  const DEFAULT = `You are Matrix — the world's sharpest stock-market research assistant, fluent in fundamental, technical and macro analysis. Be crisp and structured; give bull case, bear case and key levels rather than a bare command. End with a one-line reminder that this is educational research, not financial advice.`;
  // Callers may pass a complete `system` (persona already included) OR just `context`.
  const system = sysOverride ? sysOverride : (DEFAULT + (context ? "\n\nCONTEXT:\n" + context : ""));
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens, system, messages }),
    });
    const data = await r.json();
    const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    res.json({ text });
  } catch (e) { res.status(502).json({ error: String(e.message) }); }
});

/* -------------------------------- /api/auth -------------------------------- */
// Signup: { identifier (mobile or email), name, pin } -> creates the account
app.post("/api/auth/signup", async (req, res) => {
  const identifier = normId(req.body?.identifier);
  const name = String(req.body?.name || "").trim();
  const pin = String(req.body?.pin || "");
  if (!identifier || !name) return res.status(400).json({ error: "identifier and name required" });
  if (!/^\d{4,6}$/.test(pin)) return res.status(400).json({ error: "PIN must be 4-6 digits" });

  const users = loadUsers();
  if (users[identifier]) return res.status(409).json({ error: "An account with this mobile/email already exists" });

  const pinHash = await bcrypt.hash(pin, 10);
  users[identifier] = { identifier, name, pinHash, onboarded: false, profile: null, createdAt: Date.now() };
  saveUsers(users);

  res.json({ ok: true, user: { identifier, name, onboarded: false, profile: null } });
});

// Login: { identifier, pin } -> returns the saved profile/onboarded flag
app.post("/api/auth/login", async (req, res) => {
  const identifier = normId(req.body?.identifier);
  const pin = String(req.body?.pin || "");
  if (!identifier || !pin) return res.status(400).json({ error: "identifier and pin required" });

  const users = loadUsers();
  const u = users[identifier];
  if (!u) return res.status(404).json({ error: "No account found for this mobile/email" });

  const ok = await bcrypt.compare(pin, u.pinHash);
  if (!ok) return res.status(401).json({ error: "Incorrect PIN" });

  res.json({ ok: true, user: { identifier: u.identifier, name: u.name, onboarded: u.onboarded, profile: u.profile } });
});

// Save personalization profile after onboarding, so it never shows again
app.post("/api/auth/profile", (req, res) => {
  const identifier = normId(req.body?.identifier);
  const profile = req.body?.profile ?? null;
  if (!identifier) return res.status(400).json({ error: "identifier required" });

  const users = loadUsers();
  const u = users[identifier];
  if (!u) return res.status(404).json({ error: "No account found" });

  u.profile = profile;
  u.onboarded = true;
  saveUsers(users);
  res.json({ ok: true, user: { identifier: u.identifier, name: u.name, onboarded: true, profile } });
});

app.get("/health", (_, res) => res.json({ ok: true }));
app.listen(PORT, () => console.log(`Matrix proxy on :${PORT}`));
