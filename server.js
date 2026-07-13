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

/* --------------------- Yahoo crumb + cookie (fundamentals) -------------------
   The v8 /chart endpoint used everywhere else is open. But /v10/quoteSummary —
   the ONLY source of P/E, margins, quarterly revenue etc. — has required a
   session cookie plus a matching "crumb" since 2023, and returns 401 without one.
   That is why the Fundamentals panel was blank: not a UI bug, an auth handshake
   we never performed.

   So: fetch a cookie, exchange it for a crumb, cache both, and retry once if the
   crumb goes stale. If the handshake fails, fundamentalsFor returns null and the
   UI says the data is unavailable — it does NOT invent a P/E ratio.
---------------------------------------------------------------------------- */
let _yc = { cookie: null, crumb: null, at: 0 };

async function yahooCreds(force = false) {
  const FRESH = 30 * 60 * 1000;                       // re-handshake every 30 min
  if (!force && _yc.crumb && Date.now() - _yc.at < FRESH) return _yc;

  const r1 = await fetch("https://fc.yahoo.com", { headers: UA });
  const raw = r1.headers.get("set-cookie") || "";
  const cookie = raw.split(",").map((c) => c.split(";")[0].trim()).filter(Boolean).join("; ");
  if (!cookie) throw new Error("yahoo: no cookie");

  const r2 = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
    headers: { ...UA, cookie },
  });
  const crumb = (await r2.text()).trim();
  if (!crumb || crumb.includes("<")) throw new Error("yahoo: no crumb");

  _yc = { cookie, crumb, at: Date.now() };
  return _yc;
}

/** GET a crumb-protected Yahoo endpoint, re-handshaking once on 401/403. */
async function jAuth(build) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { cookie, crumb } = await yahooCreds(attempt === 1);
    const r = await fetch(build(crumb), { headers: { ...UA, cookie } });
    if (r.ok) return r.json();
    if (r.status !== 401 && r.status !== 403) throw new Error(`upstream ${r.status}`);
  }
  throw new Error("yahoo: auth failed");
}

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
  const symbols = String(req.query.symbols || "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 60);
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
  const symbols = String(req.query.symbols || "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 60);
  if (!symbols.length) return res.status(400).json({ error: "symbols required" });
  try {
    const out = {};
    await mapLimit(symbols, 5, async (sym) => {
      try {
        const v = await memo(`ind:${sym}`, 300_000, () => indicatorsFor(sym));
        if (v) out[sym] = v;
      } catch { /* skip symbols with no history */ }
    });
    res.json({ indicators: out });
  } catch (e) { res.status(502).json({ error: String(e.message) }); }
});

/* -------------------------- /api/fundamentals -----------------------------
   REAL fundamentals + REAL institutional holders from Yahoo quoteSummary.
   P/E, ROE, revenue & earnings growth, margins, market cap — all reported, none
   invented. Holders come from Yahoo's institutionOwnership module.            */
async function fundamentalsFor(symbol) {
  const mods = "defaultKeyStatistics,financialData,summaryDetail,institutionOwnership,price,earnings";
  // quoteSummary is crumb-protected -> jAuth, not j. This was the bug.
  const d = await jAuth((crumb) =>
    `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}` +
    `?modules=${mods}&crumb=${encodeURIComponent(crumb)}`
  );
  const r = d.quoteSummary?.result?.[0];
  if (!r) return null;
  const ks = r.defaultKeyStatistics || {}, fd = r.financialData || {}, sd = r.summaryDetail || {}, px = r.price || {};
  const num = (o) => (o && typeof o.raw === "number" ? o.raw : null);
  const pct = (o) => { const v = num(o); return v == null ? null : +(v * 100).toFixed(1); };
  const holders = (r.institutionOwnership?.ownershipList || []).slice(0, 4).map((h) => ({
    n: h.organization,
    v: num(h.value),                       // position value (USD/INR as reported)
    pct: pct(h.pctHeld),
    c: pct(h.pctChange),
    date: num(h.reportDate),
  })).filter((h) => h.n);
  // REAL quarterly revenue & earnings as reported (Yahoo earnings module).
  const eq = r.earnings?.financialsChart?.quarterly || [];
  const quarters = eq.map((q) => ({ q: q.date, rev: num(q.revenue), earn: num(q.earnings) })).filter((q) => q.rev != null);
  return {
    quarters: quarters.length ? quarters : null,
    pe: num(sd.trailingPE) != null ? +num(sd.trailingPE).toFixed(1) : (num(ks.forwardPE) != null ? +num(ks.forwardPE).toFixed(1) : null),
    roe: pct(fd.returnOnEquity),
    revGrowth: pct(fd.revenueGrowth),
    ebitdaGrowth: pct(fd.earningsGrowth),        // earnings growth (EBITDA growth isn't published)
    profitMargin: pct(fd.profitMargins),
    marketCap: num(px.marketCap) ?? num(sd.marketCap),
    debtToEquity: num(fd.debtToEquity),
    inst: holders.length ? holders : null,
  };
}
app.get("/api/fundamentals", async (req, res) => {
  const symbols = String(req.query.symbols || "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 40);
  if (!symbols.length) return res.status(400).json({ error: "symbols required" });
  try {
    const out = {};
    const errors = {};                     // why a symbol produced nothing
    await mapLimit(symbols, 4, async (sym) => {
      try {
        const v = await memo(`fund:${sym}`, 900_000, () => fundamentalsFor(sym));   // 15-min cache
        if (v) out[sym] = v;
        else errors[sym] = "yahoo returned no quoteSummary result";
      } catch (e) {
        // Swallowing this is why the panel was blank with no explanation. If the
        // data cannot be had, we need to KNOW that, not silently render nothing.
        errors[sym] = String(e.message || e);
      }
    });
    // ?debug=1 surfaces the real upstream failure instead of an empty object.
    if (req.query.debug) return res.json({ fundamentals: out, errors });
    res.json({ fundamentals: out });
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
