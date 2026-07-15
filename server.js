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
const compression = require("compression");        // gzip API responses
const rateLimit = require("express-rate-limit");   // brute-force protection
const bcrypt = require("bcryptjs");                 // proper PIN hashing
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const db = require("./db");   // Postgres when DATABASE_URL is set, else flat files

const app = express();

/* CORS locked to known origins (was wide-open app.use(cors())). The custom broker headers
   MUST stay allowed or every /api/broker/* preflight fails. Extra origins can be added via
   the CORS_ORIGINS env var (comma-separated) without a code change. */
const ALLOWED_ORIGINS = [
  "https://matrix-frontend-indol.vercel.app",
  "http://localhost:5173",
  "http://localhost:4173",
  ...String(process.env.CORS_ORIGINS || "").split(",").map((x) => x.trim()).filter(Boolean),
];
app.use(cors({
  origin(origin, cb) {
    // allow same-origin / curl / server-to-server (no Origin header) and any listed origin
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error("Not allowed by CORS"));
  },
  allowedHeaders: ["Content-Type", "X-Broker-Session", "X-User-Id", "X-Confirm-Live"],
  exposedHeaders: ["Location"],   // Schwab returns the order id in the Location header
}));

app.use(compression());     // gzip JSON responses — big win on the indicators/quotes payloads
// (was: app.use(cors());  wide openpp.com" })
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

    /* Validate fields that must be sane. We DON'T reject unknown fields — the frontend
       sends a rich trade object — but a negative qty or non-numeric price is never valid. */
    if (trade.side && !["BUY", "SELL"].includes(String(trade.side).toUpperCase()))
      return res.status(400).json({ error: "side must be BUY or SELL" });
    if (trade.qty != null && (!Number.isFinite(+trade.qty) || +trade.qty <= 0))
      return res.status(400).json({ error: "qty must be a positive number" });
    if (trade.price != null && (!Number.isFinite(+trade.price) || +trade.price < 0))
      return res.status(400).json({ error: "price must be a non-negative number" });
    if (String(trade.sym).length > 64)
      return res.status(400).json({ error: "symbol too long" });
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
/* PINs are now bcrypt-hashed. Existing users were SHA-256 — we MUST NOT lock them out, so
   verifyPin accepts the old scheme too, and a successful legacy login is transparently
   re-hashed to bcrypt (see /api/login). No user re-registers; the upgrade is invisible. */
const BCRYPT_ROUNDS = 10;
const legacySha = (pin) => crypto.createHash("sha256").update(String(pin) + "|matrix").digest("hex");
const hashPin = (pin) => bcrypt.hashSync(String(pin), BCRYPT_ROUNDS);

/** True if `pin` matches the stored hash, whether that hash is bcrypt or legacy SHA-256. */
function verifyPin(pin, stored) {
  if (!stored) return false;
  // bcrypt hashes start with $2a$/$2b$/$2y$. Anything else is a legacy SHA-256 hex digest.
  if (/^\$2[aby]\$/.test(stored)) return bcrypt.compareSync(String(pin), stored);
  return stored === legacySha(pin);
}
/** True if the stored hash is the old SHA-256 scheme and should be upgraded on login. */
const isLegacyHash = (stored) => stored && !/^\$2[aby]\$/.test(stored);
const cleanPhone = (p) => String(p || "").replace(/[^0-9]/g, "");

/* Rate limit auth endpoints: 10 attempts per 15 min per IP. Blocks brute force without
   getting in a real user's way. */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Please wait a few minutes and try again." },
});

app.post("/api/register", authLimiter, async (req, res) => {
  try {
    const phone = cleanPhone(req.body && req.body.phone), pin = req.body && req.body.pin, name = (req.body && req.body.name) || "";
    if (phone.length < 6 || !pin || String(pin).length < 4) return res.status(400).json({ error: "Enter a valid phone and a 4+ digit PIN." });
    if (await db.getUser(phone)) return res.status(409).json({ error: "That number is already registered — please log in." });
    await db.createUser(phone, hashPin(pin), name);
    res.json({ ok: true, userId: phone, name });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/login", authLimiter, async (req, res) => {
  try {
    const phone = cleanPhone(req.body && req.body.phone), pin = req.body && req.body.pin;
    const u = await db.getUser(phone);
    if (!u || !verifyPin(pin, u.pin)) return res.status(401).json({ error: "Wrong phone or PIN." });

    // Blocked users are turned away even with a correct PIN.
    if (typeof db.isUserBlocked === "function" && await db.isUserBlocked(phone)) {
      return res.status(403).json({ error: "This account has been blocked. Contact support." });
    }

    /* Upgrade a legacy SHA-256 user to bcrypt now that we've verified their PIN. Best-effort:
       a failed upgrade must not fail the login. */
    if (isLegacyHash(u.pin) && typeof db.updateUserPin === "function") {
      try { await db.updateUserPin(phone, hashPin(pin)); } catch { /* upgrade later */ }
    }
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

/* ================================ ADMIN ================================== */
/* Locked behind TWO checks: the caller's userId must be in ADMIN_USER_IDS, AND they must
   present the ADMIN_KEY secret. Both are required — a leaked key alone, or a known admin
   userId alone, is not enough. Set ADMIN_USER_IDS (comma-separated) and ADMIN_KEY in env. */
const stripPh = (s) => String(s || "").replace(/^ph_/, "");
function isAdmin(req) {
  const adminIds = String(process.env.ADMIN_USER_IDS || "").split(",").map((x) => stripPh(x.trim())).filter(Boolean);
  const adminKey = process.env.ADMIN_KEY || "";
  const uid = stripPh(req.get("X-User-Id") || req.query.userId || "");
  const key = req.get("X-Admin-Key") || req.query.key || "";
  if (!adminKey || !adminIds.length) return false;       // admin not configured -> no access
  return adminIds.includes(uid) && key === adminKey;
}
function requireAdmin(req, res) {
  if (!isAdmin(req)) { res.status(403).json({ error: "Forbidden" }); return false; }
  return true;
}

// List all users (basic records, no PINs).
app.get("/api/admin/users", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try { res.json({ users: await db.listUsers() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Full detail on one user: profile, saved state (strategies + onboarding answers), trades.
app.get("/api/admin/user", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const phone = cleanPhone(req.query.phone);
    const full = await db.getUserFull(phone);
    if (!full) return res.status(404).json({ error: "user not found" });
    res.json(full);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Block or unblock a user.
app.post("/api/admin/block", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const phone = cleanPhone(req.body && req.body.phone);
    const blocked = !!(req.body && req.body.blocked);
    if (!phone) return res.status(400).json({ error: "phone required" });
    await db.setUserBlocked(phone, blocked);
    res.json({ ok: true, phone, blocked });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Full admin check (userId + key) — used before actually opening the panel.
app.get("/api/admin/check", async (req, res) => {
  res.json({ admin: isAdmin(req) });
});

// Visibility-only check: is this userId in the admin list? No key required, because this
// only decides whether to SHOW the button — it grants no access (every admin route still
// demands the key). Returns false if admin isn't configured at all.
app.get("/api/admin/is-admin-user", async (req, res) => {
  const adminIds = String(process.env.ADMIN_USER_IDS || "").split(",").map((x) => stripPh(x.trim())).filter(Boolean);
  const adminKey = process.env.ADMIN_KEY || "";
  const uid = stripPh(req.get("X-User-Id") || req.query.userId || "");
  res.json({
    adminUser: Boolean(adminKey && adminIds.length && adminIds.includes(uid)),
    // Diagnostics: helps you set ADMIN_USER_IDS correctly. `yourUserId` is the exact string
    // that must appear in ADMIN_USER_IDS. No secrets are exposed here.
    yourUserId: String(uid),
    adminConfigured: Boolean(adminKey && adminIds.length),
  });
});


/* ----------------------------- tiny TTL cache ----------------------------- */
const cache = new Map();
function memo(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return Promise.resolve(hit.v);
  return Promise.resolve(fn()).then((v) => { cache.set(key, { v, t: Date.now() }); return v; });
}
const FETCH_TIMEOUT_MS = 8000;
/* Timed fetch: aborts after 8s so a hanging upstream (Yahoo, an LLM provider) fails fast
   instead of stalling the whole request behind it. */
async function fetchT(url, opts = {}, ms = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`upstream timeout after ${ms}ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

const j = async (url) => {
  const r = await fetchT(url, { headers: UA });
  if (!r.ok) throw new Error(`upstream ${r.status}`);
  return r.json();
};

/* Yahoo's crumb-authenticated quoteSummary endpoint (P/E, ROE, margins, quarterly
   revenue) refuses requests from datacenter IPs — verified from Render: the cookie
   and crumb handshake both return 401 ("yahoo: auth failed"). The open v8 /chart
   endpoint that powers everything else is unaffected.

   So there is NO fundamentals data source, and /api/fundamentals is gone rather
   than left returning {} forever. Scraping Moneycontrol was considered and rejected:
   numbers whose provenance we cannot verify are worse than no numbers.       */

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

/* MARKET NEWS FEED — many symbols at once, tagged by what kind of event it is.
   The single-symbol /api/news gives you one stock's headlines; the Dashboard needs a
   feed across the whole watchlist, which is why "In the news" was only ever showing
   one stock.

   ON SCRAPING MONEYCONTROL / NSE: not done, deliberately. NSE's announcement API
   rejects datacenter IPs (the same wall Yahoo's quoteSummary put up, which is why
   fundamentals got deleted), and Moneycontrol has no public API — scraping their HTML
   means shipping a parser that breaks silently and, worse, presents numbers whose
   provenance we cannot verify. A wrong dividend or split figure is not a cosmetic bug.
   Yahoo's news IS real, sourced and attributed, so that is what we aggregate. If you
   want NSE corporate announcements, the honest path is a broker feed or a licensed
   data vendor, not a scraper.

   Event tagging is done on the HEADLINE TEXT ONLY — we tag what the headline says, and
   nothing is inferred beyond it. */
const NEWS_TAGS = [
  { tag: "Earnings",  re: /\b(q[1-4]|quarter(ly)?|results?|earnings|profit|revenue|net income|pat\b)/i },
  { tag: "Dividend",  re: /\b(dividend|payout|record date|ex-dividend)/i },
  { tag: "Split",     re: /\b(stock split|share split|bonus issue|bonus share)/i },
  { tag: "Bulk deal", re: /\b(bulk deal|block deal|bulk sell|stake sale|offloads?|pledge[ds]?)/i },
  { tag: "Buyback",   re: /\b(buyback|buy-back|repurchase)/i },
  { tag: "M&A",       re: /\b(acquisition|acquires?|merger|takeover|stake buy)/i },
  { tag: "Order win", re: /\b(order win|bags order|wins? contract|awarded)/i },
];

const tagOf = (title) => {
  const hit = NEWS_TAGS.find((t) => t.re.test(title || ""));
  return hit ? hit.tag : null;
};

app.get("/api/news/feed", async (req, res) => {
  const syms = String(req.query.symbols || "").split(",").map((x) => x.trim()).filter(Boolean).slice(0, 12);
  const onlyTagged = String(req.query.tagged || "") === "1";
  if (!syms.length) return res.status(400).json({ error: "symbols required" });

  try {
    const per = await Promise.all(syms.map(async (sym) => {
      try {
        const items = await memo(`nf:${sym}`, 300_000, async () => {
          const u = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(sym)}&newsCount=6&quotesCount=0`;
          const d = await j(u);
          return (d.news || []).map((a) => ({
            sym,
            t: a.title,
            d: a.providerPublishTime ? a.providerPublishTime * 1000 : null,
            src: a.publisher || null,
            url: a.link || null,
          }));
        });
        return items;
      } catch { return []; }                 // one bad symbol must not kill the feed
    }));

    let all = per.flat().filter((x) => x.t);
    all.forEach((x) => { x.tag = tagOf(x.t); });
    if (onlyTagged) all = all.filter((x) => x.tag);

    // newest first; de-duplicate identical headlines across symbols
    const seen = new Set();
    all = all
      .sort((a, b) => (b.d || 0) - (a.d || 0))
      .filter((x) => { const k = (x.t || "").toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
      .slice(0, 30);

    res.json({ news: all, count: all.length });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

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

/* ======================= SERVER-SIDE EXIT MONITOR =========================
   Runs on the server every minute, so a target/stop is honoured even when nobody
   has the app open. Walks REAL 5-minute candles forward from the entry time and
   closes the position at whichever level was actually touched first.
   Set EXIT_MONITOR=off to disable.                                            */
async function candlesFor(symbol, range = "5d", interval = "5m") {
  const data = await memo(`h:${symbol}:${range}:${interval}`, 60_000, () =>
    j(`${YF}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`));
  const r = data.chart?.result?.[0];
  const ts = r?.timestamp || [];
  const q = r?.indicators?.quote?.[0] || {};
  return ts.map((t, i) => ({ t: t * 1000, o: q.open?.[i], h: q.high?.[i], l: q.low?.[i], c: q.close?.[i] }))
           .filter((d) => d.c != null && d.h != null && d.l != null);
}

// Same rules as the in-app engine: TP / hard SL / trailing SL, worst-case on ties.
function resolveExit(trade, candles) {
  const { tp, sl, tsl, entry, entryAt } = trade;
  if (!tp && !sl && !tsl) return null;
  const target = tp ? entry * (1 + tp / 100) : null;
  const hardStop = sl ? entry * (1 - sl / 100) : null;
  let peak = entry;
  for (const c of candles.filter((c) => c.t > (entryAt || 0))) {
    const trailStop = tsl ? peak * (1 - tsl / 100) : null;
    const stop = Math.max(hardStop ?? -Infinity, trailStop ?? -Infinity);
    const hasStop = stop > -Infinity;
    const hitStop = hasStop && c.l <= stop;
    const hitTarget = target != null && c.h >= target;
    const stopLabel = (trailStop != null && stop === trailStop) ? "Trailing stop" : "Stop loss";
    if (hitStop) return { exit: +stop.toFixed(2), exitAt: c.t, exitType: stopLabel };
    if (hitTarget) return { exit: +target.toFixed(2), exitAt: c.t, exitType: "Exit trigger" };
    if (c.h > peak) peak = c.h;
  }
  return null;
}

// Map an app symbol to its Yahoo ticker (mirrors the frontend's mapping).
const Y_SPECIAL = { NIFTY50: "^NSEI", BANKNIFTY: "^NSEBANK", SENSEX: "^BSESN", FINNIFTY: "^CNXFIN", INDIAVIX: "^INDIAVIX", SPX: "^GSPC", NDX: "^NDX", DJI: "^DJI", VIX: "^VIX", GOLD: "GC=F", SILVER: "SI=F", CRUDE: "CL=F", NATGAS: "NG=F", COPPER: "HG=F", ALUMINIUM: "ALI=F", BTC: "BTC-USD", ETH: "ETH-USD", SOL: "SOL-USD", XRP: "XRP-USD", DOGE: "DOGE-USD", ADA: "ADA-USD", AVAX: "AVAX-USD", LINK: "LINK-USD", MATIC: "MATIC-USD", DOT: "DOT-USD", BNB: "BNB-USD" };
const IN_MKT = new Set(["IN", "FNO"]);
function yahooSymbolFor(trade) {
  const s = trade.sym;
  if (Y_SPECIAL[s]) return Y_SPECIAL[s];
  if (IN_MKT.has(trade.market)) return `${s}.NS`;
  return s;
}

let monitorRunning = false;
let lastMonitor = { at: null, checked: 0, closed: 0 };
async function runExitMonitor() {
  if (monitorRunning) return;
  monitorRunning = true;
  let checked = 0, closed = 0;
  try {
    const open = await db.getOpenTrades(200);
    for (const { userId, trade } of open) {
      // Options/derivative legs have no Yahoo candle feed — skip them.
      if (String(trade.sym).includes(" ")) continue;
      checked++;
      try {
        const candles = await candlesFor(yahooSymbolFor(trade));
        const hit = resolveExit(trade, candles);
        if (!hit) continue;
        const qty = trade.qty || 1;
        const updated = { ...trade, ...hit, pnl: +((hit.exit - trade.entry) * qty).toFixed(2) };
        await db.updateTrade(userId, updated);
        closed++;
        console.log(`[monitor] closed ${trade.sym} for ${userId} @ ${hit.exit} (${hit.exitType})`);
      } catch (e) { /* one bad symbol shouldn't stop the sweep */ }
    }
  } catch (e) { console.error("[monitor] sweep failed:", e.message); }
  finally {
    monitorRunning = false;
    lastMonitor = { at: Date.now(), checked, closed };
  }
}
if (process.env.EXIT_MONITOR !== "off") {
  setInterval(runExitMonitor, 60_000);
  setTimeout(runExitMonitor, 10_000);           // first sweep shortly after boot
}
app.get("/api/monitor", (req, res) => res.json({ enabled: process.env.EXIT_MONITOR !== "off", last: lastMonitor }));

/* --------------------------- /api/indicators ------------------------------
   REAL technical indicators computed from REAL daily candles (1y of history).
   Nothing here is generated or seeded — every number is derived from prices.
   e.g. /api/indicators?symbols=RELIANCE.NS,NVDA                              */
const SMA = (a, n) => a.length < n ? null : +(a.slice(-n).reduce((x, y) => x + y, 0) / n).toFixed(4);
function EMA(a, n) {
  if (a.length < n) return null;
  const k = 2 / (n + 1);
  let e = a.slice(0, n).reduce((x, y) => x + y, 0) / n;
  for (let i = n; i < a.length; i++) e = a[i] * k + e * (1 - k);
  return +e.toFixed(4);
}
function emaSeries(a, n) {
  if (a.length < n) return [];
  const k = 2 / (n + 1), out = [];
  let e = a.slice(0, n).reduce((x, y) => x + y, 0) / n;
  out.push(e);
  for (let i = n; i < a.length; i++) { e = a[i] * k + e * (1 - k); out.push(e); }
  return out;
}
function RSI(closes, n = 14) {
  if (closes.length < n + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= n; i++) { const d = closes[i] - closes[i - 1]; d >= 0 ? gain += d : loss -= d; }
  gain /= n; loss /= n;
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (n - 1) + (d > 0 ? d : 0)) / n;
    loss = (loss * (n - 1) + (d < 0 ? -d : 0)) / n;
  }
  if (loss === 0) return 100;
  const rs = gain / loss;
  return +(100 - 100 / (1 + rs)).toFixed(2);
}
function MACD(closes) {
  const e12 = emaSeries(closes, 12), e26 = emaSeries(closes, 26);
  if (!e12.length || !e26.length) return { macd: null, signal: null, hist: null };
  const off = e12.length - e26.length;
  const macdLine = e26.map((v, i) => e12[i + off] - v);
  const sig = emaSeries(macdLine, 9);
  const macd = macdLine[macdLine.length - 1];
  const signal = sig.length ? sig[sig.length - 1] : null;
  return { macd: +macd.toFixed(4), signal: signal != null ? +signal.toFixed(4) : null, hist: signal != null ? +(macd - signal).toFixed(4) : null };
}
function ATR(c, n = 14) {
  if (c.length < n + 1) return null;
  const trs = [];
  for (let i = 1; i < c.length; i++) {
    trs.push(Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c)));
  }
  let atr = trs.slice(0, n).reduce((a, b) => a + b, 0) / n;
  for (let i = n; i < trs.length; i++) atr = (atr * (n - 1) + trs[i]) / n;
  return +atr.toFixed(4);
}
function ADX(c, n = 14) {
  if (c.length < 2 * n) return null;
  let plusDM = [], minusDM = [], trs = [];
  for (let i = 1; i < c.length; i++) {
    const up = c[i].h - c[i - 1].h, dn = c[i - 1].l - c[i].l;
    plusDM.push(up > dn && up > 0 ? up : 0);
    minusDM.push(dn > up && dn > 0 ? dn : 0);
    trs.push(Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c)));
  }
  const smooth = (arr) => { let s = arr.slice(0, n).reduce((a, b) => a + b, 0); const out = [s]; for (let i = n; i < arr.length; i++) { s = s - s / n + arr[i]; out.push(s); } return out; };
  const sTR = smooth(trs), sP = smooth(plusDM), sM = smooth(minusDM);
  const dx = sTR.map((tr, i) => {
    if (!tr) return 0;
    const pdi = 100 * sP[i] / tr, mdi = 100 * sM[i] / tr;
    return (pdi + mdi) === 0 ? 0 : 100 * Math.abs(pdi - mdi) / (pdi + mdi);
  });
  if (dx.length < n) return null;
  let adx = dx.slice(0, n).reduce((a, b) => a + b, 0) / n;
  for (let i = n; i < dx.length; i++) adx = (adx * (n - 1) + dx[i]) / n;
  return +adx.toFixed(2);
}
function Stochastic(c, n = 14) {
  if (c.length < n) return null;
  const w = c.slice(-n);
  const hi = Math.max(...w.map((x) => x.h)), lo = Math.min(...w.map((x) => x.l));
  if (hi === lo) return 50;
  return +(100 * (c[c.length - 1].c - lo) / (hi - lo)).toFixed(2);
}
function CCI(c, n = 20) {
  if (c.length < n) return null;
  const tp = c.map((x) => (x.h + x.l + x.c) / 3).slice(-n);
  const ma = tp.reduce((a, b) => a + b, 0) / n;
  const md = tp.reduce((a, b) => a + Math.abs(b - ma), 0) / n;
  if (!md) return 0;
  return +((tp[tp.length - 1] - ma) / (0.015 * md)).toFixed(2);
}
function MFI(c, n = 14) {
  if (c.length < n + 1) return null;
  let pos = 0, neg = 0;
  for (let i = c.length - n; i < c.length; i++) {
    const tp = (c[i].h + c[i].l + c[i].c) / 3, ptp = (c[i - 1].h + c[i - 1].l + c[i - 1].c) / 3;
    const flow = tp * (c[i].v || 0);
    if (tp > ptp) pos += flow; else neg += flow;
  }
  if (!neg) return 100;
  return +(100 - 100 / (1 + pos / neg)).toFixed(2);
}
function VWAP(c, n = 20) {
  const w = c.slice(-n);
  let pv = 0, vv = 0;
  w.forEach((x) => { const tp = (x.h + x.l + x.c) / 3; pv += tp * (x.v || 0); vv += (x.v || 0); });
  return vv ? +(pv / vv).toFixed(4) : null;
}
function OBV(c) {
  let obv = 0;
  for (let i = 1; i < c.length; i++) obv += c[i].c > c[i - 1].c ? (c[i].v || 0) : c[i].c < c[i - 1].c ? -(c[i].v || 0) : 0;
  return Math.round(obv);
}
function bollingerPctB(closes, n = 20) {
  if (closes.length < n) return null;
  const w = closes.slice(-n);
  const ma = w.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(w.reduce((a, b) => a + (b - ma) ** 2, 0) / n);
  const up = ma + 2 * sd, lo = ma - 2 * sd;
  if (up === lo) return 0.5;
  return +((closes[closes.length - 1] - lo) / (up - lo)).toFixed(3);
}

/* ------------------------- SERIES FACTS (for tags) -------------------------
   Everything below is derived from the SAME candles indicatorsFor already
   fetched — no extra Yahoo calls.

   These exist because the important tags are EVENTS, not states. "Golden Cross"
   means the 50-DMA actually crossed above the 200-DMA; it does not mean the 50 is
   merely above the 200. A stock three years into an uptrend would otherwise be
   tagged "Golden Cross" every single day, which is a lie dressed as a signal.
   Detecting the cross needs the series, so we compute it here and return the
   REAL number of bars since it happened.                                      */

/** Rolling SMA series (not just the latest value). */
function smaSeries(a, n) {
  if (a.length < n) return [];
  const out = new Array(a.length).fill(null);
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i];
    if (i >= n) sum -= a[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

/**
 * Bars since `fast` crossed `slow` in the given direction, or null if it never
 * did within the series. Bars, not days — a real, checkable count.
 */
function barsSinceCross(fast, slow, dir = "above") {
  for (let i = fast.length - 1; i > 0; i--) {
    const a = fast[i], b = slow[i], pa = fast[i - 1], pb = slow[i - 1];
    if (a == null || b == null || pa == null || pb == null) break;
    const crossed = dir === "above" ? pa <= pb && a > b : pa >= pb && a < b;
    if (crossed) return fast.length - 1 - i;
  }
  return null;
}

/** Swing pivots: a high with `k` lower highs either side (and the mirror for lows). */
function pivots(c, k = 5) {
  const highs = [], lows = [];
  for (let i = k; i < c.length - k; i++) {
    let isH = true, isL = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      if (c[j].h >= c[i].h) isH = false;
      if (c[j].l <= c[i].l) isL = false;
    }
    if (isH) highs.push({ i, v: c[i].h });
    if (isL) lows.push({ i, v: c[i].l });
  }
  return { highs, lows };
}

/**
 * Bull flag, defined strictly:
 *   1. an impulse leg of >= 8% within the prior 20 bars, then
 *   2. a consolidation of 3-15 bars whose range is at most 40% of the impulse,
 *   3. still holding in the upper half of that impulse (it has not given it back).
 * Returns null unless all three hold. No "close enough".
 */
function bullFlag(c) {
  if (c.length < 30) return null;
  const w = c.slice(-35);
  for (let cons = 3; cons <= 15; cons++) {
    const flag = w.slice(w.length - cons);
    const pole = w.slice(Math.max(0, w.length - cons - 20), w.length - cons);
    if (pole.length < 8) continue;
    const poleLow = Math.min(...pole.map((x) => x.l));
    const poleHigh = Math.max(...pole.map((x) => x.h));
    const poleMove = ((poleHigh - poleLow) / poleLow) * 100;
    if (poleMove < 8) continue;
    const flagHigh = Math.max(...flag.map((x) => x.h));
    const flagLow = Math.min(...flag.map((x) => x.l));
    const flagRange = flagHigh - flagLow;
    if (flagRange > (poleHigh - poleLow) * 0.4) continue;
    if (flagLow < poleLow + (poleHigh - poleLow) * 0.5) continue;
    return { consolidationBars: cons, poleMovePct: +poleMove.toFixed(1) };
  }
  return null;
}

async function indicatorsFor(symbol) {
  const c = await candlesFor(symbol, "1y", "1d");
  if (!c || c.length < 30) return null;
  const closes = c.map((x) => x.c);
  const last = c[c.length - 1], prev = c[c.length - 2] || last;
  const { macd, signal, hist } = MACD(closes);

  // Series facts — real events, from the candles we already have.
  const s50 = smaSeries(closes, 50);
  const s200 = smaSeries(closes, 200);
  const goldenCross = (s50.length && s200.length) ? barsSinceCross(s50, s200, "above") : null;
  const deathCross = (s50.length && s200.length) ? barsSinceCross(s50, s200, "below") : null;

  const { highs, lows } = pivots(c, 5);
  const hh = highs.length >= 2 ? highs[highs.length - 1].v > highs[highs.length - 2].v : null;
  const hl = lows.length >= 2 ? lows[lows.length - 1].v > lows[lows.length - 2].v : null;

  return {
    price: +last.c.toFixed(4),
    chg: prev.c ? +(((last.c - prev.c) / prev.c) * 100).toFixed(2) : 0,
    // `|| 0` was a fabricated fallback: it turned "we have no volume for this
    // instrument" into "zero shares traded", which is a claim, not an absence.
    // Indices genuinely have no volume. null means null.
    vol: last.v ?? null,
    avgVol: (() => {
      const vs = c.slice(-20).map((x) => x.v).filter((v) => v != null);
      return vs.length ? Math.round(vs.reduce((a, b) => a + b, 0) / vs.length) : null;
    })(),
    rsi: RSI(closes),
    sma50: SMA(closes, 50), sma200: SMA(closes, 200),
    ema20: EMA(closes, 20), ema50: EMA(closes, 50),
    macd, macdSignal: signal, macdHist: hist,
    atr: ATR(c), adx: ADX(c), cci: CCI(c), stoch: Stochastic(c), mfi: MFI(c),
    vwap: VWAP(c), obv: OBV(c), bbPctB: bollingerPctB(closes),
    high52: +Math.max(...c.map((x) => x.h)).toFixed(2),
    low52: +Math.min(...c.map((x) => x.l)).toFixed(2),
    // REAL support/resistance: recent swing low/high over the last ~60 sessions.
    support: +Math.min(...c.slice(-60).map((x) => x.l)).toFixed(2),
    resistance: +Math.max(...c.slice(-60).map((x) => x.h)).toFixed(2),

    /* Series facts. Null means "did not happen", never "we could not be bothered".
       goldenCross/deathCross are BARS SINCE the cross actually occurred. */
    goldenCross,
    deathCross,
    higherHigh: hh,
    higherLow: hl,
    bullFlag: bullFlag(c),
  };
}

/* ----------------------------- /api/intraday -----------------------------
   Real short-term momentum, computed from actual 5-minute candles.

   Trending previously ranked on the DAY change, which is not "trending" at all —
   a stock up 4% since 9:15 but flat for the last hour is not moving now. This
   returns what actually happened in the last 5 and 15 minutes, plus a volume
   surge measured against the session's own average 5-min volume.

   Everything here is derived from real candles. If a symbol has no intraday data
   (illiquid, market closed with no session, unsupported) it is simply absent from
   the response — the UI then shows nothing rather than a zero.                  */
async function intradayFor(sym) {
  const d = await j(`${YF}/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=5m`);
  const r = d?.chart?.result?.[0];
  const q = r?.indicators?.quote?.[0];
  if (!r || !q) return null;

  // Keep only complete candles (Yahoo pads the array with nulls).
  const rows = (r.timestamp || [])
    .map((t, i) => ({ t, c: q.close?.[i], v: q.volume?.[i] }))
    .filter((x) => x.c != null && !Number.isNaN(x.c));

  if (rows.length < 2) return null;

  const last = rows[rows.length - 1];
  const at = (barsBack) => rows[rows.length - 1 - barsBack];

  const pctFrom = (bar) => (bar && bar.c ? +(((last.c - bar.c) / bar.c) * 100).toFixed(2) : null);

  // 1 bar back = 5 minutes, 3 bars back = 15 minutes.
  const chg5m = rows.length >= 2 ? pctFrom(at(1)) : null;
  const chg15m = rows.length >= 4 ? pctFrom(at(3)) : null;

  // Volume surge: the latest 5-min bar against the average 5-min bar this session.
  const vols = rows.map((x) => x.v).filter((v) => v != null && v > 0);
  const avg5m = vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : null;
  const volSurge = avg5m && last.v != null ? +(last.v / avg5m).toFixed(2) : null;

  return {
    chg5m,
    chg15m,
    volSurge,               // 1.0 = normal, 3.0 = three times its usual 5-min volume
    lastBarAt: last.t * 1000,
    bars: rows.length,
  };
}

app.get("/api/intraday", async (req, res) => {
  // Same silent-truncation bug as /api/indicators: 60 < the 79-symbol Indian universe.
  const symbols = String(req.query.symbols || "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 200);
  if (!symbols.length) return res.status(400).json({ error: "symbols required" });
  try {
    const out = {};
    await mapLimit(symbols, 5, async (sym) => {
      try {
        // 60s cache: this is the one thing that genuinely needs to be fresh.
        const v = await memo(`intra:${sym}`, 60_000, () => intradayFor(sym));
        if (v) out[sym] = v;
      } catch { /* absent from the response rather than zeroed */ }
    });
    res.json(out);
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

app.get("/api/indicators", async (req, res) => {
  /* The cap used to be 60, applied with a SILENT .slice(). The Indian universe is 79
     symbols, so everything from position 61 on — RELIANCE among them — never received
     indicators at all, and its card read "Data currently unavailable" forever. The stock
     was fine; the request was quietly truncated.

     A cap is still sensible (it protects the upstream from a runaway query), but it must
     be big enough for a real market and it must SAY when it bites, rather than dropping
     symbols on the floor. */
  const asked = String(req.query.symbols || "").split(",").map((s) => s.trim()).filter(Boolean);
  const CAP = 200;
  const symbols = asked.slice(0, CAP);
  const truncated = asked.length > CAP ? asked.length - CAP : 0;
  if (!symbols.length) return res.status(400).json({ error: "symbols required" });
  try {
    const out = {};
    await mapLimit(symbols, 5, async (sym) => {
      try {
        const v = await memo(`ind:${sym}`, 300_000, () => indicatorsFor(sym));
        if (v) out[sym] = v;
      } catch { /* skip symbols with no history */ }
    });
    res.json({ indicators: out, ...(truncated ? { truncated } : {}) });
  } catch (e) { res.status(502).json({ error: String(e.message) }); }
});

/* -------------------------------- /api/ask -------------------------------- */
// Server-side Ask Matrix. Tries providers in order and FALLS THROUGH on failure,
// so a bad model name or rate-limit on one provider doesn't kill the request.
// Set any of: GROQ_API_KEY (free, recommended) / OPENROUTER_API_KEY / GEMINI_API_KEY / ANTHROPIC_API_KEY
// Tolerant env reader: trims whitespace and strips accidental surrounding quotes,
// and accepts a few common alternate names (a stray space or quotes in the Render
// dashboard is the usual reason a key "is set" but isn't seen).
function envKey(...names) {
  for (const n of names) {
    let v = process.env[n];
    if (typeof v === "string") {
      v = v.trim().replace(/^["']|["']$/g, "");
      if (v) return v;
    }
  }
  return "";
}

/* Build the ordered list of env-var names to try for a per-user credential:
   perUser("FYERS_APP_ID", "MAT1") -> ["FYERS_APP_ID_MAT1", "FYERS_APP_ID"].
   The userId is sanitized to the characters valid in an env-var name (letters, digits,
   underscore) so it matches exactly how the Render variable would be named. If there's no
   per-user variable set, envKey falls through to the global one — so a single-user server
   with just FYERS_APP_ID keeps working unchanged. */
function perUser(base, userId) {
  const safe = String(userId || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return safe ? [`${base}_${safe}`, base] : [base];
}
const GROQ_KEY = () => envKey("GROQ_API_KEY", "GROQ_KEY", "GROQ_APIKEY", "GROQ", "Groq", "groq", "groq_api_key");
const OPENROUTER_KEY = () => envKey("OPENROUTER_API_KEY", "OPENROUTER_KEY");
const GEMINI_KEY = () => envKey("GEMINI_API_KEY", "GOOGLE_API_KEY");
const ANTHROPIC_KEY = () => envKey("ANTHROPIC_API_KEY");

const GROQ_MODELS = () => [process.env.GROQ_MODEL, "llama-3.3-70b-versatile", "llama-3.1-8b-instant", "openai/gpt-oss-20b"].filter(Boolean);

async function callGroq(system, messages, max_tokens) {
  let lastErr = "";
  for (const model of GROQ_MODELS()) {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${GROQ_KEY()}` },
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
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${OPENROUTER_KEY()}` },
    body: JSON.stringify({ model: process.env.OPENROUTER_MODEL || "meta-llama/llama-3.3-70b-instruct:free", max_tokens, messages: [{ role: "system", content: system }, ...messages] }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error?.message || `openrouter ${r.status}`);
  return (data.choices?.[0]?.message?.content || "").trim();
}
async function callGemini(system, messages, max_tokens) {
  const model = process.env.GEMINI_MODEL || "gemini-2.0-flash";
  const contents = messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: typeof m.content === "string" ? m.content : (m.content || []).map((c) => c.text || "").join("\n") }] }));
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY()}`, {
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
    headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_KEY(), "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens, system, messages }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error?.message || `anthropic ${r.status}`);
  return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
}

// Which providers are configured (also used by /api/health)
const providers = () => [
  GROQ_KEY() && { name: "groq", fn: callGroq },
  OPENROUTER_KEY() && { name: "openrouter", fn: callOpenRouter },
  GEMINI_KEY() && { name: "gemini", fn: callGemini },
  ANTHROPIC_KEY() && { name: "anthropic", fn: callAnthropic },
].filter(Boolean);

app.get("/api/health", (req, res) => {
  const engines = providers().map((p) => p.name);
  const groq = GROQ_KEY();
  res.json({
    ok: true,
    engines,
    db: db.USING_PG ? "postgres" : "flat-file",
    // Debug helpers (no secret values are ever returned):
    groqKeySeen: !!groq,
    groqKeyLength: groq ? groq.length : 0,
    groqKeyPrefix: groq ? groq.slice(0, 4) + "..." : null,
    envVarsContainingKEY: Object.keys(process.env).filter((k) => /KEY|TOKEN|GROQ/i.test(k)).sort(),
    hint: engines.length ? "LLM configured." : "No LLM key visible to the process. Check the variable NAME on the correct Render service, then redeploy.",
  });
});

app.post("/api/ask", async (req, res) => {
  const { messages = [], context = "", system: sysOverride, max_tokens = 1000 } = req.body || {};
  const DEFAULT = `You are Matrix — the world's sharpest stock-market research assistant, fluent in fundamental, technical and macro analysis. Be crisp and structured; give bull case, bear case and key levels rather than a bare command. End with a one-line reminder that this is educational research, not financial advice.`;
  const system = sysOverride ? sysOverride : (DEFAULT + (context ? "\n\nCONTEXT:\n" + context : ""));
  const chain = providers();
  if (!chain.length) return res.status(500).json({ error: "No LLM key set. Add GROQ_API_KEY (free) in your Render environment." });
  const errors = [];
  /* Each provider gets 8 seconds, no more. The chain used to await each one with
     no timeout, so a single hanging provider stalled every fallback behind it and
     the request just sat there. Groq answers in well under a second; if something
     takes longer than 8s it is broken, not thinking. */
  const withTimeout = (promise, ms, label) => Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label}: timed out after ${ms}ms`)), ms)),
  ]);

  for (const p of chain) {
    const t0 = Date.now();
    try {
      const text = await withTimeout(p.fn(system, messages, max_tokens), 8000, p.name);
      /* NEVER leak the provider name to the client. The user talks to Neo; which
         vendor answers is an internal detail (and it changes on fallback). */
      if (text) return res.json({ text, engine: "Neo", ms: Date.now() - t0 });
      errors.push(`${p.name}: empty response`);
    } catch (e) {
      errors.push(`${p.name}: ${e.message}`);
      console.error(`[ask] ${p.name} failed after ${Date.now() - t0}ms:`, e.message);
    }
  }
  res.status(502).json({ error: errors.join(" | ") });
});


/* ═══════════════════════════ BROKER INTEGRATION ═══════════════════════════
   Real-time market data (and, if explicitly enabled, real orders) from Zerodha
   Kite Connect and FYERS.

   WHY THE SECRET LIVES HERE AND NOT IN THE BROWSER
   ------------------------------------------------
   The OAuth flow needs your api_secret to exchange a request token for an access
   token. Anything shipped to the browser is readable by anyone who opens devtools,
   so the secret NEVER leaves this server. The browser only ever holds the resulting
   short-lived access token, and sends it back as a header.

   Set on Render (Environment):
     KITE_API_KEY, KITE_API_SECRET          <- Zerodha Kite Connect
     FYERS_APP_ID, FYERS_SECRET_ID          <- FYERS API v3
     BROKER_TRADING_ENABLED=false           <- must be "true" to allow REAL orders

   BROKER_TRADING_ENABLED defaults to FALSE. Connecting a broker gives you live
   PRICES; it does not arm real-money execution. That is a separate, deliberate
   switch, because the difference between paper and real is somebody's savings.

   Tokens are NOT persisted server-side. They expire daily (both brokers force a
   re-login each morning — that is their rule, not something we can engineer away).
------------------------------------------------------------------------- */

const TRADING_ENABLED = String(process.env.BROKER_TRADING_ENABLED || "").toLowerCase() === "true";

/* THE BROKER TOKEN NEVER GOES TO THE BROWSER.
   It was being handed to the client, which meant a token capable of placing REAL
   TRADES was sitting in the user's browser storage, readable by any XSS. Now the
   server keeps it and the client only ever holds an opaque session id that is
   useless anywhere else.

   Bound to a userId, so one user's session id cannot be replayed against another's
   broker account. In memory: broker tokens die daily anyway, and a restart forcing
   a re-login is the correct failure mode for something this sensitive. */
const brokerSessions = new Map();           // sessionId -> { userId, broker, accessToken, at }
const SESSION_TTL = 12 * 60 * 60 * 1000;    // 12h; brokers expire theirs daily regardless

function putBrokerSession(userId, broker, accessToken, refreshToken = null) {
  const id = crypto.randomBytes(32).toString("hex");
  brokerSessions.set(id, { userId: String(userId), broker, accessToken, refreshToken, at: Date.now() });
  return id;
}

/** Resolve a session id to a live token, checking it belongs to this user. */
function getBrokerSession(req) {
  const id = req.get("X-Broker-Session");
  const userId = req.get("X-User-Id");
  if (!id || !userId) return null;
  const s = brokerSessions.get(id);
  if (!s) return null;
  if (Date.now() - s.at > SESSION_TTL) { brokerSessions.delete(id); return null; }
  if (s.userId !== String(userId)) return null;    // not yours
  return s;
}

// Sweep expired sessions so the map cannot grow without bound.
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of brokerSessions) if (now - s.at > SESSION_TTL) brokerSessions.delete(id);
}, 30 * 60 * 1000).unref?.();

const BROKERS = {
  zerodha: {
    name: "Zerodha",
    // Per-user first (KITE_API_KEY_<userId>), then the global KITE_API_KEY fallback.
    key: (userId) => envKey(...perUser("KITE_API_KEY", userId)),
    secret: (userId) => envKey(...perUser("KITE_API_SECRET", userId)),
    loginUrl: (key) => `https://kite.zerodha.com/connect/login?v=3&api_key=${key}`,
  },
  fyers: {
    name: "FYERS",
    // Per-user first (FYERS_APP_ID_<userId>), then the global FYERS_APP_ID fallback. This is
    // what lets two users connect with their OWN FYERS apps: set FYERS_APP_ID_MAT1 etc.
    key: (userId) => envKey(...perUser("FYERS_APP_ID", userId)),
    secret: (userId) => envKey(...perUser("FYERS_SECRET_ID", userId)),
    loginUrl: (key, redirect) =>
      `https://api-t1.fyers.in/api/v3/generate-authcode?client_id=${encodeURIComponent(key)}&redirect_uri=${encodeURIComponent(redirect || "")}&response_type=code&state=matrix`,
  },

  /* DELTA EXCHANGE — no OAuth.
     Delta authenticates every request with an HMAC signature over
     (method + timestamp + path + query + body), using an API key/secret pair. There is
     no login redirect and no user token: the KEYS ARE THE CREDENTIAL.

     That has a consequence worth stating plainly: the keys live in this server's env, so
     Delta trades on THE SERVER'S account, not on a per-user account the way the OAuth
     brokers do. For a single-operator app that is exactly right. If this ever became
     multi-user, Delta would need per-user keys and this design would be wrong. */
  delta: {
    name: "Delta Exchange",
    noOAuth: true,
    key: () => envKey("DELTA_API_KEY"),
    secret: () => envKey("DELTA_API_SECRET"),
    loginUrl: () => null,
  },

  /* CHARLES SCHWAB — OAuth2, but with a much shorter fuse than the Indian brokers.
     The access token lives ~30 MINUTES (not a day), so a session that only stored the
     access token would die mid-afternoon. We keep the refresh token (~7 days) and mint
     a new access token when the old one expires. */
  schwab: {
    name: "Charles Schwab",
    key: () => envKey("SCHWAB_APP_KEY"),
    secret: () => envKey("SCHWAB_APP_SECRET"),
    loginUrl: (key, redirect) =>
      `https://api.schwabapi.com/v1/oauth/authorize?client_id=${encodeURIComponent(key)}&redirect_uri=${encodeURIComponent(redirect || "")}&response_type=code`,
  },
};

/* ── Delta request signing ───────────────────────────────────────────────────────
   signature = HMAC_SHA256(secret, method + timestamp + path + query + body)
   Sent as: api-key, timestamp, signature. The secret never leaves this process. */
const DELTA_BASE = "https://api.india.delta.exchange";

function deltaHeaders(method, path, query = "", body = "") {
  const key = envKey("DELTA_API_KEY");
  const secret = envKey("DELTA_API_SECRET");
  if (!key || !secret) throw new Error("Delta keys not set on the server");

  const ts = Math.floor(Date.now() / 1000).toString();
  const payload = method + ts + path + query + body;
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("hex");

  return {
    "api-key": key,
    timestamp: ts,
    signature,
    "Content-Type": "application/json",
    "User-Agent": "matrix",
  };
}

async function deltaCall(method, path, { query = "", body = null, signed = true } = {}) {
  const bodyStr = body ? JSON.stringify(body) : "";
  const headers = signed
    ? deltaHeaders(method, path, query, bodyStr)
    : { "Content-Type": "application/json", "User-Agent": "matrix" };

  const r = await fetch(DELTA_BASE + path + query, {
    method,
    headers,
    ...(bodyStr ? { body: bodyStr } : {}),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.success === false) {
    throw new Error((d.error && (d.error.code || d.error)) || d.message || `delta ${r.status}`);
  }
  return d;
}

/* ── Schwab token refresh ────────────────────────────────────────────────────────
   The access token expires in ~30 minutes. Rather than letting the session die (and
   showing a LIVE badge over dead data), we refresh it on demand. If the refresh token
   is also dead — they last ~7 days — we surface that honestly and the user re-links. */
async function schwabToken(sess) {
  if (sess.expiresAt && Date.now() < sess.expiresAt - 60_000) return sess.accessToken;
  if (!sess.refreshToken) throw new Error("Schwab session expired — reconnect");

  const key = envKey("SCHWAB_APP_KEY"), secret = envKey("SCHWAB_APP_SECRET");
  const basic = Buffer.from(`${key}:${secret}`).toString("base64");

  const r = await fetch("https://api.schwabapi.com/v1/oauth/token", {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: sess.refreshToken }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error(d.error_description || d.error || "Schwab refresh failed");

  sess.accessToken = d.access_token;
  if (d.refresh_token) sess.refreshToken = d.refresh_token;
  sess.expiresAt = Date.now() + (Number(d.expires_in) || 1800) * 1000;
  return sess.accessToken;
}

/** Which brokers are actually configured on this server. */
app.get("/api/broker/status", (req, res) => {
  // Report configuration for THIS user (per-user creds if set, else the global fallback).
  const userId = req.query.userId || req.get("X-User-Id");
  const out = {};
  Object.entries(BROKERS).forEach(([id, b]) => {
    out[id] = { name: b.name, configured: Boolean(b.key(userId) && b.secret(userId)) };
  });
  res.json({ brokers: out, tradingEnabled: TRADING_ENABLED });
});

/** Step 1 of OAuth: where the user logs in. */
app.get("/api/broker/login-url", (req, res) => {
  const id = String(req.query.broker || "");
  const b = BROKERS[id];
  if (!b) return res.status(400).json({ error: "unknown broker" });
  const userId = req.query.userId || req.get("X-User-Id");   // whose FYERS app to use
  const key = b.key(userId);
  if (!key) return res.status(400).json({ error: `${b.name} is not configured on the server (missing API key).` });
  res.json({ url: b.loginUrl(key, req.query.redirect) });
});

/* Step 2: exchange the short-lived request/auth code for an access token.
   This is the ONLY place the api_secret is used, and it never leaves the server. */
app.post("/api/broker/session", async (req, res) => {
  const { broker, requestToken, userId } = req.body || {};
  const b = BROKERS[broker];
  if (!b) return res.status(400).json({ error: "unknown broker" });
  if (!userId) return res.status(400).json({ error: "userId required" });
  // Delta has no OAuth redirect, so it has no requestToken. Everyone else must have one.
  if (!b.noOAuth && !requestToken) return res.status(400).json({ error: "requestToken required" });

  const key = b.key(userId), secret = b.secret(userId);
  if (!key || !secret) return res.status(400).json({ error: `${b.name} is not configured on the server.` });

  try {
    if (broker === "zerodha") {
      // Kite: checksum = SHA256(api_key + request_token + api_secret)
      const checksum = crypto.createHash("sha256").update(key + requestToken + secret).digest("hex");
      const r = await fetch("https://api.kite.trade/session/token", {
        method: "POST",
        headers: { "X-Kite-Version": "3", "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ api_key: key, request_token: requestToken, checksum }),
      });
      const d = await r.json();
      if (!r.ok || d.status === "error") throw new Error(d.message || `kite ${r.status}`);
      // Opaque id out; the access token stays in this process.
      const sid = putBrokerSession(userId, broker, d.data.access_token);
      return res.json({ sessionId: sid, user: d.data.user_name || null, broker });
    }

    if (broker === "fyers") {
      // FYERS: appIdHash = SHA256(app_id:secret_id)
      const appIdHash = crypto.createHash("sha256").update(`${key}:${secret}`).digest("hex");
      const r = await fetch("https://api-t1.fyers.in/api/v3/validate-authcode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grant_type: "authorization_code", appIdHash, code: requestToken }),
      });
      const d = await r.json();
      if (!r.ok || d.s === "error") throw new Error(d.message || `fyers ${r.status}`);
      const sid = putBrokerSession(userId, broker, d.access_token, d.refresh_token || null);
      return res.json({ sessionId: sid, user: null, broker });
    }

    if (broker === "delta") {
      /* No token to exchange — the keys ARE the credential. So "connecting" has to mean
         something real: we make a SIGNED call and see if Delta accepts it. Otherwise we
         would hand back a session id for keys that don't work, and the failure would only
         surface later, at the worst possible moment: on an order. */
      const d = await deltaCall("GET", "/v2/wallet/balances");
      const bal = (d.result || [])[0] || null;
      const sid = putBrokerSession(userId, broker, "server-signed");   // no per-user token exists
      return res.json({
        sessionId: sid,
        broker,
        user: bal && bal.user_id ? String(bal.user_id) : null,
      });
    }

    if (broker === "schwab") {
      // OAuth2 authorization-code exchange. Basic auth with the app key/secret.
      const basic = Buffer.from(`${key}:${secret}`).toString("base64");
      const redirect = String(req.body.redirect || "");
      const r = await fetch("https://api.schwabapi.com/v1/oauth/token", {
        method: "POST",
        headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: requestToken,
          redirect_uri: redirect,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.access_token) throw new Error(d.error_description || d.error || `schwab ${r.status}`);

      const sid = putBrokerSession(userId, broker, d.access_token);
      // Keep the refresh token and expiry ON THE SESSION — a 30-minute access token alone
      // would leave the app showing a LIVE badge over a dead connection by mid-afternoon.
      const sess = brokerSessions.get(sid);
      if (sess) {
        sess.refreshToken = d.refresh_token || null;
        sess.expiresAt = Date.now() + (Number(d.expires_in) || 1800) * 1000;
      }
      return res.json({ sessionId: sid, user: null, broker });
    }

    res.status(400).json({ error: "unsupported broker" });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

/** Auth header for a broker call. */
function brokerAuth(broker, token, userId) {
  // The app key in this header MUST be the same app that issued the token — so for a
  // per-user setup we look up THIS user's app key (falling back to the global one).
  if (broker === "zerodha") {
    return { "X-Kite-Version": "3", Authorization: `token ${BROKERS.zerodha.key(userId)}:${token}` };
  }
  if (broker === "fyers") {
    return { Authorization: `${BROKERS.fyers.key(userId)}:${token}` };
  }
  return {};
}

/* REAL-TIME QUOTES. This is the point of the whole exercise: Yahoo is ~15 minutes
   delayed on NSE; a broker feed is live. Symbols arrive already in broker format
   (see domain/brokerSymbols.js) — the server does not guess at symbol names. */
app.get("/api/broker/quotes", async (req, res) => {
  const sess = getBrokerSession(req);
  /* 401 = the session is genuinely gone (expired, or wiped by a server restart — sessions
     live in memory on the free tier). The client should reconnect. This is DISTINCT from a
     quote-fetch hiccup below, which is a 502 and must NOT drop the session. */
  if (!sess) return res.status(401).json({ error: "no broker session", code: "SESSION_GONE" });
  const broker = sess.broker;
  const token = sess.accessToken;
  const symbols = String(req.query.symbols || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!BROKERS[broker]) return res.status(400).json({ error: "unknown broker" });
  if (!symbols.length) return res.status(400).json({ error: "symbols required" });

  try {
    const out = {};

    if (broker === "zerodha") {
      const qs = symbols.map((s) => `i=${encodeURIComponent(s)}`).join("&");
      const r = await fetch(`https://api.kite.trade/quote?${qs}`, { headers: brokerAuth(broker, token, sess.userId) });
      const d = await r.json();
      if (!r.ok || d.status === "error") throw new Error(d.message || `kite ${r.status}`);
      Object.entries(d.data || {}).forEach(([sym, q]) => {
        const prev = q.ohlc && q.ohlc.close;
        out[sym] = {
          price: q.last_price ?? null,
          chg: prev ? +(((q.last_price - prev) / prev) * 100).toFixed(2) : null,
          vol: q.volume ?? null,
          oi: q.oi ?? null,                          // REAL open interest — Yahoo has none
          bid: q.depth?.buy?.[0]?.price ?? null,
          ask: q.depth?.sell?.[0]?.price ?? null,
        };
      });
    }

    if (broker === "fyers") {
      const r = await fetch(`https://api-t1.fyers.in/data/quotes?symbols=${encodeURIComponent(symbols.join(","))}`, {
        headers: brokerAuth(broker, token, sess.userId),
      });
      const d = await r.json();
      if (!r.ok || d.s === "error") throw new Error(d.message || `fyers ${r.status}`);
      (d.d || []).forEach((row) => {
        const v = row.v || {};
        out[row.n] = {
          price: v.lp ?? null,
          chg: v.chp ?? null,
          vol: v.volume ?? null,
          oi: v.oi ?? null,
          bid: v.bid ?? null,
          ask: v.ask ?? null,
        };
      });
    }

    if (broker === "delta") {
      /* Delta's tickers endpoint is PUBLIC — no signature needed for market data. One
         call returns every contract; we pick out the ones asked for rather than making
         N round trips. */
      const d = await deltaCall("GET", "/v2/tickers", { signed: false });
      const want = new Set(symbols);
      (d.result || []).forEach((t) => {
        if (!want.has(t.symbol)) return;
        const price = t.mark_price != null ? Number(t.mark_price)
                    : t.close != null ? Number(t.close)
                    : t.spot_price != null ? Number(t.spot_price) : null;
        const open = t.open != null ? Number(t.open) : null;
        out[t.symbol] = {
          price,
          // Delta gives open/close, not a percent. Compute it only when BOTH are real.
          chg: (price != null && open) ? +(((price - open) / open) * 100).toFixed(2) : null,
          vol: t.volume != null ? Number(t.volume) : null,
          oi: t.open_interest != null ? Number(t.open_interest) : null,   // real OI
          bid: t.quotes?.best_bid != null ? Number(t.quotes.best_bid) : null,
          ask: t.quotes?.best_ask != null ? Number(t.quotes.best_ask) : null,
        };
      });
    }

    if (broker === "schwab") {
      const tk = await schwabToken(sess);                       // refreshes if the 30-min token died
      const r = await fetch(
        `https://api.schwabapi.com/marketdata/v1/quotes?symbols=${encodeURIComponent(symbols.join(","))}`,
        { headers: { Authorization: `Bearer ${tk}`, Accept: "application/json" } }
      );
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.message || d.error || `schwab ${r.status}`);

      Object.entries(d || {}).forEach(([sym, row]) => {
        const q = row && row.quote;
        if (!q) return;
        out[sym] = {
          price: q.lastPrice ?? null,
          chg: q.netPercentChange ?? q.netPercentChangeInDouble ?? null,
          vol: q.totalVolume ?? null,
          oi: null,                                             // equities have no OI. null, not 0.
          bid: q.bidPrice ?? null,
          ask: q.askPrice ?? null,
        };
      });
    }

    res.json({ quotes: out, broker, live: true, at: Date.now() });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

/* REAL ORDERS. Gated twice: the server must have BROKER_TRADING_ENABLED=true AND
   the client must send X-Confirm-Live: yes. Two locks, because the failure mode
   here is real money moving without the user meaning it. */
app.post("/api/broker/order", async (req, res) => {
  if (!TRADING_ENABLED) {
    return res.status(403).json({
      error: "Live trading is disabled on this server. Set BROKER_TRADING_ENABLED=true to allow real orders.",
    });
  }
  if (req.get("X-Confirm-Live") !== "yes") {
    return res.status(400).json({ error: "Live order not explicitly confirmed by the client." });
  }

  const sess = getBrokerSession(req);
  if (!sess) return res.status(401).json({ error: "no broker session" });
  const broker = sess.broker;
  const token = sess.accessToken;
  const { symbol, side, qty, orderType = "MARKET", product = "CNC" } = req.body || {};
  // A LIMIT order needs a price; the client may send it as `limitPrice` or `price`.
  const price = req.body?.limitPrice != null ? req.body.limitPrice : req.body?.price;
  if (!BROKERS[broker]) return res.status(400).json({ error: "unknown broker" });
  if (!symbol || !side || !qty) return res.status(400).json({ error: "symbol, side and qty are required" });

  try {
    if (broker === "zerodha") {
      const [exchange, tradingsymbol] = String(symbol).split(":");
      const body = new URLSearchParams({
        exchange, tradingsymbol,
        transaction_type: side, quantity: String(qty),
        order_type: orderType, product,
        validity: "DAY",
        ...(orderType === "LIMIT" && price ? { price: String(price) } : {}),
      });
      const r = await fetch("https://api.kite.trade/orders/regular", {
        method: "POST", headers: { ...brokerAuth(broker, token, sess.userId), "Content-Type": "application/x-www-form-urlencoded" }, body,
      });
      const d = await r.json();
      if (!r.ok || d.status === "error") throw new Error(d.message || `kite ${r.status}`);
      return res.json({ orderId: d.data.order_id, status: "PENDING", broker });
    }

    if (broker === "fyers") {
      const r = await fetch("https://api-t1.fyers.in/api/v3/orders/sync", {
        method: "POST",
        headers: { ...brokerAuth(broker, token, sess.userId), "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol, qty: Number(qty),
          type: orderType === "LIMIT" ? 1 : 2,           // 1 = limit, 2 = market
          side: side === "BUY" ? 1 : -1,
          productType: product === "CNC" ? "CNC" : "INTRADAY",
          limitPrice: orderType === "LIMIT" ? Number(price) : 0,
          stopPrice: 0, validity: "DAY", disclosedQty: 0, offlineOrder: false,
        }),
      });
      const d = await r.json();
      if (!r.ok || d.s === "error") throw new Error(d.message || `fyers ${r.status}`);
      return res.json({ orderId: d.id, status: "PENDING", broker });
    }

    if (broker === "delta") {
      /* Delta orders are signed like everything else. product_id is REQUIRED — the API
         does not take a bare symbol — so we look the product up first and fail if we
         can't find it, rather than posting an order against a guessed id. */
      const prods = await deltaCall("GET", "/v2/products", { signed: false });
      const prod = (prods.result || []).find((p) => p.symbol === symbol);
      if (!prod) throw new Error(`Delta does not list ${symbol}`);

      const d = await deltaCall("POST", "/v2/orders", {
        body: {
          product_id: prod.id,
          size: Number(qty),
          side: String(side).toLowerCase() === "buy" ? "buy" : "sell",
          order_type: "market_order",
        },
      });
      return res.json({ ok: true, broker, orderId: d.result?.id ?? null, raw: d.result ?? null });
    }

    if (broker === "schwab") {
      const tk = await schwabToken(sess);

      // Schwab orders are placed against an ACCOUNT HASH, not the account number.
      const ar = await fetch("https://api.schwabapi.com/trader/v1/accounts/accountNumbers", {
        headers: { Authorization: `Bearer ${tk}`, Accept: "application/json" },
      });
      const accs = await ar.json().catch(() => []);
      const hash = Array.isArray(accs) && accs[0] && accs[0].hashValue;
      if (!hash) throw new Error("Could not resolve a Schwab account");

      const r = await fetch(`https://api.schwabapi.com/trader/v1/accounts/${hash}/orders`, {
        method: "POST",
        headers: { Authorization: `Bearer ${tk}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          orderType: "MARKET",
          session: "NORMAL",
          duration: "DAY",
          orderStrategyType: "SINGLE",
          orderLegCollection: [{
            instruction: String(side).toUpperCase() === "BUY" ? "BUY" : "SELL",
            quantity: Number(qty),
            instrument: { symbol, assetType: "EQUITY" },
          }],
        }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.message || e.error || `schwab ${r.status}`);
      }
      // Schwab returns the new order id in the Location header, not the body.
      const loc = r.headers.get("location") || "";
      return res.json({ ok: true, broker, orderId: loc.split("/").pop() || null });
    }

    res.status(400).json({ error: "unsupported broker" });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});


/* THE USER'S REAL PORTFOLIO, pulled from the broker.
   Read-only. This is what they actually own — not our paper positions. The two are
   never mixed: Real mode shows this, Virtual mode shows the paper book. Merging them
   would produce a P&L that is true of no account that exists. */


/* ─────────────────────── OPTION CHAIN — from the broker ───────────────────────
   THE SYMBOL COMES FROM THE BROKER. WE NEVER BUILD ONE.

   Constructing "NSE:NIFTY26JUL24050CE" from parts means guessing the expiry calendar
   (NSE has changed its expiry day), the weekly-vs-monthly encoding, the strike interval,
   and which strikes exist. Any one wrong and the order does not fail politely — it BUYS
   A DIFFERENT CONTRACT. So we ask what exists, and pick from that. If we can't load the
   chain, the strategy does not trade. It does not guess.                              */

const optCache = new Map();
const optMemo = async (k, ms, fn) => {
  const hit = optCache.get(k);
  if (hit && Date.now() - hit.at < ms) return hit.v;
  const v = await fn();
  optCache.set(k, { at: Date.now(), v });
  return v;
};

app.get("/api/broker/optionchain", async (req, res) => {
  const sess = getBrokerSession(req);
  if (!sess) return res.status(401).json({ error: "no broker session" });
  const { broker, accessToken: token } = sess;
  const underlying = String(req.query.underlying || "NIFTY").toUpperCase();

  try {
    if (broker === "fyers") {
      const idx = { NIFTY: "NSE:NIFTY50-INDEX", NIFTY50: "NSE:NIFTY50-INDEX", BANKNIFTY: "NSE:NIFTYBANK-INDEX", FINNIFTY: "NSE:FINNIFTY-INDEX" };
      const sym = idx[underlying] || `NSE:${underlying}-EQ`;

      const data = await optMemo(`oc:${sym}`, 60_000, async () => {
        const u = `https://api-t1.fyers.in/data/options-chain-v3?symbol=${encodeURIComponent(sym)}&strikecount=20`;
        const r = await fetch(u, { headers: brokerAuth(broker, token, sess.userId) });
        return r.json();
      });

      const d = data && (data.data || data);
      const rows = (d && (d.optionsChain || d.options_chain)) || [];
      if (!Array.isArray(rows) || !rows.length) {
        return res.status(502).json({ error: "broker returned no option chain", raw: data && data.message });
      }

      const contracts = rows
        .map((r) => ({
          symbol: r.symbol || r.tradingsymbol || null,
          strike: r.strike_price != null ? Number(r.strike_price) : null,
          type: r.option_type || r.optionType || null,
          expiry: r.expiry || r.expiryDate || null,
          lot: r.lot_size != null ? Number(r.lot_size) : (r.minLot != null ? Number(r.minLot) : null),
          ltp: r.ltp != null ? Number(r.ltp) : null,
        }))
        .filter((r) => r.symbol && r.strike != null && (r.type === "CE" || r.type === "PE"));

      if (!contracts.length) {
        return res.status(502).json({ error: "option chain shape not recognised — refusing to guess symbols" });
      }

      return res.json({
        broker, underlying,
        spot: d.spot != null ? Number(d.spot) : null,
        expiries: [...new Set(contracts.map((c) => c.expiry).filter(Boolean))].sort(),
        contracts,
        lot: contracts.find((c) => c.lot)?.lot ?? null,
      });
    }

    if (broker === "zerodha") {
      const csv = await optMemo("kite:nfo", 6 * 3600_000, async () => {
        const r = await fetch("https://api.kite.trade/instruments/NFO", { headers: brokerAuth(broker, token, sess.userId) });
        return r.text();
      });

      const lines = csv.split("\n");
      const head = lines[0].split(",").map((x) => x.trim());
      const col = (n) => head.indexOf(n);
      const iTs = col("tradingsymbol"), iName = col("name"), iExp = col("expiry"),
            iStrike = col("strike"), iType = col("instrument_type"), iLot = col("lot_size");
      if (iTs < 0 || iStrike < 0 || iType < 0) {
        return res.status(502).json({ error: "instrument dump shape not recognised — refusing to guess symbols" });
      }

      const contracts = [];
      for (let i = 1; i < lines.length; i++) {
        const p = lines[i].split(",");
        if (p[iName] !== underlying) continue;
        const t = p[iType];
        if (t !== "CE" && t !== "PE") continue;
        contracts.push({
          symbol: `NFO:${p[iTs]}`,
          strike: Number(p[iStrike]),
          type: t,
          expiry: p[iExp],
          lot: iLot >= 0 ? Number(p[iLot]) : null,
          ltp: null,
        });
      }
      if (!contracts.length) return res.status(404).json({ error: `no option contracts found for ${underlying}` });

      return res.json({
        broker, underlying, spot: null,
        expiries: [...new Set(contracts.map((c) => c.expiry).filter(Boolean))].sort(),
        contracts,
        lot: contracts.find((c) => c.lot)?.lot ?? null,
      });
    }

    return res.status(400).json({ error: `option chain not supported for ${broker}` });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

app.get("/api/broker/portfolio", async (req, res) => {
  const sess = getBrokerSession(req);
  if (!sess) return res.status(401).json({ error: "no broker session" });
  const { broker, accessToken: token } = sess;

  try {
    if (broker === "zerodha") {
      const [hRes, mRes] = await Promise.all([
        fetch("https://api.kite.trade/portfolio/holdings", { headers: brokerAuth(broker, token, sess.userId) }),
        fetch("https://api.kite.trade/user/margins", { headers: brokerAuth(broker, token, sess.userId) }),
      ]);
      const h = await hRes.json();
      const m = await mRes.json();
      if (h.status === "error") throw new Error(h.message);

      const holdings = (h.data || []).map((p) => ({
        sym: p.tradingsymbol,
        qty: p.quantity ?? 0,
        avg: p.average_price ?? null,
        ltp: p.last_price ?? null,
        pnl: p.pnl ?? null,
        value: p.last_price != null ? p.last_price * (p.quantity ?? 0) : null,
      }));
      const cash = m.data && m.data.equity && m.data.equity.available
        ? m.data.equity.available.live_balance ?? null
        : null;
      return res.json({ broker, holdings, cash, currency: "INR" });
    }

    if (broker === "fyers") {
      /* FYERS splits what you own across TWO endpoints, and BOTH matter:
           /holdings  -> stock that has settled into your demat (T+1 and older)
           /positions -> today's trades, incl. delivery buys not yet settled
         Reading only /holdings meant a freshly-bought delivery stock (still sitting in
         the Positions tab in the FYERS app) showed as "No holdings" here — even though
         it is very much yours. We now fetch both and merge them. */
      const [hRes, pRes, fRes] = await Promise.all([
        fetch("https://api-t1.fyers.in/api/v3/holdings", { headers: brokerAuth(broker, token, sess.userId) }),
        fetch("https://api-t1.fyers.in/api/v3/positions", { headers: brokerAuth(broker, token, sess.userId) }),
        fetch("https://api-t1.fyers.in/api/v3/funds", { headers: brokerAuth(broker, token, sess.userId) }),
      ]);
      const h = await hRes.json();
      const p = await pRes.json();
      const f = await fRes.json();
      if (h.s === "error" && p.s === "error") throw new Error(h.message || p.message || "fyers portfolio failed");

      const clean = (sym) => String(sym || "").replace(/^NSE:/, "").replace(/-EQ$/, "");

      const settled = (h.holdings || []).map((x) => ({
        sym: clean(x.symbol),
        qty: x.quantity ?? 0,
        avg: x.costPrice ?? null,
        ltp: x.ltp ?? null,
        pnl: x.pl ?? null,
        value: x.marketVal ?? null,
        source: "holdings",
      }));

      /* Positions with a non-zero net quantity are open. netQty > 0 is a long you hold;
         we skip flat (0) rows, which are closed round-trips FYERS still lists. */
      const open = (p.netPositions || [])
        .filter((x) => Number(x.netQty ?? x.qty ?? 0) !== 0)
        .map((x) => ({
          sym: clean(x.symbol),
          qty: Number(x.netQty ?? x.qty ?? 0),
          avg: x.netAvg ?? x.avgPrice ?? x.buyAvg ?? null,
          ltp: x.ltp ?? null,
          pnl: x.pl ?? x.realized_profit ?? null,
          value: (x.ltp != null && x.netQty != null) ? +(x.ltp * x.netQty).toFixed(2) : null,
          source: "positions",
        }));

      /* Merge: if the same symbol appears in both (a partially-settled holding), keep the
         settled holding row and don't double-count the position. */
      const bySym = new Map();
      settled.forEach((x) => bySym.set(x.sym, x));
      open.forEach((x) => { if (!bySym.has(x.sym)) bySym.set(x.sym, x); });
      const holdings = [...bySym.values()];

      // fund_limit is a list of labelled buckets; the available cash is the one we want.
      const bucket = (f.fund_limit || []).find((x) => /available/i.test(x.title || ""));
      const cash = bucket ? bucket.equityAmount ?? null : null;
      return res.json({ broker, holdings, cash, currency: "INR" });
    }

    if (broker === "delta") {
      // Real balances + real open positions. Signed calls; keys never leave this process.
      const [w, p] = await Promise.all([
        deltaCall("GET", "/v2/wallet/balances"),
        deltaCall("GET", "/v2/positions/margined"),
      ]);

      const cash = (w.result || []).reduce((a, b) => a + (Number(b.available_balance) || 0), 0);

      const holdings = (p.result || [])
        .filter((x) => Number(x.size) !== 0)
        .map((x) => ({
          sym: x.product_symbol || (x.product && x.product.symbol) || null,
          qty: Number(x.size),
          avg: x.entry_price != null ? Number(x.entry_price) : null,
          ltp: x.mark_price != null ? Number(x.mark_price) : null,
          pnl: x.unrealized_pnl != null ? Number(x.unrealized_pnl) : null,
        }))
        .filter((h) => h.sym);

      return res.json({ broker, holdings, cash, currency: "INR" });
    }

    if (broker === "schwab") {
      const tk = await schwabToken(sess);
      const r = await fetch("https://api.schwabapi.com/trader/v1/accounts?fields=positions", {
        headers: { Authorization: `Bearer ${tk}`, Accept: "application/json" },
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.message || d.error || `schwab ${r.status}`);

      const accounts = Array.isArray(d) ? d : [];
      const holdings = [];
      let cash = 0;

      accounts.forEach((a) => {
        const acc = a.securitiesAccount || {};
        cash += Number(acc.currentBalances?.cashBalance ?? 0);

        (acc.positions || []).forEach((p) => {
          const inst = p.instrument || {};
          const qty = Number(p.longQuantity ?? 0) - Number(p.shortQuantity ?? 0);
          if (!qty || !inst.symbol) return;
          const mv = p.marketValue != null ? Number(p.marketValue) : null;
          holdings.push({
            sym: inst.symbol,
            qty,
            avg: p.averagePrice != null ? Number(p.averagePrice) : null,
            /* Schwab reports market VALUE, not last price. Deriving LTP = value/qty is
               exact, so it's fine — but if value is missing we leave LTP null rather than
               reaching for a number we'd be half-inventing. */
            ltp: mv != null && qty ? +(mv / qty).toFixed(4) : null,
            pnl: p.longOpenProfitLoss != null ? Number(p.longOpenProfitLoss) : null,
          });
        });
      });

      return res.json({ broker, holdings, cash, currency: "USD" });
    }

    res.status(400).json({ error: "portfolio not supported for this broker yet" });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

/** Drop a broker session (logout, or the user disconnecting). */
app.post("/api/broker/logout", (req, res) => {
  const id = req.get("X-Broker-Session");
  if (id) brokerSessions.delete(id);
  res.json({ ok: true });
});

app.get("/health", (_, res) => res.json({ ok: true }));
app.listen(PORT, () => console.log(`Matrix proxy on :${PORT}`));
