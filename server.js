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
const db = require("./db");
const strat = require("./strategyEngine");   // server-side port of the strategy exit engine
const { evalExitPair, optRanker, lenOptions, costPctFor } = require("./optimizerCore");   // pure optimiser scoring math (unit-tested)
const patterns = require("./patterns");       // chart-pattern detection for the screener scan
const { validateOrder: serverValidateOrder } = require("./riskEngine");
const { signToken, verifyToken, requireAuth, storageKeyFor } = require("./auth");   // must be required BEFORE any route uses requireAuth
const { marketOpenIST, intradaySquareDue, holidayCalendarReady } = require("./marketHours");   // IST market-open + intraday square-off + calendar readiness
const { createPinLock } = require("./pinLock");       // per-account PIN/answer brute-force lockout
const reconcile = require("./reconcile");             // PURE, unit-tested reconciliation + OAuth-binding decisions
const mcx = require("./mcxContract");                 // MCX near-month futures resolution
/* softAuth: verify the token IF present (attaching req.authUserId), but NEVER reject. Broker
   routes use this — identity is taken from the token when we have it, and we fall back to the
   X-User-Id header otherwise, so a token-flow hiccup can't hard-block real functionality the way
   requireAuth did. Prefer requireAuth for pure-data routes; broker routes stay usable. */
function softAuth(req, _res, next) {
  try {
    const h = req.get("Authorization") || "";
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (m) { const v = verifyToken(m[1]); if (v && v.userId) req.authUserId = v.userId; }
  } catch { /* soft — ignore */ }
  next();
}
/* Identity for broker routes: verified token when we have it, else the (legacy) header. */
const routeUserId = (req) => req.authUserId ? storageKeyFor(req.authUserId) : (req.get("X-User-Id") || (req.body && req.body.userId) || req.query.userId || null);

/* COMPLIANCE: a personal broker feed is licensed to its owner ONLY — under Indian exchange/broker
   data rules it must never be redistributed to other users. So the FYERS house feed is served
   solely to the account whose id equals HOUSE_OWNER_ID (set on Render to the owner's login id).
   Everyone else gets Yahoo (or their own connected broker). Reads the optional bearer token on
   otherwise-public data routes; returns false for anonymous/other users. */
/* True if the id matches HOUSE_OWNER_ID, tolerating ANY phone format: with/without a "ph_"
   prefix, a country code (91…), spaces, or "+". We compare the trailing 10 digits, which is the
   phone number itself — so 9167737726, 919167737726 and +91 91677 37726 all match. */
function idMatchesOwner(id) {
  const oid = (process.env.HOUSE_OWNER_ID || "").trim();
  if (!oid || id == null) return false;
  const digits = (x) => String(x || "").replace(/\D/g, "");
  const a = digits(id), b = digits(oid);
  if (!a || !b) return false;
  return a === b || a.slice(-10) === b.slice(-10);
}
function isHouseOwner(req) {
  if (!(process.env.HOUSE_OWNER_ID || "").trim()) return false;
  try {
    const h = req.get("Authorization") || "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : "";   // M-01: header only, never query string
    const v = verifyToken(token);
    if (!v) return false;
    return idMatchesOwner(v.userId);
  } catch { return false; }
}
const stripPh = (s) => String(s || "").replace(/^ph_/, "");   // "ph_9167..." -> "9167..."   // server-side risk checks for real orders   // Postgres when DATABASE_URL is set, else flat files

const app = express();

/* CORS locked to known origins (was wide-open app.use(cors())). The custom broker headers
   MUST stay allowed or every /api/broker/* preflight fails. Extra origins can be added via
   the CORS_ORIGINS env var (comma-separated) without a code change. */
const ALLOWED_ORIGINS = [
  "https://matrixone.app",
  "https://www.matrixone.app",
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
  // "Authorization" MUST be here or every authed call (login token → trades, state,
  // username, public strategies, ideas) is blocked by the browser as a CORS error.
  // R19-P1-01: X-Idempotency-Key is a custom header the browser preflights — it MUST be allow-listed or every
  // cross-origin live-order request is rejected at preflight before /api/broker/order ever runs.
  allowedHeaders: ["Content-Type", "Authorization", "X-Broker-Session", "X-User-Id", "X-Confirm-Live", "X-Admin-Key", "X-Idempotency-Key"],
  exposedHeaders: ["Location"],   // Schwab returns the order id in the Location header
}));

app.use(compression());     // gzip JSON responses — big win on the indicators/quotes payloads
// (was: app.use(cors());  wide openpp.com" })
app.use(express.json({ limit: "2mb" }));   // explicit bounded body size (P2-10) — generous enough for base64 idea screenshots, not unbounded

/* API versioning contract (P3-08). The wire API is v1; APP_VERSION comes from the deploy (Render sets
   it, else "dev"). Every response carries X-App-Version so a client/log can tell which build answered,
   and /api/version exposes it for health/debugging. Bumping the API contract → introduce /api/v2 paths. */
const APP_VERSION = process.env.APP_VERSION || process.env.RENDER_GIT_COMMIT || "dev";
const API_VERSION = "v1";
app.use((req, res, next) => { res.set("X-App-Version", APP_VERSION); res.set("X-Api-Version", API_VERSION); next(); });

/* Structured, machine-readable log for FINANCIAL actions (P3-10) — one JSON line per money event
   (real order placed/filled/rejected/unknown, auto-buy/-exit fills). Grep-able and shippable to a log
   drain, unlike the free-text console lines. Best-effort; never throws into a trade path. */
function logFinancial(event, fields) {
  try { console.log(JSON.stringify({ ts: new Date().toISOString(), lvl: "fin", evt: event, ...fields })); }
  catch { try { console.log("[fin]", event); } catch { /* noop */ } }
}
/* R21-P2-04: deterministic JSON — recursively SORT object keys so two semantically-identical payloads (differing
   only in property insertion order) serialize identically. Used for the idempotency payload hash so an unchanged
   strategy object isn't mistaken for a changed order just because the client reordered its keys. */
function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(",")}}`;
}
/* R22-C01: the server risk gate must derive state ONLY from VERIFIED executions. A client can POST a trade,
   but a REAL row that the browser authored (not stamped serverAuthored by a verified broker fill) must never
   feed the daily-loss / trade-count / cooldown maths — otherwise a fabricated `real:true` row with fake P&L
   could loosen the loss breaker or the cooldown. Virtual (paper) trades and server-verified real fills count;
   client-authored real rows are display-only. */
function riskEligibleTrades(trades) {
  return (trades || []).filter((t) => !(t && t.real === true && t.clientAuthored === true && t.serverAuthored !== true));
}
/* R17-P2-03: write a durable user-facing notice (used by background jobs like delayed-fill protection so the
   user learns the terminal outcome even though it happened server-side). Best-effort; never throws. */
async function addUserNotice(userId, notice) {
  try { await db.addNotice(String(userId), { ...notice, at: Date.now() }); } catch { /* non-fatal */ }
}
/* R19 fix: persist an authoritative trade row for a VERIFIED real fill — and DO NOT silently swallow a
   write failure. If the row can't be stored, future risk/position maths would run on an incomplete journal
   (the exact "operate on incomplete history" hazard). So: retry a few times; if still failing, (1) log a
   financial-severity event for ops, (2) leave a durable user notice, and (3) for UNATTENDED auto-entries,
   HALT further entries for that user so the engine won't keep trading against a book it can't record.
   Returns true if the row is durable, false if it could not be persisted. */
async function recordAuthoritativeFill(userKey, trade, { haltUserIdOnFail = null } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await db.saveTrade(userKey, trade, { authoritative: true });
      /* ARCH-1: write-through to the IMMUTABLE fills ledger (append-only, idempotent). This is the server-owned
         source of truth for reconciliation/audit and future risk derivation; the trades table stays the editable
         projection. Best-effort relative to the trade write — the trade write is what the retry/halt guards. */
      if (typeof db.recordFill === "function") { try { await db.recordFill(userKey, trade); } catch { /* ledger append is non-fatal to the trade write */ } }
      return true;
    }
    catch (e) {
      if (attempt === 2) {
        logFinancial("authoritative_fill_persist_failed", { userKey, orderId: trade && trade.orderId, sym: trade && trade.sym, broker: trade && trade.broker, err: String((e && e.message) || e) });
        await addUserNotice(userKey, { kind: "reconcile", severity: "high", title: "Recording a filled order failed", body: `A real ${trade && trade.side} fill on ${trade && trade.sym} executed but couldn't be saved to your history. Please reconcile with your broker; new orders are paused as a precaution.`, orderId: trade && trade.orderId });
        /* R21-P1-03: a journal-write failure means the risk ledger is now incomplete. Set the DURABLE per-user
           risk-lock (checked by EVERY new-entry route — manual AND automated) so no further real order is placed
           against a book we couldn't record. Also set the automated-entry halt. Both fail-closed. */
        try { await db.setRiskLock(userKey, true); } catch { /* best-effort */ }
        if (haltUserIdOnFail != null && typeof db.setEntryHalt === "function") {
          try { await db.setEntryHalt(storageKeyFor(String(haltUserIdOnFail)), true); } catch { /* best-effort */ }
          /* R22-C03: engage the LIVE in-memory kill-switch immediately too — the durable flag alone wouldn't
             stop the already-running Auto-Buy engine until restart. This makes a manual/delayed/auto journal
             failure halt the engine in the SAME process, right now. (haltedEntries is defined later; resolved
             at call time.) */
          try { haltedEntries.add(String(storageKeyFor(String(haltUserIdOnFail)))); } catch { /* engine may not be up */ }
        }
        return false;
      }
      await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
    }
  }
  return false;
}
/* M-02: on SENSITIVE routes, re-check the DB after requireAuth — reject a token whose version is stale
   (PIN reset / block / logout / deletion bumped it) or whose account is now blocked/deleted. A stolen 30-day
   token can't keep trading after the user secures the account. Best-effort: if the lookup fails we allow (the
   route's own checks still apply), never lock a user out on a transient DB error. */
async function requireFreshSession(req, res, next) {
  const phone = stripPh(req.authUserId || "");
  if (!phone) return res.status(401).json({ error: "Authentication required." });
  let u;
  try { u = await db.getUser(phone); }
  catch {
    // H2-02: a security control must FAIL CLOSED. If we can't verify the session against the DB (outage),
    // do NOT let a possibly-revoked token through to a real-money / sensitive action.
    return res.status(503).json({ error: "Couldn't verify your session right now — please retry in a moment." });
  }
  if (!u || u.deleted) return res.status(401).json({ error: "This session is no longer valid — sign in again." });
  if (u.blocked) return res.status(403).json({ error: "This account is blocked." });
  if ((Number(u.tokenVersion) || 0) !== (Number(req.authTokenVersion) || 0)) {
    return res.status(401).json({ error: "Your session was reset (PIN change or security action) — sign in again." });
  }
  next();
}
// H2-03: alias — the same active/unblocked/fresh-token guard for sensitive mutation + broker-data routes.
const requireActiveUser = requireFreshSession;
/* R19-P2-02: account DELETION must reject a stale/revoked token and a vanished user (fail closed on outage),
   but must NOT be blocked for a *blocked* user — data-deletion is a right that survives an account block. */
async function requireFreshSessionAllowBlocked(req, res, next) {
  const phone = stripPh(req.authUserId || "");
  if (!phone) return res.status(401).json({ error: "Authentication required." });
  let u;
  try { u = await db.getUser(phone); }
  catch { return res.status(503).json({ error: "Couldn't verify your session right now — please retry in a moment." }); }
  if (!u || u.deleted) return res.status(401).json({ error: "This session is no longer valid — sign in again." });
  if ((Number(u.tokenVersion) || 0) !== (Number(req.authTokenVersion) || 0)) {
    return res.status(401).json({ error: "Your session was reset (PIN change or security action) — sign in again." });
  }
  next();
}
app.get("/api/version", (req, res) => res.json({ name: "matrixone-api", version: APP_VERSION, apiVersion: API_VERSION }));

const PORT = process.env.PORT || 8787;
const YF = "https://query1.finance.yahoo.com";
/* A REAL browser User-Agent + Accept headers. Yahoo throttles/short-changes obviously-bot agents
   from datacenter IPs (the old "MatrixProxy" UA came back with ~2 candles, which broke Indian charts
   and backtests). A normal Chrome UA is served the full history. */
const UA = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
  "Accept": "application/json,text/plain,*/*",
  "Accept-Language": "en-US,en;q=0.9",
};
db.initDb().catch((e) => console.error("[db] init failed:", e.message));

/* ------------------------------- trade store ------------------------------ */
// Save a completed/opened trade:  POST /api/trades   body: { userId, trade }
app.post("/api/trades", requireAuth, async (req, res) => {
  try {
    const { trade } = req.body || {};
    const userId = storageKeyFor(req.authUserId);   // from the verified token, NOT the client
    if (!trade || !trade.sym) return res.status(400).json({ error: "trade required" });

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
    const rec = { id: trade.id || crypto.randomUUID(), ...trade };   // collision-proof id (P3-09), not time+short-random
    // R21-P1-02: a browser post is NEVER authoritative. Strip any client-claimed serverAuthored flag; saveTrade
    // (authoritative:false) then guarantees it can only annotate — not overwrite — a server-verified fill row.
    delete rec.serverAuthored;
    // R22-C01: mark any REAL row the browser posts as clientAuthored so the risk gate ignores it (it can only
    // ANNOTATE a server-verified fill, never feed the daily-loss / count / cooldown maths). Fabricated fake-P&L
    // posts therefore can't loosen the risk controls; they remain display-only.
    if (rec.real === true) rec.clientAuthored = true;
    // R20 follow-up (H1): saveTrade may re-key to a user-namespaced/canonical id — echo the STORED row back so
    // the client holds the id the DB actually uses (not the raw one it sent), else later deletes/patches miss.
    const saved = await db.saveTrade(userId, rec, { authoritative: false });
    rcBust(`trades:${userId}`);
    res.json({ ok: true, trade: saved || rec });
  } catch (e) { serverError(res, e); }
});

// Fetch trade history:  GET /api/trades?userId=&from=<ms>&to=<ms>
app.get("/api/trades", requireAuth, async (req, res) => {
  try {
    const userId = storageKeyFor(req.authUserId);   // from the verified token
    const from = req.query.from ? +req.query.from : 0;
    const to = req.query.to ? +req.query.to : Date.now();
    const trades = await rcWrap(`trades:${userId}:${from}:${to}`, () => db.getTrades(userId, from, to));
    res.json({ trades });
  } catch (e) { serverError(res, e); }
});

/* ARCH-4: durable order-intent reconcile. The order_idempotency ledger IS the intent store — it survives
   restart (Postgres) and records each intent's terminal outcome. This lets the UI resolve an AMBIGUOUS order
   ("outcome unknown—checking broker") after a timeout/reload by polling the SAME idempotency key:
     succeeded → the order went through (replay the stored response);  rejected/none → nothing executed, safe to
     retry;  in_flight/unknown → still unresolved, keep showing the reconcile state. Scoped to the caller. */
app.get("/api/order/intent-status", requireAuth, async (req, res) => {
  try {
    const key = String(req.query.key || "").slice(0, 100);
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(key)) return res.status(400).json({ error: "A valid intent key is required." });
    const rec = await db.getIdempotencyRecord(storageKeyFor(req.authUserId), key).catch(() => null);
    if (!rec) return res.json({ status: "none" });
    res.json({ status: rec.status, ageMs: rec.createdAt ? Date.now() - rec.createdAt : null, ...(rec.status === "succeeded" && rec.response ? { response: rec.response } : {}) });
  } catch (e) { serverError(res, e); }
});

/* Clear the caller's VIRTUAL (paper) trades across all markets. Real broker trades are never
   touched. Scoped to the verified token's own userId, so a user can only wipe their own book. */
app.post("/api/trades/clear-virtual", requireAuth, async (req, res) => {
  try {
    const userId = storageKeyFor(req.authUserId);   // from the verified token, NOT the client
    const removed = await db.clearVirtualTrades(userId);
    rcBust(`trades:${userId}`);
    res.json({ ok: true, removed });
  } catch (e) { serverError(res, e); }
});

/* RECONCILE AGAINST DELTA — self-heal phantom records. Reads the caller's ACTUAL Delta positions (signed
   with their own keys) and DROPS any OPEN real crypto journal record for a symbol Delta doesn't actually
   hold. This fixes an inflated dashboard/P&L (e.g. positions the browser optimistically recorded that were
   rejected or never filled) WITHOUT touching real holdings or the server's managed positions. Delta only —
   it's the broker whose positions we can verify. Scoped to the verified token's own book. */
app.post("/api/trades/reconcile-real", requireAuth, async (req, res) => {
  try {
    const userId = storageKeyFor(req.authUserId);
    const sess = await sessionFromCred(req.authUserId, "delta");
    if (!sess) return res.status(400).json({ error: "Connect your Delta account first — reconcile verifies against Delta's actual positions." });
    /* R16-P2-05: reconcile with SIDE + SIGNED SIZE per Delta product, not a base-symbol set. We build a map
       of base symbol → { long: totalLongSize, short: totalShortSize } so a phantom is judged against the
       actual direction and quantity Delta holds, not merely "some BTC position exists". */
    let deltaBook;
    try {
      const pr = await withTimeout(deltaCall("GET", "/v2/positions/margined", { userId: req.authUserId }), 8000);
      deltaBook = reconcile.buildDeltaBook((pr && pr.result) || []);
    } catch { return res.status(502).json({ error: "Couldn't read your Delta positions right now — try again in a moment." }); }
    /* R16-P2-05/06: partition using the PURE, unit-tested planner. Only broker="delta" rows are auto-closable;
       untagged phantoms are "broker unknown" and require explicit confirmIds (never auto-closed on the mere
       absence of another broker's saved credential). */
    const trades = await db.getTrades(userId, 0, Date.now()).catch(() => []);
    const openCryptoReal = (trades || []).filter((t) =>
      t && t.real === true && (t.market || "") === "Crypto" &&
      t.entryAt != null && (t.exitAt == null || t.exit == null) && t.status !== "rejected");
    const { phantomDelta, phantomUnknown } = reconcile.deltaReconcilePlan(openCryptoReal, deltaBook);

    // Preview mode (default): report what WOULD change; touch nothing. Pass apply:true to act.
    const apply = req.body && req.body.apply === true;
    const confirmIds = new Set((req.body && Array.isArray(req.body.confirmIds) ? req.body.confirmIds : []).map(String));
    const heldSymbols = [...deltaBook.keys()];
    if (!apply) {
      return res.json({ ok: true, preview: true, removed: 0, heldSymbols,
        wouldClose: phantomDelta.map((t) => ({ id: t.id, sym: t.sym, side: t.side || (t.short ? "SELL" : "BUY"), qty: t.qty })),
        unknownIds: phantomUnknown.map((t) => t.id),
        unknownBroker: phantomUnknown.map((t) => ({ id: t.id, sym: t.sym, side: t.side || (t.short ? "SELL" : "BUY"), qty: t.qty })) });
    }
    /* R16-P2-07: close phantom rows with an IMMUTABLE reconciliation adjustment (mark them closed at
       break-even with an audit note) rather than a hard delete, so P&L / Orders / Portfolio stay consistent
       and the history is preserved. Delta-tagged phantoms auto-close; untagged only if user-confirmed. */
    const toClose = phantomDelta.concat(phantomUnknown.filter((t) => confirmIds.has(String(t.id))));
    const now = Date.now();
    for (const t of toClose) {
      await db.updateTrade(userId, { ...t, exit: Number(t.entry) || t.exit || 0, exitAt: now, pnl: 0, status: "closed",
        reconciled: true, reconciledAt: now, reconcileReason: "Closed via Delta reconciliation — Delta held no matching position." }).catch(() => {});
    }
    rcBust(`trades:${userId}`);
    logFinancial("trades.reconcileReal", { userId, closed: toClose.length, held: heldSymbols });
    res.json({ ok: true, removed: toClose.length, heldSymbols,
      closedSymbols: toClose.map((t) => t.sym),
      unknownIds: phantomUnknown.filter((t) => !confirmIds.has(String(t.id))).map((t) => t.id),
      unknownBroker: phantomUnknown.filter((t) => !confirmIds.has(String(t.id))).map((t) => ({ id: t.id, sym: t.sym, side: t.side || (t.short ? "SELL" : "BUY"), qty: t.qty })) });
  } catch (e) { serverError(res, e); }
});

/* SERVER-OWNED RISK POLICY (R15-P1-02). The per-user caps are the REAL safety control, so they must be
   stored server-side and loaded on every order — a tampered/old client can't drop them by omitting the
   body. Only clean positive numbers are kept. `merge` returns the STRICTER of two policies per field so a
   per-order client override can only tighten, never loosen. */
const { cleanRiskPolicy, strictestRiskPolicy } = require("./riskPolicy");   // pure + unit-tested
app.get("/api/risk-policy", requireAuth, async (req, res) => {
  try { const p = await db.getRiskPolicy(storageKeyFor(req.authUserId)); res.json({ ok: true, policy: p || {} }); }
  catch (e) { serverError(res, e); }
});
app.post("/api/risk-policy", requireAuth, requireActiveUser, async (req, res) => {
  try {
    const policy = cleanRiskPolicy(req.body && req.body.policy);
    await db.saveRiskPolicy(storageKeyFor(req.authUserId), policy);
    logFinancial("risk.policySaved", { userId: storageKeyFor(req.authUserId), policy });
    res.json({ ok: true, policy });
  } catch (e) { serverError(res, e); }
});

/* R17-P2-03: durable user notices (delayed-protection outcomes, etc.) + pending-protection status, so the
   user can see "protected / rejected / expired / still pending" for background jobs. */
app.get("/api/notices", requireAuth, async (req, res) => {
  try {
    const uid = storageKeyFor(req.authUserId);
    const notices = await db.getNotices(uid, 50).catch(() => []);
    const pending = (await db.listPendingProtection(200).catch(() => [])).filter((p) => String(p.userId) === String(uid))
      .map((p) => ({ orderId: p.orderId, symbol: p.symbol, broker: p.broker, since: p.created_at, attempts: p.attempts }));
    res.json({ ok: true, notices, pendingProtection: pending });
  } catch (e) { serverError(res, e); }
});
app.post("/api/notices/read", requireAuth, async (req, res) => {
  try { await db.markNoticesRead(storageKeyFor(req.authUserId)); res.json({ ok: true }); }
  catch (e) { serverError(res, e); }
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

/* ------------------------------ AUTH TOKENS ------------------------------- */
/* Token signing/verification + the requireAuth middleware live in auth.js (required at the
   top of this file, before any route uses them). */


/* Rate limit auth endpoints: 10 attempts per 15 min per IP. Blocks brute force without
   getting in a real user's way. */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Please wait a few minutes and try again." },
});

/* The AI endpoints (/api/ask, /api/ai/strategy) call paid LLM providers, so an open, unlimited
   endpoint is a direct cost-abuse vector: anyone could hammer it and run up the bill. Cap each IP
   to a sane burst. Real users nowhere near this; a scraper hits the wall fast. */
const llmLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many AI requests. Please wait a few minutes and try again." },
});

/* COMPUTE endpoints (/api/optimize-exits, /api/optimize-indicators, /api/momentum-scan) each fan out to
   several real-candle fetches + grid searches. They're deliberately reachable in guest mode (browsing
   Top Picks / backtests without an account), so we can't require auth — but they were UNBOUNDED, an
   abuse/DoS vector (P1-11). Cap the burst per IP; the memo cache absorbs repeats, so a real user never
   hits this while a scraper does. */
const computeLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many analysis requests. Please wait a minute and try again." },
});
/* R21-P2-11 — per-IP budget for PUBLIC market-data routes (quote/history/news/fundamentals/quotes). These call
   upstream providers (Yahoo/Delta) and cost CPU + rate-limited API quota, so an unauthenticated caller mustn't
   be able to hammer them. Generous enough for normal browsing (a page render fires several), hard-capped so a
   scraper/abuser is throttled. Diagnostics/health are separately gated to non-production below. */
const publicDataLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests — please slow down." },
});

/* P2-11 — don't leak raw upstream/internal error text (stack fragments, DB driver messages, provider
   payloads) to the client. Log the full detail server-side; return a generic message. Routes that need
   to surface a SPECIFIC user-facing reason (e.g. "insufficient balance") still send their own message
   explicitly with the appropriate status — this only replaces the catch-all 500 handlers. */
function serverError(res, e, msg = "Something went wrong on our end. Please try again.") {
  try { console.error("[error]", (e && (e.stack || e.message)) || e); } catch { /* noop */ }
  if (!res.headersSent) res.status(500).json({ error: msg });
}

/* Per-ACCOUNT PIN brute-force lockout (P1-12/13). The per-IP authLimiter alone is dodgeable by rotating
   IPs, and /api/pin/verify (the Real-mode step-up) had no limit at all — a 4-digit PIN is only 10k
   guesses. After 5 wrong PINs for ONE account, further attempts are refused for 15 min; a correct PIN
   clears the counter. Logic lives in pinLock.js so it's unit-tested in isolation. */
const _pinLock = createPinLock({ maxFails: 5, lockMs: 15 * 60 * 1000 });
const pinLockState = (key) => _pinLock.state(key);
const recordPinFail = (key) => _pinLock.fail(key);
const clearPinFails = (key) => _pinLock.clear(key);

/* A user-chosen handle: 3–20 chars, must start with a letter, then letters/digits/_ .
   Returns the cleaned handle, or null if it doesn't meet the rules. */
function cleanUsername(raw) {
  const u = String(raw || "").trim();
  if (!/^[A-Za-z][A-Za-z0-9_]{2,19}$/.test(u)) return null;
  return u;
}

app.post("/api/register", authLimiter, async (req, res) => {
  try {
    const phone = cleanPhone(req.body && req.body.phone), pin = req.body && req.body.pin, name = (req.body && req.body.name) || "";
    if (phone.length < 6 || !pin || String(pin).length < 4) return res.status(400).json({ error: "Enter a valid phone and a 4+ digit PIN." });
    const existingUser = await db.getUser(phone);
    // A soft-deleted stub is kept only for the admin's trade-history audit; the number is free to reuse.
    if (existingUser && !existingUser.deleted) return res.status(409).json({ error: "That number is already registered — please log in." });
    /* R17-P2-06: if this number was previously soft-deleted, a NEW person may now own it. Move the old
       account's retained trades to an opaque archive key BEFORE creating the new account, so the new user
       starts with a clean slate and can never load the previous owner's financial history. Admin can still
       retrieve the archived trades for the number for audit. */
    if (existingUser && existingUser.deleted) {
      /* Round18-4: archival must SUCCEED before we create the new account. If moving the previous owner's
         retained trades to an archive key fails, we ABORT — otherwise the new user could load the old
         owner's financial history under the shared phone-derived key. Fail closed. */
      try {
        const oldUid = storageKeyFor(phone);
        const archiveKey = `arch_${existingUser.deletedAt || Date.now()}_${oldUid}`;
        // R21-P2-08: reassign the previous owner's trades AND register the archive in ONE transaction, so a
        // crash can't move history without recording where it went (or leave an orphaned archive record).
        if (typeof db.reassignAndArchiveTrades === "function") {
          await db.reassignAndArchiveTrades(phone, oldUid, archiveKey);
        } else {
          const moved = await db.reassignTrades(oldUid, archiveKey);
          if (moved) await db.recordTradeArchive(phone, archiveKey);
        }
        if (typeof db.purgeLedgersForUser === "function") await db.purgeLedgersForUser(oldUid);
      } catch (e) {
        console.error("[register] archive of recycled-number history failed — aborting registration:", e.message);
        return res.status(503).json({ error: "Couldn't set up your account right now. Please try again in a moment." });
      }
    }
    const username = cleanUsername(req.body && req.body.username);
    if (!username) return res.status(400).json({ error: "Choose a user ID: 3–20 characters, starting with a letter (letters, numbers, underscore)." });
    if (typeof db.getUserByUsername === "function" && await db.getUserByUsername(username)) {
      return res.status(409).json({ error: "That user ID is taken — try another." });
    }
    /* Security question is now OPTIONAL — the unified sign-up asks only for a user ID and
       (optionally) an email. If a question+answer are supplied they're stored for PIN
       recovery; if not, the account is created without one and can set it later from
       the profile. */
    const secQuestion = ((req.body && req.body.secQuestion) || "").trim();
    const secAnswer = ((req.body && req.body.secAnswer) || "").trim();
    const answerHash = (secQuestion && secAnswer) ? hashPin(secAnswer.toLowerCase()) : null;
    // Optional email — validated loosely; stored only if it looks like an address.
    let email = String((req.body && req.body.email) || "").trim().slice(0, 254);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Enter a valid email address, or leave it blank." });
    // Optional referral: resolve the referral code (a user's handle) to a real account.
    let referredBy = null;
    const refRaw = cleanUsername(req.body && req.body.referralCode);
    if (refRaw && typeof db.getUserByUsername === "function" && await db.getUserByUsername(refRaw)) referredBy = refRaw;
    // Admins are auto-approved; everyone else starts PENDING and needs admin approval before login.
    const autoApprove = isAdminPhone(phone);
    await db.createUser(phone, hashPin(pin), name, secQuestion || null, answerHash, username, referredBy, autoApprove);
    if (email && typeof db.setEmail === "function") { try { await db.setEmail(phone, email); } catch { email = ""; } }
    if (autoApprove) {
      if (typeof db.setLastLogin === "function") { try { await db.setLastLogin(phone); } catch { /* non-fatal */ } }
      // M2-01: sign with the account's ACTUAL token version. On a recycled number the row inherited a bumped
      // version from the prior deletion — signing with the real value keeps THIS token valid while the
      // previous owner's older-version token stays revoked.
      const nu = await db.getUser(phone);
      return res.json({ ok: true, userId: phone, name, username, referredBy, email: email || null, createdAt: Date.now(), token: signToken(phone, undefined, undefined, Number(nu && nu.tokenVersion) || 0) });
    }
    // Pending: NO token is issued, so the client shows a "waiting for approval" screen.
    res.json({ ok: true, pending: true, userId: phone, name, username, message: "Account created. An admin will review and activate it shortly." });
  } catch (e) { serverError(res, e); }
});
/* Is this phone one of the configured admins? Admins bypass the approval gate. */
function isAdminPhone(phone) {
  const ids = String(process.env.ADMIN_USER_IDS || "").split(",").map((x) => stripPh(x.trim())).filter(Boolean);
  return ids.includes(stripPh(phone));
}

app.post("/api/login", authLimiter, async (req, res) => {
  try {
    const phone = cleanPhone(req.body && req.body.phone), pin = req.body && req.body.pin;
    const lock = pinLockState(phone);
    if (lock.locked) return res.status(429).json({ error: `Too many wrong PINs. Try again in ${Math.ceil(lock.retrySec / 60)} min.` });
    const u = await db.getUser(phone);
    // Unified Login / Sign-up: if there's no account for this number, tell the client so
    // it can switch to the "looks like you're new" sign-up step instead of showing an error.
    if (!u) return res.status(404).json({ ok: false, newAccount: true, error: "No account for this number." });
    // A soft-deleted account (self- or admin-deleted) keeps only a stub so the admin can still see its
    // trade history — the login is dead. Treat it like a new number so the client offers a fresh sign-up.
    if (u.deleted) return res.status(404).json({ ok: false, newAccount: true, error: "No account for this number." });
    if (!verifyPin(pin, u.pin)) { recordPinFail(phone); return res.status(401).json({ error: "Wrong PIN for this number." }); }
    clearPinFails(phone);

    // Blocked users are turned away even with a correct PIN.
    if (typeof db.isUserBlocked === "function" && await db.isUserBlocked(phone)) {
      return res.status(403).json({ error: "This account has been blocked. Contact support." });
    }
    // Un-approved (pending) signups can't enter until an admin activates them. Admins bypass.
    if (u.approved !== true && !isAdminPhone(phone)) {
      return res.status(403).json({ pending: true, error: "Your account is awaiting admin approval." });
    }

    /* Upgrade a legacy SHA-256 user to bcrypt now that we've verified their PIN. Best-effort:
       a failed upgrade must not fail the login. */
    if (isLegacyHash(u.pin) && typeof db.updateUserPin === "function") {
      try { await db.updateUserPin(phone, hashPin(pin)); } catch { /* upgrade later */ }
    }
    if (typeof db.setLastLogin === "function") { try { await db.setLastLogin(phone); } catch { /* non-fatal */ } }
    res.json({ ok: true, userId: phone, name: u.name || "", username: u.username || null, email: u.email || null, createdAt: u.createdAt || null, token: signToken(phone, undefined, undefined, Number(u.tokenVersion) || 0) });
  } catch (e) { serverError(res, e); }
});

/* ------------------------------- EMAIL ------------------------------------
   Optional contact email the user can add/change from their profile. */
app.post("/api/email", requireAuth, async (req, res) => {
  try {
    const phone = stripPh(req.authUserId);
    const email = String((req.body && req.body.email) || "").trim().slice(0, 254);
    // Empty clears it; otherwise require a basic, sane email shape.
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Enter a valid email address." });
    }
    if (typeof db.setEmail === "function") await db.setEmail(phone, email);
    res.json({ ok: true, email });
  } catch (e) { serverError(res, e); }
});

/* ---------------------------- USER ID (username) ---------------------------
   Availability check (public) and set-handle (for existing accounts that don't have one
   yet — the app mandates it right after their first login). */
app.get("/api/username/available", authLimiter, async (req, res) => {
  try {
    const username = cleanUsername(req.query.u);
    if (!username) return res.json({ ok: true, valid: false, available: false });
    const taken = typeof db.getUserByUsername === "function" ? await db.getUserByUsername(username) : null;
    res.json({ ok: true, valid: true, available: !taken });
  } catch (e) { serverError(res, e); }
});

app.post("/api/username", requireAuth, async (req, res) => {
  try {
    const phone = stripPh(req.authUserId);
    const username = cleanUsername(req.body && req.body.username);
    if (!username) return res.status(400).json({ error: "User ID must be 3–20 characters, starting with a letter (letters, numbers, underscore)." });
    const owner = typeof db.getUserByUsername === "function" ? await db.getUserByUsername(username) : null;
    if (owner && stripPh(owner) !== phone) return res.status(409).json({ error: "That user ID is taken — try another." });
    await db.setUsername(phone, username);
    res.json({ ok: true, username });
  } catch (e) { serverError(res, e); }
});

/* ---------------------------- PUBLIC STRATEGIES ---------------------------
   Anyone signed in can publish their own strategy; everyone can browse them. */
app.get("/api/public-strategies", async (req, res) => {
  try {
    // Cache the shared list for a couple of minutes so the Automate "Public" tab loading doesn't
    // re-scan the whole table per visitor — another egress lever with no UX impact (list changes rarely).
    let list = typeof db.listPublicStrategies === "function" ? await memo("pubstrats:list", 120_000, () => db.listPublicStrategies()) : [];
    const sym = (req.query.symbol || "").trim();
    const by = (req.query.by || "").trim().toLowerCase();
    if (sym) list = list.filter((s) => (s.symbols || []).includes(sym));
    if (by) list = list.filter((s) => String(s.owner_name || "").toLowerCase() === by);
    res.json({ strategies: list });
  } catch (e) { serverError(res, e); }
});

app.post("/api/public-strategies", requireAuth, async (req, res) => {
  try {
    const phone = stripPh(req.authUserId);
    const s = (req.body && req.body.strategy) || {};
    const u = await db.getUser(phone);
    const ownerName = (u && u.username) || (u && u.name) || phone;
    const id = String(s.id || ("pub_" + phone + "_" + Date.now()));
    const row = await db.publishStrategy({
      id, owner: phone, owner_name: ownerName,
      name: s.name || "Strategy", symbols: s.symbols || [], data: s.cfg || s.data || {}, created_at: Date.now(),
    });
    cache.delete("pubstrats:list");
    res.json({ ok: true, strategy: row });
  } catch (e) { serverError(res, e); }
});

app.delete("/api/public-strategies/:id", requireAuth, async (req, res) => {
  try {
    const phone = stripPh(req.authUserId);
    const isAdm = isAdmin(req);
    await db.unpublishStrategy(req.params.id, isAdm ? "" : phone);
    cache.delete("pubstrats:list");
    res.json({ ok: true });
  } catch (e) { serverError(res, e); }
});

/* ------------------------------ COMMUNITY IDEAS ------------------------------
   Any signed-in user can post an idea; everyone can browse them. */
app.get("/api/ideas", async (req, res) => {
  try {
    // Ideas change rarely and the payload is now screenshot-free, so cache the whole list for a few
    // minutes and serve every request from memory — collapses the app's ideas polling to ~1 DB read.
    let list = typeof db.listIdeas === "function" ? await memo("ideas:list", 180_000, () => db.listIdeas()) : [];
    const sym = (req.query.symbol || "").trim();
    const by = (req.query.by || "").trim().toLowerCase();
    if (sym) list = list.filter((i) => i.symbol === sym);
    if (by) list = list.filter((i) => String(i.owner_name || "").toLowerCase() === by);
    /* APPROVAL GATE: everyone sees APPROVED ideas. An admin sees everything (to review).
       A signed-in author sees their own still-pending ideas so they know it's awaiting review. */
    const admin = isAdmin(req);
    // Author identity for "see my own pending ideas" must come from a VERIFIED token, not a header a
    // caller can forge to view someone else's unapproved posts.
    let me = req.authUserId ? stripPh(req.authUserId) : null;
    if (!me) { const h = req.get("Authorization") || ""; const tok = h.startsWith("Bearer ") ? h.slice(7) : ""; const v = verifyToken(tok); if (v) me = stripPh(v.userId); }
    if (!admin) list = list.filter((i) => (i.status || "approved") === "approved" || (me && i.owner === me));
    res.json({ ideas: list });
  } catch (e) { serverError(res, e); }
});

app.post("/api/ideas", requireAuth, async (req, res) => {
  try {
    const phone = stripPh(req.authUserId);
    const b = req.body || {};
    const symbol = String(b.symbol || "").trim();
    if (!symbol) return res.status(400).json({ error: "Pick a symbol for your idea." });
    const u = await db.getUser(phone);
    const ownerName = (u && u.username) || (u && u.name) || phone;
    const id = "idea_" + phone + "_" + Date.now();
    // Up to 4 short tags; screenshot is an optional data URL, size-capped so a huge image
    // can't bloat the row. New ideas start 'pending' and need admin approval to go public.
    const tags = Array.isArray(b.tags) ? b.tags.map((t) => String(t).slice(0, 24)).filter(Boolean).slice(0, 4) : [];
    let screenshot = typeof b.screenshot === "string" && b.screenshot.startsWith("data:image/") ? b.screenshot : null;
    if (screenshot && screenshot.length > 1_500_000) screenshot = null;   // ~1.5MB cap
    const row = await db.postIdea({
      id, owner: phone, owner_name: ownerName, symbol,
      direction: b.direction === "Short" ? "Short" : "Long",
      note: String(b.note || "").slice(0, 600), target: String(b.target || "").slice(0, 24), stop: String(b.stop || "").slice(0, 24),
      tags, screenshot, status: "pending", created_at: Date.now(),
    });
    cache.delete("ideas:list");   // new idea → refresh the cached list on the next read
    res.json({ ok: true, idea: row });
  } catch (e) { serverError(res, e); }
});

/* Lazy screenshot fetch — the list omits the heavy base64 blob; the client requests each image only
   for the cards it renders. Screenshots are immutable once posted, so cache hard (memory + browser). */
app.get("/api/ideas/:id/screenshot", async (req, res) => {
  try {
    const dataUrl = await memo("ideashot:" + req.params.id, 3_600_000, () => db.getIdeaScreenshot(req.params.id));
    if (!dataUrl || typeof dataUrl !== "string") return res.status(404).end();
    const m = /^data:(image\/[a-zA-Z+.-]+);base64,(.*)$/.exec(dataUrl);
    if (!m) return res.status(404).end();
    res.set("Cache-Control", "public, max-age=86400, immutable");   // browser caches for a day
    res.type(m[1]);
    res.send(Buffer.from(m[2], "base64"));
  } catch (e) { res.status(500).end(); }
});

/* Admin approves or rejects a pending idea before it becomes public. */
app.post("/api/ideas/:id/review", requireAuth, async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: "admin only" });
    const status = req.body && req.body.status === "approved" ? "approved" : "rejected";
    if (typeof db.reviewIdea === "function") await db.reviewIdea(req.params.id, status);
    cache.delete("ideas:list");
    res.json({ ok: true, status });
  } catch (e) { serverError(res, e); }
});

app.delete("/api/ideas/:id", requireAuth, async (req, res) => {
  try {
    const phone = stripPh(req.authUserId);
    await db.deleteIdea(req.params.id, isAdmin(req) ? "" : phone);
    cache.delete("ideas:list"); cache.delete("ideashot:" + req.params.id);
    res.json({ ok: true });
  } catch (e) { serverError(res, e); }
});

/* ---------------------------- FORGOT PIN (recovery) ---------------------------
   Two steps, both rate-limited (authLimiter) so the security answer can't be brute-forced:
     1) GET the user's security question so the app can show it.
     2) POST the answer + a new PIN; if the answer matches, the PIN is reset.
   The answer is compared against its bcrypt hash; it is never returned or logged. To avoid
   leaking which phone numbers exist, step 1 gives a generic response when there's no
   question on file. */
app.get("/api/forgot/question", authLimiter, async (req, res) => {
  try {
    const phone = cleanPhone(req.query.phone);
    if (!phone) return res.status(400).json({ error: "phone required" });
    const q = typeof db.getSecurityQuestion === "function" ? await db.getSecurityQuestion(phone) : null;
    if (!q) {
      // No question (unknown number OR an older account without one). Don't reveal which.
      return res.json({ ok: false, reason: "no_recovery", message: "No security question is set for this number. If this is your account, an admin can reset your PIN." });
    }
    res.json({ ok: true, question: q });
  } catch (e) { serverError(res, e); }
});

app.post("/api/forgot/reset", authLimiter, async (req, res) => {
  try {
    const phone = cleanPhone(req.body && req.body.phone);
    const answer = ((req.body && req.body.answer) || "").trim().toLowerCase();
    const newPin = req.body && req.body.newPin;
    if (!phone || !answer || !newPin) return res.status(400).json({ error: "phone, answer and newPin are required." });
    if (String(newPin).length < 4) return res.status(400).json({ error: "PIN must be at least 4 digits." });

    // Per-account lockout on the recovery ANSWER too (P1-13) — a separate namespace from the PIN so a
    // failed answer can't lock the login and vice-versa.
    const ansKey = "ans:" + phone;
    const lock = pinLockState(ansKey);
    if (lock.locked) return res.status(429).json({ error: `Too many wrong answers. Try again in ${Math.ceil(lock.retrySec / 60)} min.` });

    const hash = typeof db.getSecurityAnswerHash === "function" ? await db.getSecurityAnswerHash(phone) : null;
    if (!hash) return res.status(400).json({ error: "No recovery is set up for this number." });
    // verifyPin works for any bcrypt/legacy hash — reuse it to check the answer.
    if (!verifyPin(answer, hash)) { recordPinFail(ansKey); return res.status(401).json({ error: "That answer doesn't match." }); }
    clearPinFails(ansKey);

    // R21-P2-01: reset the PIN and revoke all prior tokens in ONE atomic write (no crash window where the PIN
    // changed but old tokens still validate), then issue exactly one fresh token from the committed version.
    let newTv = 0;
    if (typeof db.updateUserPinAndBumpToken === "function") {
      newTv = Number(await db.updateUserPinAndBumpToken(phone, hashPin(newPin))) || 0;
    } else {
      await db.updateUserPin(phone, hashPin(newPin));
      if (typeof db.bumpTokenVersion === "function") await db.bumpTokenVersion(phone);
      const u0 = await db.getUser(phone); newTv = Number(u0 && u0.tokenVersion) || 0;
    }
    const u = await db.getUser(phone);
    res.json({ ok: true, userId: phone, name: (u && u.name) || "", token: signToken(phone, undefined, undefined, newTv) });
  } catch (e) { serverError(res, e); }
});

/* ---------------------- SECURITY QUESTION (logged-in user) ----------------------
   Lets a signed-in user set OR change their own security question — the recovery path for
   accounts made before this existed. The phone comes from the verified token, so a user can
   only ever set their OWN question. */
app.get("/api/security-question", requireAuth, async (req, res) => {
  try {
    const phone = stripPh(req.authUserId);   // token subject -> bare phone
    const q = typeof db.getSecurityQuestion === "function" ? await db.getSecurityQuestion(phone) : null;
    res.json({ ok: true, hasQuestion: !!q, question: q || null });
  } catch (e) { serverError(res, e); }
});

app.post("/api/security-question", requireAuth, async (req, res) => {
  try {
    const phone = stripPh(req.authUserId);
    const question = ((req.body && req.body.question) || "").trim();
    const answer = ((req.body && req.body.answer) || "").trim();
    if (!question || !answer) return res.status(400).json({ error: "A question and an answer are both required." });
    if (typeof db.updateSecurityQuestion !== "function") return res.status(500).json({ error: "not supported" });
    // Answer normalized (trim + lowercase) then bcrypt-hashed — never stored in plaintext.
    const answerHash = hashPin(answer.toLowerCase());
    await db.updateSecurityQuestion(phone, question, answerHash);
    res.json({ ok: true });
  } catch (e) { serverError(res, e); }
});

// Save/load a user's app state blob (automations, watchlists, wallets, profile).
app.post("/api/state", requireAuth, async (req, res) => {
  try {
    const state = (req.body && req.body.state && typeof req.body.state === "object" && !Array.isArray(req.body.state)) ? req.body.state : {};
    /* M-05: bound the app-state blob — it's an opaque per-user document, so cap its serialized size and the
       number of top-level sections to stop a corrupt/oversized/adversarial payload inflating DB rows/caches. */
    let size = 0; try { size = Buffer.byteLength(JSON.stringify(state)); } catch { size = Infinity; }
    if (size > 512 * 1024) return res.status(413).json({ error: "App state is too large to save." });
    if (Object.keys(state).length > 200) return res.status(400).json({ error: "App state has too many sections." });
    const userId = storageKeyFor(req.authUserId);   // from the verified token
    await db.saveState(userId, state);
    rcBust(`state:${userId}`);
    res.json({ ok: true });
  } catch (e) { serverError(res, e); }
});
app.get("/api/state", requireAuth, async (req, res) => {
  try {
    const userId = storageKeyFor(req.authUserId);   // from the verified token
    const state = await rcWrap(`state:${userId}`, () => db.getState(userId));
    res.json({ state });
  } catch (e) { serverError(res, e); }
});

/* Per-user saved screeners ("My Screeners") — survive logout / new device. The client sends its
   whole list; we store it whole (small). */
app.get("/api/screeners", requireAuth, async (req, res) => {
  try { res.json({ screeners: await db.getScreeners(storageKeyFor(req.authUserId)) }); }
  catch (e) { serverError(res, e); }
});
app.post("/api/screeners", requireAuth, async (req, res) => {
  try {
    const list = Array.isArray(req.body && req.body.screeners) ? req.body.screeners.slice(0, 100) : [];
    await db.saveScreeners(storageKeyFor(req.authUserId), list);
    res.json({ ok: true });
  } catch (e) { serverError(res, e); }
});

/* ================================ ADMIN ================================== */
/* Locked behind TWO checks: the caller's userId must be in ADMIN_USER_IDS, AND they must
   present the ADMIN_KEY secret. Both are required — a leaked key alone, or a known admin
   userId alone, is not enough. Set ADMIN_USER_IDS (comma-separated) and ADMIN_KEY in env. */
function isAdmin(req) {
  const adminIds = String(process.env.ADMIN_USER_IDS || "").split(",").map((x) => stripPh(x.trim())).filter(Boolean);
  const adminKey = process.env.ADMIN_KEY || "";
  const key = req.get("X-Admin-Key") || req.query.key || "";
  if (!adminKey || !adminIds.length) return false;       // admin not configured -> no access
  // IDENTITY MUST COME FROM A VERIFIED TOKEN, never the spoofable X-User-Id header. Two factors are
  // required: (1) the token's subject is in the admin list AND (2) the shared admin key matches.
  let uid = req.authUserId ? stripPh(req.authUserId) : null;
  if (!uid) {
    const h = req.get("Authorization") || "";
    const tok = h.startsWith("Bearer ") ? h.slice(7) : "";   // M-01: header only, never query string
    const v = verifyToken(tok);
    if (v) uid = stripPh(v.userId);
  }
  return !!uid && adminIds.includes(uid) && key === adminKey;
}
function requireAdmin(req, res) {
  if (!isAdmin(req)) { res.status(403).json({ error: "Forbidden" }); return false; }
  return true;
}

// List all users (basic records, no PINs).
app.get("/api/admin/users", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try { res.json({ users: await db.listUsers() }); }
  catch (e) { serverError(res, e); }
});

// Full detail on one user: profile, saved state (strategies + onboarding answers), trades.
app.get("/api/admin/user", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const phone = cleanPhone(req.query.phone);
    const full = await db.getUserFull(phone);
    if (!full) return res.status(404).json({ error: "user not found" });
    res.json(full);
  } catch (e) { serverError(res, e); }
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
  } catch (e) { serverError(res, e); }
});

// ADMIN: wipe a specific user's VIRTUAL (paper) trade history. Real broker trades are NEVER touched.
app.post("/api/admin/clear-virtual", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const phone = cleanPhone(req.body && req.body.phone);
    if (!phone) return res.status(400).json({ error: "phone required" });
    const removed = await db.clearVirtualTrades(storageKeyFor(phone));
    res.json({ ok: true, phone, removed });
  } catch (e) { serverError(res, e); }
});

/* ADMIN: wipe ONE trade type's history for a user — Manual / Auto Buy / Screener Auto Buy / Automate.
   `scope` = "virtual" (default), "real", or "all". This clears only the JOURNAL rows behind the
   dashboard/history; it does NOT place any broker order, close any real position, or touch the server's
   managed positions / armed strategies. Used to drop phantom or duplicated journal records so the
   displayed P&L reflects reality. Real broker holdings are unaffected. */
const CLEARABLE_TYPES = new Set(["Manual", "Auto Buy", "Screener Auto Buy", "Automate"]);
const CLEAR_SCOPES = new Set(["virtual", "real", "all"]);
app.post("/api/admin/clear-trades", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const phone = cleanPhone(req.body && req.body.phone);
    const tradeType = String((req.body && req.body.tradeType) || "");
    const scope = String((req.body && req.body.scope) || "virtual");
    if (!phone) return res.status(400).json({ error: "phone required" });
    if (!CLEARABLE_TYPES.has(tradeType)) return res.status(400).json({ error: "invalid tradeType" });
    if (!CLEAR_SCOPES.has(scope)) return res.status(400).json({ error: "invalid scope" });
    const removed = await db.clearTradesByType(storageKeyFor(phone), tradeType, scope);
    logFinancial("admin.clearTrades", { phone: storageKeyFor(phone), tradeType, scope, removed });
    res.json({ ok: true, phone, tradeType, scope, removed });
  } catch (e) { serverError(res, e); }
});

// Accounts awaiting approval.
app.get("/api/admin/pending-users", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try { res.json({ users: typeof db.listPendingUsers === "function" ? await db.listPendingUsers() : [] }); }
  catch (e) { serverError(res, e); }
});
// Approve (activate) or un-approve a signup.
app.post("/api/admin/approve", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const phone = cleanPhone(req.body && req.body.phone);
    const approved = req.body && req.body.approved === false ? false : true;
    if (!phone) return res.status(400).json({ error: "phone required" });
    /* R19-P2-03 / R20-P2-01: UN-approval is ONE financial kill and must not report success unless every part
       is durable. Approval flip + token-version rotation happen ATOMICALLY (one DB write); then the entry
       halt is set and, if THAT can't be persisted, we FAIL CLOSED (503) rather than returning success with the
       kill-switch absent. Auto-buy already refuses to enter for approved!==true; this kills live tokens too. */
    if (!approved) {
      if (typeof db.unapproveUserAndRevoke === "function") {
        await db.unapproveUserAndRevoke(phone);
      } else {
        await db.setUserApproved(phone, false);
        if (typeof db.bumpTokenVersion === "function") await db.bumpTokenVersion(phone);
      }
      try { await db.setEntryHalt(storageKeyFor(phone), true); }
      catch { return res.status(503).json({ error: "Un-approved and tokens revoked, but the automated-entry halt could not be saved — retry so nothing keeps trading." }); }
    } else {
      await db.setUserApproved(phone, true);
    }
    res.json({ ok: true, phone, approved });
  } catch (e) { serverError(res, e); }
});

/* Verify the login PIN for a step-up action (e.g. entering Real mode / placing a real order).
   Identity comes from the verified token; the PIN is checked against its bcrypt hash. */
app.post("/api/pin/verify", requireAuth, async (req, res) => {
  try {
    const phone = stripPh(req.authUserId);
    const pin = req.body && req.body.pin;
    if (!pin) return res.status(400).json({ error: "PIN required" });
    const lock = pinLockState(phone);
    if (lock.locked) return res.status(429).json({ error: `Too many wrong PINs. Try again in ${Math.ceil(lock.retrySec / 60)} min.` });
    const u = await db.getUser(phone);
    if (!u) return res.status(404).json({ error: "user not found" });
    const ok = verifyPin(pin, u.pin) === true;
    if (ok) clearPinFails(phone); else recordPinFail(phone);
    res.json({ ok });
  } catch (e) { serverError(res, e); }
});

/* Change your OWN login PIN — requires the CURRENT PIN (so a stolen session can't silently
   change it), derives identity from the verified token, and stores the new PIN bcrypt-hashed. */
app.post("/api/pin/change", requireAuth, async (req, res) => {
  try {
    const phone = stripPh(req.authUserId);
    const currentPin = req.body && req.body.currentPin;
    const newPin = req.body && req.body.newPin;
    if (!currentPin || !newPin) return res.status(400).json({ error: "Current and new PIN are both required." });
    if (!/^\d{4,6}$/.test(String(newPin))) return res.status(400).json({ error: "New PIN must be 4–6 digits." });
    if (String(newPin) === String(currentPin)) return res.status(400).json({ error: "New PIN must be different from the current one." });
    const lock = pinLockState(phone);
    if (lock.locked) return res.status(429).json({ error: `Too many wrong PINs. Try again in ${Math.ceil(lock.retrySec / 60)} min.` });
    const u = await db.getUser(phone);
    if (!u) return res.status(404).json({ error: "user not found" });
    if (!verifyPin(currentPin, u.pin)) { recordPinFail(phone); return res.status(401).json({ error: "Your current PIN is incorrect." }); }
    clearPinFails(phone);
    /* C2-02 / R19-P2-01: change the PIN and revoke every existing token in ONE atomic write, then issue one
       fresh token to THIS device. The atomic helper returns the new token_version so there's no window where
       the PIN is changed but old tokens still validate (the previous two-call sequence could crash between). */
    let newTv = 0;
    if (typeof db.updateUserPinAndBumpToken === "function") {
      newTv = Number(await db.updateUserPinAndBumpToken(phone, hashPin(newPin))) || 0;
    } else {
      await db.updateUserPin(phone, hashPin(newPin));
      if (typeof db.bumpTokenVersion === "function") { try { await db.bumpTokenVersion(phone); } catch { /* non-fatal */ } }
      const nu = await db.getUser(phone); newTv = Number(nu && nu.tokenVersion) || 0;
    }
    res.json({ ok: true, token: signToken(phone, undefined, undefined, newTv) });
  } catch (e) { serverError(res, e); }
});

// Admin backstop: reset any user's PIN. The last-resort recovery when a user can't answer
// their security question (or never set one).
app.post("/api/admin/reset-pin", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const phone = cleanPhone(req.body && req.body.phone);
    const newPin = req.body && req.body.newPin;
    if (!phone || !newPin || String(newPin).length < 4) return res.status(400).json({ error: "phone and a 4+ digit newPin are required." });
    if (!(await db.getUser(phone))) return res.status(404).json({ error: "user not found" });
    // M-02 / R19-P2-01: an admin PIN reset revokes the user's existing tokens too — atomically.
    if (typeof db.updateUserPinAndBumpToken === "function") {
      await db.updateUserPinAndBumpToken(phone, hashPin(newPin));
    } else {
      await db.updateUserPin(phone, hashPin(newPin));
      if (typeof db.bumpTokenVersion === "function") { try { await db.bumpTokenVersion(phone); } catch { /* non-fatal */ } }
    }
    res.json({ ok: true, phone });
  } catch (e) { serverError(res, e); }
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
/* Two-layer: `cache` holds resolved values for ttlMs; `inflight` holds the promise of a fetch
   that is CURRENTLY running. The inflight layer is the rate-limit saver — without it, N requests
   for the same symbol arriving before the first fetch resolves would each fire their own upstream
   call (Yahoo / indianapi), multiplying load exactly when it's busiest. Now they share one call. */
const cache = new Map();
const inflight = new Map();
function memo(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return Promise.resolve(hit.v);
  const pending = inflight.get(key);
  if (pending) return pending;                    // a fetch for this key is already running — join it
  const p = Promise.resolve().then(fn)
    .then((v) => { cache.set(key, { v, t: Date.now() }); inflight.delete(key); return v; })
    .catch((e) => { inflight.delete(key); throw e; });
  inflight.set(key, p);
  return p;
}
/* ------------------------------ read cache ------------------------------
   The app polls a handful of per-user GET endpoints (autoexit, autobuy, state, trades) on a timer.
   This tiny in-memory cache collapses repeated reads within a short TTL so they don't each hit
   Postgres — the main lever for keeping DB data-transfer low. Writes for a user bust that user's keys,
   and the TTL is short enough that background engine changes still surface quickly. */
const READ_CACHE = new Map();                       // key -> { at, data }
const READ_TTL_MS = Math.max(3000, Number(process.env.READ_CACHE_MS) || 8000);
function rcGet(key) { const e = READ_CACHE.get(key); return (e && Date.now() - e.at < READ_TTL_MS) ? e.data : undefined; }
function rcSet(key, data) { READ_CACHE.set(key, { at: Date.now(), data }); return data; }
function rcBust(prefix) { for (const k of READ_CACHE.keys()) { if (k === prefix || k.startsWith(prefix + ":")) READ_CACHE.delete(k); } }
/* Wrap a read: return the cached value if fresh, else run fn(), cache and return it. */
async function rcWrap(key, fn) { const hit = rcGet(key); if (hit !== undefined) return hit; return rcSet(key, await fn()); }

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

/* Yahoo's search returns loosely-related (often WRONG) news — EICHERMOT was showing IBM/Nvidia.
   Keep an item ONLY if it's genuinely about the symbol: its relatedTickers include the ticker,
   or the ticker appears as a whole word in the headline. Better to show fewer, correct stories. */
function symBase(s) { return String(s || "").replace(/\.(NS|BO|NSE|BSE)$/i, "").toUpperCase(); }
/* DELAYED FALLBACK FEED — serve Indian equity prices from BSE (.BO) instead of NSE (.NS).
   NSE's real-time data terms are stricter; the public/delayed BSE feed is the compliant fallback
   for users who haven't connected their own broker. Connected-broker users get THEIR broker's
   live feed via a separate path, so this only affects the non-connected fallback. The app keeps
   its .NS symbol as the key — we just fetch the .BO listing and return it under the original sym. */
function fallbackYF(sym) {
  const s = String(sym || "");
  return s.endsWith(".NS") ? s.slice(0, -3) + ".BO" : s;
}
function newsRelevant(a, sym) {
  const full = String(sym || "").toUpperCase();
  const base = symBase(sym);
  if (!base) return false;
  const rt = (a.relatedTickers || []).map((x) => String(x).toUpperCase());
  const titleHit = (minLen) => {
    try { return base.length >= minLen && new RegExp(`(^|[^A-Za-z0-9])${base}([^A-Za-z0-9]|$)`).test(String(a.title || "").toUpperCase()); }
    catch { return false; }
  };
  if (/\.(NS|BO)$/i.test(full)) {
    // INDIAN ticker. Strongest signal: the exact .NS/.BO ticker (or its US-less base) in
    // relatedTickers. But Yahoo frequently returns real Indian headlines WITHOUT tagging the
    // exchange ticker — which used to filter everything out ("no headlines"). So also accept a
    // DISTINCTIVE headline match: require length >= 4 so a short, ambiguous base (HAL, MRF) can't
    // pull in a US namesake's story, while RELIANCE / EICHERMOT / INFOSYS still match by name.
    // Accept ONLY the exchange-qualified ticker — a bare base match (e.g. "BDL") pulls in a US
    // namesake's story (Bharat Dynamics BDL.NS ≠ the US "BDL"). Distinctive names still match below.
    if (rt.includes(full) || rt.includes(base + ".NS") || rt.includes(base + ".BO")) return true;
    return titleHit(4);
  }
  // US / crypto: relatedTickers base match, or the ticker as a whole word in the headline.
  if (rt.includes(base)) return true;
  return titleHit(3);
}
/* Whole-word match of a company NAME or ticker BASE inside a headline/description. NewsAPI tags
   stories by company name ("Intel", "Reliance"), not the ticker, so a raw keyword search on the
   symbol returns unrelated stories — this is what strictly limits results to the actual company.
   Multi-word names also match on their distinctive first word (Reliance Industries -> "Reliance"). */
function newsTextMatch(text, name, base) {
  const T = String(text || "").toUpperCase();
  const cands = new Set();
  if (name) {
    const nm = String(name).trim().toUpperCase();
    if (nm.length >= 3) cands.add(nm);
    const first = nm.split(/\s+/)[0];
    if (first && first.length >= 4) cands.add(first);   // distinctive first word only (skip "THE", "HDFC" is 4+)
  }
  if (base && base.length >= 3) cands.add(String(base).toUpperCase());
  for (const c of cands) {
    try { if (new RegExp(`(^|[^A-Za-z0-9])${c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9]|$)`).test(T)) return true; }
    catch { /* skip bad pattern */ }
  }
  return false;
}
app.get("/api/news/feed", async (req, res) => {
  // Each entry may be "SYM|Company Name". The NAME is what makes Indian coverage work: most Indian
  // headlines say the company name ("Infosys"), not the ticker ("INFY"), so a ticker-only match
  // collapsed the whole feed to the handful of stocks whose base literally appears in headlines
  // (RELIANCE). With the name we search Yahoo by name and match headlines by name too.
  const entries = String(req.query.symbols || "").split(",").map((x) => x.trim()).filter(Boolean).slice(0, 30)
    .map((e) => { const i = e.indexOf("|"); return i === -1 ? { sym: e, name: "" } : { sym: e.slice(0, i), name: e.slice(i + 1).trim() }; });
  const onlyTagged = String(req.query.tagged || "") === "1";
  if (!entries.length) return res.status(400).json({ error: "symbols required" });

  try {
    const per = await Promise.all(entries.map(async ({ sym, name }) => {
      try {
        const base = symBase(sym);
        const q = (name && name.length >= 3) ? name : base;   // search by company name when we have it
        const items = await memo(`nf:${sym}:${q}`, 300_000, async () => {
          const u = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&newsCount=20&quotesCount=0`;
          const d = await j(u);
          return (d.news || []).filter((a) => newsRelevant(a, sym) || newsTextMatch(a.title, name, base)).map((a) => ({
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
      .slice(0, 60);

    res.json({ news: all, count: all.length });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

/* ───────────────────────── FYERS house price feed (optional) ─────────────────────────
   When configured, the server holds its OWN FYERS token and serves Indian equity quotes
   from FYERS for EVERY user — no per-user broker connection, and no dependence on Yahoo
   for Indian prices. It's opt-in and self-healing: if the token is missing, expired, or a
   call fails, we silently fall back to Yahoo, so nothing breaks when it isn't set up.

   Set on the server (Render):
     FYERS_APP_ID, FYERS_SECRET_ID     — your FYERS API v3 app
     FYERS_REFRESH_TOKEN, FYERS_PIN    — one-time interactive login gives a refresh token
                                         (valid ~15 days) + your login PIN; the server mints
                                         fresh access tokens from these automatically.
     FYERS_ACCESS_TOKEN (alt)          — or drop in a daily access token directly (expires
                                         in ~24h; refresh the var each day).                */
const FY_HOST = "https://api-t1.fyers.in";
let _fyHouse = { token: null, at: 0 };
let _fyLastError = null;      // surfaced by /api/feeds-status for debugging
let _deltaLastError = null;
let _fyDebug = null;          // safe (no secrets): shapes + raw FYERS response
let _fyCooldownUntil = 0;     // don't retry the mint until this time (avoids hammering FYERS -> 429)
let _fyLoginInflight = null;  // single-flight: the in-progress TOTP login promise (prevents concurrent
                              // logins racing and invalidating each other's single-use auth code)

/* The standalone undici (from package.json). We must use ITS fetch when routing through a
   ProxyAgent it created — mixing a standalone-undici dispatcher with Node's built-in fetch
   throws "invalid onError method" (their internal handler interfaces differ). */
let _undici = null;
try { _undici = require("undici"); } catch (e) { console.error("[proxy] undici not available:", e.message); }
/* A fetch that uses undici's OWN fetch when a dispatcher is supplied; otherwise the global one. */
function pfetch(url, opts = {}) {
  if (opts && opts.dispatcher && _undici && typeof _undici.fetch === "function") return _undici.fetch(url, opts);
  return fetch(url, opts);
}

/* Build an undici ProxyAgent from a proxy URL (credentials sent as Proxy-Authorization). */
function makeProxyDispatcher(url) {
  if (!url || !_undici) return null;
  try {
    const { ProxyAgent } = _undici;
    const u = new URL(url);
    /* connect options for the socket TO THE PROXY. Two things bit us on Render:
       (1) IPv6 trap: if the proxy host has an AAAA record, undici tries IPv6 first, but Render
           has no IPv6 egress, so the SYN times out (ETIMEDOUT) — while `curl` succeeds because
           it does Happy Eyeballs. `autoSelectFamily` makes undici race v4/v6 like curl.
       (2) Render(US)->proxy handshake can exceed undici's default 10s connect timeout on a cold
           socket, so give it more room. */
    /* Force IPv4 to the proxy. Render has IPv4 egress but not reliable IPv6; if undici tries the
       host's AAAA record it hangs -> ETIMEDOUT, while curl (Happy Eyeballs) falls back to v4.
       The proxy host has an A record (curl reaches it), so pinning family:4 removes the ambiguity. */
    const opts = {
      uri: `${u.protocol}//${u.host}`,
      connect: { timeout: 20000, family: 4 },
    };
    if (u.username || u.password) {
      const cred = Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString("base64");
      opts.token = `Basic ${cred}`;
    }
    return new ProxyAgent(opts);
  } catch (e) { console.error("[fyers-proxy] init failed:", e.message); return null; }
}
/* FYERS "Static IP" apps only accept calls from whitelisted IPs. Route FYERS house-feed
   traffic through a proxy that exits from those IPs. Set FYERS_PROXY_URL to the FYERS-specific
   proxy (its exit IP must match what's whitelisted in the FYERS app). If unset, FYERS calls go
   DIRECT (from the server's own IP). We deliberately do NOT fall back to the Delta proxy —
   its exit IP differs and would fail the FYERS whitelist. */
const fyersDispatcher = makeProxyDispatcher(process.env.FYERS_PROXY_URL || "");
const fyFetchOpts = fyersDispatcher ? { dispatcher: fyersDispatcher } : {};
/* Every FYERS API call MUST exit from the whitelisted IP — especially ORDER placement, which FYERS
   rejects outright otherwise ("Orders are only allowed from whitelisted IP addresses"). Route them
   all through the proxy dispatcher; when no proxy is configured this is a plain fetch. */
function fyFetch(url, opts) { return pfetch(url, { ...(opts || {}), ...fyFetchOpts }); }

/* RFC-6238 TOTP (HMAC-SHA1, 30s step, 6 digits) from a base32 secret — the same 6-digit code your
   authenticator app shows. Dependency-free so we can log into FYERS unattended. */
function totpCode(secretB32, atMs = Date.now()) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of String(secretB32 || "").toUpperCase().replace(/[^A-Z2-7]/g, "")) bits += A.indexOf(ch).toString(2).padStart(5, "0");
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  let counter = Math.floor(atMs / 1000 / 30);
  const cb = Buffer.alloc(8);
  for (let i = 7; i >= 0; i--) { cb[i] = counter & 0xff; counter = Math.floor(counter / 256); }
  const h = crypto.createHmac("sha1", Buffer.from(bytes)).update(cb).digest();
  const o = h[h.length - 1] & 0xf;
  const code = ((h[o] & 0x7f) << 24) | ((h[o + 1] & 0xff) << 16) | ((h[o + 2] & 0xff) << 8) | (h[o + 3] & 0xff);
  return (code % 1000000).toString().padStart(6, "0");
}

/* Fully-automated FYERS login using the TOTP secret + PIN — the ONLY way to keep the house feed
   alive now that FYERS disabled the refresh-token API (SEBI). Mirrors the manual login: send OTP →
   verify TOTP → verify PIN → get auth code → exchange for an access token. Needs FYERS_FY_ID,
   FYERS_TOTP_SECRET, FYERS_PIN, FYERS_APP_ID (full, e.g. 0YCNKL9SRQ-200), FYERS_SECRET_ID,
   FYERS_REDIRECT_URI. Returns the daily access token, or null if not configured. */
async function fyersLoginTOTP() {
  const fyId = (process.env.FYERS_FY_ID || "").trim();
  const totpSecret = (process.env.FYERS_TOTP_SECRET || "").trim();
  const pin = (process.env.FYERS_PIN || "").trim();
  const appId = (process.env.FYERS_APP_ID || "").trim();
  const secret = (process.env.FYERS_SECRET_ID || "").trim();
  const redirect = (process.env.FYERS_REDIRECT_URI || "").trim();
  if (!fyId || !totpSecret || !pin || !appId || !secret || !redirect) return null;
  const dash = appId.lastIndexOf("-");
  const appCore = dash > 0 ? appId.slice(0, dash) : appId;
  const appType = dash > 0 ? appId.slice(dash + 1) : "100";
  const b64 = (s) => Buffer.from(String(s)).toString("base64");
  // OTP steps live on api-t2 vagator/v2; the auth-code exchange is on api.fyers.in/api/v2/token
  // (both confirmed against the current working FYERS TOTP flow — api-t1 vagator now 404s).
  const V = "https://api-t2.fyers.in/vagator/v2";
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
  const post = async (url, body, headers) => {
    const r = await pfetch(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": UA, ...(headers || {}) }, body: JSON.stringify(body), ...fyFetchOpts });
    // Capture status + raw body so a geo-block/HTML page (non-JSON) is visible in _fyDebug
    // instead of collapsing to an opaque {}. __status / __raw are stripped before use.
    const text = await r.text().catch(() => "");
    let j = {}; try { j = text ? JSON.parse(text) : {}; } catch { j = {}; }
    return { ...j, __status: r.status, __raw: (text || "").slice(0, 300) };
  };
  // 1. request an OTP session
  let r = await post(`${V}/send_login_otp_v2`, { fy_id: b64(fyId), app_id: "2" });
  if (!r.request_key) {
    // Surface exactly what FYERS returned (status + first 300 chars) — usually a geo/IP block
    // shows as HTTP 403/503 with an HTML or empty body; a real API error carries a JSON message.
    _fyDebug = { step: "send_login_otp_v2", proxied: Boolean(fyersDispatcher), fyIdLen: fyId.length, status: r.__status, raw: r.__raw };
    throw new Error("send_otp: " + (r.message || (r.__status ? `HTTP ${r.__status} ${r.__raw || "(empty body)"}` : JSON.stringify(r))));
  }
  // 2. verify the TOTP (retry once past the 30s boundary if FYERS says invalid)
  let key = r.request_key;
  r = await post(`${V}/verify_otp`, { request_key: key, otp: totpCode(totpSecret) });
  if (!r.request_key) { await new Promise((res) => setTimeout(res, 1200)); r = await post(`${V}/verify_otp`, { request_key: key, otp: totpCode(totpSecret) }); }
  if (!r.request_key) throw new Error("verify_otp: " + (r.message || JSON.stringify(r)));
  // 3. verify the PIN -> short-lived bearer for the token step
  r = await post(`${V}/verify_pin_v2`, { request_key: r.request_key, identity_type: "pin", identifier: b64(pin) });
  const vTok = r.data && r.data.access_token;
  if (!vTok) throw new Error("verify_pin: " + (r.message || JSON.stringify(r)));
  // 4. exchange for an auth code. FYERS answers on api.fyers.in/api/v2/token with a 308 whose
  //    JSON body carries { Url: "<redirect_uri>?auth_code=..." }; after the redirect is followed
  //    the final response URL also carries the auth_code — read whichever we can get.
  //    NOTE: appType here is the PLATFORM type for the login flow and is ALWAYS "100" — it is NOT
  //    the app-id suffix. A "-200" app still logs in with appType "100"; the -200 suffix only
  //    matters for the appIdHash (full appId:secret) used in the validate-authcode step below.
  const LOGIN_APP_TYPE = "100";
  const tokenBody = { fyers_id: fyId, app_id: appCore, redirect_uri: redirect, appType: LOGIN_APP_TYPE, code_challenge: "", state: "matrix", scope: "", nonce: "", response_type: "code", create_cookie: true };
  const tres = await pfetch("https://api.fyers.in/api/v2/token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": UA, Authorization: `Bearer ${vTok}` },
    body: JSON.stringify(tokenBody),
    ...fyFetchOpts,
  });
  let authCode = null;
  const tText = await tres.text().catch(() => "");
  try { const tj = tText ? JSON.parse(tText) : {}; const u = tj.Url || tj.url; if (u) authCode = new URL(u).searchParams.get("auth_code"); } catch { /* not JSON — try the redirected URL */ }
  if (!authCode) { try { authCode = new URL(tres.url).searchParams.get("auth_code"); } catch { /* no query */ } }
  if (!authCode) {
    _fyDebug = { step: "token", status: tres.status, sentAppId: appCore, sentAppType: LOGIN_APP_TYPE, appIdSuffix: appId.slice(-6), raw: (tText || "").slice(0, 300) };
    throw new Error("token: HTTP " + tres.status + " — no auth_code (" + ((tText || "").slice(0, 120) || "empty body") + ")");
  }
  // 5. validate the auth code -> the API access token we actually use
  const appIdHash = crypto.createHash("sha256").update(`${appId}:${secret}`).digest("hex");
  const vac = await post("https://api-t1.fyers.in/api/v3/validate-authcode", { grant_type: "authorization_code", appIdHash, code: authCode });
  if (!vac.access_token) throw new Error("validate-authcode: " + (vac.message || JSON.stringify(vac)));
  return vac.access_token;
}

async function fyersHouseToken() {
  if (_fyHouse.token && (Date.now() - _fyHouse.at) < 12 * 3600 * 1000) return _fyHouse.token;
  // PREFERRED now: fully-automated TOTP login (refresh-token API is disabled by SEBI). Cached 12h.
  if ((process.env.FYERS_TOTP_SECRET || "").trim()) {
    if (Date.now() < _fyCooldownUntil) return _fyHouse.token || null;
    try {
      // SINGLE-FLIGHT: if a login is already running (e.g. a quote poll and a history request both
      // wake up cold at the same time), await THAT one instead of starting a second. Two concurrent
      // TOTP logins each mint an auth code and FYERS invalidates the loser — the classic intermittent
      // "validate-authcode: invalid auth code". One login at a time removes that race entirely.
      if (!_fyLoginInflight) {
        _fyLoginInflight = (async () => {
          try { return await fyersLoginTOTP(); }
          catch (e) {
            const msg = String((e && e.message) || e);
            // Retry ONCE on the transient errors: a single-use auth code that lost a race, or a soft
            // Cloudflare rate-limit (429/1015). Wait past the 30s TOTP window so the retry uses a
            // fresh 6-digit code + a fresh auth code.
            if (/invalid auth code|rate.?limit|error 1015|\b1015\b|send_otp/i.test(msg)) {
              await new Promise((r) => setTimeout(r, 2000));
              return await fyersLoginTOTP();
            }
            throw e;
          }
        })().finally(() => { _fyLoginInflight = null; });
      }
      const tok = await _fyLoginInflight;
      if (tok) { _fyHouse = { token: tok, at: Date.now() }; _fyLastError = null; _fyCooldownUntil = 0; return tok; }
    } catch (e) {
      _fyLastError = "totp-login: " + e.message;
      _fyCooldownUntil = Date.now() + 5 * 60 * 1000;   // back off 5 min on failure
      console.error("[fyers-house]", _fyLastError);
      // fall through to the manual/refresh paths below in case those are configured
    }
  }
  // A directly-provided daily access token WINS — no minting, no refresh-token flow, no rate
  // limit. Set FYERS_ACCESS_TOKEN to bypass the refresh flow entirely (re-set it each day).
  const directTok = (process.env.FYERS_ACCESS_TOKEN || "").trim();
  if (directTok) { _fyHouse = { token: directTok, at: Date.now() }; _fyLastError = null; return directTok; }
  // After a failure we back off, so a bad/expired token can't spam FYERS on every quote poll.
  if (Date.now() < _fyCooldownUntil) return null;
  // .trim() guards against a stray newline/space pasted into the Render env value.
  const appId = (process.env.FYERS_APP_ID || "").trim();
  const secret = (process.env.FYERS_SECRET_ID || "").trim();
  const refresh = (process.env.FYERS_REFRESH_TOKEN || "").trim();
  const pin = (process.env.FYERS_PIN || "").trim();
  if (appId && secret && refresh && pin) {
    try {
      const appIdHash = crypto.createHash("sha256").update(`${appId}:${secret}`).digest("hex");
      const r = await pfetch(`${FY_HOST}/api/v3/validate-refresh-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grant_type: "refresh_token", appIdHash, refresh_token: refresh, pin }),
        ...fyFetchOpts,
      });
      const d = await r.json().catch(() => ({}));
      // Shapes only — never the secret values themselves.
      _fyDebug = {
        appIdLen: appId.length, appIdSuffix: appId.slice(-4),
        secretLen: secret.length,
        refreshLen: refresh.length, refreshPrefix: refresh.slice(0, 4), refreshHasSpace: /\s/.test(refresh),
        pinLen: pin.length,
        httpStatus: r.status, fyersResponse: d,
      };
      if (r.ok && d.access_token) { _fyHouse = { token: d.access_token, at: Date.now() }; _fyLastError = null; _fyCooldownUntil = 0; return d.access_token; }
      _fyLastError = "refresh-token exchange: " + (d.message || d.s || ("HTTP " + r.status));
      // 429 = rate-limited: back off HARD (10 min). Other failures: back off 2 min.
      _fyCooldownUntil = Date.now() + (r.status === 429 ? 10 * 60 * 1000 : 2 * 60 * 1000);
      console.error("[fyers-house]", _fyLastError);
    } catch (e) { _fyLastError = "refresh error: " + e.message; _fyCooldownUntil = Date.now() + 2 * 60 * 1000; console.error("[fyers-house]", _fyLastError); }
  } else {
    _fyLastError = "not configured (need FYERS_APP_ID, FYERS_SECRET_ID, FYERS_REFRESH_TOKEN, FYERS_PIN — or FYERS_ACCESS_TOKEN)";
  }
  const staticTok = process.env.FYERS_ACCESS_TOKEN || "";
  if (staticTok) { _fyHouse = { token: staticTok, at: Date.now() }; return staticTok; }
  return null;
}

// Yahoo symbol -> FYERS symbol. Only cash equities map cleanly; indices/others return null
// (and therefore stay on Yahoo).
// Yahoo index tickers -> FYERS index symbols, so indices (NIFTY50, BANKNIFTY, …) go through the FYERS
// house feed instead of falling back to Yahoo. FYERS lists indices as "<EXCH>:<NAME>-INDEX".
const FYERS_INDEX = {
  "^NSEI": "NSE:NIFTY50-INDEX",
  "^NSEBANK": "NSE:NIFTYBANK-INDEX",
  "^NSEFIN": "NSE:FINNIFTY-INDEX",
  "^CNXFIN": "NSE:FINNIFTY-INDEX",
  "^INDIAVIX": "NSE:INDIAVIX-INDEX",
  "^BSESN": "BSE:SENSEX-INDEX",
};
function yahooToFyers(ySym) {
  const s = String(ySym || "");
  if (FYERS_INDEX[s]) return FYERS_INDEX[s];
  if (s.endsWith(".NS")) return `NSE:${s.slice(0, -3)}-EQ`;
  if (s.endsWith(".BO")) return `BSE:${s.slice(0, -3)}-EQ`;
  return null;
}

/* ── Delta Exchange house crypto feed ─────────────────────────────────────────────────
   Same idea as the FYERS feed, for CRYPTO. Delta's /v2/tickers is PUBLIC (no keys, no
   signature), so this works out of the box with no configuration — it just gives crypto
   prices from Delta instead of Yahoo. "BTC-USD" -> Delta's "BTCUSD" perpetual. */
function yahooToDelta(ySym) {
  /* Accept every shape the app might send for a crypto quote and normalise to Delta's
     "<COIN>USD" perpetual, so crypto prices come from DELTA and never silently fall back to
     Yahoo on a format mismatch:
       BTC-USD  (yahoo)      -> BTCUSD
       BTCUSDT  (binance fmt)-> BTCUSD
       BTCUSD   (broker fmt) -> BTCUSD   <-- the frontend was sending this; the old regex missed it */
  const s = String(ySym || "").toUpperCase().replace(/\.P$/, "");
  let m = s.match(/^([A-Z0-9]+)-USDT?$/); if (m) return `${m[1]}USD`;
  m = s.match(/^([A-Z0-9]+?)USDT$/);      if (m) return `${m[1]}USD`;
  m = s.match(/^([A-Z0-9]+?)USD$/);       if (m) return `${m[1]}USD`;
  return null;
}
/* Best-effort crypto symbol -> Delta perpetual, INCLUDING a bare coin ("LAB" -> "LABUSD").
   Only used as a LAST-RESORT candle fallback (after Yahoo returns nothing), so a non-crypto
   symbol that slips through just 404s on Delta and yields no candles — never a wrong instrument. */
function deltaPerpFromAny(sym) {
  const d = yahooToDelta(sym);
  if (d) return d;
  const s = String(sym || "").toUpperCase().replace(/\.P$/, "");
  return /^[A-Z0-9]{2,15}$/.test(s) ? `${s}USD` : null;
}
/* Yahoo interval -> Delta candle resolution (Delta speaks 1m/5m/15m/30m/1h/2h/4h/1d/1w/30d…). */
function deltaResolution(interval) {
  const map = { "1m": "1m", "2m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "60m": "1h", "1h": "1h", "90m": "1h", "1d": "1d", "1wk": "1w", "1mo": "30d" };
  return map[String(interval)] || "1d";
}
async function deltaHouseQuotes(ySyms) {
  const pairs = ySyms.map((y) => [y, yahooToDelta(y)]).filter(([, d]) => d);
  if (!pairs.length) return {};
  try {
    // Per-symbol public ticker (verified working). One call per crypto symbol, memoised 15s.
    const out = {};
    await Promise.all(pairs.map(async ([y, ds]) => {
      try {
        const d = await memo(`delta:${ds}`, 15_000, () =>
          j(`${DELTA_BASE}/v2/tickers/${encodeURIComponent(ds)}`));
        const t = d && d.result;
        if (!t) return;
        const price = t.mark_price != null ? Number(t.mark_price)
                    : t.close != null ? Number(t.close)
                    : t.spot_price != null ? Number(t.spot_price) : null;
        const open = t.open != null ? Number(t.open) : null;
        if (price != null) out[y] = { sym: y, name: y, price, chg: open ? +(((price - open) / open) * 100).toFixed(2) : 0, currency: "USD", src: "delta" };
      } catch (e) { _deltaLastError = "ticker " + ds + ": " + e.message; }
    }));
    if (Object.keys(out).length) _deltaLastError = null;
    return out;
  } catch { return {}; }
}

/* ── EQUITY HOUSE FEED SWITCH ──────────────────────────────────────────────────────────
   The FYERS (Indian) and IND Money (US) house feeds serve ONE server-held source's prices to
   EVERY user. That's a data-redistribution grey area (unlicensed), so by default it is OFF:
   a user who hasn't connected their own broker sees Yahoo (delayed) prices, and a CONNECTED
   user sees their OWN broker's live feed via the per-user session — the compliant model.
   Set EQUITY_HOUSE_FEED=true to re-enable the shared feed (e.g. once you hold a redistribution
   licence). The Delta CRYPTO feed is a genuinely PUBLIC endpoint and is never gated by this. */
const EQUITY_HOUSE_FEED = String(process.env.EQUITY_HOUSE_FEED || "").toLowerCase() === "true";

/* ── IND Money US house feed ──────────────────────────────────────────────────────────
   REAL-TIME US prices for ALL users (Yahoo is ~15 min delayed on US too). IND Money's
   public graph endpoint returns a live `price` plus intraday candles — no auth needed.
   A US symbol here is a plain ticker (AAPL, NVDA) — crypto is X-USD, Indian is X.NS.
   Gated by EQUITY_HOUSE_FEED (default OFF => non-connected users fall back to Yahoo). */
const INDM_US = "https://apixt-us.indmoney.com/us-stock-broker/us/catalog/get-stock-graph";
let _indmLastError = null;
const isUsTicker = (s) => /^[A-Z]{1,5}$/.test(String(s || ""));
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
async function indmoneyHouseQuotes(ySyms, owner = false) {
  if (!EQUITY_HOUSE_FEED && !owner) return {};   // gated off unless the global feed is on OR this is the house owner
  const us = (ySyms || []).filter(isUsTicker);
  if (!us.length) return {};
  const today = ymd(Date.now());
  const out = {};
  // Throttle to 6 at a time — firing 40+ concurrent requests made the feed flaky, which
  // silently fell back to (delayed) Yahoo. Each symbol is memoised 20s so polls stay cheap.
  await mapLimit(us, 6, async (sym) => {
    try {
      const d = await memo(`im:${sym}`, 20_000, () =>
        j(`${INDM_US}/${encodeURIComponent(sym)}?start_date=${today}&end_date=${today}&label=1D&response_format=json&currency=USD`));
      if (d && d.success && d.price != null) {
        out[sym] = { sym, name: sym, price: Number(d.price), chg: d["1d_percentage_chane"] != null ? Number(d["1d_percentage_chane"]) : 0, currency: "USD", src: "indmoney" };
      }
    } catch (e) { _indmLastError = "im " + sym + ": " + e.message; }
  });
  if (Object.keys(out).length) _indmLastError = null;
  return out;
}
async function indmoneyUsCandles(sym, range, owner = false) {
  if (!EQUITY_HOUSE_FEED && !owner) return null;   // gated unless the global feed is on OR this is the house owner
  const label = ({ "5d": "1W", "1mo": "1M", "3mo": "3M", "6mo": "6M", "1y": "1Y" })[range] || "1M";
  const end = ymd(Date.now());
  const start = ymd(Date.now() - rangeToSeconds(range) * 1000);
  const d = await j(`${INDM_US}/${encodeURIComponent(sym)}?start_date=${start}&end_date=${end}&label=${label}&response_format=json&currency=USD`);
  return ((d && d.candles) || []).map((c) => ({ t: c.ts * 1000, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume })).filter((x) => x.c != null);
}

// Quotes for the Indian-equity subset, keyed back by the ORIGINAL yahoo symbol.
async function fyersHouseQuotes(ySyms) {
  if (!EQUITY_HOUSE_FEED) return {};   // non-connected users fall back to Yahoo
  const token = await fyersHouseToken();
  if (!token) return {};
  const appId = process.env.FYERS_APP_ID || "";
  const pairs = ySyms.map((y) => [y, yahooToFyers(y)]).filter(([, f]) => f);
  if (!pairs.length) return {};
  try {
    const r = await pfetch(`${FY_HOST}/data/quotes?symbols=${encodeURIComponent(pairs.map(([, f]) => f).join(","))}`, {
      headers: { Authorization: `${appId}:${token}` },
      ...fyFetchOpts,
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.s === "error") {
      if (d.code === -16 || /token/i.test(d.message || "")) _fyHouse = { token: null, at: 0 };   // force re-mint next time
      _fyLastError = "quotes: " + (d.message || ("HTTP " + r.status));
      console.error("[fyers-house]", _fyLastError);
      return {};
    }
    const byFy = {};
    (d.d || []).forEach((row) => { byFy[row.n] = row.v || {}; });
    const out = {};
    for (const [y, f] of pairs) {
      const v = byFy[f];
      if (v && v.lp != null) out[y] = { sym: y, name: y, price: v.lp, chg: v.chp != null ? +Number(v.chp).toFixed(2) : 0, currency: "INR", src: "fyers" };
    }
    if (Object.keys(out).length) _fyLastError = null;
    return out;
  } catch (e) { _fyLastError = "quotes error: " + e.message; console.error("[fyers-house]", _fyLastError); return {}; }
}

/* ── MCX (Indian commodity) house feed ──────────────────────────────────────────────────
   OPT-IN via MCX_HOUSE_FEED. When on (and a FYERS house token exists), commodity quotes come from
   the near-month MCX futures contract in INR instead of COMEX/NYMEX in USD. MCX contracts roll
   monthly, so we read FYERS' public symbol master to resolve the current contract per underlying.
   Everything degrades to COMEX/Yahoo: no token, feed off, master unreachable, or symbol not
   mappable all simply return {} and the caller prices the instrument the old way. */
const MCX_MASTER_URL = process.env.MCX_MASTER_URL || "https://public.fyers.in/sym_details/MCX_COM.csv";
const mcxFeedOn = () => /^(true|1|yes)$/i.test(String(process.env.MCX_HOUSE_FEED || ""));
let _mcxRows = { rows: null, at: 0 };
async function mcxSymbolRows() {
  // Cache the parsed master for 12h — it only changes when contracts roll (monthly).
  if (_mcxRows.rows && (Date.now() - _mcxRows.at) < 12 * 3600 * 1000) return _mcxRows.rows;
  try {
    const r = await pfetch(MCX_MASTER_URL, fyFetchOpts);
    const txt = await r.text();
    const rows = mcx.parseSymbolMaster(txt);
    if (rows.length) { _mcxRows = { rows, at: Date.now() }; return rows; }
  } catch (e) { _fyLastError = "mcx master: " + e.message; }
  return _mcxRows.rows || [];
}
async function mcxHouseQuotes(ySyms) {
  if (!mcxFeedOn()) return {};
  const wanted = (ySyms || []).filter((y) => mcx.COMEX_TO_MCX[y]);
  if (!wanted.length) return {};
  const token = await fyersHouseToken();
  if (!token) return {};
  const rows = await mcxSymbolRows();
  if (!rows.length) return {};
  // Resolve each requested commodity to its near-month contract; keep the mapping both ways.
  const byTicker = {};
  const pairs = [];
  for (const y of wanted) {
    const c = mcx.resolveFromYahoo(rows, y);
    if (c) { byTicker[c.ticker] = { y, meta: c }; pairs.push(c.ticker); }
  }
  if (!pairs.length) return {};
  const appId = process.env.FYERS_APP_ID || "";
  try {
    const r = await pfetch(`${FY_HOST}/data/quotes?symbols=${encodeURIComponent(pairs.join(","))}`, {
      headers: { Authorization: `${appId}:${token}` },
      ...fyFetchOpts,
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.s === "error") { _fyLastError = "mcx quotes: " + (d.message || ("HTTP " + r.status)); return {}; }
    const out = {};
    (d.d || []).forEach((row) => {
      const hit = byTicker[row.n];
      const v = row.v || {};
      if (hit && v.lp != null) {
        out[hit.y] = {
          sym: hit.y, name: hit.meta.label || hit.y,
          price: v.lp, chg: v.chp != null ? +Number(v.chp).toFixed(2) : 0,
          currency: "INR", src: "fyers-mcx",
          contract: hit.meta.ticker, unit: hit.meta.unit || null, lot: hit.meta.lot || 1,
        };
      }
    });
    return out;
  } catch (e) { _fyLastError = "mcx quotes error: " + e.message; return {}; }
}

/* Historical candles from the FYERS house feed. Returns the SAME shape as the Yahoo path
   ({ t, o, h, l, c, v }), or null for anything FYERS can't serve (non-equity, weekly/monthly,
   or when the feed isn't configured) so the caller cleanly falls back to Yahoo. */
const FY_RES = { "1m": "1", "2m": "2", "3m": "3", "5m": "5", "10m": "10", "15m": "15", "30m": "30", "60m": "60", "1h": "60", "90m": "90", "1d": "D", "1D": "D" };
const FY_RANGE_DAYS = { "1d": 2, "5d": 7, "1mo": 31, "3mo": 93, "6mo": 186, "1y": 370, "2y": 740 };
/* CORE FYERS history fetch. Given a resolved FYERS symbol + an Authorization header, returns the
   candles. Shared by the OWNER house feed and each connected user's OWN feed, so the per-user
   (compliant) path reuses the exact same request/parse. */
async function fetchFyersHistoryRaw(fy, res, days, authHeader) {
  /* FYERS caps a SINGLE /data/history request at ~366 days (this is why the 1D chart, which asks for
     2 years, came back empty while intraday timeframes — all well under a year — worked fine). So we
     split any span longer than a year into ≤365-day windows, fetch each, then merge + de-dupe. Spans
     under a year (every intraday timeframe) still make exactly one call, so nothing else changes. */
  const fmt = (d) => d.toISOString().slice(0, 10);
  /* FYERS caps a single request differently by resolution: ~366 days for DAILY, but only ~100 days
     for intraday (minute) resolutions. Chunk accordingly, so a months-long intraday backtest pull
     succeeds instead of coming back empty. */
  const MAX = (res === "D" || res === "1D") ? 365 : 90;
  const now = Date.now();
  const windows = [];
  for (let off = days; off > 0; off -= MAX) {
    const span = Math.min(off, MAX);
    windows.push({ from: fmt(new Date(now - off * 864e5)), to: fmt(new Date(now - (off - span) * 864e5)) });
  }
  const all = [];
  let lastErr = null;
  for (const w of windows) {
    const url = `${FY_HOST}/data/history?symbol=${encodeURIComponent(fy)}&resolution=${res}&date_format=1&range_from=${w.from}&range_to=${w.to}&cont_flag=1`;
    const r = await pfetch(url, { headers: { Authorization: authHeader }, ...fyFetchOpts });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.s === "error" || !Array.isArray(d.candles)) { lastErr = { code: d && d.code, message: d && d.message }; continue; }
    for (const c of d.candles) all.push({ t: c[0] * 1000, o: c[1], h: c[2], l: c[3], c: c[4], v: c[5] });
  }
  if (!all.length) return { candles: null, code: lastErr && lastErr.code, message: lastErr && lastErr.message };
  const seen = new Set();
  const candles = all
    .filter((x) => x.c != null && x.h != null && x.l != null)
    .filter((x) => (seen.has(x.t) ? false : (seen.add(x.t), true)))
    .sort((a, b) => a.t - b.t);
  return { candles };
}
async function fyersHouseHistory(ySym, range, interval) {
  /* HISTORY comes from FYERS whenever a house token is configured — Yahoo throttles historical
     candles from datacenter IPs down to a couple of bars, which broke charts and backtests. This
     is the DELAYED OHLC history, not the live tick feed (that stays gated by EQUITY_HOUSE_FEED). */
  const fy = yahooToFyers(ySym);
  const res = FY_RES[interval];
  const days = FY_RANGE_DAYS[range];
  if (!fy || !res || !days) return null;
  const token = await fyersHouseToken();
  if (!token) return null;
  const appId = process.env.FYERS_APP_ID || "";
  try {
    const out = await fetchFyersHistoryRaw(fy, res, days, `${appId}:${token}`);
    if (!out.candles && (out.code === -16 || /token/i.test(out.message || ""))) _fyHouse = { token: null, at: 0 };
    return out.candles;
  } catch { return null; }
}
/* A CONNECTED user's OWN FYERS history — their licensed data for their own use (compliant). Uses
   the user's stored FYERS token, not the house token. Returns null if they aren't connected. */
async function userFyersHistory(userId, ySym, range, interval) {
  const fy = yahooToFyers(ySym);
  const res = FY_RES[interval];
  const days = FY_RANGE_DAYS[range];
  if (!fy || !res || !days) return null;
  try {
    const sess = await sessionFromCred(userId, "fyers");
    if (!sess || !sess.accessToken) return null;
    const auth = brokerAuth("fyers", sess.accessToken, userId).Authorization;
    const out = await fetchFyersHistoryRaw(fy, res, days, auth);
    return out.candles;
  } catch { return null; }
}
/* The authenticated user's storage key from an optional bearer token (null if anonymous). */
function reqUserIdOptional(req) {
  try {
    const h = req.get("Authorization") || "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : "";   // M-01: header only, never query string
    const v = verifyToken(token);
    return v ? storageKeyFor(v.userId) : null;
  } catch { return null; }
}

app.get("/api/quote", publicDataLimiter, async (req, res) => {
  const symbols = String(req.query.symbols || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!symbols.length) return res.status(400).json({ error: "symbols required" });
  try {
    // The house OWNER (you) gets the live IND Money US feed; the cache key is owner-scoped so that
    // owner-only data is NEVER served to another user out of the shared quote cache.
    const owner = isHouseOwner(req);
    const quotes = await memo(`q:${symbols.join(",")}:${owner ? "o" : ""}`, 15_000, async () => {
      // Indian equities from the FYERS house feed and crypto from the Delta feed first;
      // Yahoo covers the rest — and anything the house feeds didn't return.
      let fyMap = {}, dMap = {}, imMap = {}, mcxMap = {};
      try { fyMap = await fyersHouseQuotes(symbols); } catch { fyMap = {}; }
      try { dMap = await deltaHouseQuotes(symbols); } catch { dMap = {}; }
      try { imMap = await indmoneyHouseQuotes(symbols, owner); } catch { imMap = {}; }   // real-time US via IND Money (owner-only)
      try { mcxMap = await mcxHouseQuotes(symbols); } catch { mcxMap = {}; }        // MCX commodity (INR) when opted in
      const houseMap = { ...fyMap, ...dMap, ...imMap, ...mcxMap };
      const need = symbols.filter((s) => !houseMap[s]);
      const rows = await mapLimit(need, 6, async (sym) => {
        try {
          const d = await j(`${YF}/v8/finance/chart/${encodeURIComponent(fallbackYF(sym))}?range=1d&interval=1d`);
          const m = d.chart?.result?.[0]?.meta;
          if (!m || m.regularMarketPrice == null) return null;
          const price = m.regularMarketPrice;
          const prev = m.chartPreviousClose ?? m.previousClose ?? price;
          const chg = prev ? (price / prev - 1) * 100 : 0;
          return { sym, name: m.symbol || sym, price, chg: +chg.toFixed(2), currency: m.currency };
        } catch { return null; }
      });
      return [...Object.values(houseMap), ...rows.filter(Boolean)];
    });
    res.json({ quotes });
  } catch (e) { res.status(502).json({ error: String(e.message) }); }
});

/* ------------------------------ /api/history ------------------------------ */
// e.g. /api/history?symbol=RELIANCE.NS&range=6mo&interval=1d  -> OHLC candles
app.get("/api/history", publicDataLimiter, async (req, res) => {
  const symbol = String(req.query.symbol || "").trim();
  const range = String(req.query.range || "6mo");
  const interval = String(req.query.interval || "1d");
  if (!symbol) return res.status(400).json({ error: "symbol required" });
  try {
    // COMPLIANT SOURCING, in order:
    //  1. OWNER (you) -> your licensed FYERS house feed.
    //  2. A CONNECTED user -> THEIR OWN broker's history (their data, their use).
    //  3. Everyone else -> Yahoo (delayed/limited).
    let candles = null;
    /* CRYPTO must NEVER touch FYERS — FYERS is an Indian-equity feed and asking it for a crypto ticker throws,
       which previously propagated to the 502 catch below and showed "no data" for every crypto backtest. Route
       crypto straight to its exchange: Delta first (it lists small tokens Yahoo doesn't — RAVE/LAB/EVAA), then
       Yahoo as a secondary for the major coins' longer intraday window. */
    const isCrypto = /-USD$|USDT$|USDC$/i.test(symbol) || /\.P$/i.test(symbol) || !!yahooToDelta(symbol);
    if (isCrypto) {
      const dsym = deltaPerpFromAny(symbol);
      if (dsym) {
        try { candles = await memo(`dch:${dsym}:${range}:${interval}`, 60_000, () => deltaCandles(dsym, deltaResolution(interval), range)); }
        catch { /* fall through to Yahoo for the major coins */ }
      }
    } else if (isHouseOwner(req)) {
      // US tickers have no FYERS feed — the owner gets IND Money's live US candles (owner-scoped cache).
      candles = isUsTicker(symbol)
        ? await memo(`imc:${symbol}:${range}:o`, 60_000, () => indmoneyUsCandles(symbol, range, true))
        : await memo(`fyh:${symbol}:${range}:${interval}`, 60_000, () => fyersHouseHistory(symbol, range, interval));
    } else {
      const uid = reqUserIdOptional(req);
      if (uid) candles = await memo(`fyu:${uid}:${symbol}:${range}:${interval}`, 60_000, () => userFyersHistory(uid, symbol, range, interval));
    }
    // A THIN house response (sometimes FYERS returns just today's 1 candle for a name) must not block the
    // Yahoo fallback — otherwise the chart says "unavailable" for a stock that has full history on Yahoo.
    if (!candles || candles.length < 5) {
      /* Yahoo caps INTRADAY history (1m ~7d, other minute ~60d, 60m ~730d) and 422s if you ask for
         more. A backtest may request 6 months of 5m — fine for FYERS, impossible on Yahoo. So for
         intraday intervals we request an explicit clamped window via period1/period2; non-connected
         users get Yahoo's max (~60 days) instead of an error/empty chart. Daily keeps the range str. */
      const YMAX_D = { "1m": 7, "2m": 60, "3m": 60, "5m": 60, "10m": 60, "15m": 60, "30m": 60, "45m": 60, "60m": 730, "90m": 60 };
      let qs;
      if (YMAX_D[interval]) {
        const days = Math.min(FY_RANGE_DAYS[range] || 60, YMAX_D[interval]);
        const p2 = Math.floor(Date.now() / 1000), p1 = p2 - days * 86400;
        qs = `period1=${p1}&period2=${p2}&interval=${interval}`;
      } else {
        qs = `range=${range}&interval=${interval}`;
      }
      // Map bare tickers to their Yahoo form BEFORE fetching — e.g. crypto "BTC" → "BTC-USD", "NIFTY50" →
      // "^NSEI" (Y_SPECIAL). Without this, a crypto backtest for "BTC" hit Yahoo as "BTC" and got no data.
      const yTicker = fallbackYF(Y_SPECIAL[symbol] || symbol);
      const data = await memo(`h:${symbol}:${range}:${interval}`, 60_000, () =>
        j(`${YF}/v8/finance/chart/${encodeURIComponent(yTicker)}?${qs}`));
      const r = data.chart?.result?.[0];
      const ts = r?.timestamp || [];
      const q = r?.indicators?.quote?.[0] || {};
      candles = ts.map((t, i) => ({
        t: t * 1000,
        o: q.open?.[i], h: q.high?.[i], l: q.low?.[i], c: q.close?.[i], v: q.volume?.[i],
      })).filter((d) => d.c != null);
    }
    // LAST RESORT: Delta's own candles. Yahoo doesn't list smaller Delta tokens (LAB, EVAA, …),
    // so their chart came back empty ("No price history"). Delta HAS them — pull directly.
    if (!candles || !candles.length) {
      const dsym = deltaPerpFromAny(symbol);
      if (dsym) {
        try {
          candles = await memo(`dch:${dsym}:${range}:${interval}`, 60_000, () => deltaCandles(dsym, deltaResolution(interval), range));
        } catch (e) { /* leave candles empty; UI shows 'unavailable' */ }
      }
    }
    res.json({ symbol, candles: candles || [] });
  } catch (e) { res.status(502).json({ error: String(e.message) }); }
});

/* ---------------------------- /api/pattern-scan --------------------------- */
// POST { pattern: "cup-handle", symbols: ["RELIANCE.NS", ...] }
// Fetches daily candles for each symbol and returns those currently forming the pattern.
// Symbols are capped and fetched with small concurrency so we never hammer the upstream feed.
app.post("/api/pattern-scan", computeLimiter, async (req, res) => {
  try {
    const pattern = String((req.body && req.body.pattern) || "").trim();
    if (!pattern) return res.status(400).json({ error: "pattern required" });
    let syms = Array.isArray(req.body && req.body.symbols) ? req.body.symbols.map(String).map((s) => s.trim()).filter(Boolean) : [];
    syms = [...new Set(syms)].slice(0, 80);           // de-dupe + cap
    const range = "6mo", interval = "1d";
    const matches = [];
    const CONC = 6;                                    // gentle concurrency
    for (let i = 0; i < syms.length; i += CONC) {
      const batch = syms.slice(i, i + CONC);
      const out = await Promise.all(batch.map(async (sym) => {
        try {
          // C-03: interval "2m" was a mislabelled 3m — fetch native 1m and fold ×3 into a real 3m candle.
          const candles = interval === "2m" ? aggCandles(await candlesFor(sym, range, "1m"), 3) : await candlesFor(sym, range, interval);
          if (!candles || candles.length < 30) return null;
          const found = patterns.detectPatterns(candles);
          const hit = found.find((p) => p.key === pattern);
          return hit ? { sym, pattern: hit.key, name: hit.name, dir: hit.dir } : null;
        } catch { return null; }
      }));
      out.forEach((r) => { if (r) matches.push(r); });
    }
    res.json({ pattern, scanned: syms.length, matches });
  } catch (e) { serverError(res, e); }
});

/* --------------------------- /api/idea-scan ---------------------------
   POST { symbols:[...] } -> Neo's daily IDEAS from REAL price action. For each symbol we scan the 1-day
   and 1-hour candles for a BULLISH chart pattern (double bottom, inverse H&S, ascending triangle,
   falling wedge, bull flag, cup & handle) OR a bullish CANDLESTICK (hammer, engulfing, piercing,
   morning star, three white soldiers), and derive entry / target / stop from the pattern's own
   projection (or a 2-ATR push). Cached ~30 min per symbol set so the homepage stays cheap.        */
function atrOf(c, len = 14) {
  const n = c.length; if (n < 2) return 0;
  let s = 0, k = 0;
  for (let i = Math.max(1, n - len); i < n; i++) {
    s += Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c)); k++;
  }
  return k ? s / k : 0;
}
function emaLast(arr, n) { if (!arr.length) return null; const k = 2 / (n + 1); let e = arr[0]; for (let i = 1; i < arr.length; i++) e = arr[i] * k + e * (1 - k); return e; }
function rsiLast(closes, n = 14) {
  if (closes.length < n + 1) return null;
  let gain = 0, loss = 0;
  for (let i = closes.length - n; i < closes.length; i++) { const d = closes[i] - closes[i - 1]; if (d >= 0) gain += d; else loss -= d; }
  if (loss === 0) return 100;
  const rs = gain / loss; return 100 - 100 / (1 + rs);
}
/* TECHNICAL fallback idea (1-day) — used when no chart/candlestick pattern fires, so every market
   still surfaces momentum / reversal / bullish-trend candidates. Lower strength than pattern ideas. */
function techIdea(sym, c) {
  const closes = c.map((x) => x.c); const n = closes.length; const px = closes[n - 1];
  if (!(px > 0) || n < 30) return null;
  const rsiV = rsiLast(closes, 14);
  const e20 = emaLast(closes, 20), e50 = emaLast(closes, 50);
  const chg5 = n > 6 ? (px / closes[n - 6] - 1) * 100 : 0;
  const prev = closes[n - 2];
  let name, strength;
  if (rsiV != null && rsiV < 40 && px > prev) { name = "Oversold reversal"; strength = 1.6; }
  else if (e20 != null && e50 != null && px > e20 && e20 > e50) { name = "Bullish trend"; strength = 1.5; }
  else if (chg5 >= 4) { name = "Momentum"; strength = 1.3; }
  else if (e20 != null && px > e20) { name = "Above 20-day trend"; strength = 0.9; }
  else { name = "On watch"; strength = 0.5; }
  const atr = atrOf(c) || px * 0.02;
  const swingLow = Math.min(...c.slice(-10).map((x) => x.l));
  const target = px + 2 * atr;
  const stop = (swingLow < px && swingLow > px * 0.85) ? swingLow : px - 1.2 * atr;
  const tpPct = +(((target / px) - 1) * 100).toFixed(1);
  const slPct = +((1 - stop / px) * 100).toFixed(1);
  if (!(tpPct >= 1 && slPct > 0.2)) return null;
  return {
    sym, tf: "1d", pattern: "technical", name, candlestick: null,
    entry: +px.toFixed(2), target: +target.toFixed(2), stop: +stop.toFixed(2),
    tpPct, slPct, rr: slPct > 0 ? +(tpPct / slPct).toFixed(1) : null, strength,
  };
}
async function scanOneIdea(sym) {
  let daily = null;
  for (const [interval, range, tf] of [["1d", "6mo", "1d"], ["60m", "1mo", "1h"]]) {
    let candles;
    try { candles = interval === "2m" ? aggCandles(await candlesFor(sym, range, "1m"), 3) : await candlesFor(sym, range, interval); } catch { continue; }   // C-03: real 3m
    if (!candles || candles.length < 30) continue;
    if (interval === "1d") daily = candles;
    const px = candles[candles.length - 1].c;
    if (!(px > 0)) continue;
    const chart = patterns.detectPatterns(candles).find((p) => p.dir === "bull");
    const cndl = patterns.bullishCandle(candles);
    if (!chart && !cndl) continue;
    const atr = atrOf(candles) || px * 0.02;
    const swingLow = Math.min(...candles.slice(-10).map((x) => x.l));
    const target = (chart && chart.target && chart.target > px && chart.target < px * 1.6) ? chart.target : px + 2 * atr;
    const stop = (swingLow < px && swingLow > px * 0.85) ? swingLow : px - 1.2 * atr;
    const tpPct = +(((target / px) - 1) * 100).toFixed(1);
    const slPct = +((1 - stop / px) * 100).toFixed(1);
    if (!(tpPct >= 1 && tpPct <= 40 && slPct > 0.2 && slPct <= 25)) continue;
    return {
      sym, tf, pattern: chart ? chart.key : cndl.key, name: chart ? chart.name : cndl.name,
      candlestick: cndl ? cndl.name : null,
      entry: +px.toFixed(2), target: +target.toFixed(2), stop: +stop.toFixed(2),
      tpPct, slPct, rr: slPct > 0 ? +(tpPct / slPct).toFixed(1) : null,
      strength: (chart ? 2 : 0) + (cndl ? (cndl.strength || 1) : 0),
    };
  }
  // No pattern fired — fall back to a 1-day technical idea so the market still has candidates.
  if (daily) { try { return techIdea(sym, daily); } catch { return null; } }
  return null;
}
app.post("/api/idea-scan", computeLimiter, async (req, res) => {
  try {
    let syms = Array.isArray(req.body && req.body.symbols) ? req.body.symbols.map(String).map((s) => s.trim()).filter(Boolean) : [];
    syms = [...new Set(syms)].slice(0, 60);
    if (!syms.length) return res.json({ ideas: [] });
    const cacheKey = "ideascan:" + syms.slice().sort().join(",");
    const ideas = await memo(cacheKey, 30 * 60_000, async () => {
      const out = [];
      const CONC = 5;
      for (let i = 0; i < syms.length; i += CONC) {
        const rs = await Promise.all(syms.slice(i, i + CONC).map((s) => scanOneIdea(s).catch(() => null)));
        rs.forEach((r) => { if (r) out.push(r); });
      }
      // Pattern ideas rank first (higher strength); technical fallbacks fill up so each market shows a
      // healthy set. Cap at 12 to keep the strongest without flooding the carousel.
      out.sort((a, b) => b.strength - a.strength || (b.rr || 0) - (a.rr || 0));
      return out.slice(0, 12);
    });
    res.json({ ideas, scanned: syms.length });
  } catch (e) { serverError(res, e); }
});

/* --------------------------- /api/screener-scan ---------------------------
   POST { symbols:[...], defs, entry, tf } -> which of these symbols' LATEST closed candle satisfies the
   screener's ENTRY chain right now (evaluated by the same engine that runs live strategies). Powers the
   homepage "Popular Screeners" carousels: a symbol appears only while it meets the entry trigger.
   Cached ~2 min since the underlying is 5-minute candles.                                            */
/* C-03: fold base candles into a higher timeframe, SESSION-ALIGNED (buckets never span a calendar day), so a
   "3m from 1m" or "4h from 60m" bar is a real fixed-duration candle, not a mislabelled 2m or a cross-session
   group. Mirrors the frontend marketService.aggregate. */
/* M2-02: bucket base candles into a higher timeframe by CLOCK BOUNDARY, not by "every n rows since the first
   present that day". Each bar is keyed to floor(epochMinute / stepMin) so a bucket is a true fixed clock
   window (e.g. 09:15–09:18, 09:18–09:21 for 3m) even if the feed starts late or has gaps. `baseMin` is the
   base interval in minutes (1 for 1m→3m, 60 for 60m→4h). Partial buckets (fewer than n base candles) are
   DROPPED so a half-formed bar can't be mistaken for a closed one. */
function aggCandles(candles, n, baseMin = 1) {
  if (!Array.isArray(candles) || n <= 1) return candles || [];
  const stepMs = n * baseMin * 60 * 1000;
  const buckets = new Map();
  for (const c of candles) {
    const ms = c.t < 1e12 ? c.t * 1000 : c.t;
    const key = Math.floor(ms / stepMs) * stepMs;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(c);
  }
  const keys = [...buckets.keys()].sort((a, b) => a - b);
  const lastKey = keys[keys.length - 1];
  const out = [];
  for (const key of keys) {
    const g = buckets.get(key).sort((a, b) => a.t - b.t);
    // Drop ONLY the trailing bucket while it's still forming (fewer than n base candles). Earlier buckets are
    // kept even if a session edge left them short (e.g. a 4h window that only overlaps part of the session),
    // so we don't discard real closed bars — but a half-formed CURRENT bar never leaks in as "closed".
    if (key === lastKey && g.length < n) continue;
    out.push({ t: g[0].t, o: g[0].o, c: g[g.length - 1].c, h: Math.max(...g.map((x) => x.h)), l: Math.min(...g.map((x) => x.l)), v: g.reduce((a, x) => a + (x.v || 0), 0) });
  }
  return out;
}
/* Fetch candles for a scan/optimizer timeframe. For 3m we fetch native 1m and fold ×3 (true 3m); everything
   else uses its native Yahoo interval. */
async function candlesForTf(sym, tf, range) {
  if (tf === "3m") { const base = await candlesFor(sym, range || "5d", "1m"); return aggCandles(base || [], 3); }
  const interval = ({ "5m": "5m", "15m": "15m", "30m": "30m", "1h": "60m", "1d": "1d" })[tf] || "5m";
  return candlesFor(sym, range || (tf === "1d" ? "1y" : "5d"), interval);
}
app.post("/api/screener-scan", computeLimiter, async (req, res) => {
  try {
    const body = req.body || {};
    let syms = Array.isArray(body.symbols) ? body.symbols.map(String).map((s) => s.trim()).filter(Boolean) : [];
    syms = [...new Set(syms)].slice(0, 60);
    const cfg = { defs: body.defs || [], entry: body.entry || [], tf: body.tf || "5m" };
    if (!syms.length || !cfg.entry.length) return res.json({ matches: [] });
    const range = cfg.tf === "1d" ? "1y" : "5d";
    const cacheKey = "scrscan:" + (body.key || "") + ":" + cfg.tf + ":" + syms.slice().sort().join(",");
    const matches = await memo(cacheKey, 2 * 60_000, async () => {
      const out = [];
      const CONC = 5;
      for (let i = 0; i < syms.length; i += CONC) {
        const rs = await Promise.all(syms.slice(i, i + CONC).map(async (sym) => {
          try {
            const candles = await candlesForTf(sym, cfg.tf, range);
            if (!candles || candles.length < 30) return null;
            const r = strat.entrySignalFired(cfg, candles);
            if (!r || !r.fired) return null;
            const last = candles[candles.length - 1];
            return { sym, price: +Number(last.c).toFixed(2), entryPrice: +Number(last.c).toFixed(2), entryAt: last.t };
          } catch { return null; }
        }));
        rs.forEach((r) => { if (r) out.push(r); });
      }
      return out;
    });
    res.json({ matches, scanned: syms.length });
  } catch (e) { serverError(res, e); }
});

/* --------------------------- /api/optimize-exits ---------------------------
   POST { defs, entry, tf, symbols } -> the SL/TP pair that would have MAXIMISED expectancy on the
   strategy's OWN past entry signals (a grid sweep over real candles), plus an out-of-sample check so
   the number isn't just curve-fit. Long-only; ties inside a bar assume the stop (conservative). */
/* Optimisers backtest over the LONGEST practical history so there are plenty of signals — the same
   spirit as the backtest tab, not a tiny recent window. Intraday intervals cap at ~60d on the data
   source, so those use the max (~2mo); hourly/daily reach much further. */
// Ranges MUST be keys the FYERS house feed understands (see FY_RANGE_DAYS) — "2mo" was NOT one, so the
// house feed returned nothing and we fell back to Yahoo, which has no intraday data for indices like
// NIFTY50 → "0 signals". "3mo" is recognised, so intraday optimisation now gets real candles.
const OPT_RANGE = { "3m": "3mo", "5m": "3mo", "15m": "3mo", "30m": "3mo", "1h": "1y", "1d": "2y" };
const OPT_INTERVAL = { "3m": "2m", "5m": "5m", "15m": "15m", "30m": "30m", "1h": "60m", "1d": "1d" };
const OPT_SLS = [0.3, 0.5, 0.75, 1, 1.5, 2, 3];
const OPT_TPS = [0.5, 1, 1.5, 2, 3, 4, 5];
function collectEntries(cfg, raw) {
  const c = strat.closedCandles((raw || []).filter((x) => x && x.c != null));
  if (!c || c.length < 40) return [];
  const closes = c.map((x) => x.c), vols = c.map((x) => x.v || 0), cache = {};
  const get = (op) => strat.resolveOperand(op, cfg.defs || [], c, closes, vols, cache, cfg.tf || null);
  const out = []; let prev = false;
  for (let i = 30; i < c.length - 1; i++) {
    let fired = false; try { fired = strat.chainEval(cfg.entry, i, get); } catch { fired = false; }
    if (fired && !prev) out.push({ c, e: i });
    prev = fired;
  }
  return out;
}
/* METRIC-based entries (My Screeners): the entry conditions are daily-snapshot metrics (RSI, EMA20,
   day-change %, …). We map each to a candle series and evaluate the chain per candle so the same SL/TP
   sweep works. An unavailable metric never blocks (matches the live screener). */
function metricSeries(m, c, closes, vols) {
  switch (m) {
    case "price": return closes;
    case "vol": return vols;
    case "rsi": return strat.RSIarr(closes, 14);
    case "ema20": return strat.EMAarr(closes, 20);
    case "ema50": return strat.EMAarr(closes, 50);
    case "sma50": return strat.SMAarr(closes, 50);
    case "sma200": return strat.SMAarr(closes, 200);
    case "macd": { const mm = strat.MACDarr(closes); return (mm && mm.line) ? mm.line : mm; }
    case "adx": return strat.ADXarr(c, 14);
    case "cci": return strat.CCIarr(c, 20);
    case "atr": return strat.ATRarr(c, 14);
    case "vwap": return strat.VWAParr(c);
    case "bbPctB": { const b = strat.BBarr(closes, 20); return closes.map((v, i) => (b.upper[i] - b.lower[i]) ? (v - b.lower[i]) / (b.upper[i] - b.lower[i]) * 100 : NaN); }
    case "chg": { const out = new Array(c.length); let dk = null, dopen = NaN; for (let i = 0; i < c.length; i++) { const dt = new Date(c[i].t); const k = dt.getUTCFullYear() + "-" + dt.getUTCMonth() + "-" + dt.getUTCDate(); if (k !== dk) { dk = k; dopen = c[i].o; } out[i] = dopen ? (c[i].c / dopen - 1) * 100 : NaN; } return out; }
    case "pchg": return closes.map((v, i) => i ? (v / closes[i - 1] - 1) * 100 : NaN);
    default: return null;
  }
}
function collectMetricEntries(conds, raw) {
  const c = strat.closedCandles((raw || []).filter((x) => x && x.c != null));
  if (!c || c.length < 40) return [];
  const closes = c.map((x) => x.c), vols = c.map((x) => x.v || 0), sc = {};
  const ser = (m) => { if (!(m in sc)) sc[m] = metricSeries(m, c, closes, vols); return sc[m]; };
  const firesAt = (i) => (conds || []).every((f) => {
    const L = ser(f.m); if (!L) return true;
    const x = L[i]; const R = f.rhsType === "indicator" ? ser(f.rhs) : null;
    const y = f.rhsType === "indicator" ? (R ? R[i] : NaN) : parseFloat(f.v);
    if (x == null || isNaN(x) || y == null || isNaN(y)) return true;
    return f.o === ">" ? x > y : f.o === "<" ? x < y : f.o === ">=" ? x >= y : f.o === "<=" ? x <= y : Math.abs(x - y) < 1e-9;
  });
  const out = []; let prev = false;
  for (let i = 30; i < c.length - 1; i++) { const fired = firesAt(i); if (fired && !prev) out.push({ c, e: i }); prev = fired; }
  return out;
}
function optimizeExits(cfg, candleSets, cur, objective = "pnl", rrMin = 1.5, maxSl = 0, costPct = 0) {
  const short = !!(cfg && (cfg.side === "SELL" || cfg.short === true));   // score a sell-mirror as a SHORT
  const collect = cfg.mode === "metric" ? (raw) => collectMetricEntries(cfg.entry, raw) : (raw) => collectEntries(cfg, raw);
  let events = [];
  for (const raw of candleSets) events = events.concat(collect(raw));
  if (!events.length) return { entries: 0 };
  if (events.length > 800) { const step = Math.ceil(events.length / 800); events = events.filter((_, k) => k % step === 0); }
  const cut = Math.floor(events.length * 0.7);
  const inS = cut >= 10 ? events.slice(0, cut) : events;
  const outS = cut >= 10 ? events.slice(cut) : [];
  const results = [];
  // RISK/REWARD FLOOR: only consider SL/TP pairs where the target is at least `rrMin`× the stop, so the
  // optimiser never recommends a setup whose reward is below the user's minimum RR (default 1:1.5).
  const RR_MIN = Number(rrMin) > 0 ? Number(rrMin) : 0;
  // MAX-SL CAP: when set, never propose a stop wider than the user's cap (e.g. maxSl=1 → SL ≤ 1%).
  const SL_MAX = Number(maxSl) > 0 ? Number(maxSl) : 0;
  const sls = SL_MAX > 0 ? OPT_SLS.filter((sl) => sl <= SL_MAX + 1e-9) : OPT_SLS;
  const slGrid = sls.length ? sls : [Math.min(...OPT_SLS)];   // if the cap is below every candidate, keep the smallest
  for (const sl of slGrid) for (const tp of OPT_TPS) { if (RR_MIN > 0 && tp < sl * RR_MIN) continue; const r = evalExitPair(sl, tp, inS, 200, short, costPct); if (r) results.push(r); }
  // If the floor was so strict nothing qualified, fall back to the full grid (still honouring the SL cap).
  if (!results.length && RR_MIN > 0) { for (const sl of slGrid) for (const tp of OPT_TPS) { const r = evalExitPair(sl, tp, inS, 200, short, costPct); if (r) results.push(r); } }
  if (!results.length) return { entries: events.length };
  const minTrades = Math.min(8, Math.max(3, Math.floor(inS.length * 0.05)));
  const rank = optRanker(objective);
  const pool = results.filter((r) => r.trades >= minTrades);
  const ranked = (pool.length ? pool : results).slice().sort(rank);
  const bp = ranked[0];
  // Report best + current on the FULL event set (fair prev-vs-new); validate best out-of-sample.
  const best = evalExitPair(bp.sl, bp.tp, events, 200, short, costPct);
  const oos = outS.length ? evalExitPair(bp.sl, bp.tp, outS, 200, short, costPct) : null;
  const current = (cur && cur.sl > 0 && cur.tp > 0) ? evalExitPair(cur.sl, cur.tp, events, 200, short, costPct) : null;
  return { entries: events.length, best, oos, current, objective, top: ranked.slice(0, 5) };
}
app.post("/api/optimize-exits", computeLimiter, async (req, res) => {
  try {
    const body = req.body || {};
    const cfg = { defs: body.defs || [], entry: body.entry || [], tf: String(body.tf || "5m"), side: body.side || (body.short ? "SELL" : null) };
    let syms = Array.isArray(body.symbols) ? body.symbols.map(String).map((s) => s.trim()).filter(Boolean) : [];
    syms = [...new Set(syms)].slice(0, 6);
    if (!cfg.entry.length || !syms.length) return res.json({ entries: 0 });
    if (body.mode === "metric") cfg.mode = "metric";
    const objective = body.objective === "winrate" ? "winrate" : "pnl";
    // Minimum reward/risk the optimiser must respect (TP ≥ rrMin × SL). User-tunable; default 1.5.
    const rrMin = (body.rrMin != null && Number(body.rrMin) >= 0) ? Number(body.rrMin) : 1.5;
    // Optional max stop-loss cap (%). When >0 the optimiser won't propose an SL above it.
    const maxSl = (body.maxSl != null && Number(body.maxSl) > 0) ? Number(body.maxSl) : 0;
    const cur = { sl: Number(body.currentSl) || 0, tp: Number(body.currentTp) || 0 };
    const costPct = body.costPct != null ? Math.max(0, +body.costPct || 0) : costPctFor(body.market);   // client may pass exact costs; else market default
    const interval = OPT_INTERVAL[cfg.tf] || "5m", range = OPT_RANGE[cfg.tf] || "1mo";
    // Content hash of the whole request so two different strategies never share a cache entry (the old
    // length-based key could collide and return another strategy's optimisation).
    const sig = JSON.stringify({ e: cfg.entry, d: cfg.defs, m: cfg.mode || "candle" });
    let h = 5381; for (let i = 0; i < sig.length; i++) h = ((h * 33) ^ sig.charCodeAt(i)) >>> 0;
    const key = "optexit:" + h.toString(36) + ":" + objective + ":rr" + rrMin + ":mx" + maxSl + ":" + cur.sl + "/" + cur.tp + ":" + cfg.tf + ":" + (cfg.side === "SELL" ? "S" : "L") + ":c" + costPct + ":" + syms.slice().sort().join(",");
    const out = await memo(key, 30 * 60_000, async () => {
      const sets = [];
      for (const sym of syms) { try { const c = await candlesForOpt(sym, range, interval); if (c && c.length) sets.push(c); } catch { /* skip */ } }
      return optimizeExits(cfg, sets, cur, objective, rrMin, maxSl, costPct);
    });
    res.json(out);
  } catch (e) { serverError(res, e); }
});

/* --------------------------- /api/optimize-indicators ---------------------------
   POST { defs, entry, tf, symbols, currentSl, currentTp, objective } -> the indicator LENGTHS and a
   shared TIMEFRAME (capped at 1h) that would have MAXIMISED win rate or P&L on the strategy's own past
   entry signals. Same real-candle backtest as the SL/TP optimiser, but here we sweep the INDICATOR
   parameters (e.g. Fast EMA 13 -> 8, Slow EMA 39 -> 55, tf 3m -> 15m) while holding SL/TP fixed at the
   strategy's current pair, so the comparison isolates entry quality. A greedy coordinate descent keeps
   the search bounded: pick the best timeframe, then tune each indicator's length one at a time. */
const IND_TFS = ["3m", "5m", "15m", "30m", "1h"];   // never above 1h, by product rule
function evalIndicatorCfg(defs, entry, tf, mode, sets, sl, tp, minTrades = 5, short = false, costPct = 0) {
  const cfg = { defs, entry, tf, mode };
  let events = [];
  for (const raw of sets) {
    const ev = mode === "metric" ? collectMetricEntries(entry, raw) : collectEntries(cfg, raw);
    events = events.concat(ev);
  }
  if (events.length > 800) { const step = Math.ceil(events.length / 800); events = events.filter((_, k) => k % step === 0); }
  const r = evalExitPair(sl, tp, events, 200, short, costPct);
  if (!r) return null;
  if (r.trades < minTrades) return null;      // too few signals to trust — treat as no result
  return r;
}
function optimizeIndicators(cfg, tfSets, cur, objective = "pnl", lockTf = null, costPct = 0) {
  const short = !!(cfg && (cfg.side === "SELL" || cfg.short === true));   // score a sell-mirror as a SHORT
  const sl = cur.sl > 0 ? cur.sl : 1;
  const tp = cur.tp > 0 ? cur.tp : 2;
  const rank = optRanker(objective);
  const better = (a, b) => { if (!a) return false; if (!b) return true; return rank(a, b) < 0; };
  const baseDefs = (cfg.defs || []).map((d) => ({ ...d }));
  // When the user LOCKS a timeframe, only tune lengths on that tf; otherwise sweep all tfs ≤ 1h.
  const tfList = (lockTf && IND_TFS.includes(lockTf)) ? [lockTf] : IND_TFS;
  let globalBest = null;      // { defs, tf, metrics }
  for (const tf of tfList) {
    const sets = tfSets[tf];
    if (!sets || !sets.length) continue;
    let curDefs = baseDefs.map((d) => ({ ...d, tf }));
    let curMetrics = evalIndicatorCfg(curDefs, cfg.entry, tf, cfg.mode, sets, sl, tp, 5, short, costPct);
    for (let i = 0; i < curDefs.length; i++) {          // tune each indicator's length in turn
      const opts = lenOptions(curDefs[i].len);
      if (!opts) continue;
      let bestDefs = curDefs, bestMetrics = curMetrics;
      for (const L of opts) {
        if (String(L) === String(curDefs[i].len)) continue;
        const trial = curDefs.map((d, j) => j === i ? { ...d, len: String(L) } : d);
        const m = evalIndicatorCfg(trial, cfg.entry, tf, cfg.mode, sets, sl, tp, 5, short, costPct);
        if (better(m, bestMetrics)) { bestDefs = trial; bestMetrics = m; }
      }
      curDefs = bestDefs; curMetrics = bestMetrics;
    }
    if (better(curMetrics, globalBest && globalBest.metrics)) globalBest = { defs: curDefs, tf, metrics: curMetrics };
  }
  const curTf = cfg.tf || "5m";
  const curSets = tfSets[curTf] || tfSets[IND_TFS.find((t) => tfSets[t] && tfSets[t].length)] || [];
  const current = curSets.length ? evalIndicatorCfg(baseDefs.map((d) => ({ ...d, tf: curTf })), cfg.entry, curTf, cfg.mode, curSets, sl, tp, 1, short, costPct) : null;
  if (!globalBest || !globalBest.metrics) return { entries: current ? current.trades : 0, current: current ? { ...current, tf: curTf } : null };
  const changes = globalBest.defs.map((d, i) => {
    const o = baseDefs[i] || {};
    return { name: d.name || d.type, type: d.type, fromLen: o.len, toLen: d.len, fromTf: o.tf || curTf, toTf: globalBest.tf };
  }).filter((c) => String(c.fromLen) !== String(c.toLen) || String(c.fromTf) !== String(c.toTf));
  return {
    entries: globalBest.metrics.trades, objective, tf: globalBest.tf,
    best: { ...globalBest.metrics, sl, tp, tf: globalBest.tf, defs: globalBest.defs.map((d) => ({ ...d, tf: globalBest.tf })) },
    current: current ? { ...current, tf: curTf } : null,
    changes,
  };
}
app.post("/api/optimize-indicators", computeLimiter, async (req, res) => {
  try {
    const body = req.body || {};
    const cfg = { defs: body.defs || [], entry: body.entry || [], tf: String(body.tf || "5m"), side: body.side || (body.short ? "SELL" : null) };
    if (body.mode === "metric") cfg.mode = "metric";
    let syms = Array.isArray(body.symbols) ? body.symbols.map(String).map((s) => s.trim()).filter(Boolean) : [];
    syms = [...new Set(syms)].slice(0, 4);
    if (!cfg.entry.length || !syms.length || !(cfg.defs || []).length) return res.json({ entries: 0 });
    // Nothing to optimise if no indicator carries a numeric length (pure MACD/VWAP strategies).
    if (!(cfg.defs || []).some((d) => Number(d && d.len) > 0)) return res.json({ entries: 0, noNumeric: true });
    const objective = body.objective === "winrate" ? "winrate" : "pnl";
    // Optional: LOCK the timeframe — only tune indicator lengths, keep this tf fixed.
    const lockTf = (body.lockTf && IND_TFS.includes(String(body.lockTf))) ? String(body.lockTf) : null;
    const cur = { sl: Number(body.currentSl) || 0, tp: Number(body.currentTp) || 0 };
    const costPct = body.costPct != null ? Math.max(0, +body.costPct || 0) : costPctFor(body.market);   // client costs, else market default
    const sig = JSON.stringify({ e: cfg.entry, d: cfg.defs, m: cfg.mode || "candle" });
    let h = 5381; for (let i = 0; i < sig.length; i++) h = ((h * 33) ^ sig.charCodeAt(i)) >>> 0;
    const key = "optind:" + h.toString(36) + ":" + objective + ":" + cur.sl + "/" + cur.tp + ":" + cfg.tf + ":" + (lockTf || "all") + ":" + (cfg.side === "SELL" ? "S" : "L") + ":c" + costPct + ":" + syms.slice().sort().join(",");
    const out = await memo(key, 30 * 60_000, async () => {
      const tfSets = {};
      // Only fetch the timeframes we'll actually search — a locked tf fetches ONE, not all five.
      const tfsToFetch = lockTf ? [lockTf] : IND_TFS;
      for (const tf of tfsToFetch) {
        const interval = OPT_INTERVAL[tf], range = OPT_RANGE[tf];
        const sets = [];
        for (const sym of syms) { try { const c = await candlesForOpt(sym, range, interval); if (c && c.length) sets.push(c); } catch { /* skip */ } }
        tfSets[tf] = sets;
      }
      return optimizeIndicators(cfg, tfSets, cur, objective, lockTf, costPct);
    });
    res.json(out);
  } catch (e) { serverError(res, e); }
});

/* --------------------------- /api/momentum-scan ---------------------------
   POST { symbols:[...], tf:"5m"|"15m"|"1h"|"4h"|"1d"|"1w", pct:2, dir:"up"|"down", bars? }
   Returns symbols whose PRICE CHANGE over one `tf` candle passes the threshold — i.e.
   "which stocks jumped 2% in the last 5 minutes / hour / day". Works on any timeframe:
   higher tfs Yahoo doesn't serve natively (4h, 1w) are built from a base interval + N bars
   (4h = four 1h candles, 1w = five 1d candles), so a single code path covers them all.     */
const MOMO_TF = {
  "1m":  { interval: "1m",  bars: 1, range: "1d" },
  "3m":  { interval: "1m",  bars: 3, range: "1d" },   // 3-min move = three 1-min candles
  "5m":  { interval: "5m",  bars: 1, range: "5d" },
  "15m": { interval: "15m", bars: 1, range: "5d" },
  "30m": { interval: "30m", bars: 1, range: "1mo" },
  "1h":  { interval: "60m", bars: 1, range: "1mo" },
  "4h":  { interval: "60m", bars: 4, range: "3mo" },
  "1d":  { interval: "1d",  bars: 1, range: "6mo" },
  "1w":  { interval: "1d",  bars: 5, range: "1y" },
};
app.post("/api/momentum-scan", computeLimiter, async (req, res) => {
  try {
    let syms = Array.isArray(req.body && req.body.symbols) ? req.body.symbols.map(String).map((s) => s.trim()).filter(Boolean) : [];
    syms = [...new Set(syms)].slice(0, 80);
    const pct = Number(req.body && req.body.pct);
    if (!Number.isFinite(pct) || pct <= 0) return res.status(400).json({ error: "pct (positive number) required" });
    const dir = String((req.body && req.body.dir) || "up").toLowerCase() === "down" ? "down" : "up";
    const tf = String((req.body && req.body.tf) || "1d").toLowerCase();
    const cfg = MOMO_TF[tf] || MOMO_TF["1d"];
    const bars = Math.max(1, Math.min(50, Number(req.body && req.body.bars) || cfg.bars));
    const matches = [];
    const CONC = 6;
    for (let i = 0; i < syms.length; i += CONC) {
      const batch = syms.slice(i, i + CONC);
      const out = await Promise.all(batch.map(async (sym) => {
        try {
          const candles = await candlesFor(sym, cfg.range, cfg.interval);
          if (!candles || candles.length < bars + 1) return null;
          const last = candles[candles.length - 1];
          const prev = candles[candles.length - 1 - bars];
          if (!last || !prev || last.c == null || !prev.c) return null;
          const chg = (last.c / prev.c - 1) * 100;
          const hit = dir === "up" ? chg >= pct : chg <= -Math.abs(pct);
          return hit ? { sym, chg: +chg.toFixed(2), ratio: +(last.c / prev.c).toFixed(4) } : null;
        } catch { return null; }
      }));
      out.forEach((r) => { if (r) matches.push(r); });
    }
    matches.sort((a, b) => (dir === "up" ? b.chg - a.chg : a.chg - b.chg));
    res.json({ tf, pct, dir, bars, scanned: syms.length, matches });
  } catch (e) { serverError(res, e); }
});

/* -------------------------------- /api/news ------------------------------- */
// e.g. /api/news?symbol=RELIANCE.NS  (Yahoo) — swap for NewsAPI if NEWS_API_KEY set
app.get("/api/news", publicDataLimiter, async (req, res) => {
  const symbol = String(req.query.symbol || req.query.q || "").trim();
  const name = String(req.query.name || "").trim();
  if (!symbol) return res.status(400).json({ error: "symbol/q required" });
  const base = symBase(symbol);
  try {
    const items = await memo(`n:${symbol}:${name}`, 120_000, async () => {
      if (process.env.NEWS_API_KEY) {
        // Query by the COMPANY NAME (quoted for an exact phrase) so NewsAPI returns that company's
        // stories, then STRICTLY filter to headlines/descriptions that actually name it — a raw
        // symbol keyword search was what pulled in random, unrelated news.
        const q = name ? `"${name}"` : base;
        const u = `https://newsapi.org/v2/everything?q=${encodeURIComponent(q)}&language=en&sortBy=publishedAt&pageSize=20&apiKey=${process.env.NEWS_API_KEY}`;
        const d = await j(u);
        return (d.articles || [])
          .filter((a) => newsTextMatch(`${a.title || ""} ${a.description || ""}`, name, base))
          .slice(0, 8)
          .map((a) => ({ t: a.title, d: a.publishedAt, src: a.source?.name, url: a.url }));
      }
      // Fallback: Yahoo search news — filtered by relatedTickers/ticker, and now also by the name.
      const d = await j(`${YF}/v1/finance/search?q=${encodeURIComponent(name || base)}&newsCount=12&quotesCount=0`);
      return (d.news || [])
        .filter((n) => newsRelevant(n, symbol) || newsTextMatch(n.title, name, base))
        .map((n) => ({ t: n.title, d: new Date(n.providerPublishTime * 1000).toISOString(), src: n.publisher, url: n.link }));
    });
    res.json({ symbol, news: items });
  } catch (e) { res.status(502).json({ error: String(e.message) }); }
});

/* ---------------------------- /api/fundamentals ----------------------------
   Yahoo quoteSummary carries the real fundamentals (P/E, ROE, margins, market cap,
   revenue/earnings growth, debt, 52w range). It now requires a CRUMB + COOKIE handshake,
   which is why it 401'd before. Flow: (1) hit Yahoo to get a session cookie, (2) fetch a
   crumb with that cookie, (3) call quoteSummary with crumb+cookie. Cached 6h — fundamentals
   barely move and this keeps us well under Yahoo's rate limits. Crypto has no fundamentals,
   so those just come back { unavailable:true } and the UI shows "—".                        */
const Y_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36";
let _yAuth = { crumb: null, cookie: null, at: 0 };
/* Accumulate Set-Cookie across requests into a name->value jar (last write wins), so we send
   the SAME cookies to getcrumb AND quoteSummary — a crumb only validates against its own cookies. */
function mergeCookies(jar, resp) {
  try {
    const arr = typeof resp.headers.getSetCookie === "function"
      ? resp.headers.getSetCookie()
      : (resp.headers.get("set-cookie") ? [resp.headers.get("set-cookie")] : []);
    for (const c of arr) { const nv = c.split(";")[0]; const i = nv.indexOf("="); if (i > 0) jar.set(nv.slice(0, i).trim(), nv.slice(i + 1).trim()); }
  } catch { /* ignore */ }
}
const jarString = (jar) => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
async function yahooAuth() {
  if (_yAuth.crumb && (Date.now() - _yAuth.at) < 30 * 60 * 1000) return _yAuth;
  const headers = { "User-Agent": Y_UA, "Accept": "text/html,application/xhtml+xml", "Accept-Language": "en-US,en;q=0.9" };
  const jar = new Map();
  // A1/A3 consent cookies come from the finance host; hit both, MERGE all cookies (don't stop early).
  for (const u of ["https://finance.yahoo.com/quote/AAPL", "https://fc.yahoo.com/"]) {
    try { mergeCookies(jar, await fetch(u, { headers, redirect: "follow" })); } catch { /* try next */ }
  }
  const cookie = jarString(jar);
  const r = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", { headers: { ...headers, Cookie: cookie, Accept: "text/plain" } });
  mergeCookies(jar, r);                                   // getcrumb may refresh cookies too
  const crumb = (await r.text()).trim();
  if (!crumb || crumb.length > 40 || /[<>]|error|unauthor/i.test(crumb)) throw new Error("crumb fetch failed (" + r.status + ")");
  _yAuth = { crumb, cookie: jarString(jar), at: Date.now() };
  return _yAuth;
}
const yNum = (x) => (x && typeof x === "object" && "raw" in x ? x.raw : (typeof x === "number" ? x : null));
async function yahooFundamentals(symbol) {
  const { crumb, cookie } = await yahooAuth();
  const mods = "price,summaryDetail,defaultKeyStatistics,financialData,summaryProfile";
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${mods}&crumb=${encodeURIComponent(crumb)}`;
  const r = await fetch(url, { headers: { "User-Agent": Y_UA, Cookie: cookie, Accept: "application/json" } });
  if (!r.ok) { if (r.status === 401 || r.status === 403) _yAuth = { crumb: null, cookie: null, at: 0 }; throw new Error("quoteSummary " + r.status); }
  const res = (await r.json())?.quoteSummary?.result?.[0];
  if (!res) throw new Error("no result");
  const pr = res.price || {}, sd = res.summaryDetail || {}, ks = res.defaultKeyStatistics || {}, fd = res.financialData || {}, prof = res.summaryProfile || {};
  return {
    symbol,
    name: pr.longName || pr.shortName || symbol,
    currency: pr.currency || null,
    sector: prof.sector || null, industry: prof.industry || null,
    marketCap: yNum(pr.marketCap) ?? yNum(sd.marketCap),
    peTrailing: yNum(sd.trailingPE) ?? yNum(ks.trailingPE),
    peForward: yNum(sd.forwardPE) ?? yNum(ks.forwardPE),
    pb: yNum(ks.priceToBook),
    eps: yNum(ks.trailingEps),
    roe: yNum(fd.returnOnEquity),
    profitMargin: yNum(fd.profitMargins) ?? yNum(ks.profitMargins),
    operatingMargin: yNum(fd.operatingMargins),
    revenueGrowth: yNum(fd.revenueGrowth),
    earningsGrowth: yNum(fd.earningsGrowth),
    debtToEquity: yNum(fd.debtToEquity),
    dividendYield: yNum(sd.dividendYield),
    beta: yNum(sd.beta) ?? yNum(ks.beta),
    high52: yNum(sd.fiftyTwoWeekHigh), low52: yNum(sd.fiftyTwoWeekLow),
  };
}
/* Financial Modeling Prep — reliable fundamentals from a real API (Yahoo blocks datacenter IPs).
   Free key at financialmodelingprep.com; set FMP_API_KEY on Render. FMP's free tier is strongest
   for US tickers; NSE/BSE (.NS/.BO) coverage can need a paid plan, in which case we fall back to
   Yahoo (and then to "unavailable"). Values are normalised to the same shape as the Yahoo path. */
async function fmpFundamentals(symbol) {
  const key = process.env.FMP_API_KEY;
  if (!key) throw new Error("no FMP key");
  const sym = encodeURIComponent(symbol);
  /* FMP migrated to the /stable/ API — the legacy /api/v3/ endpoints return empty for keys issued
     after the change (which is why "FMP empty" showed even with a valid key). Stable uses a
     ?symbol=X query instead of a path param, and renamed several ratio fields, so we probe a few
     name variants per metric to survive both stable and any lingering v3 responses. */
  const base = "https://financialmodelingprep.com/stable";
  const one = (x) => (Array.isArray(x) ? x[0] : (x && typeof x === "object" && !x["Error Message"] ? x : null)) || null;
  const [prof, ratios, growth] = await Promise.all([
    j(`${base}/profile?symbol=${sym}&apikey=${key}`).catch(() => null),
    j(`${base}/ratios-ttm?symbol=${sym}&apikey=${key}`).catch(() => null),
    j(`${base}/financial-growth?symbol=${sym}&limit=1&apikey=${key}`).catch(() => null),
  ]);
  const p = one(prof), r = one(ratios), g = one(growth);
  if (!p && !r) throw new Error("FMP empty");
  const num = (o, keys) => { for (const k of keys) { const v = o && o[k]; if (v != null && v !== "" && !isNaN(+v)) return +v; } return null; };
  const de = num(r, ["debtToEquityRatioTTM", "debtEquityRatioTTM", "debtToEquityTTM"]);
  const dy = num(r, ["dividendYieldTTM", "dividendYielTTM"]);
  return {
    symbol,
    name: (p && (p.companyName || p.name)) || symbol,
    currency: (p && p.currency) || null,
    sector: (p && p.sector) || null, industry: (p && p.industry) || null,
    marketCap: num(p, ["marketCap", "mktCap"]),
    peTrailing: num(r, ["priceToEarningsRatioTTM", "peRatioTTM", "priceEarningsRatioTTM"]),
    peForward: null,
    pb: num(r, ["priceToBookRatioTTM", "pbRatioTTM", "priceToBookTTM"]),
    eps: num(p, ["eps"]),
    roe: num(r, ["returnOnEquityTTM"]),                          // fraction (0.18)
    profitMargin: num(r, ["netProfitMarginTTM", "netIncomeMarginTTM"]),          // fraction
    operatingMargin: num(r, ["operatingProfitMarginTTM", "operatingMarginTTM"]), // fraction
    revenueGrowth: num(g, ["revenueGrowth"]),                   // fraction
    earningsGrowth: num(g, ["epsgrowth", "epsGrowth", "growthEPS"]),
    debtToEquity: de != null ? de * 100 : null,                 // ->% to match Yahoo
    dividendYield: dy,                                          // fraction
    beta: num(p, ["beta"]),
    high52: null, low52: null,
    src: "fmp",
  };
}
/* indianapi.in — the India source for NSE/BSE fundamentals. Free tier base is stock.indianapi.in,
   auth via X-Api-Key. /stock?name=<ticker> returns companyProfile.peerCompanyList where the
   company's OWN row carries P/E, P/B, market cap (₹ crore), ROE %, net-profit-margin %, div yield.
   Field names vary slightly, so we probe several. Set INDIANAPI_KEY on Render. */
function pickNum(obj, keys) {
  for (const k of keys) { const v = obj && obj[k]; if (v != null && v !== "" && !isNaN(+v)) return +v; }
  return null;
}
async function indianApiFundamentals(symbol) {
  const key = process.env.INDIANAPI_KEY;
  if (!key) throw new Error("no INDIANAPI key");
  const base = String(symbol).replace(/\.(NS|BO|NSE|BSE)$/i, "");
  const r = await fetch(`https://stock.indianapi.in/stock?name=${encodeURIComponent(base)}`, { headers: { "X-Api-Key": key, Accept: "application/json" } });
  if (!r.ok) throw new Error("indianapi " + r.status);
  const d = await r.json();
  if (!d || !d.companyName) throw new Error("indianapi empty");
  // The company's OWN metrics live in keyMetrics (bucketed {key,value} arrays) + stockDetailsReusableData.
  // (peerCompanyList is COMPETITORS with 0-filled ratios — do not use it for the subject company.)
  const km = {};
  for (const bucket of Object.values(d.keyMetrics || {})) if (Array.isArray(bucket)) for (const it of bucket) if (it && it.key != null) km[it.key] = it.value;
  const sd = d.stockDetailsReusableData || {};
  const pk = (keys) => { for (const k of keys) { const v = km[k] != null ? km[k] : sd[k]; if (v != null && v !== "" && !isNaN(+v)) return +v; } return null; };
  const mcapCr = pk(["marketCap"]);
  const roe = pk(["returnOnAverageEquityTrailing12Month", "returnOnAverageEquity5YearAverage"]);
  const npm = pk(["netProfitMarginPercentTrailing12Month", "netProfitMargin5YearAverage"]);
  const opm = pk(["operatingMarginTrailing12Month", "operatingMargin5YearAverage"]);
  const revG = pk(["revenueChangePercentTTMPOverTTM", "revenueGrowthRate5Year", "growthRatePercentRevenue3Year"]);
  const epsG = pk(["ePSChangePercentTTMOverTTM", "ePSGrowthRate5Year"]);
  const de = pk(["totalDebtPerTotalEquityMostRecentQuarter", "totalDebtPerTotalEquityMostRecentFiscalYear"]);
  const dy = pk(["currentDividendYieldCommonStockPrimaryIssueLTM", "dividendYieldIndicatedAnnualDividendDividedByClosingprice", "dividendYield5YearAverage"]);
  /* PEERS — indianapi's peerCompanyList carries the competitor set. Its RATIOS are unreliable
     (often 0), but the names, price, %change and market-cap are real, so we keep those and read
     P/E only when it's a sensible non-zero. Read defensively: field names vary across responses. */
  const num = (v) => (v != null && v !== "" && !isNaN(+v) ? +v : null);
  const peers = (Array.isArray(d.peerCompanyList) ? d.peerCompanyList : []).map((p) => ({
    name: p.companyName || p.name || p.tickerId || "",
    price: num(p.price),
    chg: num(p.percentChange ?? p.netChange),
    pe: (() => { const v = num(p.priceToEarningsValueRatio ?? p.priceToEarnings); return v && v > 0 ? v : null; })(),
    marketCapCr: num(p.marketCap),
  })).filter((p) => p.name).slice(0, 8);
  return {
    symbol,
    name: d.companyName,
    currency: "INR",
    sector: (d.companyProfile && d.companyProfile.mgSector) || d.industry || null,
    industry: d.industry || (d.companyProfile && d.companyProfile.mgIndustry) || null,
    marketCap: mcapCr != null ? mcapCr * 1e7 : null,                 // ₹ crore -> ₹ absolute
    peTrailing: pk(["pPerEBasicExcludingExtraordinaryItemsTTM", "pPerEIncludingExtraordinaryItemsTTM", "pPerENormalizedMostRecentFiscalYear"]),
    peForward: null,
    pb: pk(["priceToBookMostRecentQuarter", "priceToBookMostRecentFiscalYear"]),
    eps: pk(["ePSIncludingExtraOrdinaryItemsTrailing12Month"]),
    roe: roe != null ? roe / 100 : null,                            // % -> fraction
    profitMargin: npm != null ? npm / 100 : null,
    operatingMargin: opm != null ? opm / 100 : null,
    revenueGrowth: revG != null ? revG / 100 : null,
    earningsGrowth: epsG != null ? epsG / 100 : null,
    debtToEquity: de != null ? de * 100 : null,                     // ratio 0.07 -> 7 (match Yahoo %)
    dividendYield: dy != null ? dy / 100 : null,
    beta: pk(["beta"]),
    high52: d.yearHigh != null ? +d.yearHigh : pk(["yhigh"]),
    low52: d.yearLow != null ? +d.yearLow : pk(["ylow"]),
    sectorPE: pk(["sectorPriceToEarningsValueRatio"]),
    peers,
    src: "indianapi",
  };
}
const _fundCache = new Map();   // success-only cache; failures are NOT cached so we keep retrying
app.get("/api/fundamentals", publicDataLimiter, async (req, res) => {
  const symbol = String(req.query.symbol || "").trim();
  if (!symbol) return res.status(400).json({ error: "symbol required" });
  if (req.query.raw === "1") {   // debug: see the raw indianapi payload to verify field mapping
    try { const base = symbol.replace(/\.(NS|BO)$/i, ""); const rr = await fetch(`https://stock.indianapi.in/stock?name=${encodeURIComponent(base)}`, { headers: { "X-Api-Key": process.env.INDIANAPI_KEY || "", Accept: "application/json" } }); return res.json(await rr.json()); }
    catch (e) { return res.json({ error: String(e.message) }); }
  }
  const hit = _fundCache.get(symbol);
  if (hit && (Date.now() - hit.at) < 6 * 3600 * 1000) return res.json(hit.data);
  const isIndian = /\.(NS|BO)$/i.test(symbol);
  let data = null, err = "";
  if (isIndian) {
    if (process.env.INDIANAPI_KEY) { try { data = await indianApiFundamentals(symbol); } catch (e) { err = "indianapi:" + e.message; } }
  } else {
    if (process.env.FMP_API_KEY) { try { data = await fmpFundamentals(symbol); } catch (e) { err = "fmp:" + e.message; } }
  }
  if (!data) { try { data = await yahooFundamentals(symbol); } catch (e) { err += " yahoo:" + e.message; } }
  if (data) { _fundCache.set(symbol, { data, at: Date.now() }); return res.json(data); }
  res.json({ symbol, unavailable: true, error: err.trim() });
});

/* ─────────────────────────── EARNINGS CALENDAR ───────────────────────────
   US: FMP's earning_calendar (recent + upcoming), which we already have a key for. Indian:
   indianapi's recent-announcements/results endpoint when a key is set. Both cached 1h; both
   fail SOFT to an empty list so the section just hides rather than erroring. No invented dates. */
const ymdUTC = (d) => new Date(d).toISOString().slice(0, 10);
async function usEarnings() {
  const key = process.env.FMP_API_KEY;
  if (!key) return { recent: [], upcoming: [] };
  const now = Date.now();
  const from = ymdUTC(now - 7 * 864e5), to = ymdUTC(now + 21 * 864e5);
  const d = await j(`https://financialmodelingprep.com/api/v3/earning_calendar?from=${from}&to=${to}&apikey=${key}`);
  const rows = (Array.isArray(d) ? d : [])
    .filter((x) => x && x.symbol && x.date && /^[A-Z.]{1,6}$/.test(x.symbol))   // US tickers only
    .map((x) => ({ sym: x.symbol, date: x.date, epsEst: x.epsEstimated ?? null, eps: x.eps ?? null, revEst: x.revenueEstimated ?? null, when: x.time || null }));
  const today = ymdUTC(now);
  return {
    recent: rows.filter((x) => x.date < today).sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 40),
    upcoming: rows.filter((x) => x.date >= today).sort((a, b) => (a.date < b.date ? -1 : 1)).slice(0, 40),
  };
}
async function indiaEarnings() {
  const key = process.env.INDIANAPI_KEY;
  if (!key) return { recent: [], upcoming: [] };
  try {
    // indianapi exposes recent results/announcements; shape varies, so we read defensively.
    const rr = await fetchT(`https://stock.indianapi.in/recent_announcements`, { headers: { "X-Api-Key": key, Accept: "application/json" } });
    const d = rr.ok ? await rr.json().catch(() => null) : null;
    const arr = Array.isArray(d) ? d : (d && Array.isArray(d.data) ? d.data : []);
    const rows = arr.map((x) => ({ sym: x.symbol || x.company || x.name || "", date: (x.date || x.announcementDate || "").slice(0, 10), title: x.subject || x.headline || x.title || "Results" })).filter((x) => x.sym && x.date);
    const today = ymdUTC(Date.now());
    return { recent: rows.filter((x) => x.date <= today).slice(0, 40), upcoming: rows.filter((x) => x.date > today).slice(0, 40) };
  } catch { return { recent: [], upcoming: [] }; }
}
app.get("/api/earnings", publicDataLimiter, async (req, res) => {
  const market = String(req.query.market || "US");
  try {
    const out = await memo(`earn:${market}`, 60 * 60 * 1000, () => (market === "IN" ? indiaEarnings() : usEarnings()));
    res.json(out);
  } catch (e) { res.json({ recent: [], upcoming: [], error: String(e.message || e) }); }
});

/* ======================= SERVER-SIDE EXIT MONITOR =========================
   Runs on the server every minute, so a target/stop is honoured even when nobody
   has the app open. Walks REAL 5-minute candles forward from the entry time and
   closes the position at whichever level was actually touched first.
   Set EXIT_MONITOR=off to disable.                                            */
/* Range string -> seconds of lookback, for windowing Delta's candle query. */
function rangeToSeconds(range) {
  const m = String(range).match(/^(\d+)(d|mo|y)$/);
  if (!m) return 30 * 86400;
  const n = Number(m[1]);
  return m[2] === "d" ? n * 86400 : m[2] === "mo" ? n * 30 * 86400 : n * 365 * 86400;
}
/* Delta's OWN candles for a crypto perpetual — EXACT parity with what the position is
   marked against on Delta (Yahoo spot can drift from the perpetual mark). Public endpoint,
   routed through the proxy like every other Delta call. Returns ascending { o,h,l,c,v,t(ms) }. */
async function deltaCandles(deltaSym, resolution, range) {
  const end = Math.floor(Date.now() / 1000);
  const start = end - rangeToSeconds(range);
  const q = `?resolution=${encodeURIComponent(resolution)}&symbol=${encodeURIComponent(deltaSym)}&start=${start}&end=${end}`;
  const d = await deltaCall("GET", "/v2/history/candles", { query: q, signed: false });
  const rows = (d && d.result) || [];
  return rows
    .map((x) => ({ t: Number(x.time) * 1000, o: x.open, h: x.high, l: x.low, c: x.close, v: x.volume }))
    .filter((x) => x.c != null)
    .sort((a, b) => a.t - b.t);
}

async function candlesFor(symbol, range = "5d", interval = "5m") {
  // Crypto: use Delta's own candles so the exit engine and charts match the perpetual mark the
  // position is held against. BUT Delta's intraday history is short — for the deep look-backs the
  // optimiser & backtest need (1mo+), its handful of candles isn't enough and the optimiser reports
  // "couldn't fetch enough price history". So for those long ranges we skip Delta and use Yahoo's far
  // wider intraday window (~60d of 5m); Delta still serves the short, live ranges (charts / exits).
  // Resolve the symbol to its market form ONCE. Crypto strategies carry a bare ticker ("BTC", "ETH"),
  // but Delta needs "BTCUSD" and Yahoo needs "BTC-USD" — Y_SPECIAL maps the bare ticker to the Yahoo
  // form. Without this the optimiser/backtest fed a bare "BTC" straight to Yahoo, which rejects it and
  // returns 0 candles → "couldn't fetch enough price history". (The frontend maps before /api/history,
  // so charts worked while the optimiser didn't.) US/Indian tickers aren't in Y_SPECIAL, so unchanged.
  const yMapped = Y_SPECIAL[String(symbol)] || String(symbol);
  const cx = yMapped.match(/^([A-Z0-9]+)-USD$/);
  const LONG_RANGE = new Set(["1mo", "3mo", "6mo", "1y", "2y"]);
  if (cx && !LONG_RANGE.has(range)) {
    try {
      const dc = await memo(`dc:${cx[1]}:${range}:${interval}`, 60_000, () => deltaCandles(`${cx[1]}USD`, deltaResolution(interval), range));
      if (dc && dc.length) return dc;
    } catch (e) { /* fall through to Yahoo */ }
  }
  // GENERAL CRYPTO PROBE. A bare ticker (BTC, ETH, LAB, PEPE…) collides with US stock tickers by shape
  // — isUsTicker matches any 1-5 letters — so we can't tell a Delta coin from a stock by name alone, and
  // Y_SPECIAL only lists the majors. So for any bare symbol that didn't resolve as a "-USD" pair, PROBE
  // Delta: if {SYM}USD returns candles it's a real Delta contract, and Delta is the ONLY source for the
  // niche ones (Yahoo has no pair for most), so return its candles. Empty probe → fall through to the
  // US / Indian / Yahoo path below. (Symbols with a "." / "^" / "=" suffix skip the probe entirely.)
  if (!cx && /^[A-Z0-9]{2,15}$/.test(yMapped)) {
    // Use the SAME resolver + resolution the (working) chart path uses: deltaPerpFromAny knows the real
    // contract symbol, deltaResolution converts the Yahoo interval to Delta's ("60m" -> "1h", etc.).
    const dsym = deltaPerpFromAny(yMapped);
    if (dsym) {
      try {
        const dc = await memo(`dcprobe:${dsym}:${range}:${interval}`, 60_000, () => deltaCandles(dsym, deltaResolution(interval), range));
        if (dc && dc.length) return dc;
      } catch (e) { /* not a Delta contract → fall through */ }
    }
  }
  // US equities: IND Money's own candles (real-time) before Yahoo (15-min delayed).
  if (isUsTicker(symbol)) {
    try {
      const uc = await memo(`imc:${symbol}:${range}`, 60_000, () => indmoneyUsCandles(symbol, range));
      if (uc && uc.length) return uc;
    } catch (e) { /* fall through to Yahoo */ }
  }
  // FYERS house feed first for Indian equities; Yahoo otherwise / on any gap.
  const fy = await memo(`fyh:${symbol}:${range}:${interval}`, 60_000, () => fyersHouseHistory(symbol, range, interval));
  if (fy && fy.length >= 5) return fy;   // a thin (e.g. 1-candle) house response falls through to Yahoo
  /* YAHOO INTRADAY IS CAPPED (1m ~7d, other minute ~60d). Requesting `range=3mo&interval=5m` makes Yahoo
     422 and return nothing — which was leaving the optimiser with 0 candles when the FYERS feed missed.
     For intraday, request an explicit clamped period window instead (same trick /api/history uses). */
  const YMAX_D = { "1m": 7, "2m": 60, "3m": 60, "5m": 60, "10m": 60, "15m": 60, "30m": 60, "45m": 60, "60m": 730, "90m": 60 };
  let qs;
  if (YMAX_D[interval]) {
    const days = Math.min(FY_RANGE_DAYS[range] || 60, YMAX_D[interval]);
    const p2 = Math.floor(Date.now() / 1000), p1 = p2 - days * 86400;
    qs = `period1=${p1}&period2=${p2}&interval=${interval}`;
  } else {
    qs = `range=${range}&interval=${interval}`;
  }
  const data = await memo(`h:${yMapped}:${range}:${interval}`, 60_000, () =>
    j(`${YF}/v8/finance/chart/${encodeURIComponent(yMapped)}?${qs}`));
  const r = data.chart?.result?.[0];
  const ts = r?.timestamp || [];
  const q = r?.indicators?.quote?.[0] || {};
  return ts.map((t, i) => ({ t: t * 1000, o: q.open?.[i], h: q.high?.[i], l: q.low?.[i], c: q.close?.[i], v: q.volume?.[i] }))
           .filter((d) => d.c != null && d.h != null && d.l != null);
}

/* CANDLES WITH PERIOD FALLBACK — for the optimiser / backtest. A long look-back on a thin or niche
   contract (e.g. LAB's 5-minute history) can come back near-empty because the source only holds a
   little history. So we step the window DOWN — the requested range, then 6mo → 3mo → 1mo — and keep the
   deepest set we can actually get, stopping as soon as one range returns a usable sample. This means a
   6-month optimise that finds nothing automatically retries at 3 months, then 1 month. */
const _RANGE_ORDER = ["1d", "5d", "1mo", "3mo", "6mo", "1y", "2y"];   // ascending
function rangeLadder(range) {
  const i = _RANGE_ORDER.indexOf(range);
  // Floor at 5 days: Delta caps candles per request, so an intraday coin (e.g. LAB at 5m) returns
  // nothing for a 1-3 month window but ~a few thousand candles for 5 days — enough to optimise on.
  const floor = _RANGE_ORDER.indexOf("5d");
  if (i < 0 || i < floor) return [range];
  const out = [];
  for (let k = i; k >= floor; k--) out.push(_RANGE_ORDER[k]);   // requested → … → 5d
  return out;
}
async function candlesForOpt(symbol, range = "3mo", interval = "5m") {
  const MIN = 30;                                       // below this a range effectively "failed"
  // C-03: "2m" is the legacy mislabel for 3m — the optimizers must use REAL 3m candles too. Fetch native
  // 1m and fold ×3 (session-aligned) instead of ranking on 2m bars.
  const threeMin = interval === "2m";
  const fetchIv = threeMin ? "1m" : interval;
  let best = [];
  for (const r of rangeLadder(range)) {
    try {
      let c = await candlesFor(symbol, r, fetchIv);
      if (threeMin) c = aggCandles(c || [], 3);
      if (c && c.length > best.length) best = c;
      if (best.length >= MIN) break;                    // got a usable sample — stop stepping down
    } catch { /* try the next-shorter range */ }
  }
  return best;
}

// True when the trade is a SHORT (opened with a SELL). For a short, profit comes from the price
// FALLING, so TP sits BELOW entry and the stop sits ABOVE it — the mirror image of a long.
function isShortTrade(trade) {
  return String(trade && trade.side).toUpperCase() === "SELL" || trade?.short === true;
}
// Same rules as the in-app engine: TP / hard SL / trailing SL, worst-case on ties. Direction-aware:
// a LONG exits on a drop to its stop or a rise to its target; a SHORT is the mirror.
function resolveExit(trade, candles) {
  const { tp, sl, tsl, entry, entryAt } = trade;
  if (!tp && !sl && !tsl) return null;
  const rows = candles.filter((c) => c.t > (entryAt || 0));
  if (isShortTrade(trade)) {
    // Short: TP below entry, stops above. Trailing stop tracks the LOWEST price reached.
    const target = tp ? entry * (1 - tp / 100) : null;
    const hardStop = sl ? entry * (1 + sl / 100) : null;
    let trough = entry;
    for (const c of rows) {
      const trailStop = tsl ? trough * (1 + tsl / 100) : null;
      const stop = Math.min(hardStop ?? Infinity, trailStop ?? Infinity);
      const hasStop = stop < Infinity;
      const hitStop = hasStop && c.h >= stop;              // price rose into the stop → loss
      const hitTarget = target != null && c.l <= target;   // price fell to target → profit
      const stopLabel = (trailStop != null && stop === trailStop) ? "Trailing stop" : "Stop loss";
      if (hitStop) return { exit: +stop.toFixed(2), exitAt: c.t, exitType: stopLabel };
      if (hitTarget) return { exit: +target.toFixed(2), exitAt: c.t, exitType: "Exit trigger" };
      if (c.l < trough) trough = c.l;
    }
    return null;
  }
  const target = tp ? entry * (1 + tp / 100) : null;
  const hardStop = sl ? entry * (1 - sl / 100) : null;
  let peak = entry;
  for (const c of rows) {
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
        let hit = resolveExit(trade, candles);
        // INTRADAY square-off: an MIS/intraday position that hasn't hit TP/SL must be closed ~15 min
        // before the bell (and never carried overnight), mirroring the broker's own auto-square. We
        // exit at the latest candle close. Non-intraday (delivery/CNC) positions are left to run.
        const isIntraday = /^(mis|intraday|intra)$/i.test(String(trade.product || "")) || trade.intraday === true;
        if (!hit && isIntraday && intradaySquareDue(trade.market)) {
          const last = candles && candles.length ? candles[candles.length - 1].c : trade.entry;
          hit = { exit: +Number(last).toFixed(2), exitAt: Date.now(), exitType: "Square-off (intraday)" };
        }
        if (!hit) continue;
        const qty = trade.qty || 1;
        const dir = isShortTrade(trade) ? -1 : 1;   // a short profits when price falls
        const updated = { ...trade, ...hit, pnl: +((hit.exit - trade.entry) * qty * dir).toFixed(2) };
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
/* Cadence is env-tunable so a small DB plan can trade a little exit-latency for much less egress. The
   VIRTUAL exit monitor is a backstop only — the app also resolves paper exits client-side while it's
   open — so a 3-minute default (was 60s) cuts this sweep's Neon reads ~3× with no real-money impact. */
const EXIT_MONITOR_MS = Math.max(30_000, Number(process.env.EXIT_MONITOR_MS) || 180_000);
if (process.env.EXIT_MONITOR !== "off") {
  setInterval(runExitMonitor, EXIT_MONITOR_MS);
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
  // FYERS house feed first (real 5-min bars with volume); Yahoo otherwise.
  let rows = null;
  const fy = await fyersHouseHistory(sym, "1d", "5m");
  if (fy && fy.length >= 2) {
    rows = fy.map((c) => ({ t: Math.round(c.t / 1000), c: c.c, v: c.v })).filter((x) => x.c != null && !Number.isNaN(x.c));
  } else {
    const d = await j(`${YF}/v8/finance/chart/${encodeURIComponent(fallbackYF(sym))}?range=1d&interval=5m`);
    const r = d?.chart?.result?.[0];
    const q = r?.indicators?.quote?.[0];
    if (!r || !q) return null;
    // Keep only complete candles (Yahoo pads the array with nulls).
    rows = (r.timestamp || [])
      .map((t, i) => ({ t, c: q.close?.[i], v: q.volume?.[i] }))
      .filter((x) => x.c != null && !Number.isNaN(x.c));
  }

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

app.get("/api/intraday", publicDataLimiter, async (req, res) => {
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

app.get("/api/indicators", publicDataLimiter, async (req, res) => {
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
  // Public health: liveness, engines, DB mode only. No key metadata or env-var names.
  res.json({
    ok: true,
    engines: providers().map((p) => p.name),
    db: db.USING_PG ? "postgres" : "flat-file",
    // Is the FYERS house price feed configured? (true = Indian equities served from FYERS)
    fyersHouseFeed: Boolean((process.env.FYERS_APP_ID && process.env.FYERS_REFRESH_TOKEN && process.env.FYERS_PIN) || process.env.FYERS_ACCESS_TOKEN),
    deltaProxy: Boolean(process.env.DELTA_PROXY_URL || process.env.DELTA_PROXY),
    fyersProxy: Boolean(process.env.FYERS_PROXY_URL),   // routing FYERS via its own static-IP proxy
    build: "history-thin-fyers-18",   // bump on deploy so we can confirm which build is live
  });
});

/* Live diagnostic for the house price feeds. Hits FYERS + Delta right now and reports what
   came back (and any error). Open in a browser to see WHY a feed is falling back to Yahoo. */
/* Delta reachability probe. Tells us EXACTLY where signed Delta calls break — public feed vs
   signed-via-proxy — without leaking any balance/keys. Open on purpose (no secrets in output). */
/* Candle-source diagnostic: how many candles the OPTIMISER actually gets for a symbol/timeframe, and
   from where. Pass the YAHOO symbol (e.g. RELIANCE.NS, ^NSEI, BAJAJ-AUTO.NS). Tells us instantly whether
   a "0 signals" is a DATA gap (0 candles) or an engine issue (candles present but no entries). */
app.get("/api/diag/candles", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const ySym = String(req.query.symbol || "").trim();
    const tf = String(req.query.tf || "5m");
    const range = OPT_RANGE[tf] || "3mo", interval = OPT_INTERVAL[tf] || "5m";
    const fyersSymbol = (typeof yahooToFyers === "function") ? yahooToFyers(ySym) : null;
    let fyersHouseCount = 0, fyErr = null, fyRaw = null;
    try { const fh = await fyersHouseHistory(ySym, range, interval); fyersHouseCount = Array.isArray(fh) ? fh.length : 0; }
    catch (e) { fyErr = String(e && e.message); }
    // Surface the RAW FYERS history response (code/message) so we can see WHY an index returns 0.
    try {
      const resn = FY_RES[interval], days = FY_RANGE_DAYS[range], tok = await fyersHouseToken();
      if (fyersSymbol && resn && days && tok) {
        const raw = await fetchFyersHistoryRaw(fyersSymbol, resn, days, `${process.env.FYERS_APP_ID || ""}:${tok}`);
        fyRaw = { count: (raw && raw.candles) ? raw.candles.length : 0, code: raw && raw.code, message: raw && raw.message };
      } else {
        fyRaw = { note: "missing resolution / range-days / house token", hasToken: !!tok };
      }
    } catch (e) { fyRaw = { error: String(e && e.message) }; }
    let all = [];
    try { all = interval === "2m" ? aggCandles(await candlesFor(ySym, range, "1m"), 3) : await candlesFor(ySym, range, interval); } catch (e) { fyErr = fyErr || String(e && e.message); }   // C-03: real 3m
    res.json({
      symbol: ySym, fyersSymbol, tf, range, interval,
      fyersHouseCount, candlesForCount: (all || []).length,
      firstAt: (all || [])[0] ? new Date(all[0].t).toISOString() : null,
      lastAt: (all || []).length ? new Date(all[all.length - 1].t).toISOString() : null,
      fyErr, fyRaw,
    });
  } catch (e) { serverError(res, e); }
});
app.get("/api/diag/delta", async (req, res) => {
  if (!requireAdmin(req, res)) return;   // internal diagnostics — admin only, not public
  const T = (p, ms = 18000) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error("timed out")), ms))]);
  const cap = (e) => ({ ok: false, error: e && e.message, cause: e && e.cause ? (e.cause.code || e.cause.message || String(e.cause)) : undefined });
  const out = { base: DELTA_BASE, proxyConfigured: Boolean(deltaDispatcher) };
  /* Raw reachability probe of the proxy itself — tells us whether Render can even open a TCP
     socket to the proxy host (independent of undici / auth). If dns resolves but tcp4 fails,
     the proxy (our Oracle Cloud Always-Free instance) is refusing our IP rather than a code/tunnel bug. */
  const proxyUrl = process.env.DELTA_PROXY_URL || process.env.DELTA_PROXY || "";
  if (proxyUrl) {
    try {
      const dns = require("dns").promises; const net = require("net");
      const pu = new URL(proxyUrl);
      const port = Number(pu.port) || (pu.protocol === "https:" ? 443 : 80);
      const probe = { host: pu.hostname, port };
      try { probe.a = await T(dns.resolve4(pu.hostname), 5000); } catch (e) { probe.a = "err: " + e.message; }
      try { probe.aaaa = await T(dns.resolve6(pu.hostname), 5000); } catch (e) { probe.aaaa = "none"; }
      probe.tcp4 = await new Promise((resolve) => {
        const t0 = Date.now();
        const s = net.connect({ host: Array.isArray(probe.a) ? probe.a[0] : pu.hostname, port, family: 4 });
        const done = (v) => { try { s.destroy(); } catch { /* noop */ } resolve(v); };
        s.setTimeout(10000);
        s.on("connect", () => done({ ok: true, ms: Date.now() - t0 }));
        s.on("timeout", () => done({ ok: false, error: "tcp timeout", ms: Date.now() - t0 }));
        s.on("error", (e) => done({ ok: false, error: e.code || e.message, ms: Date.now() - t0 }));
      });
      out.proxyProbe = probe;
    } catch (e) { out.proxyProbe = { error: e.message }; }
  }
  /* Render's DIRECT outbound IP (NOT through the proxy). This is the IP Render connects to the
     Oracle Cloud proxy FROM — allow it in the proxy's ingress security list / firewall. */
  try { const dr = await T(fetch("https://api.ipify.org?format=json"), 8000); out.directOutboundIp = (await dr.json()).ip; } catch (e) { out.directOutboundIp = "unknown (" + (e && e.message) + ")"; }
  // The IP Delta sees for signed calls = this server's outbound IP (via the proxy if configured).
  // Whitelist THIS on your Delta API key — not your phone's IP.
  try { const ir = await T(pfetch("https://api.ipify.org?format=json", deltaDispatcher ? { dispatcher: deltaDispatcher } : {})); out.serverOutboundIp = (await ir.json()).ip; } catch (e) { out.serverOutboundIp = "unknown (" + (e && e.message) + ")"; }
  try { const t = await T(deltaCall("GET", "/v2/products", { signed: false })); out.public = { ok: true, products: (t.result || []).length }; }
  catch (e) { out.public = cap(e); }
  try { await T(deltaCall("GET", "/v2/wallet/balances")); out.signed = { ok: true }; }
  catch (e) { out.signed = cap(e); }
  res.json(out);
});

app.get("/api/feeds-status", async (req, res) => {
  if (!requireAdmin(req, res)) return;   // internal feed/config diagnostics — admin only
  let fy = {}, de = {};
  try { fy = await fyersHouseQuotes(["RELIANCE.NS"]); } catch (e) { _fyLastError = e.message; }
  try { de = await deltaHouseQuotes(["BTC-USD"]); } catch (e) { _deltaLastError = e.message; }
  // DIRECT token + history probe — bypasses the EQUITY_HOUSE_FEED quote gate so we can see whether
  // the FYERS auth (TOTP or access token) actually works and whether history is coming from FYERS.
  let tokenOk = false, tokenErr = null, histCount = 0, histErr = null;
  try { const t = await fyersHouseToken(); tokenOk = Boolean(t); } catch (e) { tokenErr = String(e.message || e); }
  try { const h = await fyersHouseHistory("RELIANCE.NS", "6mo", "1d"); histCount = (h && h.length) || 0; } catch (e) { histErr = String(e.message || e); }
  const totpEnv = { FYERS_FY_ID: Boolean(process.env.FYERS_FY_ID), FYERS_TOTP_SECRET: Boolean(process.env.FYERS_TOTP_SECRET), FYERS_REDIRECT_URI: Boolean(process.env.FYERS_REDIRECT_URI) };
  const secLen = (process.env.FYERS_TOTP_SECRET || "").trim().length;
  res.json({
    fyers: {
      envConfigured: {
        FYERS_APP_ID: Boolean(process.env.FYERS_APP_ID),
        FYERS_SECRET_ID: Boolean(process.env.FYERS_SECRET_ID),
        FYERS_REFRESH_TOKEN: Boolean(process.env.FYERS_REFRESH_TOKEN),
        FYERS_PIN: Boolean(process.env.FYERS_PIN),
        FYERS_ACCESS_TOKEN: Boolean(process.env.FYERS_ACCESS_TOKEN),
        ...totpEnv,
      },
      // Is the TOTP secret a plausible base32 key (not a 6-digit code)? A 6-digit numeric value is
      // the classic mistake — flag it so it's obvious.
      totpSecretLooksValid: secLen >= 16 && !/^\d{6}$/.test((process.env.FYERS_TOTP_SECRET || "").trim()),
      tokenOk, tokenError: tokenErr,
      historyCandles: histCount, historyError: histErr,   // >2 means the FYERS house feed is live
      working: Object.keys(fy).length > 0,
      sample: fy["RELIANCE.NS"] || null,
      lastError: _fyLastError,
      debug: _fyDebug,   // shapes + FYERS raw response (no secret values)
    },
    delta: {
      working: Object.keys(de).length > 0,
      sample: de["BTC-USD"] || null,
      lastError: _deltaLastError,
    },
  });
});

app.post("/api/ask", llmLimiter, async (req, res) => {
  const { messages = [], context = "", system: sysOverride, max_tokens = 1000 } = req.body || {};
  const DEFAULT = `You are Neo — Matrix One's stock-market and trading assistant, fluent in fundamental, technical and macro analysis of stocks, crypto, commodities, options, and how to use this app's features (strategies, screeners, backtests, automation).
SCOPE — STRICT: You ONLY discuss markets, trading, investing, and this app. If the user asks about anything unrelated (essays, general knowledge, coding help, homework, personal/life advice, recipes, politics, etc.), politely DECLINE in one sentence and steer back — e.g. "I can only help with stocks, trading and Matrix One. Ask me about a symbol, sector, or strategy." Do NOT answer the off-topic request even partially, and do not write essays or creative content.
ACCURACY: Never invent prices, figures, fundamentals, or news. If you don't have a current number, say you don't have live data for it rather than guessing. Prefer explaining method and what to look at over fabricating specifics.
Be crisp and structured; where relevant give bull case, bear case and key levels rather than a bare command. End market answers with a one-line reminder that this is educational research, not financial advice.`;
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
  // L-05: don't leak the joined provider error chain (vendor names/status) to the client — log it, return a
  // generic message. Which vendor answered/failed is an internal detail.
  console.error("[ask] all providers failed:", errors.join(" | "));
  res.status(502).json({ error: "Neo is unavailable right now. Please try again in a moment." });
});

/* AI STRATEGY INTERPRETER — turns any plain-English rule into executable conditions.
   The deterministic parser (frontend) is the fast path; when it can't fully read a prompt, the
   app calls this. We prompt the LLM to output STRICT JSON in the engine's own condition grammar,
   then validate every field against the known operands/ops so a hallucinated rule can't slip in. */
const AI_STRAT_SYS = `You convert a trader's plain-English strategy into JSON the trading engine can run. You handle ONLY trading strategy rules — never answer general questions. Output ONLY compact JSON, no prose, no markdown, shaped exactly:
{"entry":[cond,...],"exit":[cond,...],"defs":[def,...],"sl":number?,"tp":number?}
"sl" and "tp" are OPTIONAL stop-loss / take-profit PERCENTAGES (plain numbers, e.g. 2 for 2%). Include them when the user states a target/stop/exit-at-return: "exit at 5% return"/"take profit 5%"/"target 5%" -> tp:5; "stop loss 2%"/"cut at 2%" -> sl:2. Omit if not mentioned.
If the user asks you to SUGGEST/RECOMMEND a strategy without giving rules, propose a sensible one: default to a momentum/trend entry (EMA20 crosses_above EMA50 AND RSI>55) unless they hint "reversal/oversold/mean reversion" (then RSI<30 entry, RSI>55 exit). Fill sl/tp from any return/stop they mention.
A cond is {"la":LEFT,"op":OP,"b":RIGHT,"bType":"num"|"ind","gate":"AND"|"OR"?}. gate is omitted on the first cond in a list.
OP is one of: ">","<",">=","<=","crosses_above","crosses_below".
bType "num" means RIGHT is a number as a string (e.g. "50"). bType "ind" means RIGHT is another operand name.
LEFT/RIGHT operands you may use:
- "Price", "Volume", "Support", "Resistance"
- "RSI","ADX","CCI","VWAP" (indicators; add a matching def)
- "MACD.line","MACD.signal","MACD.hist"
- "BB.upper","BB.middle","BB.lower"
- "EMA<n>" / "SMA<n>" e.g. "EMA50","SMA200" (add a def with that name)
- "CC.open","CC.high","CC.low","CC.close" (current candle), "PC.open".. (previous candle)
- "DayChange" = % move since TODAY'S OPEN (add def {"type":"DayChange","name":"DayChange"}). Use for "up X% today / on the day / intraday".
- "DayChangePrevClose" = % move vs the PREVIOUS DAY'S CLOSE (add def {"type":"DayChangePrevClose","name":"DayChangePrevClose"}). Use for "up X% from last/previous day close", "gapped up X%".
- "PriceChange" = % move over a recent window (add def {"type":"PriceChange","name":"PriceChange","winMin":N}). Use for "up X% in the last N minutes/hours". winMin is the window in MINUTES (5 mins -> winMin:5, 1 hour -> winMin:60). For down-moves make the number negative (op "<"): "down 3% in 10 min" -> {"la":"PriceChange","op":"<","b":"-3","bType":"num"} with def winMin:10.
- Chart patterns as a boolean operand compared > 0: "PAT:cup-handle","PAT:double-bottom","PAT:double-top","PAT:head-shoulders","PAT:inv-head-shoulders","PAT:asc-triangle","PAT:desc-triangle","PAT:sym-triangle","PAT:bull-flag","PAT:bear-flag","PAT:rising-wedge","PAT:falling-wedge","PAT:rectangle"
- Candlestick patterns by name as a boolean operand compared > 0 (preferred over hand-coding CC/PC geometry): "CDL:doji","CDL:hammer","CDL:inverted-hammer","CDL:hanging-man","CDL:shooting-star","CDL:bull-engulfing","CDL:bear-engulfing","CDL:marubozu","CDL:spinning-top","CDL:morning-star","CDL:evening-star". These need NO def.
A def is {"type":"RSI"|"EMA"|"SMA"|"MACD"|"BB"|"ADX"|"CCI"|"VWAP"|"Stoch"|"DMI"|"CurrentCandle"|"PrevCandle","len":"14","name":"RSI"}. Only add defs for operands that need them (RSI/EMA/SMA/BB/ADX/CCI/MACD/candles). Support/Resistance/Price/Volume/PAT:/CDL: need NO def.
PARAMETERS IN BRACKETS/NUMBERS — when the user writes indicator settings, put them on the def:
- "MACD(3,10,16)" -> def {"type":"MACD","name":"MACD","fast":3,"slow":10,"signal":16} (fast,slow,signal in that order).
- "RSI 21" or "RSI(21)" -> def {"type":"RSI","len":"21","name":"RSI"}. "EMA 21" -> {"type":"EMA","len":"21","name":"EMA21"} (operand "EMA21"). Same for SMA/ADX/CCI.
- "BB(20,2)" / "Bollinger 20,2" -> def {"type":"BB","len":"20","mult":2,"name":"BB"}. If no numbers are given, use the defaults (MACD 12/26/9, RSI 14, BB 20/2).
STochastic operands: "Stoch.k","Stoch.d" (add a Stoch def). DMI operands: "DMI.plus","DMI.minus","DMI.adx" (add a DMI def).

TRANSLATION KNOWLEDGE — map common trader language to the operands above:
- Trend / moving averages: "golden cross" = EMA50 crosses_above EMA200; "death cross" = EMA50 crosses_below EMA200; "price above 200 DMA" = Price > SMA200; "20 over 50" = EMA20 crosses_above EMA50.
- Momentum: "oversold" = RSI < 30; "overbought" = RSI > 70; "strong trend" = DMI.adx > 25; "momentum turning up" = MACD.line crosses_above MACD.signal; "MACD bullish/bearish" = MACD.line >/< MACD.signal.
- Mean reversion / Bollinger: "bollinger bounce" / "reverts from lower band" = Price crosses_above BB.lower; "band squeeze breakout up" = Price crosses_above BB.upper; "back to the mean" = Price crosses_below BB.middle.
- Breakouts / levels: "breaks resistance" = Price crosses_above Resistance; "breaks support"/"breakdown" = Price crosses_below Support; "bounces off support" = Price crosses_above Support; "new highs" = Price crosses_above Resistance.
- Volume: "volume spike"/"high volume" = Volume > SMA20 of volume — approximate as Volume > (a def SMA20 named "VOLSMA") only if clearly asked; otherwise omit volume.
- Candlesticks (use current CC.* vs previous PC.*): "bullish engulfing" = CC.close > PC.open AND CC.open < PC.close; "bearish engulfing" = CC.close < PC.open AND CC.open > PC.close; "green candle"/"bullish candle" = CC.close > CC.open; "red candle" = CC.close < CC.open; "higher close" = CC.close > PC.close; "gap up" = CC.open > PC.close.
- Chart patterns: use the PAT:* boolean operands (compare > 0). "inverted head and shoulders" = PAT:inv-head-shoulders; "W bottom"/"double bottom" = PAT:double-bottom; "flag"/"bull flag" = PAT:bull-flag; "wedge" pick rising/falling; "triangle" pick asc/desc/sym.
- Named algo strategies (compose the archetype): "trend following" = EMA50 > EMA200 AND MACD.line > MACD.signal; "mean reversion" = RSI < 30 (exit RSI > 55); "momentum breakout" = Price crosses_above Resistance AND DMI.adx > 20; "RSI reversal" = RSI crosses_above 30 (exit RSI crosses_above 70); "supertrend flip up" (approx) = Price crosses_above EMA20 AND DMI.plus > DMI.minus.
- Fundamentals (P/E, ROE, revenue growth, debt) are NOT runnable by this technical engine — if a prompt is purely fundamental, return empty entry/exit rather than inventing operands.
Combine multiple clauses with gate "AND" (default) or "OR" when the user says "or". Always attach the def for every indicator you reference, exactly once, with a sensible default length (RSI 14, EMA/SMA the stated number, ADX/DMI 14, Stoch 14, CCI 20).

Examples:
"buy when a cup and handle forms" -> {"entry":[{"la":"PAT:cup-handle","op":">","b":"0","bType":"num"}],"exit":[],"defs":[]}
"buy when price bounces from support and rsi above 50" -> {"entry":[{"la":"Price","op":"crosses_above","b":"Support","bType":"ind"},{"la":"RSI","op":">","b":"50","bType":"num","gate":"AND"}],"exit":[],"defs":[{"type":"RSI","len":"14","name":"RSI"}]}
"golden cross with strong trend, exit on death cross" -> {"entry":[{"la":"EMA50","op":"crosses_above","b":"EMA200","bType":"ind"},{"la":"DMI.adx","op":">","b":"25","bType":"num","gate":"AND"}],"exit":[{"la":"EMA50","op":"crosses_below","b":"EMA200","bType":"ind"}],"defs":[{"type":"EMA","len":"50","name":"EMA50"},{"type":"EMA","len":"200","name":"EMA200"},{"type":"DMI","len":"14","name":"DMI"}]}
"mean reversion: buy oversold, sell when it recovers" -> {"entry":[{"la":"RSI","op":"<","b":"30","bType":"num"}],"exit":[{"la":"RSI","op":">","b":"55","bType":"num"}],"defs":[{"type":"RSI","len":"14","name":"RSI"}]}
"bullish engulfing above the 50 EMA" -> {"entry":[{"la":"CC.close","op":">","b":"PC.open","bType":"ind"},{"la":"CC.open","op":"<","b":"PC.close","bType":"ind","gate":"AND"},{"la":"Price","op":">","b":"EMA50","bType":"ind","gate":"AND"}],"exit":[],"defs":[{"type":"CurrentCandle","name":"CC"},{"type":"PrevCandle","name":"PC"},{"type":"EMA","len":"50","name":"EMA50"}]}
"bollinger bounce off the lower band, exit at the middle" -> {"entry":[{"la":"Price","op":"crosses_above","b":"BB.lower","bType":"ind"}],"exit":[{"la":"Price","op":"crosses_above","b":"BB.middle","bType":"ind"}],"defs":[{"type":"BB","len":"20","name":"BB"}]}
"sell when rsi crosses above 80" -> {"entry":[],"exit":[{"la":"RSI","op":"crosses_above","b":"80","bType":"num"}],"defs":[{"type":"RSI","len":"14","name":"RSI"}]}
"enter when the stock is up at least 10% from the last day close" -> {"entry":[{"la":"DayChangePrevClose","op":">=","b":"10","bType":"num"}],"exit":[],"defs":[{"type":"DayChangePrevClose","name":"DayChangePrevClose"}]}
"buy when price is up 2% in the last 5 minutes" -> {"entry":[{"la":"PriceChange","op":">","b":"2","bType":"num"}],"exit":[],"defs":[{"type":"PriceChange","name":"PriceChange","winMin":5}]}
"suggest a strategy, exit at 5% return" -> {"entry":[{"la":"EMA20","op":"crosses_above","b":"EMA50","bType":"ind"},{"la":"RSI","op":">","b":"55","bType":"num","gate":"AND"}],"exit":[],"defs":[{"type":"EMA","len":"20","name":"EMA20"},{"type":"EMA","len":"50","name":"EMA50"},{"type":"RSI","len":"14","name":"RSI"}],"tp":5}
If a part is genuinely impossible to express, omit it. Never invent operands outside the list above.`;

const AI_OPS = new Set([">", "<", ">=", "<=", "crosses_above", "crosses_below"]);
/* H-07: strictly validate LLM-produced indicator DEFS against a schema with type-specific numeric bounds and
   an allow-list of types. Malformed/adversarial model output (huge lengths, NaNs, unknown types) can't
   create expensive/invalid indicators or a strategy that appears armed but never fires. */
const AI_DEF_TYPES = new Set(["RSI", "EMA", "SMA", "MACD", "BB", "ADX", "CCI", "VWAP", "Stoch", "DMI", "CurrentCandle", "PrevCandle", "DayChange", "DayChangePrevClose", "PriceChange", "ATR", "Keltner"]);
const boundInt = (v, lo, hi, dflt) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= lo && n <= hi ? n : dflt; };
function sanitizeAiDefs(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const d of arr) {
    if (!d || typeof d.type !== "string" || typeof d.name !== "string") continue;
    const type = d.type.trim();
    if (!AI_DEF_TYPES.has(type)) continue;                       // unknown operand type → drop
    if (d.name.length > 24) continue;
    const nd = { type, name: d.name.trim().slice(0, 24) };
    if (["RSI", "EMA", "SMA", "ADX", "CCI", "ATR"].includes(type)) nd.len = String(boundInt(d.len, 2, 400, 14));
    else if (type === "BB" || type === "Keltner") { nd.len = String(boundInt(d.len, 2, 400, 20)); nd.mult = boundInt(d.mult, 1, 6, 2); }
    else if (type === "MACD") { nd.fast = boundInt(d.fast, 2, 200, 12); nd.slow = boundInt(d.slow, 3, 400, 26); nd.signal = boundInt(d.signal, 1, 200, 9); if (nd.fast >= nd.slow) { nd.fast = 12; nd.slow = 26; } }
    else if (type === "Stoch" || type === "DMI") nd.len = String(boundInt(d.len, 2, 200, 14));
    else if (type === "PriceChange") nd.winMin = boundInt(d.winMin, 1, 1440, 5);
    // CurrentCandle/PrevCandle/VWAP/DayChange(*) need no numeric params
    out.push(nd);
    if (out.length >= 8) break;
  }
  return out;
}
function sanitizeAiConds(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.filter((c) => c && typeof c.la === "string" && AI_OPS.has(c.op) && c.b != null)
    .map((c, i) => {
      const cond = { la: c.la, op: c.op, b: String(c.b), bType: c.bType === "ind" ? "ind" : "num" };
      if (i > 0) cond.gate = c.gate === "OR" ? "OR" : "AND";
      return cond;
    }).slice(0, 8);
}
app.post("/api/ai/strategy", llmLimiter, async (req, res) => {
  // 800 chars (was 500) so a rich multi-condition prompt isn't truncated mid-rule — a real limiter on
  // how "smart" Neo could be. Still bounded to keep token cost predictable.
  const text = String((req.body && req.body.text) || "").slice(0, 800);
  if (!text.trim()) return res.status(400).json({ error: "text required" });
  const chain = providers();
  if (!chain.length) return res.status(500).json({ error: "no LLM configured" });
  const withTimeout = (p, ms, l) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error(`${l}: timeout`)), ms))]);
  /* TOKEN SAVER: interpretation is deterministic for a given prompt, so cache the RESULT by prompt text
     for an hour. Identical prompts (the same strategy typed by many users, or retried) never re-bill the
     GROQ/LLM tokens — the single biggest lever on API spend for this endpoint. */
  const cacheKey = "aistrat:" + text.trim().toLowerCase().replace(/\s+/g, " ");
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.t < 3_600_000) return res.json(cached.v);
  for (const p of chain) {
    try {
      const out = await withTimeout(p.fn(AI_STRAT_SYS, [{ role: "user", content: text }], 500), 8000, p.name);
      const m = String(out || "").match(/\{[\s\S]*\}/);   // strip any stray prose/markdown
      if (!m) continue;
      const parsed = JSON.parse(m[0]);
      const entry = sanitizeAiConds(parsed.entry);
      const exit = sanitizeAiConds(parsed.exit);
      const defs = sanitizeAiDefs(parsed.defs);   // H-07: schema-validated, type-bounded
      // Pass through optional SL/TP percentages when the model extracted them (0 < x <= 100).
      const okPct = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 && n <= 100 ? +n : null; };
      const sl = okPct(parsed.sl), tp = okPct(parsed.tp);
      if (entry.length || exit.length) {
        const payload = { entry, exit, defs, ...(sl ? { sl } : {}), ...(tp ? { tp } : {}), engine: "Neo" };
        cache.set(cacheKey, { v: payload, t: Date.now() });
        return res.json(payload);
      }
    } catch (e) { console.error("[ai/strategy]", p.name, e.message); }
  }
  res.status(502).json({ error: "couldn't interpret" });
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

function putBrokerSession(userId, broker, accessToken, refreshToken = null, extra = null) {
  const id = crypto.randomBytes(32).toString("hex");
  const sess = { userId: String(userId), broker, accessToken, refreshToken, extra, at: Date.now() };
  brokerSessions.set(id, sess);
  /* Persist encrypted creds so the connection SURVIVES a server restart or the browser being
     closed on mobile: /api/broker/resume can re-mint a session id from these without asking
     the user to reconnect. (Delta uses server env keys, so it needs nothing stored.) */
  try { if (typeof persistSessionCred === "function") persistSessionCred(sess).catch(() => {}); } catch { /* best-effort */ }
  return id;
}

/** Resolve a session id to a live token, checking it belongs to this user. Identity is taken
    from the VERIFIED token (req.authUserId, set by requireAuth) — never from the spoofable
    X-User-Id header. Falls back to the header only for legacy/non-authed read paths. */
function getBrokerSession(req) {
  const id = req.get("X-Broker-Session");
  const userId = req.authUserId ? storageKeyFor(req.authUserId) : req.get("X-User-Id");
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

/* ── Bring-your-own-app credential cache ───────────────────────────────────────────────
   Each user can connect their OWN broker API app (app_id + secret + optional PIN), stored
   ENCRYPTED in db.broker_apps. The synchronous key()/secret() below need those values, so
   we keep a decrypted copy in memory, keyed "userId|broker". Warmed from the DB on boot
   (warmAppCredCache, called after initDb) and updated whenever a user connects.
   This is what replaces the env-var-per-user idea: no restart, no Render coupling. */
const appCredCache = new Map();
function appCredKey(userId, broker) { return `${storageKeyFor(userId)}|${broker}`; }
function getUserAppCred(broker, userId) {
  if (!userId) return null;
  return appCredCache.get(appCredKey(userId, broker)) || null;
}
function setUserAppCred(userId, broker, cred) {
  appCredCache.set(appCredKey(userId, broker), cred);
}

/* OAUTH CSRF STATE — a random, single-use, short-lived nonce per login attempt (RFC 6749 §10.12).
   Issued at /api/broker/login-url, echoed by the broker on the redirect, and verified once at
   /api/broker/session. Prevents an attacker's auth_code (from a login THEY started) being planted
   into a victim's session — the old hardcoded `state=matrix` gave no such protection. In-memory is
   fine: an unfinished login just restarts. */
const oauthStates = new Map();               // nonce -> { userId, broker, redirect, exp }
const OAUTH_STATE_TTL = 10 * 60_000;         // 10 minutes to complete the broker login
/* R4/R5-P2-03: OAuth callback allow-list. When OAUTH_REDIRECT_ALLOWLIST is set (comma-separated origins
   or URL prefixes) the login redirect must match one of them; otherwise it's rejected. Opt-in — unset
   means "don't change behaviour" so existing BYOA flows keep working. The canonical redirect is also
   stored in the one-time state record and verified at completion when the client echoes it back. */
const OAUTH_REDIRECT_ALLOW = (process.env.OAUTH_REDIRECT_ALLOWLIST || "").split(",").map((s) => s.trim()).filter(Boolean);
/* R8-P1-03: OAuth hardening is FAIL-CLOSED in production by default. Production refuses to boot unless the
   redirect allow-list is configured AND redirect-echo enforcement is on — an unprotected callback is a
   real-money account risk, so it should be an explicit, deliberate opt-OUT, not a silent default. The only
   escape hatch is OAUTH_ALLOW_INSECURE_REDIRECTS=1 (development / first-deploy bring-up only). Outside
   production (or with the bypass) we merely WARN. All variables are documented in ENV.md. */
(() => {
  const prod = process.env.NODE_ENV === "production";
  const enforceEcho = /^(1|true|yes)$/i.test(String(process.env.OAUTH_ENFORCE_REDIRECT || ""));
  const insecureBypass = /^(1|true|yes)$/i.test(String(process.env.OAUTH_ALLOW_INSECURE_REDIRECTS || ""));
  // Back-compat: OAUTH_REQUIRE_ALLOWLIST still hard-fails on an empty list even outside production.
  const requireAllow = /^(1|true|yes)$/i.test(String(process.env.OAUTH_REQUIRE_ALLOWLIST || ""));
  if (requireAllow && !OAUTH_REDIRECT_ALLOW.length) throw new Error("OAUTH_REQUIRE_ALLOWLIST is set but OAUTH_REDIRECT_ALLOWLIST is empty — configure your exact callback origin(s)/path(s). See ENV.md.");
  if (prod && !insecureBypass) {
    if (!OAUTH_REDIRECT_ALLOW.length) throw new Error("Refusing to boot: NODE_ENV=production without OAUTH_REDIRECT_ALLOWLIST. Set it to your exact broker callback URL(s) (e.g. https://your-app-domain), or set OAUTH_ALLOW_INSECURE_REDIRECTS=1 for a temporary dev/bring-up bypass. See ENV.md.");
    if (!enforceEcho) throw new Error("Refusing to boot: NODE_ENV=production without OAUTH_ENFORCE_REDIRECT=1. Enable redirect-echo enforcement (safe once frontend + backend are both deployed), or set OAUTH_ALLOW_INSECURE_REDIRECTS=1 for a temporary bypass. See ENV.md.");
  }
  if (prod && insecureBypass) console.warn("[oauth] PRODUCTION running with OAUTH_ALLOW_INSECURE_REDIRECTS=1 — allow-list/enforcement NOT required. This is a bring-up bypass; remove it and configure OAUTH_REDIRECT_ALLOWLIST + OAUTH_ENFORCE_REDIRECT=1 for a real deployment.");
})();
/* R6-P2-03: match on EXACT origin + a PATH BOUNDARY — never a naive startsWith, which would let
   "https://app.example" prefix-match the attacker origin "https://app.example.evil.com". An allow entry
   may be a bare origin ("https://app.example") or an origin+path prefix ("https://app.example/oauth"). */
const redirectAllowed = (redirect) => reconcile.redirectAllowed(redirect, OAUTH_REDIRECT_ALLOW);
/* R16-P2-11: the nonce lives in a SHARED Postgres store when a DB is configured, so a login started on one
   replica can complete on another and state survives a restart. Flat-file/no-DB deployments fall back to the
   in-memory Map (single process, so that's still correct there). */
async function issueOAuthState(userId, broker, redirect = null) {
  const now = Date.now();
  const nonce = crypto.randomBytes(24).toString("hex");
  const rec = { userId: userId != null ? String(userId) : null, broker, redirect: redirect || null, exp: now + OAUTH_STATE_TTL };
  const stored = await db.saveOAuthState(nonce, rec, rec.exp).catch(() => false);
  if (!stored) {
    for (const [k, v] of oauthStates) if (v.exp < now) oauthStates.delete(k);   // prune expired (mem fallback)
    oauthStates.set(nonce, rec);
  }
  return nonce;
}
async function consumeOAuthState(nonce, broker, userId, redirect = null) {
  if (!nonce) return { ok: false, reason: "missing state — start the broker login again" };
  let s = await db.consumeOAuthStateRow(nonce).catch(() => null);
  if (!s) { s = oauthStates.get(nonce) || null; oauthStates.delete(nonce); }   // one-time use (mem fallback)
  if (!s) return { ok: false, reason: "unknown or expired state — start the broker login again" };
  if (s.exp < Date.now()) return { ok: false, reason: "the login expired — please try again" };
  if (s.broker !== broker) return { ok: false, reason: "broker mismatch" };
  if (s.userId && userId && String(s.userId) !== String(userId)) return { ok: false, reason: "this login belongs to a different account" };
  // R6-P1-02: bind the transaction to the redirect that STARTED it (mismatch always rejected; missing
  // echo rejected only when OAUTH_ENFORCE_REDIRECT is on). Pure decision in reconcile.js.
  const rb = reconcile.redirectBindingOk(s.redirect, redirect, /^(1|true|yes)$/i.test(String(process.env.OAUTH_ENFORCE_REDIRECT || "")));
  if (!rb.ok) return rb;
  return { ok: true };
}

const BROKERS = {
  zerodha: {
    name: "Zerodha",
    // Per-user BYOA app (db.broker_apps) first, then env (KITE_API_KEY_<userId>), then global.
    key: (userId) => getUserAppCred("zerodha", userId)?.appId || envKey(...perUser("KITE_API_KEY", userId)),
    secret: (userId) => getUserAppCred("zerodha", userId)?.secret || envKey(...perUser("KITE_API_SECRET", userId)),
    loginUrl: (key) => `https://kite.zerodha.com/connect/login?v=3&api_key=${key}`,
  },
  fyers: {
    name: "FYERS",
    /* Resolution order, so ONE code path serves every setup:
       1. The user's OWN app (BYOA) stored encrypted in db.broker_apps — this is what lets
          two users each connect their own FYERS app and have trades land in their own account.
       2. A per-user env var (FYERS_APP_ID_<userId>) — legacy manual config.
       3. The global FYERS_APP_ID — the server's house app. */
    key: (userId) => getUserAppCred("fyers", userId)?.appId || envKey(...perUser("FYERS_APP_ID", userId)),
    secret: (userId) => getUserAppCred("fyers", userId)?.secret || envKey(...perUser("FYERS_SECRET_ID", userId)),
    loginUrl: (key, redirect, state) =>
      `https://api-t1.fyers.in/api/v3/generate-authcode?client_id=${encodeURIComponent(key)}&redirect_uri=${encodeURIComponent(redirect || "")}&response_type=code&state=${encodeURIComponent(state || "matrix")}`,
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
    // Per-user BYOA: the user's own Delta API key/secret (db.broker_apps) so their trades land in
    // THEIR account; the operator/admin falls back to the server's house env keys.
    key: (userId) => getUserAppCred("delta", userId)?.appId || envKey("DELTA_API_KEY"),
    secret: (userId) => getUserAppCred("delta", userId)?.secret || envKey("DELTA_API_SECRET"),
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
    loginUrl: (key, redirect, state) =>
      `https://api.schwabapi.com/v1/oauth/authorize?client_id=${encodeURIComponent(key)}&redirect_uri=${encodeURIComponent(redirect || "")}&response_type=code${state ? `&state=${encodeURIComponent(state)}` : ""}`,
  },

  /* BRING-YOUR-OWN-CREDENTIAL brokers. Unlike the OAuth brokers, these don't send the user
     to a login page — the user generates a token (or enters login + TOTP) and hands it to
     us directly. `userCreds:true` means "no server app key needed; credentials arrive in
     the connect body". No secrets sit in the server env for these. */
  dhan: {
    name: "Dhan", userCreds: true,
    /* "Log in with Dhan" (PARTNER consent OAuth) is available when the server holds Matrix's Dhan
       partner credentials; otherwise the user pastes a token (userCreds path). key()/secret() return
       the PARTNER id/secret used to generate + consume the consent. loginUrl is null because Dhan
       needs an async generate-consent call first — that's handled in /api/broker/login-url. */
    partnerOAuth: () => Boolean(envKey("DHAN_PARTNER_ID") && envKey("DHAN_PARTNER_SECRET")),
    key: () => envKey("DHAN_PARTNER_ID") || "byo",
    secret: () => envKey("DHAN_PARTNER_SECRET") || "byo",
    loginUrl: () => null,
  },
  indmoney: {
    name: "IND Money", userCreds: true,
    key: () => "byo", secret: () => "byo", loginUrl: () => null,
  },
  angelone: {
    name: "Angel One", userCreds: true,
    key: () => "byo", secret: () => "byo", loginUrl: () => null,
  },
  groww: {
    name: "Groww", userCreds: true,
    key: () => "byo", secret: () => "byo", loginUrl: () => null,
  },
  coindcx: {
    name: "CoinDCX", userCreds: true,   // per-user crypto (API key + secret), HMAC-signed
    key: () => "byo", secret: () => "byo", loginUrl: () => null,
  },
  binance: {
    name: "Binance", userCreds: true,   // per-user crypto (API key + secret), HMAC query-string
    key: () => "byo", secret: () => "byo", loginUrl: () => null,
  },
  coinswitch: {
    name: "CoinSwitch", userCreds: true,   // per-user crypto (Ed25519 signature)
    key: () => "byo", secret: () => "byo", loginUrl: () => null,
  },
};

/* Binance signs with HMAC_SHA256 over the query string; the api key rides in X-MBX-APIKEY.
   Works for GET (reads) and POST (orders) — Binance accepts the signed params in the query
   string for both. */
async function binanceSigned(apiKey, apiSecret, path, params = {}, method = "GET") {
  const q = new URLSearchParams({ ...params, timestamp: String(Date.now()), recvWindow: "10000" }).toString();
  const signature = crypto.createHmac("sha256", apiSecret).update(q).digest("hex");
  const r = await fetch(`https://api.binance.com${path}?${q}&signature=${signature}`, { method, headers: { "X-MBX-APIKEY": apiKey } });
  const d = await r.json().catch(() => ({}));
  return { r, d };
}

/* CoinSwitch PRO uses Ed25519: sign (METHOD + request_path + epoch) with the secret (a hex
   Ed25519 private seed). Headers: X-AUTH-APIKEY, X-AUTH-SIGNATURE (hex), X-AUTH-EPOCH. */
async function coinswitchSigned(apiKey, apiSecret, method, path, body = null) {
  const epoch = String(Date.now());
  // CoinSwitch PRO signs method + endpoint + epoch (+ payload for write calls).
  const payload = body ? JSON.stringify(body) : "";
  const msg = method + path + epoch + payload;
  let signature = "";
  try {
    const seed = Buffer.from(apiSecret, "hex");
    const keyObj = crypto.createPrivateKey({
      key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
      format: "der", type: "pkcs8",
    });
    signature = crypto.sign(null, Buffer.from(msg), keyObj).toString("hex");
  } catch (e) { throw new Error("CoinSwitch key format not recognised: " + e.message); }
  const r = await fetch(`https://api-trading.coinswitch.co${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-AUTH-APIKEY": apiKey, "X-AUTH-SIGNATURE": signature, "X-AUTH-EPOCH": epoch },
    ...(body ? { body: payload } : {}),
  });
  const d = await r.json().catch(() => ({}));
  return { r, d };
}

/* ── Instrument-master resolvers for brokers that trade by NUMERIC id ──────────────────
   Dhan and Angel One place orders against a numeric instrument id, not a ticker. Getting
   this wrong doesn't fail politely — it BUYS A DIFFERENT STOCK. So we download the broker's
   own master, match STRICTLY on (NSE, cash-equity, exact trading symbol), and REFUSE if the
   match is missing or ambiguous. A refused order is safe; a guessed id is not. Cached 12h. */
const _scrip = { dhan: { at: 0, map: null }, angel: { at: 0, map: null } };

async function dhanSecurityId(sym) {
  const now = Date.now();
  if (!_scrip.dhan.map || now - _scrip.dhan.at > 12 * 3600 * 1000) {
    const res = await fetchT("https://images.dhan.co/api-data/api-scrip-master.csv", {}, 30000);
    const txt = await res.text();
    const lines = txt.split(/\r?\n/);
    const H = lines[0].split(",").map((s) => s.trim());
    const iId = H.indexOf("SEM_SMST_SECURITY_ID"), iSym = H.indexOf("SEM_TRADING_SYMBOL"),
      iExch = H.indexOf("SEM_EXM_EXCH_ID"), iSeg = H.indexOf("SEM_SEGMENT");
    if (iId < 0 || iSym < 0 || iExch < 0) throw new Error("Dhan scrip master format changed — cannot resolve id safely");
    const map = {};
    for (let k = 1; k < lines.length; k++) {
      const c = lines[k].split(",");
      if (!c[iExch]) continue;
      if (c[iExch].trim() !== "NSE") continue;                       // NSE only
      if (iSeg >= 0 && !/^(E|EQ|I)$/i.test((c[iSeg] || "").trim())) continue;   // cash/equity segment
      const t = (c[iSym] || "").trim().toUpperCase();
      if (t) map[t] = (c[iId] || "").trim();
    }
    _scrip.dhan = { at: now, map };
  }
  const key = String(sym).toUpperCase().replace(/-EQ$/, "");
  const id = _scrip.dhan.map[key] || _scrip.dhan.map[`${key}-EQ`];
  if (!id) throw new Error(`Dhan: no NSE equity security id for ${sym} — refusing rather than guess`);
  return id;
}

async function angelToken(sym) {
  const now = Date.now();
  if (!_scrip.angel.map || now - _scrip.angel.at > 12 * 3600 * 1000) {
    const res = await fetchT("https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json", {}, 30000);
    const arr = await res.json();
    const map = {};
    for (const x of (Array.isArray(arr) ? arr : [])) {
      if ((x.exch_seg || x.exchSeg) !== "NSE") continue;
      const s = String(x.symbol || "").toUpperCase();
      if (!s.endsWith("-EQ")) continue;                              // NSE cash equity symbols end -EQ
      map[s] = String(x.token);
    }
    _scrip.angel = { at: now, map };
  }
  const key = `${String(sym).toUpperCase().replace(/-EQ$/, "")}-EQ`;
  const token = _scrip.angel.map[key];
  if (!token) throw new Error(`Angel One: no NSE equity token for ${sym} — refusing rather than guess`);
  return { token, tradingsymbol: key };
}

/* CoinDCX signs each request: signature = HMAC_SHA256(JSON body, apiSecret), sent with the
   api key in X-AUTH-APIKEY and the hex signature in X-AUTH-SIGNATURE. Returns { r, d }. */
async function coindcxCall(apiKey, apiSecret, path, extraBody = {}) {
  const body = { timestamp: Date.now(), ...extraBody };
  const payload = JSON.stringify(body);
  const signature = crypto.createHmac("sha256", apiSecret).update(payload).digest("hex");
  const r = await fetch(`https://api.coindcx.com${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-AUTH-APIKEY": apiKey, "X-AUTH-SIGNATURE": signature },
    body: payload,
  });
  const d = await r.json().catch(() => ({}));
  return { r, d };
}

/* Standard Angel One SmartAPI headers. The private key + JWT identify the app + session;
   the IP/MAC headers are required by the API but may be placeholders for a server client. */
function angelHeaders(apiKey, jwt) {
  return {
    "Content-Type": "application/json", Accept: "application/json",
    "X-UserType": "USER", "X-SourceID": "WEB",
    "X-ClientLocalIP": "127.0.0.1", "X-ClientPublicIP": "127.0.0.1", "X-MACAddress": "00:00:00:00:00:00",
    "X-PrivateKey": apiKey,
    ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
  };
}

/* ── Delta request signing ───────────────────────────────────────────────────────
   signature = HMAC_SHA256(secret, method + timestamp + path + query + body)
   Sent as: api-key, timestamp, signature. The secret never leaves this process. */
/* Set DELTA_TESTNET=true (with TESTNET api keys in DELTA_API_KEY/SECRET) to route ALL Delta
   traffic to the testnet — real API, fake money — so the crypto order + reconciliation path can
   be exercised end-to-end without real funds. Production (india.delta.exchange) is the default. */
const DELTA_BASE = String(process.env.DELTA_TESTNET || "").toLowerCase() === "true"
  ? (process.env.DELTA_TESTNET_BASE || "https://cdn-ind.testnet.deltaex.org")
  : "https://api.india.delta.exchange";

/* ── Delta outbound proxy ─────────────────────────────────────────────────────────
   Delta whitelists API keys by IP. Render's outbound IP isn't (and can't reliably be)
   whitelisted, so Delta rejects our calls with `ip_not_whitelisted_for_api_key`.
   The fix is to route ONLY the Delta requests through a static, whitelisted proxy.
   Here that proxy is our own Oracle Cloud Always-Free instance, which holds a reserved
   static public IP — THAT is the IP whitelisted on the Delta API key. Set DELTA_PROXY_URL
   to it, e.g.
     http://<user>:<pass>@<oracle-instance-public-ip>:<port>
   Credentials are pulled out of the URL and sent as a Proxy-Authorization header
   (the most reliable way for undici's ProxyAgent). If the var is unset, Delta calls
   go out directly, exactly as before. */
const deltaDispatcher = makeProxyDispatcher(process.env.DELTA_PROXY_URL || process.env.DELTA_PROXY || "");
if (deltaDispatcher) console.log("[delta] routing Delta API through the configured proxy");

/* Is this userId one of the configured operator/admin accounts? Admins may use the server's
   house Delta keys (env). Everyone else MUST bring their own Delta API key/secret. */
function isAdminUserId(uid) {
  const ids = String(process.env.ADMIN_USER_IDS || "").split(",").map((x) => stripPh(x.trim())).filter(Boolean);
  return ids.includes(stripPh(String(uid || "")));
}
/* Resolve the Delta API key/secret to sign with for THIS user:
   - a non-admin who connected their own Delta (BYOA) -> THEIR keys (trades hit THEIR account)
   - the admin/operator -> the server's house env keys (their own account)
   - a non-admin WITHOUT their own keys -> null, and signed order calls must refuse (never fall
     back to the house account, or one user's trade would execute on the operator's account). */
function deltaCredsFor(userId) {
  const uc = getUserAppCred("delta", userId);
  if (uc && uc.appId && uc.secret) return { key: uc.appId, secret: uc.secret, own: true };
  if (!userId || isAdminUserId(userId)) return { key: envKey("DELTA_API_KEY"), secret: envKey("DELTA_API_SECRET"), own: false };
  return null;   // non-admin, no BYOA keys -> caller must reject
}
/* Throw unless this user is allowed to place a signed Delta order (has own keys, or is admin). */
function assertDeltaTradable(userId) {
  if (!deltaCredsFor(userId)) throw new Error("Connect your own Delta account (API key + secret) to trade crypto for real.");
}

function deltaHeaders(method, path, query = "", body = "", creds = null) {
  const key = (creds && creds.key) || envKey("DELTA_API_KEY");
  const secret = (creds && creds.secret) || envKey("DELTA_API_SECRET");
  if (!key || !secret) throw new Error("Delta keys not set — connect your Delta account first");

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

async function deltaCall(method, path, { query = "", body = null, signed = true, userId = null } = {}) {
  const bodyStr = body ? JSON.stringify(body) : "";
  // For signed calls tied to a user, sign with THAT user's Delta keys (BYOA). Unsigned public
  // calls (products, candles, tickers) need no creds. When no userId is given, house keys are used.
  const creds = signed ? (userId != null ? deltaCredsFor(userId) : { key: envKey("DELTA_API_KEY"), secret: envKey("DELTA_API_SECRET") }) : null;
  if (signed && userId != null && !creds) throw new Error("Connect your own Delta account (API key + secret) to trade crypto for real.");
  const headers = signed
    ? deltaHeaders(method, path, query, bodyStr, creds)
    : { "Content-Type": "application/json", "User-Agent": "matrix" };

  /* One fetch, wrapped with an explicit abort so a hung proxy leg fails in bounded time
     instead of hanging until the platform cancels it (which surfaces as the cryptic
     "fetch failed (request was cancelled)"). */
  const doFetch = async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      return await pfetch(DELTA_BASE + path + query, {
        method,
        headers,
        signal: ctrl.signal,
        ...(bodyStr ? { body: bodyStr } : {}),
        ...(deltaDispatcher ? { dispatcher: deltaDispatcher } : {}),   // route via whitelisted proxy when configured
      });
    } finally { clearTimeout(timer); }
  };

  /* Retry ONCE on a transport failure — but ONLY for idempotent GETs. The Delta signed leg
     goes through a third-party Mumbai proxy (IP-whitelist requirement); a cold Render dyno or
     a briefly-unreachable proxy drops the first request, and a second attempt a moment later
     almost always succeeds. POSTs (orders) are never retried — a duplicate order is far worse
     than one clear failure. */
  const transportErr = (e) => {
    const s = `${e && e.message} ${e && e.cause && (e.cause.code || e.cause.message)}`.toLowerCase();
    return /fetch failed|cancel|abort|timeout|econnreset|etimedout|socket|closed|network/.test(s);
  };
  let r;
  try {
    r = await doFetch();
  } catch (e) {
    if (method === "GET" && transportErr(e)) {
      await new Promise((res2) => setTimeout(res2, 1200));
      try { r = await doFetch(); }
      catch (e2) {
        const why = (e2 && e2.cause && (e2.cause.code || e2.cause.message)) || (e2 && e2.message) || "unreachable";
        throw new Error(`Couldn't reach Delta through the trading proxy (${why}). The server may have been asleep or the proxy is briefly unreachable — try connecting again in a few seconds.`);
      }
    } else {
      throw e;
    }
  }
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

/* The static egress IP the user must whitelist in their FYERS app. All broker order/quote
   traffic exits through our proxy, so ONE whitelisted IP covers every user. Configure
   BROKER_STATIC_IP explicitly, or we derive it from the FYERS/Delta proxy URL host. */
function brokerStaticIp() {
  const explicit = (process.env.BROKER_STATIC_IP || "").trim();
  if (explicit) return explicit;
  const proxy = process.env.FYERS_PROXY_URL || process.env.DELTA_PROXY_URL || process.env.DELTA_PROXY || "";
  try { if (proxy) return new URL(proxy).hostname; } catch { /* not a URL */ }
  return null;
}

/** Which brokers are actually configured on this server, for the AUTHENTICATED user only. */
app.get("/api/broker/status", requireAuth, async (req, res) => {
  /* R14-P2-05: identity MUST come from the verified token, never a spoofable X-User-Id/query param —
     otherwise anyone could enumerate identifiers to learn whether a given user has broker credentials. */
  const userId = req.authUserId;
  const storeKey = userId ? storageKeyFor(userId) : null;
  const out = {};
  for (const [id, b] of Object.entries(BROKERS)) {
    // hasCreds: the server holds resumable creds for this user → the client can auto-resume the
    // session on ANY device (e.g. mobile after connecting on laptop) without a fresh reconnect.
    let hasCreds = false;
    try {
      if (id === "delta") hasCreds = Boolean(getUserAppCred("delta", userId)) || isAdminUserId(userId);
      else if (storeKey) hasCreds = Boolean(await db.getBrokerCred(storeKey, id));
    } catch { hasCreds = false; }
    out[id] = {
      name: b.name,
      configured: Boolean(b.key(userId) && b.secret(userId)),
      // Has THIS user supplied their own app credentials (bring-your-own-app)?
      appConnected: Boolean(getUserAppCred(id, userId)),
      hasCreds,
    };
  }
  res.json({ brokers: out, tradingEnabled: TRADING_ENABLED, staticIp: brokerStaticIp() });
});

/* What the user needs to set up their own FYERS app: the redirect URL to register and the
   static IP to whitelist. The frontend shows these before the user pastes App ID + Secret. */
app.get("/api/broker/connect-info", (req, res) => {
  res.json({ staticIp: brokerStaticIp() });
});

/* BRING-YOUR-OWN-APP: the user supplies their OWN broker API app credentials (app_id +
   secret, and an OPTIONAL trading PIN used only to auto-refresh the daily token). Stored
   AES-256-GCM encrypted in db.broker_apps and cached in memory so the OAuth login + token
   exchange (which reuse b.key()/b.secret()) work for this user. The plaintext secret never
   goes to the browser after this and never lands in an env var. */
app.post("/api/broker/app-creds", requireAuth, requireActiveUser, async (req, res) => {
  const userId = storageKeyFor(req.authUserId);
  const { broker } = req.body || {};
  const b = BROKERS[broker];
  if (!b) return res.status(400).json({ error: "unknown broker" });
  // Delta uses an API key + secret (no OAuth) — allow it here so each user stores their OWN keys.
  if ((b.noOAuth && broker !== "delta") || b.userCreds) return res.status(400).json({ error: `${b.name} does not use an app id/secret.` });
  const appId = String((req.body.appId || "")).trim();
  const secret = String((req.body.secret || "")).trim();
  const pin = String((req.body.pin || "")).trim();   // optional — enables daily auto-refresh (not used by Delta)
  if (!appId || !secret) return res.status(400).json({ error: broker === "delta" ? "Delta API Key and Secret are required." : "App ID and Secret are required." });
  try {
    const cred = { appId, secret, pin: pin || null };
    await db.saveBrokerApp(userId, broker, encryptCred(cred));
    setUserAppCred(userId, broker, cred);
    res.json({ ok: true, staticIp: brokerStaticIp() });
  } catch (e) {
    serverError(res, e);
  }
});

/* ── Global admin-controlled app settings ──────────────────────────────────────────────
   Two gates the admin flips for the whole app:
     allowRealMode          — may non-admin users switch to Real trading at all?
     allowBrokerConnect{mkt} — may non-admin users connect their own broker for that market?
   Both default to FALSE (locked down): a fresh deploy does NOT let members trade real money
   or connect brokers until the admin explicitly turns it on. Admins are never gated by these. */
const MARKETS = ["IN", "US", "Crypto", "Commodity"];
const DEFAULT_APP_SETTINGS = {
  // Per-market, like allowBrokerConnect: may non-admins switch to REAL trading on this market?
  allowRealMode: MARKETS.reduce((o, m) => { o[m] = false; return o; }, {}),
  allowBrokerConnect: MARKETS.reduce((o, m) => { o[m] = false; return o; }, {}),
  // Virtual (paper) trading, split into Indian exchanges (IN + Commodity/MCX, SEBI-regulated) and
  // Global (US + Crypto). BOTH default OFF — SEBI forbids paper trading on live NSE prices, and we
  // keep the global one off by default too so it's an explicit admin opt-in.
  allowVirtual: { IN: false, Global: false },
  // Show the Indian market to users who HAVEN'T connected a broker (on the delayed BSE fallback
  // feed). Default OFF — by default a non-connected member doesn't see the Indian market at all.
  showIndianWithoutBroker: false,
  // Show the US market tab to non-admin users. Default OFF — US stays admin-only until enabled.
  showUSMarket: false,
};
function mergeAppSettings(stored) {
  const s = stored || {};
  const abc = (s.allowBrokerConnect && typeof s.allowBrokerConnect === "object") ? s.allowBrokerConnect : {};
  const av = (s.allowVirtual && typeof s.allowVirtual === "object") ? s.allowVirtual : {};
  // Back-compat: allowRealMode used to be a single boolean. If we see a boolean, apply it to every
  // market; otherwise read it per-market.
  const armRaw = s.allowRealMode;
  const armObj = (armRaw && typeof armRaw === "object") ? armRaw : null;
  const armBool = typeof armRaw === "boolean" ? armRaw : false;
  return {
    allowRealMode: MARKETS.reduce((o, m) => { o[m] = armObj ? Boolean(armObj[m]) : armBool; return o; }, {}),
    allowBrokerConnect: MARKETS.reduce((o, m) => { o[m] = Boolean(abc[m]); return o; }, {}),
    allowVirtual: { IN: Boolean(av.IN), Global: Boolean(av.Global) },
    showIndianWithoutBroker: Boolean(s.showIndianWithoutBroker),
    showUSMarket: Boolean(s.showUSMarket),
  };
}

// Public read — every client needs this to know what to show. No secrets here.
app.get("/api/app-settings", async (_req, res) => {
  try { res.json({ settings: mergeAppSettings(await rcWrap("app-settings", () => db.getAppSettings())) }); }
  catch { res.json({ settings: DEFAULT_APP_SETTINGS }); }
});

// Admin write — locked behind isAdmin (ADMIN_USER_IDS + X-Admin-Key), like the other admin routes.
app.post("/api/app-settings", async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "admin only" });
  try {
    const next = mergeAppSettings(req.body && req.body.settings);
    await db.saveAppSettings(next);
    rcBust("app-settings");
    res.json({ ok: true, settings: next });
  } catch (e) { serverError(res, e); }
});

/* Right-to-erasure: a user permanently deletes their OWN account and all associated data.
   Auth is taken from the verified token — you can only delete yourself. Also clears any live
   broker sessions and cached app credentials so nothing survives in memory. */
app.post("/api/account/delete", requireAuth, requireFreshSessionAllowBlocked, async (req, res) => {
  const phone = req.authUserId;
  const userId = storageKeyFor(phone);
  try {
    await db.deleteAccount(userId, phone);
    // Purge in-memory state for this user.
    for (const [id, s] of brokerSessions) if (s.userId === String(userId)) brokerSessions.delete(id);
    for (const k of appCredCache.keys()) if (k.startsWith(`${userId}|`)) appCredCache.delete(k);
    /* R21-P2-09: report the ACTUAL erasure contract rather than a blanket "deleted". Personal data (profile,
       PIN, email, connected-broker credentials, strategies, ideas, saved config, notices, in-flight ledgers)
       is erased; realised TRADE HISTORY is RETAINED under a de-identified stub for regulatory/audit records
       and is no longer linked to live personal details. */
    res.json({ ok: true, erased: ["profile", "pin", "email", "brokerCredentials", "strategies", "ideas", "config", "notices", "ledgers"], retained: ["tradeHistory"], retentionReason: "Trade records are retained (de-identified) to meet record-keeping obligations; personal details are erased." });
  } catch (e) { serverError(res, e); }
});

// Admin: permanently delete ANY account (by phone) and all its data.
app.post("/api/admin/delete-user", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const phone = cleanPhone(req.body && req.body.phone);
    if (!phone) return res.status(400).json({ error: "phone required" });
    if (isAdminPhone(phone)) return res.status(400).json({ error: "Cannot delete an admin account." });
    const userId = storageKeyFor(phone);
    await db.deleteAccount(userId, phone);
    for (const [id, s] of brokerSessions) if (s.userId === String(userId)) brokerSessions.delete(id);
    for (const k of appCredCache.keys()) if (k.startsWith(`${userId}|`)) appCredCache.delete(k);
    res.json({ ok: true, phone });
  } catch (e) { serverError(res, e); }
});

/** Step 1 of OAuth: where the user logs in. */
app.get("/api/broker/login-url", requireAuth, async (req, res) => {
  const id = String(req.query.broker || "");
  const b = BROKERS[id];
  if (!b) return res.status(400).json({ error: "unknown broker" });
  // R3-#2: identity comes ONLY from the verified token — never a query/header the caller controls.
  // Otherwise an unauthenticated caller could mint an OAuth state (and start a connect) for someone
  // else's account. storageKeyFor matches how BYOA creds + the session step key this user.
  const userId = storageKeyFor(req.authUserId);   // whose FYERS/Delta app to use

  /* DHAN "Log in with Dhan" (PARTNER consent flow). Unlike the plain OAuth brokers, Dhan needs a
     server-side call FIRST: we generate a consent with Matrix's partner credentials, get a consentId,
     then send the user to Dhan's own consent-login page. Dhan redirects back to our registered URL
     with ?tokenId=, which /api/broker/session consumes into an access token. */
  if (id === "dhan") {
    const pid = envKey("DHAN_PARTNER_ID"), psec = envKey("DHAN_PARTNER_SECRET");
    if (!pid || !psec) return res.status(400).json({ error: "Dhan partner login isn't set up on the server. Paste a Dhan access token instead." });
    try {
      const r = await fetch("https://api.dhan.co/v2/partner/generate-consent", {
        method: "GET",
        headers: { partner_id: pid, partner_secret: psec, "Content-Type": "application/json" },
      });
      const d = await r.json().catch(() => ({}));
      const consentId = d.consentId || d.consentAppId || d.consent_id;
      if (!r.ok || !consentId) return res.status(400).json({ error: d.errorMessage || d.message || `Dhan couldn't start the login (${r.status}).` });
      return res.json({ url: `https://auth.dhan.co/consent-login?consentId=${encodeURIComponent(consentId)}` });
    } catch (e) {
      return res.status(502).json({ error: `Dhan consent error: ${String(e.message || e)}` });
    }
  }

  const key = b.key(userId);
  if (!key) return res.status(400).json({ error: `${b.name} is not configured on the server (missing API key).` });
  /* REDIRECT MUST MATCH EXACTLY. FYERS rejects the login (and loops the user back to its own login
     page) if the redirect_uri isn't character-for-character the one registered in the app. The
     frontend sends the current page URL, which can drift (trailing slash, sub-path). For the SHARED
     house app we pin it to FYERS_REDIRECT_URI when set, so it always equals what's registered. */
  let redirect = req.query.redirect;
  if (id === "fyers" && envKey("FYERS_REDIRECT_URI") && !getUserAppCred("fyers", userId)) {
    redirect = envKey("FYERS_REDIRECT_URI");   // only for shared-app users; BYOA users keep their own
  }
  // R4/R5-P2-03: reject a callback that isn't on the configured allow-list (opt-in via env).
  if (!redirectAllowed(redirect)) return res.status(400).json({ error: "This redirect URL isn't allow-listed for OAuth. Use your registered callback." });
  // CSRF: mint a single-use state nonce bound to this login (verified back at /api/broker/session),
  // and BIND the canonical redirect into that state so the transaction is tied to the URL that started it.
  const stateNonce = await issueOAuthState(userId, id, redirect);   // userId is already the verified, storageKeyFor'd id
  // R7-P1-01: return the EFFECTIVE redirect (possibly server-canonicalised to FYERS_REDIRECT_URI) so the
  // client echoes THIS exact value back at session — otherwise the binding check rejects a valid callback
  // whenever the browser URL differs from the pinned canonical redirect.
  res.json({ url: b.loginUrl(key, redirect, stateNonce), state: stateNonce, redirect: redirect || null });
});

/* Step 2: exchange the short-lived request/auth code for an access token.
   This is the ONLY place the api_secret is used, and it never leaves the server. */
app.post("/api/broker/session", requireAuth, requireActiveUser, async (req, res) => {
  const { broker, requestToken } = req.body || {};
  const userId = routeUserId(req);   // verified token when present, else the client-supplied id
  const b = BROKERS[broker];
  if (!b) return res.status(400).json({ error: "unknown broker" });
  if (!userId) return res.status(400).json({ error: "userId required" });

  /* CSRF: OAuth-redirect brokers must present the single-use `state` nonce we minted at login-url and
     the broker echoed back. This binds the returned auth_code to a login THIS user actually started —
     without it, an attacker's auth_code could be planted into someone else's connect. Verified only
     for the redirect brokers (fyers/schwab); Delta/userCreds/house sessions have no OAuth redirect. */
  if ((broker === "fyers" || broker === "schwab") && !(req.body && req.body.extra && req.body.extra.house)) {
    const chk = await consumeOAuthState(req.body && req.body.state, broker, userId, req.body && req.body.redirect);   // redirect echo-verified when the client sends it
    if (!chk.ok) return res.status(400).json({ error: "Login could not be verified (" + chk.reason + ")." });
  }

  /* OWNER "server session" for FYERS (option 1 — connect like Delta): no OAuth redirect, no request
     token. FYERS is already logged in server-side via the daily TOTP auto-login, so we hand the owner
     a session backed by that house token. Owner-only, and only when the TOTP env is configured. */
  if (broker === "fyers" && req.body && req.body.extra && req.body.extra.house) {
    if (!isHouseOwner(req)) return res.status(403).json({ error: "The server session is owner-only." });
    try {
      const token = await fyersHouseToken();
      if (!token) return res.status(400).json({ error: "FYERS server session isn't configured — set FYERS_FY_ID / FYERS_TOTP_SECRET / FYERS_PIN / FYERS_APP_ID / FYERS_SECRET_ID / FYERS_REDIRECT_URI on the server." });
      const sid = putBrokerSession(userId, "fyers", token, null, null);
      return res.json({ sessionId: sid, broker, user: "house" });
    } catch (e) { return res.status(400).json({ error: "FYERS server session failed: " + (e.message || e) }); }
  }

  // Delta has no OAuth redirect (server keys). userCreds brokers carry credentials in
  // `extra` instead of a requestToken. Everyone else must present a requestToken.
  if (!b.noOAuth && !b.userCreds && !requestToken) return res.status(400).json({ error: "requestToken required" });

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
      const r = await fyFetch("https://api-t1.fyers.in/api/v3/validate-authcode", {
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
         something real: we make a SIGNED call with THIS user's keys and see if Delta accepts it.
         A non-admin must have connected their own Delta keys first (never the house account). */
      if (!deltaCredsFor(userId) || (!getUserAppCred("delta", userId) && !isAdminUserId(userId))) {
        return res.status(400).json({ error: "Enter your own Delta API key and secret first." });
      }
      const d = await deltaCall("GET", "/v2/wallet/balances", { userId });
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

    if (broker === "dhan") {
      /* TWO ways to connect Dhan:
         1. PARTNER consent ("Log in with Dhan"): the redirect came back with a tokenId, which we sent
            as `requestToken`. We consume it with Matrix's partner credentials to receive the user's
            access token + client id — no token pasting, no expiry juggling for the user.
         2. PASTE TOKEN (fallback): the user generated an access token on web.dhan.co and typed it in. */
      const pid = envKey("DHAN_PARTNER_ID"), psec = envKey("DHAN_PARTNER_SECRET");
      if (requestToken && pid && psec) {
        const r0 = await fetch(`https://api.dhan.co/v2/partner/consume-consent?tokenId=${encodeURIComponent(requestToken)}`, {
          method: "GET",
          headers: { partner_id: pid, partner_secret: psec, "Content-Type": "application/json" },
        });
        const d0 = await r0.json().catch(() => ({}));
        const accessToken = String(d0.accessToken || d0.access_token || "").trim();
        const clientId = String(d0.dhanClientId || d0.dhan_client_id || "").trim();
        if (!r0.ok || !accessToken) throw new Error(d0.errorMessage || d0.message || `Dhan login could not be completed (${r0.status}).`);
        const sid = putBrokerSession(userId, broker, accessToken, null, { clientId });
        return res.json({ sessionId: sid, user: (d0.dhanClientName || clientId) || null, broker });
      }
      /* Fallback: pasted access token (+ client id). Validate by hitting the funds endpoint. */
      const extra = req.body.extra || {};
      const accessToken = String(extra.accessToken || "").trim();
      const clientId = String(extra.clientId || "").trim();
      if (!accessToken) throw new Error("Dhan access token is required.");
      const r = await fetch("https://api.dhan.co/v2/fundlimit", { headers: { "access-token": accessToken, "Content-Type": "application/json" } });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.errorType || d.status === "failed") throw new Error(d.errorMessage || d.message || `Dhan rejected the token (${r.status}).`);
      const sid = putBrokerSession(userId, broker, accessToken, null, { clientId });
      return res.json({ sessionId: sid, user: clientId || null, broker });
    }

    if (broker === "indmoney") {
      /* IND Money (INDstocks): Bearer access token from web.indstocks.com. The raw token
         is the Authorization header value (no "Bearer " prefix). Validate via /user/profile. */
      const extra = req.body.extra || {};
      const accessToken = String(extra.accessToken || "").trim();
      if (!accessToken) throw new Error("INDstocks access token is required.");
      const r = await fetch("https://api.indstocks.com/user/profile", { headers: { Authorization: accessToken } });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.status !== "success") throw new Error(d.message || d.error || `INDstocks rejected the token (${r.status}).`);
      const sid = putBrokerSession(userId, broker, accessToken);
      return res.json({ sessionId: sid, user: (d.data && (d.data.first_name || d.data.user_id)) || null, broker });
    }

    if (broker === "angelone") {
      /* Angel One SmartAPI: log in with the user's OWN API key + client code + PIN + TOTP.
         Returns a JWT we keep server-side; the API key is needed on every later call. */
      const extra = req.body.extra || {};
      const apiKey = String(extra.apiKey || "").trim();
      const clientCode = String(extra.clientCode || "").trim();
      const pin = String(extra.pin || "").trim();
      const totp = String(extra.totp || "").trim();
      if (!apiKey || !clientCode || !pin || !totp) throw new Error("Angel One needs API key, client code, PIN and TOTP.");
      const r = await fetch("https://apiconnect.angelone.in/rest/auth/angelbroking/user/v1/loginByPassword", {
        method: "POST",
        headers: angelHeaders(apiKey, null),
        body: JSON.stringify({ clientcode: clientCode, password: pin, totp }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.status || !d.data || !d.data.jwtToken) throw new Error(d.message || d.errorcode || `Angel One login failed (${r.status}).`);
      const sid = putBrokerSession(userId, broker, d.data.jwtToken, d.data.refreshToken || null, { apiKey, feedToken: d.data.feedToken || null });
      return res.json({ sessionId: sid, user: clientCode, broker });
    }

    if (broker === "groww") {
      /* Groww: paste an access token from the Groww trading API console. Validate via holdings. */
      const extra = req.body.extra || {};
      const accessToken = String(extra.accessToken || "").trim();
      if (!accessToken) throw new Error("Groww access token is required.");
      const r = await fetch("https://api.groww.in/v1/holdings/user", { headers: brokerAuth("groww", accessToken) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.status === "FAILURE" || d.error) throw new Error((d.error && d.error.message) || d.message || `Groww rejected the token (${r.status}).`);
      const sid = putBrokerSession(userId, broker, accessToken);
      return res.json({ sessionId: sid, user: null, broker });
    }

    if (broker === "coindcx") {
      const extra = req.body.extra || {};
      const apiKey = String(extra.apiKey || "").trim();
      const apiSecret = String(extra.apiSecret || "").trim();
      if (!apiKey || !apiSecret) throw new Error("CoinDCX needs an API key and secret.");
      const { r, d } = await coindcxCall(apiKey, apiSecret, "/exchange/v1/users/balances");
      if (!r.ok || (!Array.isArray(d) && (d.message || d.code))) throw new Error(d.message || `CoinDCX rejected the keys (${r.status}).`);
      const sid = putBrokerSession(userId, broker, "coindcx", null, { apiKey, apiSecret });
      return res.json({ sessionId: sid, user: null, broker });
    }

    if (broker === "binance") {
      const extra = req.body.extra || {};
      const apiKey = String(extra.apiKey || "").trim();
      const apiSecret = String(extra.apiSecret || "").trim();
      if (!apiKey || !apiSecret) throw new Error("Binance needs an API key and secret.");
      const { r, d } = await binanceSigned(apiKey, apiSecret, "/api/v3/account");
      if (!r.ok || d.code) throw new Error(d.msg || `Binance rejected the keys (${r.status}). (Binance may be geo-blocked from the server region.)`);
      const sid = putBrokerSession(userId, broker, "binance", null, { apiKey, apiSecret });
      return res.json({ sessionId: sid, user: null, broker });
    }

    if (broker === "coinswitch") {
      const extra = req.body.extra || {};
      const apiKey = String(extra.apiKey || "").trim();
      const apiSecret = String(extra.apiSecret || "").trim();
      if (!apiKey || !apiSecret) throw new Error("CoinSwitch needs an API key and secret.");
      const { r, d } = await coinswitchSigned(apiKey, apiSecret, "GET", "/trade/api/v2/user/portfolio");
      if (!r.ok || (d && d.message && !d.data)) throw new Error((d && d.message) || `CoinSwitch rejected the keys (${r.status}).`);
      const sid = putBrokerSession(userId, broker, "coinswitch", null, { apiKey, apiSecret });
      return res.json({ sessionId: sid, user: null, broker });
    }

    res.status(400).json({ error: "unsupported broker" });
  } catch (e) {
    // undici hides the real network reason under e.cause — surface it (helps proxy debugging).
    const detail = (e && e.cause && (e.cause.message || e.cause.code)) ? ` (${e.cause.message || e.cause.code})` : "";
    res.status(502).json({ error: String(e.message || e) + detail });
  }
});

/* Re-establish a broker session from persisted (encrypted) creds — WITHOUT asking the user to
   reconnect. This is what makes a connection survive the app being closed on mobile or the
   free-tier server restarting: the browser keeps the broker id in localStorage, and on a dead
   session it calls this to mint a fresh session id from the stored creds. */
app.post("/api/broker/resume", requireAuth, requireActiveUser, async (req, res) => {
  const userId = routeUserId(req);
  const broker = req.body && req.body.broker;
  if (!userId || !broker) return res.status(400).json({ error: "userId and broker required" });
  try {
    const sess = await sessionFromCred(userId, broker);
    if (!sess) return res.status(404).json({ error: "no stored connection — please reconnect" });
    const sid = putBrokerSession(userId, broker, sess.accessToken, sess.refreshToken, sess.extra || null);
    res.json({ sessionId: sid, broker });
  } catch (e) { serverError(res, e); }
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
  if (broker === "dhan") {
    return { "access-token": token, "Content-Type": "application/json" };
  }
  if (broker === "indmoney") {
    return { Authorization: token };   // INDstocks: raw token, no "Bearer " prefix
  }
  if (broker === "groww") {
    return { Accept: "application/json", Authorization: `Bearer ${token}`, "X-API-VERSION": "1.0" };
  }
  return {};
}

/* REAL-TIME QUOTES. This is the point of the whole exercise: Yahoo is ~15 minutes
   delayed on NSE; a broker feed is live. Symbols arrive already in broker format
   (see domain/brokerSymbols.js) — the server does not guess at symbol names. */
app.get("/api/broker/quotes", requireAuth, async (req, res) => {
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
      const r = await fyFetch(`https://api-t1.fyers.in/data/quotes?symbols=${encodeURIComponent(symbols.join(","))}`, {
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

/* Fetch the user's REAL account state from their broker: available cash + open positions.
   Used to run risk checks server-side before a live order. Returns { wallet, portfolio } or
   null if it can't be fetched (caller decides how to fail). Reuses the same broker endpoints
   the portfolio view uses. Has an overall timeout so a slow broker can't hang the order. */
let lastAcctError = "";   // surfaced in the risk-check 503 so failures are diagnosable
async function fetchBrokerAccount(sess) {
  const { broker, accessToken: token } = sess;
  lastAcctError = "";
  const withTimeout = (p, ms = 6000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("broker account fetch timed out")), ms))]);
  const clean = (sym) => String(sym || "").replace(/^NSE:/, "").replace(/-EQ$/, "");
  try {
    if (broker === "zerodha") {
      const [hRes, mRes] = await withTimeout(Promise.all([
        fetch("https://api.kite.trade/portfolio/holdings", { headers: brokerAuth(broker, token, sess.userId) }),
        fetch("https://api.kite.trade/user/margins", { headers: brokerAuth(broker, token, sess.userId) }),
      ]));
      const h = await hRes.json(); const m = await mRes.json();
      const portfolio = (h.data || []).map((p) => ({ sym: p.tradingsymbol, qty: p.quantity ?? 0, avg: p.average_price ?? null, price: p.last_price ?? null, market: "IN" }));
      const wallet = m.data?.equity?.available?.live_balance ?? 0;
      return { wallet: Number(wallet) || 0, portfolio };
    }
    if (broker === "fyers") {
      const [hRes, pRes, fRes] = await withTimeout(Promise.all([
        fyFetch("https://api-t1.fyers.in/api/v3/holdings", { headers: brokerAuth(broker, token, sess.userId) }),
        fyFetch("https://api-t1.fyers.in/api/v3/positions", { headers: brokerAuth(broker, token, sess.userId) }),
        fyFetch("https://api-t1.fyers.in/api/v3/funds", { headers: brokerAuth(broker, token, sess.userId) }),
      ]));
      const h = await hRes.json(); const p = await pRes.json(); const f = await fRes.json();
      const settled = (h.holdings || []).map((x) => ({ sym: clean(x.symbol), qty: x.quantity ?? 0, avg: x.costPrice ?? null, price: x.ltp ?? null, market: "IN" }));
      const open = (p.netPositions || []).filter((x) => Number(x.netQty ?? x.qty ?? 0) !== 0)
        .map((x) => ({ sym: clean(x.symbol), qty: Number(x.netQty ?? x.qty ?? 0), avg: x.netAvg ?? x.avgPrice ?? null, price: x.ltp ?? null, market: "IN" }));
      const bySym = new Map(); settled.forEach((x) => bySym.set(x.sym, x)); open.forEach((x) => { if (!bySym.has(x.sym)) bySym.set(x.sym, x); });
      const bucket = (f.fund_limit || []).find((x) => /available/i.test(x.title || ""));
      const wallet = bucket ? (bucket.equityAmount ?? 0) : 0;
      return { wallet: Number(wallet) || 0, portfolio: [...bySym.values()] };
    }
    if (broker === "delta") {
      // WALLET is essential (funds check) — try it, with one retry, before giving up.
      let w = null;
      for (let attempt = 0; attempt < 2 && !w; attempt++) {
        try { w = await withTimeout(deltaCall("GET", "/v2/wallet/balances", { userId: sess.userId }), 8000); }
        catch (e) {
          // undici wraps the real reason (DNS/connection/TLS) in e.cause — surface it.
          const cause = e && e.cause ? (e.cause.code || e.cause.message || String(e.cause)) : "";
          lastAcctError = `wallet: ${e.message}${cause ? " / " + cause : ""}`;
          console.error(`[risk] delta wallet fetch attempt ${attempt + 1} failed:`, e.message, cause);
          if (attempt === 0) await new Promise((r) => setTimeout(r, 700));
        }
      }
      if (!w) return null;   // can't verify funds -> refuse (real money)
      const wallet = (w.result || []).reduce((a, b) => a + (Number(b.available_balance) || 0), 0);
      // POSITIONS are only used for the "already holding" checks — if that endpoint is flaky,
      // don't block the whole order; proceed with an empty position list.
      let portfolio = [];
      try {
        const pos = await withTimeout(deltaCall("GET", "/v2/positions/margined", { userId: sess.userId }), 8000);
        portfolio = (pos.result || []).filter((x) => Number(x.size) !== 0)
          .map((x) => ({ sym: x.product_symbol || (x.product && x.product.symbol) || null, qty: Number(x.size), avg: x.entry_price != null ? Number(x.entry_price) : null, price: x.mark_price != null ? Number(x.mark_price) : null, market: "Crypto" }));
      } catch (e) { console.error("[risk] delta positions fetch failed (non-fatal):", e.message); }
      return { wallet, portfolio };
    }
    if (broker === "coindcx") {
      const { apiKey, apiSecret } = sess.extra || {};
      const { d } = await withTimeout(coindcxCall(apiKey, apiSecret, "/exchange/v1/users/balances"));
      const arr = Array.isArray(d) ? d : [];
      const portfolio = arr.filter((x) => Number(x.balance) > 0).map((x) => ({ sym: x.currency, qty: Number(x.balance), avg: null, price: null, market: "Crypto" }));
      const cash = arr.find((x) => x.currency === "INR") || arr.find((x) => x.currency === "USDT");
      return { wallet: cash ? Number(cash.balance) : 0, portfolio };
    }
  } catch (e) {
    lastAcctError = e.message;
    console.error("[risk] broker account fetch failed:", e.message);
    return null;
  }
  return null;
}

/* A live mark for RISK-CHECKING a market order that carries no price of its own.
   A market BUY has no limit price, and a brand-new position has no held average, so the
   risk engine sees price=null and (correctly) refuses. We pull a real mark from the same
   house feeds the app already uses — Delta for crypto, FYERS for Indian — rather than
   trusting a client-supplied number. Returns a Number, or null if we genuinely can't
   price it (in which case the order is still refused, which is the safe outcome). */
async function liveMarkForOrder(brokerSym, market) {
  try {
    if (market === "Crypto") {
      const base = String(brokerSym).replace(/(USDT|USD|INR)$/i, "").toUpperCase();
      const q = await deltaHouseQuotes([`${base}-USD`]);
      const hit = q[`${base}-USD`];
      return hit && hit.price != null ? Number(hit.price) : null;
    }
    const base = String(brokerSym).replace(/^[A-Z]+:/, "").replace(/-EQ$/i, "").toUpperCase();
    const q = await fyersHouseQuotes([`${base}.NS`]).catch(() => ({}));
    const hit = q[`${base}.NS`];
    return hit && hit.price != null ? Number(hit.price) : null;
  } catch { return null; }
}

/* Round a price to the instrument's tick size — Delta rejects prices off the grid. */
function roundToTick(price, tick) {
  const t = Number(tick);
  if (!Number.isFinite(t) || t <= 0) return price;
  const decimals = (String(tick).split(".")[1] || "").length;
  return +(Math.round(price / t) * t).toFixed(Math.min(decimals + 2, 10));
}

/* NATIVE SL/TP on Delta: a bracket of two market-order legs that close the position when
   price hits the stop or the target. Placed AFTER the entry fills, so the EXCHANGE enforces
   the exit even if the app is closed, the phone is off, or the server restarts.

   Never throws: a failed bracket must NOT unwind a filled entry. We return { placed, message }
   so the caller can tell the user honestly whether protection is actually live — the one thing
   we must never do is let someone believe a stop exists when it doesn't. */
/* Delta perpetuals trade in whole CONTRACTS; contract_value = coin units per contract (e.g.
   BTCUSD = 0.001 BTC). We keep our internal qty in COIN units (so P&L is right everywhere) and
   convert to/from an integer contract count only at the order boundary. */
function deltaContracts(prod, coinQty) {
  const cv = Number(prod && prod.contract_value) || 1;
  return { cv, contracts: Math.max(0, Math.floor(Number(coinQty) / cv + 1e-9)) };
}
function deltaCoinToContracts(prod, coinQty) {
  const cv = Number(prod && prod.contract_value) || 1;
  return Math.max(1, Math.round(Number(coinQty) / cv));   // exits round to the nearest contract, min 1
}
async function placeDeltaBracket(prod, side, entryRef, slPct, tpPct, userId = null) {
  try {
    if (!(entryRef > 0)) return { placed: false, message: "no entry price to base SL/TP on" };
    const long = String(side).toLowerCase() === "buy";
    const tick = prod.tick_size;
    const legs = {};
    if (slPct > 0) {
      const sl = long ? entryRef * (1 - slPct / 100) : entryRef * (1 + slPct / 100);
      legs.stop_loss_order = { order_type: "market_order", stop_price: String(roundToTick(sl, tick)) };
    }
    if (tpPct > 0) {
      const tp = long ? entryRef * (1 + tpPct / 100) : entryRef * (1 - tpPct / 100);
      legs.take_profit_order = { order_type: "market_order", stop_price: String(roundToTick(tp, tick)) };
    }
    if (!legs.stop_loss_order && !legs.take_profit_order) return { placed: false, message: "no SL/TP requested" };
    const body = { product_id: prod.id, product_symbol: prod.symbol, bracket_stop_trigger_method: "last_traded_price", ...legs };
    // The position may not be visible the instant a market entry returns — one short retry.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await deltaCall("POST", "/v2/orders/bracket", { body, userId });
        return { placed: true, message: "SL/TP set on Delta", ...legs };
      } catch (e) {
        if (attempt === 0) { await new Promise((r) => setTimeout(r, 1200)); continue; }
        return { placed: false, message: String(e.message || e) };
      }
    }
  } catch (e) { return { placed: false, message: String(e.message || e) }; }
}

/* REAL ORDERS. Gated twice: the server must have BROKER_TRADING_ENABLED=true AND
   the client must send X-Confirm-Live: yes. Two locks, because the failure mode
   here is real money moving without the user meaning it. */
app.post("/api/broker/order", requireAuth, requireFreshSession, async (req, res) => {
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
  /* R21-P1-03: if a prior verified fill couldn't be journaled, this account's risk history is incomplete. Block
     new REAL ENTRIES until it's reconciled — but always allow a CLOSING/reduce-only order so the user can flatten
     risk. Exit paths set body.reduceOnly or the X-Reduce-Only header. */
  {
    const isReduceOnly = req.body?.reduceOnly === true || req.get("X-Reduce-Only") === "yes";
    if (!isReduceOnly && typeof db.isRiskLocked === "function") {
      /* R22-C03: a safety gate must FAIL CLOSED. If we can't read the risk-lock (DB incident), do NOT let a new
         real entry through on the assumption it's unlocked — reject with 503 until the lock can be verified. */
      let locked;
      try { locked = await db.isRiskLocked(storageKeyFor(sess.userId)); }
      catch { return res.status(503).json({ error: "Couldn't verify your account's trading status right now — please retry in a moment." }); }
      if (locked) return res.status(423).json({ error: "Trading is paused: a recent fill couldn't be saved to your risk history. Reconcile with your broker, then resume. Closing/exit orders are still allowed.", riskLocked: true });
    }
  }
  /* R17-P1-02 / P2-07 durable idempotency with EXPLICIT outcome states. A live order MUST carry a stable
     X-Idempotency-Key (UUID) per user action. The first request claims it (stamping a request-body hash);
     a repeat with the same key: replays a succeeded response, is BLOCKED while still in_flight or after an
     UNKNOWN (ambiguous transport) outcome — it never silently re-submits — and is rejected if the same key
     is reused with a DIFFERENT payload. Only a CONCLUSIVE broker rejection frees the key for a real retry. */
  const idemKey = String(req.get("X-Idempotency-Key") || (req.body && req.body.clientRequestId) || "").slice(0, 100);
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(idemKey)) {
    return res.status(400).json({ error: "A valid idempotency key is required for live orders (update the app if this persists)." });
  }
  const idemUser = storageKeyFor(sess.userId);
  /* R19-P2-04: the payload hash must cover EVERY field that changes what actually gets placed — not just
     symbol/side/qty/price. Two requests that share a key but differ in SL/TP/trailing/auto-exit/interval
     are DIFFERENT orders and must be rejected as a key-reuse mismatch, never silently replayed. */
  const idemHash = crypto.createHash("sha256").update(JSON.stringify({
    b: sess.broker, s: req.body?.symbol, d: req.body?.side, q: req.body?.qty,
    t: req.body?.orderType || "MARKET", p: req.body?.product || "CNC",
    px: req.body?.limitPrice != null ? req.body.limitPrice : req.body?.price,
    // Protection settings that change what actually gets placed — must match the fields the handler reads
    // below (slPct/tpPct/tslPct/autoExit/strategy), or a same-key retry with different protection replays
    // the old order silently. `strategy` is the full exit-config object, so hash its canonical JSON.
    sl: Number(req.body?.slPct) || 0, tp: Number(req.body?.tpPct) || 0, tsl: Number(req.body?.tslPct) || 0,
    ax: req.body?.autoExit === true ? 1 : 0,
    st: req.body?.strategy != null ? stableStringify(req.body.strategy) : null,   // R21-P2-04: order-independent
    ep: req.body?.entryPrice != null ? Number(req.body.entryPrice) : null,
  })).digest("hex");
  {
    /* C2-01: the idempotency claim must FAIL CLOSED. If the ledger can't be written (DB incident), we must
       NOT place a real order without a durable dedupe record — a retry/replica/timeout could then duplicate
       it. Reject with 503 and touch no broker adapter. */
    let won;
    try { won = await db.claimIdempotencyKey(idemUser, idemKey, idemHash); }
    catch { return res.status(503).json({ error: "Couldn't record this order safely right now (temporary). Please retry in a moment." }); }
    if (!won) {
      const rec = await db.getIdempotencyRecord(idemUser, idemKey).catch(() => null);
      if (rec && rec.reqHash && rec.reqHash !== idemHash) {
        return res.status(409).json({ error: "This idempotency key was already used for a different order. Start a new order." });
      }
      if (rec && rec.status === "succeeded" && rec.response) return res.status(200).json({ ...rec.response, idempotentReplay: true });
      if (rec && rec.status === "unknown") {
        return res.status(409).json({ error: "A previous attempt with this key had an UNVERIFIED outcome. Check the order on your broker before retrying — we won't resubmit automatically.", ...(rec.response ? { previous: rec.response } : {}) });
      }
      /* R21-P2-05: a request that's genuinely still in flight blocks for a few seconds — but a record that's
         been in_flight for MINUTES means the original attempt died mid-execution (crash/timeout). We must NOT
         auto-resubmit (the broker may have received it), so instead of blocking forever we surface a RECONCILE
         path: tell the user the outcome is unverified and to check their broker. The stamped client/broker id
         lives in the record for that reconciliation. */
      // Age from createdAt (set at claim time) — updatedAt is null until finalize, which a stuck record never reaches.
      const ageMs = rec ? (Date.now() - (rec.createdAt || rec.updatedAt || Date.now())) : 0;
      const STALE_INFLIGHT_MS = Number(process.env.IDEM_STALE_MS) || 120_000;
      if (rec && ageMs > STALE_INFLIGHT_MS) {
        return res.status(409).json({ error: "A previous attempt with this key never confirmed (it may have reached your broker). Check your broker before retrying — we won't resubmit automatically.", staleMs: ageMs });
      }
      return res.status(409).json({ error: "This order is already being placed — please wait a moment before retrying." });
    }
    /* Classify the outcome as the response leaves: success → store for replay; a CONCLUSIVE rejection →
       release the key (a genuine retry may reuse it); anything else (timeout/transport/unknown, incl. thrown
       503s) → mark UNKNOWN and KEEP the key so a same-key retry is blocked until the user reconciles. */
    const _json = res.json.bind(res);
    /* R19-P2-05: AWAIT the ledger write before the response leaves. Previously this was fire-and-forget, so a
       fast client retry could arrive before the "succeeded" record was durable and either re-submit or see a
       spurious "in flight". We now persist first, THEN respond. Express ignores the returned promise; the
       response is still sent when _json runs. On a ledger write failure we log and respond anyway — the order
       already executed, so blocking the confirmation would be strictly worse. */
    res.json = async (obj) => {
      try {
        const code = res.statusCode || 200;
        if (obj && !obj.error && (obj.orderId || obj.ok)) {
          await db.finalizeIdempotency(idemUser, idemKey, "succeeded", obj);
        } else {
          const msg = String((obj && (obj.reason || obj.error)) || "");
          const conclusiveReject = code === 422 || code === 400 || /reject|insufficient|not filled|unfilled|cancell?ed|invalid|margin|too small|min(?:imum)? size|not enough|balance|bad request/i.test(msg);
          await db.finalizeIdempotency(idemUser, idemKey, conclusiveReject ? "rejected" : "unknown", obj);
        }
      } catch { /* durable-write failed; still deliver the response so a real fill isn't hidden from the user */ }
      return _json(obj);
    };
  }
  const broker = sess.broker;
  const token = sess.accessToken;
  /* H-03: normalize + strictly allowlist the order enums ONCE, up front, before any broker-specific mapping.
     Several adapters map "anything not exactly BUY" to SELL, so a malformed/case-mismatched side ("buy",
     "BYY", "") could become a real SELL. Reject unless side ∈ {BUY,SELL}, type ∈ supported set, product valid. */
  const side = String(req.body?.side || "").trim().toUpperCase();
  const orderType = String(req.body?.orderType || "MARKET").trim().toUpperCase();
  const product = String(req.body?.product || "CNC").trim().toUpperCase();
  const symbol = req.body?.symbol;
  const qty = req.body?.qty;
  if (!["BUY", "SELL"].includes(side)) return res.status(400).json({ error: "side must be exactly BUY or SELL." });
  if (!["MARKET", "LIMIT"].includes(orderType)) return res.status(400).json({ error: "orderType must be MARKET or LIMIT." });
  if (!["CNC", "MIS", "INTRADAY", "NRML", "MARGIN"].includes(product)) return res.status(400).json({ error: "Unsupported product type for this order." });
  // A LIMIT order needs a price; the client may send it as `limitPrice` or `price`.
  const price = req.body?.limitPrice != null ? req.body.limitPrice : req.body?.price;
  // Optional native stop-loss / take-profit (percentages) to attach as an exchange-side
  // bracket, so exits fire even with the app closed. entryPrice anchors the SL/TP maths.
  const slPct = Number(req.body?.slPct) || 0;
  const tpPct = Number(req.body?.tpPct) || 0;
  // Server-side signal-based auto-exit opt-in: register this position so the engine watches
  // its strategy exit (price + indicator) and closes it reduce-only, even with the app shut.
  const wantAutoExit = req.body?.autoExit === true;
  const exitCfg = req.body?.strategy || null;      // { defs, exit } from the strategy builder
  const tslPct = Number(req.body?.tslPct) || 0;
  const regMarket = ["delta", "coindcx", "binance", "coinswitch"].includes(broker) ? "Crypto" : "IN";
  async function registerAutoExit(qtyOverride, entryOverride) {
    if (!wantAutoExit) return null;   // register for BOTH longs and shorts (exit math is direction-aware)
    /* R14-P1-05/06: only arm an app-managed exit for brokers whose exit path returns VERIFIED fill truth
       (Delta, FYERS). Other brokers' exits report only acceptance — a managed position on them would be
       armed before the entry is confirmed and later "closed" on acceptance, selling shares that may never
       have been acquired. Fail closed: don't arm; the client warns the user to set SL/TP in their broker. */
    if (!FILL_VERIFIED_BROKERS.has(broker)) { console.warn(`[autoexit] not arming managed SL/TP for ${broker} — no verified fill truth (long-only Delta/FYERS supported)`); return null; }
    /* R14-P1-04: never arm protection without a USABLE entry price — priceExitFired returns fired:false when
       entry<=0, so percentage SL/TP would be silently inert. Require a positive reference before registering. */
    try {
      const bareSym = String(symbol).replace(/^[A-Z]+:/, "").replace(/-EQ$/i, "");
      const entryRef = Number(entryOverride) > 0 ? Number(entryOverride) : (Number(req.body?.entryPrice) || await liveMarkForOrder(symbol, regMarket) || null);
      if (!(Number(entryRef) > 0)) { console.warn(`[autoexit] not arming ${broker} ${symbol} — no usable entry price for SL/TP`); return null; }
      const regQty = Number(qtyOverride) > 0 ? Number(qtyOverride) : nQty;
      const yahoo = req.body?.yahoo || (regMarket === "Crypto"
        ? `${String(symbol).replace(/(USDT|USD|INR)$/i, "")}-USD`
        : `${bareSym}.NS`);
      const pos = await registerManagedPosition({
        sess, symbol: bareSym, brokerSym: symbol, qty: regQty, entry: entryRef,
        market: regMarket, sl: slPct || null, tp: tpPct || null, tsl: tslPct || null,
        cfg: exitCfg, yahoo, interval: req.body?.interval || "5m",
        short: String(side).toLowerCase() === "sell",
      });
      return pos.id;
    } catch (e) { console.error("[autoexit] register failed:", e.message); return null; }
  }
  if (!BROKERS[broker]) return res.status(400).json({ error: "unknown broker" });
  // Quantity must be a finite positive number within a sane ceiling — a negative, NaN, or
  // absurd qty must never reach a live broker.
  const nQty = Number(qty);
  if (!Number.isFinite(nQty) || nQty <= 0 || nQty > 1_000_000) {
    return res.status(400).json({ error: "quantity must be a positive number within limits" });
  }
  if (!symbol || !side || !qty) return res.status(400).json({ error: "symbol, side and qty are required" });

  /* SERVER-SIDE RISK CHECK. The frontend risk engine is a UX affordance; THIS is the real
     control. We fetch the user's actual account state from their broker (cash + open
     positions) and validate the order against it — funds, position size, max positions,
     sell-vs-held, daily-loss cap. Client-supplied values are never trusted here.
     If we CAN'T fetch account state, we refuse rather than place blind — this is real money. */
  {
    const rkMarket = ["delta", "coindcx", "binance", "coinswitch"].includes(broker) ? "Crypto" : "IN";
    const account = await fetchBrokerAccount(sess);
    if (!account) {
      return res.status(503).json({ error: "Could not verify your account state with the broker to risk-check this order. Try again in a moment." + (lastAcctError ? ` (${lastAcctError})` : "") });
    }
    const orderSym = String(symbol).replace(/^NSE:/, "").replace(/-EQ$/, "");
    const rkTrades = await db.getTrades(storageKeyFor(sess.userId), 0, Date.now()).catch(() => []);
    let rkPrice = price != null ? Number(price) : (account.portfolio.find((h) => h.sym === orderSym) ? account.portfolio.find((h) => h.sym === orderSym).price : null);
    // Market order, new position: no limit price and nothing held. Fetch a live mark so the
    // risk engine can size the order instead of refusing it for "No live price".
    if (rkPrice == null) rkPrice = await liveMarkForOrder(symbol, rkMarket);
    /* R15-P1-02: caps come from the SERVER-OWNED policy (loaded here, authoritative), NOT the request body.
       A per-order client override may only make them STRICTER — omitting/altering the body can never drop a
       cap the user configured. */
    const serverPolicy = await db.getRiskPolicy(storageKeyFor(sess.userId)).catch(() => null);
    const clientOverride = cleanRiskPolicy(req.body?.riskLimits);
    const effLimits = strictestRiskPolicy(serverPolicy, clientOverride);
    const userLimits = Object.keys(effLimits).length ? effLimits : null;
    const check = serverValidateOrder(
      { sym: orderSym, side: String(side).toUpperCase(), qty: nQty, price: rkPrice, market: rkMarket },
      { wallet: account.wallet, portfolio: account.portfolio, trades: riskEligibleTrades(rkTrades), ...(userLimits ? { limits: userLimits } : {}) },
    );
    if (!check.ok) {
      return res.status(422).json({ error: "Order blocked by risk checks: " + (check.reasons[0] || "not allowed"), reasons: check.reasons });
    }
  }


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
      const autoExitId = await registerAutoExit();
      return res.json({ orderId: d.data.order_id, status: "PENDING", broker, autoExitId });
    }

    if (broker === "fyers") {
      const r = await fyFetch("https://api-t1.fyers.in/api/v3/orders/sync", {
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
      /* R9-P1-02: NEVER arm app-managed SL/TP on mere acceptance. If the user asked for auto-exit, confirm
         the entry actually FILLED first (same verification the auto-buy path uses) and register the managed
         position at the REAL filled quantity/price. A rejected or still-pending entry arms nothing — so the
         exit engine can't later SELL against a holding that doesn't exist. Order placement itself still
         returns to the client; only the auto-exit arming is gated on the fill. */
      let autoExitId = null, fillStatus = "PENDING", autoExitNote = null;
      /* R20-P2-09: verify the FILL STATUS ONCE, ALWAYS — independent of whether protection was requested. The
         same filled market order must report FILLED whether or not SL/TP was asked for (previously it only
         verified inside `if (wantAutoExit)` and returned PENDING for a plain order). This single source of
         truth drives both the client status and the authoritative journal write. */
      const c = await verifyFyersFill(sess, d.id, Number(qty));
      if (c.filled) fillStatus = "FILLED";
      else if (c.rejected) fillStatus = "REJECTED";
      else fillStatus = "PENDING";

      /* R19-P1-04 / R20-P1-02: on ANY verified fill (long or short, protection or not) write the authoritative,
         user-namespaced, dedupe-by-orderId trade row so risk counters include the execution even if the browser
         never posts a journal row. recordAuthoritativeFill retries and fails loud (notice + log) on write error. */
      if (c.filled) {
        await recordAuthoritativeFill(storageKeyFor(sess.userId), {
          sym: String(symbol).replace(/^NSE:/, "").replace(/-EQ$/, ""), side,
          qty: c.filledQty || Number(qty), entry: Number(c.avgPrice) || Number(price) || 0,
          entryAt: Date.now(), market: regMarket, real: true, broker: "fyers", tradeType: String(req.body?.tradeType || "Manual"), orderId: d.id, serverAuthored: true,
        }, { haltUserIdOnFail: sess.userId });   // H2: if the fill can't be journaled, halt AUTOMATED entries so risk isn't computed on an incomplete book
      }

      if (wantAutoExit) {
        /* R10-audit: our FYERS exit path can only SELL — it cannot BUY-to-cover. So we must NOT arm
           app-managed SL/TP on a SHORT (SELL) entry: the exit engine would later fire another SELL and
           GROW the short instead of closing it. Refuse to arm; the user manages a short in their FYERS app. */
        if (String(side).toLowerCase() !== "buy") {
          autoExitNote = "SL/TP not armed — app-managed FYERS exits support long (BUY) entries only. Our exit can't buy-to-cover a short; manage this position in your FYERS app.";
        } else if (c.filled) {
          autoExitId = await registerAutoExit(c.filledQty || Number(qty), c.avgPrice);
        } else if (c.rejected) {
          autoExitNote = "SL/TP not armed — entry was rejected.";
        } else {
          /* R16-P2-10: don't abandon the requested protection. Park it so the background watcher attaches
             SL/TP once (if) this LIMIT entry fills later — protection tracks the CONFIRMED filled qty. */
          const bareSym = String(symbol).replace(/^NSE:/, "").replace(/-EQ$/, "");
          await db.savePendingProtection({
            id: `pp_${sess.userId}_${d.id}`, userId: String(sess.userId), broker: "fyers", orderId: d.id,
            symbol: bareSym, brokerSym: symbol, qty: Number(qty), market: regMarket, product,
            sl: slPct || null, tp: tpPct || null, tsl: tslPct || null, cfg: exitCfg,
            yahoo: req.body?.yahoo || `${bareSym}.NS`, interval: req.body?.interval || "5m", short: String(side).toLowerCase() === "sell",
          }).catch(() => {});
          autoExitNote = "Entry not filled yet — we'll attach your SL/TP automatically if it fills. You can also re-arm from the position.";
        }
      }
      /* R22-C02: a PLAIN (no SL/TP) FYERS order that's still pending when we respond can fill later at the
         broker with no journal event. Park a durable row (plain:true → journal only, no protection) so the
         background watcher reconciles the eventual fill exactly once, keeping the risk ledger complete. */
      if (!wantAutoExit && fillStatus === "PENDING") {
        const bareSym = String(symbol).replace(/^NSE:/, "").replace(/-EQ$/, "");
        await db.savePendingProtection({
          id: `pp_${sess.userId}_${d.id}`, userId: String(sess.userId), broker: "fyers", orderId: d.id,
          symbol: bareSym, brokerSym: symbol, qty: Number(qty), market: regMarket, product,
          sl: null, tp: null, tsl: null, cfg: null, plain: true, tradeType: String(req.body?.tradeType || "Manual"),
          yahoo: req.body?.yahoo || `${bareSym}.NS`, interval: req.body?.interval || "5m", short: String(side).toLowerCase() === "sell",
        }).catch(() => {});
      }
      return res.json({ orderId: d.id, status: fillStatus, broker, autoExitId, autoExitArmed: !!autoExitId, ...(autoExitNote ? { autoExitNote } : {}) });
    }

    if (broker === "delta") {
      /* Per-user BYOA: this order signs with the user's OWN Delta keys. A non-admin who hasn't
         connected their own Delta account is refused here — their trade must never route to the
         operator's house account. */
      assertDeltaTradable(sess.userId);
      /* Delta orders are signed like everything else. product_id is REQUIRED — the API
         does not take a bare symbol — so we look the product up first and fail if we
         can't find it, rather than posting an order against a guessed id. */
      const prods = await deltaCall("GET", "/v2/products", { signed: false });
      const prod = (prods.result || []).find((p) => p.symbol === symbol);
      if (!prod) throw new Error(`Delta does not list ${symbol}`);

      // Delta trades in whole CONTRACTS. Convert coin-unit qty to an integer contract count.
      const isBuy = String(side).toLowerCase() === "buy";
      const { cv, contracts } = deltaContracts(prod, qty);
      const sendSize = isBuy ? contracts : deltaCoinToContracts(prod, qty);   // exits round up to ≥1
      if (isBuy && sendSize < 1) {
        return res.status(400).json({ ok: false, status: "rejected", broker, reason: `Amount too small for ${symbol} on Delta — one contract is ≈ ${cv} unit(s). Increase your amount.` });
      }
      const d = await deltaCall("POST", "/v2/orders", {
        userId: sess.userId,
        body: {
          product_id: prod.id,
          size: sendSize,
          side: isBuy ? "buy" : "sell",
          order_type: "market_order",
          ...(isBuy ? {} : { reduce_only: true }),
        },
      });
      /* A 200 is NOT a fill. Verify execution (all sizes here are CONTRACTS). */
      const o = d.result || {};
      const sizeC = Number(o.size) || sendSize;
      const unfilledC = o.unfilled_size != null ? Number(o.unfilled_size) : (o.state === "closed" ? 0 : sizeC);
      const filledC = Math.max(0, sizeC - unfilledC);
      const status = (o.state === "cancelled" || o.state === "rejected" || filledC <= 0) ? "rejected" : (filledC < sizeC ? "partial" : "filled");
      if (status === "rejected") {
        return res.status(400).json({ ok: false, status: "rejected", broker, orderId: o.id ?? null, reason: o.cancellation_reason || o.meta_data?.reason || "Order not filled — likely insufficient balance/margin on your Delta account" });
      }
      const filled = filledC * cv;   // report COIN units so the journal/position P&L stays correct
      /* Attach an exchange-side bracket so the stop-loss / take-profit fire on Delta itself,
         with the app closed. Best-effort and honestly reported: the entry has filled, so a
         bracket failure returns a warning rather than pretending the position is safe. */
      let bracket = null;
      if (slPct > 0 || tpPct > 0) {   // bracket both longs and shorts (placeDeltaBracket mirrors for sell)
        const entryRef = Number(o.average_fill_price) || Number(req.body?.entryPrice) || await liveMarkForOrder(symbol, "Crypto");
        bracket = await placeDeltaBracket(prod, side, entryRef, slPct, tpPct, sess.userId);
      }
      const autoExitId = await registerAutoExit();
      // R19-P1-04: server-authoritative trade row on the verified Delta fill (risk counters count it server-side).
      await recordAuthoritativeFill(storageKeyFor(sess.userId), { sym: String(symbol).replace(/(USDT|USD|INR)$/i, "").toUpperCase(), side, qty: filled, entry: Number(o.average_fill_price) || Number(req.body?.entryPrice) || 0, entryAt: Date.now(), market: "Crypto", real: true, broker: "delta", tradeType: "Manual", orderId: o.id ?? null, serverAuthored: true }, { haltUserIdOnFail: sess.userId });
      return res.json({ ok: true, broker, status, orderId: o.id ?? null, filledQty: filled, avgPrice: o.average_fill_price != null ? Number(o.average_fill_price) : null, bracket, autoExitId, raw: o });
    }

    if (broker === "coindcx") {
      /* CoinDCX spot order. The app's crypto symbol (e.g. "BTC") maps to the INR pair the
         retail account trades ("BTCINR"). Signed with the user's own key/secret. */
      const { apiKey, apiSecret } = sess.extra || {};
      const base = String(symbol).replace(/(INR|USDT)$/i, "").toUpperCase();
      const market = `${base}INR`;
      const body = {
        side: String(side).toLowerCase() === "buy" ? "buy" : "sell",
        order_type: orderType === "LIMIT" ? "limit_order" : "market_order",
        market,
        total_quantity: Number(qty),
        ...(orderType === "LIMIT" && price ? { price_per_unit: Number(price) } : {}),
      };
      const { r, d } = await coindcxCall(apiKey, apiSecret, "/exchange/v1/orders/create", body);
      if (!r.ok || d.message || d.code) throw new Error(d.message || `CoinDCX order failed (${r.status}).`);
      const o = (d.orders && d.orders[0]) || d;
      const autoExitId = await registerAutoExit();
      return res.json({ ok: true, broker, orderId: o.id || o.order_id || null, status: o.status || "PENDING", autoExitId });
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

    if (broker === "binance") {
      const { apiKey, apiSecret } = sess.extra || {};
      if (!apiKey || !apiSecret) throw new Error("Binance keys missing — reconnect.");
      const base = String(symbol).replace(/(USDT|USD|INR)$/i, "").toUpperCase();
      const isBuy = String(side).toUpperCase() === "BUY";
      const params = { symbol: `${base}USDT`, side: isBuy ? "BUY" : "SELL", type: "MARKET" };
      // Market BUY sized by spend (quoteOrderQty) avoids LOT_SIZE rejections; SELL by base qty.
      const ref = Number(req.body?.entryPrice) || 0;
      if (isBuy && ref > 0) params.quoteOrderQty = +(Number(qty) * ref).toFixed(2);
      else params.quantity = Number(qty);
      const { r, d } = await binanceSigned(apiKey, apiSecret, "/api/v3/order", params, "POST");
      if (!r.ok) throw new Error((d && d.msg) || `Binance order failed (${r.status})`);
      const autoExitId = await registerAutoExit();
      return res.json({ ok: true, broker, orderId: d.orderId ?? null, status: d.status || "FILLED", autoExitId });
    }

    if (broker === "coinswitch") {
      const { apiKey, apiSecret } = sess.extra || {};
      const base = String(symbol).replace(/(USDT|USD|INR)$/i, "").toUpperCase();
      const body = { symbol: `${base}/INR`, side: String(side).toLowerCase(), type: "market", quantity: Number(qty), exchange: "coinswitchx" };
      const { r, d } = await coinswitchSigned(apiKey, apiSecret, "POST", "/trade/api/v2/order", body);
      if (!r.ok || (d && (d.error || d.message))) throw new Error((d && (d.message || d.error)) || `CoinSwitch order failed (${r.status})`);
      const autoExitId = await registerAutoExit();
      return res.json({ ok: true, broker, orderId: (d && d.data && (d.data.order_id || d.data.id)) || null, status: "PENDING", autoExitId });
    }

    if (broker === "dhan") {
      const securityId = await dhanSecurityId(String(symbol).replace(/^NSE:/, "").replace(/-EQ$/, ""));
      const body = {
        dhanClientId: sess.extra && sess.extra.clientId, transactionType: String(side).toUpperCase(),
        exchangeSegment: "NSE_EQ", productType: product === "CNC" ? "CNC" : "INTRADAY",
        orderType: "MARKET", validity: "DAY", securityId, quantity: String(Number(qty)),
        price: "", disclosedQuantity: "", afterMarketOrder: false,
      };
      const r = await fetch("https://api.dhan.co/v2/orders", { method: "POST", headers: { ...brokerAuth("dhan", token, sess.userId), "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.orderStatus === "REJECTED" || d.errorType) throw new Error(d.errorMessage || d.omsErrorDescription || `Dhan order failed (${r.status})`);
      const autoExitId = await registerAutoExit();
      return res.json({ ok: true, broker, orderId: d.orderId ?? null, status: d.orderStatus || "PENDING", autoExitId });
    }

    if (broker === "angelone") {
      const { token: symboltoken, tradingsymbol } = await angelToken(String(symbol).replace(/^NSE:/, "").replace(/-EQ$/, ""));
      const body = {
        variety: "NORMAL", tradingsymbol, symboltoken, transactiontype: String(side).toUpperCase(),
        exchange: "NSE", ordertype: "MARKET", producttype: product === "CNC" ? "DELIVERY" : "INTRADAY",
        duration: "DAY", price: "0", squareoff: "0", stoploss: "0", quantity: String(Number(qty)),
      };
      const r = await fetch("https://apiconnect.angelone.in/rest/secure/angelbroking/order/v1/placeOrder", {
        method: "POST", headers: angelHeaders(sess.extra && sess.extra.apiKey, token), body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.status === false || d.errorcode) throw new Error(d.message || `Angel One order failed (${r.status})`);
      const autoExitId = await registerAutoExit();
      return res.json({ ok: true, broker, orderId: (d.data && (d.data.orderid || d.data.uniqueorderid)) || null, status: "PENDING", autoExitId });
    }

    if (broker === "groww") {
      const bare = String(symbol).replace(/^NSE:/, "").replace(/-EQ$/, "");
      const body = {
        trading_symbol: bare, quantity: Number(qty), validity: "DAY", exchange: "NSE", segment: "CASH",
        product: product === "CNC" ? "CNC" : "MIS", order_type: "MARKET", transaction_type: String(side).toUpperCase(),
      };
      const r = await fetch("https://api.groww.in/v1/order/create", { method: "POST", headers: { ...brokerAuth("groww", token, sess.userId), "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.status === "FAILURE" || d.error) throw new Error((d.error && (d.error.message || d.error)) || d.message || `Groww order failed (${r.status})`);
      const autoExitId = await registerAutoExit();
      return res.json({ ok: true, broker, orderId: (d.payload && d.payload.groww_order_id) || d.groww_order_id || null, status: "PENDING", autoExitId });
    }

    if (broker === "indmoney") {
      // INDstocks REST API: POST /order for NSE/BSE equities. security_id is the numeric NSE
      // scrip id (same numbering brokers share), resolved strictly from the instrument master.
      const securityId = await dhanSecurityId(String(symbol).replace(/^NSE:/, "").replace(/-EQ$/, ""));
      const body = {
        txn_type: String(side).toUpperCase(), exchange: "NSE", segment: "EQUITY", security_id: String(securityId),
        qty: Number(qty), order_type: "MARKET", product: product === "CNC" ? "CNC" : "INTRADAY",
        validity: "DAY", is_amo: false, algo_id: "99999",
      };
      const r = await fetch("https://api.indstocks.com/order", { method: "POST", headers: { ...brokerAuth("indmoney", token, sess.userId), "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.status !== "success") throw new Error((d && d.message) || `IND Money order failed (${r.status})`);
      const autoExitId = await registerAutoExit();
      return res.json({ ok: true, broker, orderId: (d.data && d.data.order_id) || null, status: (d.data && d.data.order_status) || "PENDING", autoExitId });
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

app.get("/api/broker/optionchain", requireAuth, async (req, res) => {
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

app.get("/api/broker/portfolio", requireAuth, requireActiveUser, async (req, res) => {   // R21-P2-02: real holdings are sensitive — a stale/blocked token must not retain visibility
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
        fyFetch("https://api-t1.fyers.in/api/v3/holdings", { headers: brokerAuth(broker, token, sess.userId) }),
        fyFetch("https://api-t1.fyers.in/api/v3/positions", { headers: brokerAuth(broker, token, sess.userId) }),
        fyFetch("https://api-t1.fyers.in/api/v3/funds", { headers: brokerAuth(broker, token, sess.userId) }),
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

      /* R16-P3-02: keep the DISPLAY consistent with the SELLABLE-qty math (`fyersSellableLong`), which for a
         symbol present in both takes settled holdings + today's signed net position. Previously the display
         kept only the settled row and dropped the position, so a same-day partial sell (netQty < 0) showed a
         larger quantity than was actually sellable. Now overlapping rows are COMBINED (qty = settled + net). */
      const bySym = new Map();
      settled.forEach((x) => bySym.set(x.sym, x));
      open.forEach((x) => {
        const prev = bySym.get(x.sym);
        if (!prev) { bySym.set(x.sym, x); return; }
        const qty = Number(prev.qty || 0) + Number(x.qty || 0);
        const ltp = prev.ltp ?? x.ltp ?? null;
        bySym.set(x.sym, { ...prev, qty, ltp, value: (ltp != null) ? +(ltp * qty).toFixed(2) : prev.value, source: "holdings+positions" });
      });
      // Drop rows that net to flat once combined (a settled holding fully sold intraday).
      const holdings = [...bySym.values()].filter((x) => Number(x.qty || 0) !== 0);

      // fund_limit is a list of labelled buckets; the available cash is the one we want.
      const bucket = (f.fund_limit || []).find((x) => /available/i.test(x.title || ""));
      const cash = bucket ? bucket.equityAmount ?? null : null;
      return res.json({ broker, holdings, cash, currency: "INR" });
    }

    if (broker === "dhan") {
      const [hRes, fRes] = await Promise.all([
        fetch("https://api.dhan.co/v2/holdings", { headers: brokerAuth(broker, token, sess.userId) }),
        fetch("https://api.dhan.co/v2/fundlimit", { headers: brokerAuth(broker, token, sess.userId) }),
      ]);
      const h = await hRes.json().catch(() => ([]));
      const f = await fRes.json().catch(() => ({}));
      const arr = Array.isArray(h) ? h : (h.data || []);
      const holdings = arr.map((x) => ({
        sym: String(x.tradingSymbol || x.symbol || x.securityId || "").replace(/-EQ$/, ""),
        qty: x.totalQty ?? x.availableQty ?? x.quantity ?? 0,
        avg: x.avgCostPrice ?? x.costPrice ?? null,
        ltp: x.lastTradedPrice ?? x.ltp ?? null,
        pnl: null,
        value: (x.lastTradedPrice != null && (x.totalQty ?? x.availableQty) != null) ? +(x.lastTradedPrice * (x.totalQty ?? x.availableQty)).toFixed(2) : null,
      }));
      // Dhan spells it "availabelBalance" in places; accept both.
      const cash = f.availabelBalance ?? f.availableBalance ?? f.sodLimit ?? null;
      return res.json({ broker, holdings, cash, currency: "INR" });
    }

    if (broker === "indmoney") {
      const [hRes, fRes] = await Promise.all([
        fetch("https://api.indstocks.com/portfolio/holdings", { headers: { Authorization: token } }),
        fetch("https://api.indstocks.com/funds", { headers: { Authorization: token } }),
      ]);
      const h = await hRes.json().catch(() => ({}));
      const f = await fRes.json().catch(() => ({}));
      const holdings = ((h && h.data) || []).map((x) => ({
        sym: String(x.trading_symbol || "").replace(/-EQ$/, ""),
        qty: x.quantity ?? 0,
        avg: x.average_price ?? null,
        ltp: x.last_traded_price ?? null,
        pnl: x.pnl_absolute ?? null,
        value: x.market_value ?? null,
      }));
      const cash = (f && f.data) ? (f.data.withdrawal_balance ?? f.data.sod_balance ?? null) : null;
      return res.json({ broker, holdings, cash, currency: "INR" });
    }

    if (broker === "angelone") {
      const apiKey = (sess.extra && sess.extra.apiKey) || "";
      const H = angelHeaders(apiKey, token);
      const [hRes, fRes] = await Promise.all([
        fetch("https://apiconnect.angelone.in/rest/secure/angelbroking/portfolio/v1/getAllHolding", { headers: H }),
        fetch("https://apiconnect.angelone.in/rest/secure/angelbroking/user/v1/getRMS", { headers: H }),
      ]);
      const h = await hRes.json().catch(() => ({}));
      const f = await fRes.json().catch(() => ({}));
      const list = (h.data && (h.data.holdings || (Array.isArray(h.data) ? h.data : []))) || [];
      const holdings = list.map((x) => ({
        sym: String(x.tradingsymbol || x.symbolname || "").replace(/-EQ$/, ""),
        qty: x.quantity ?? 0,
        avg: x.averageprice ?? null,
        ltp: x.ltp ?? null,
        pnl: x.profitandloss ?? null,
        value: (x.ltp != null && x.quantity != null) ? +(x.ltp * x.quantity).toFixed(2) : null,
      }));
      const cash = (f && f.data) ? (f.data.availablecash ?? f.data.net ?? null) : null;
      return res.json({ broker, holdings, cash, currency: "INR" });
    }

    if (broker === "groww") {
      const hRes = await fetch("https://api.groww.in/v1/holdings/user", { headers: brokerAuth("groww", token) });
      const h = await hRes.json().catch(() => ({}));
      const list = (h.payload && h.payload.holdings) || h.holdings || (Array.isArray(h.payload) ? h.payload : []) || [];
      const holdings = list.map((x) => ({
        sym: String(x.trading_symbol || x.tradingSymbol || x.symbol || "").replace(/-EQ$/, ""),
        qty: x.quantity ?? 0,
        avg: x.average_price ?? x.avg_price ?? null,
        ltp: x.ltp ?? x.last_price ?? null,
        pnl: null,
        value: (x.ltp != null && x.quantity != null) ? +(x.ltp * x.quantity).toFixed(2) : null,
      }));
      return res.json({ broker, holdings, cash: null, currency: "INR" });
    }

    if (broker === "coindcx") {
      const { apiKey, apiSecret } = sess.extra || {};
      const { d } = await coindcxCall(apiKey, apiSecret, "/exchange/v1/users/balances");
      const arr = Array.isArray(d) ? d : [];
      const holdings = arr
        .filter((x) => Number(x.balance) > 0 || Number(x.locked_balance) > 0)
        .map((x) => ({ sym: x.currency, qty: +(Number(x.balance) + Number(x.locked_balance || 0)).toFixed(8), avg: null, ltp: null, pnl: null, value: null }));
      return res.json({ broker, holdings, cash: null, currency: "USD" });
    }

    if (broker === "binance") {
      const { apiKey, apiSecret } = sess.extra || {};
      const { d } = await binanceSigned(apiKey, apiSecret, "/api/v3/account");
      const holdings = (d.balances || [])
        .filter((x) => Number(x.free) > 0 || Number(x.locked) > 0)
        .map((x) => ({ sym: x.asset, qty: +(Number(x.free) + Number(x.locked)).toFixed(8), avg: null, ltp: null, pnl: null, value: null }));
      return res.json({ broker, holdings, cash: null, currency: "USD" });
    }

    if (broker === "coinswitch") {
      const { apiKey, apiSecret } = sess.extra || {};
      const { d } = await coinswitchSigned(apiKey, apiSecret, "GET", "/trade/api/v2/user/portfolio");
      const arr = (d && (d.data || d.portfolio)) || [];
      const holdings = (Array.isArray(arr) ? arr : [])
        .map((x) => ({ sym: x.currency || x.symbol, qty: Number(x.balance || x.quantity || 0), avg: null, ltp: null, pnl: null, value: null }))
        .filter((h) => h.qty > 0);
      return res.json({ broker, holdings, cash: null, currency: "USD" });
    }

    if (broker === "delta") {
      // Real balances + real open positions. Signed calls; keys never leave this process.
      const [w, p, prodResp] = await Promise.all([
        deltaCall("GET", "/v2/wallet/balances", { userId: sess.userId }),
        deltaCall("GET", "/v2/positions/margined", { userId: sess.userId }),
        deltaCall("GET", "/v2/products", { signed: false }).catch(() => ({ result: [] })),
      ]);
      /* Delta trades in whole CONTRACTS, and one contract is `contract_value` COIN units (e.g. PAXG/XAUT gold
         tokens are ~0.001 coin per contract). Build id/symbol → contract_value so we can show the real coin
         quantity and notional — otherwise "26 contracts" of a $4050 token looks like a $105k holding instead of
         the true ~$105. */
      const cvById = new Map(), cvBySym = new Map();
      for (const pr of (prodResp && prodResp.result) || []) {
        const cv = Number(pr && pr.contract_value) || 1;
        if (pr && pr.id != null) cvById.set(String(pr.id), cv);
        if (pr && pr.symbol) cvBySym.set(pr.symbol, cv);
      }
      const cvForPos = (x) => Number(
        x.contract_value != null ? x.contract_value
          : (x.product && x.product.contract_value != null) ? x.product.contract_value
          : cvById.get(String(x.product_id)) != null ? cvById.get(String(x.product_id))
          : cvBySym.get(x.product_symbol || (x.product && x.product.symbol)) != null ? cvBySym.get(x.product_symbol || (x.product && x.product.symbol))
          : 1
      ) || 1;

      const bals = w.result || [];
      // Delta is a LEVERAGED venue: a position's notional (mark × size) is many times the capital
      // actually committed. The real numbers a trader cares about come from the wallet:
      //   equity      = total account balance (cash + unrealised P&L)
      //   available   = free balance not locked as margin
      //   marginUsed  = capital actually deployed as position/order margin
      const cash = bals.reduce((a, b) => a + (Number(b.available_balance) || 0), 0);
      const equity = bals.reduce((a, b) => a + (Number(b.balance) || 0), 0);
      const marginUsed = bals.reduce((a, b) => a + (Number(b.position_margin) || 0) + (Number(b.order_margin) || 0), 0);

      const holdings = (p.result || [])
        .filter((x) => Number(x.size) !== 0)
        .map((x) => {
          const cv = cvForPos(x);
          const coinQty = Number(x.size) * cv;   // contracts → real coin units
          // Notional uses the COIN quantity, not the raw contract count (mark/entry prices are per-coin).
          const notional = (x.mark_price != null && x.size != null) ? Number(x.mark_price) * coinQty : null;
          // Actual capital in THIS position: Delta's own `margin` when present, else notional/leverage.
          const lev = x.leverage != null ? Number(x.leverage) : null;
          const margin = x.margin != null ? Number(x.margin) : (notional != null && lev ? notional / lev : null);
          return {
            sym: x.product_symbol || (x.product && x.product.symbol) || null,
            qty: coinQty,                               // REAL coin units (was raw contract count → 1000x too big for gold tokens)
            contracts: Number(x.size),                  // keep the raw contract count for reference/exits
            contractValue: cv,
            avg: x.entry_price != null ? Number(x.entry_price) : null,
            ltp: x.mark_price != null ? Number(x.mark_price) : null,
            notional,                                   // leveraged position size (coin-based)
            margin,                                     // real capital deployed
            leverage: lev,
            value: notional,                            // value/qty = mark price still holds (both coin-based now)
            pnl: x.unrealized_pnl != null ? Number(x.unrealized_pnl) : null,
            source: "positions",
            market: "Crypto",
          };
        })
        .filter((h) => h.sym);

      return res.json({ broker, holdings, cash, equity, marginUsed, currency: "USD", leveraged: true });
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
app.post("/api/broker/logout", requireAuth, requireActiveUser, (req, res) => {
  const id = req.get("X-Broker-Session");
  const s = id ? brokerSessions.get(id) : null;
  // Only the session's OWNER may drop it — otherwise a leaked/guessed session id could DoS another user.
  if (s && s.userId === storageKeyFor(req.authUserId)) brokerSessions.delete(id);
  res.json({ ok: true });
});

/* ═══════════════════════ SERVER-SIDE SIGNAL-BASED AUTO-EXIT ═══════════════════════
   Closes a REAL position on the exchange when the strategy's exit fires (price SL/TP/
   trailing OR an indicator signal) — with the user's app closed. This is the only place
   in the app where the SERVER places a real order without a live request from the user,
   so every guardrail matters:
     • REDUCE-ONLY: the engine can only CLOSE a position, never open one.
     • KILL SWITCH: does nothing unless AUTO_EXIT_LIVE=true (otherwise it dry-runs + logs).
     • IDEMPOTENT: a position is claimed ('closing') before the order, so a restart mid-flight
       can't double-sell.
     • ENCRYPTED CREDS: the token/keys needed to act are stored AES-256-GCM, never plaintext.
   ─────────────────────────────────────────────────────────────────────────────────── */

/* AES-256-GCM. Key derived from CRED_KEY (preferred) or an existing server secret, so a
   deploy without CRED_KEY still encrypts rather than storing plaintext. Set CRED_KEY (any
   long random string) in production and rotating it simply forces users to reconnect. */
const CRED_SECRET = process.env.CRED_KEY || process.env.JWT_SECRET || process.env.DATABASE_URL || "matrix-cred-fallback-secret";
const CRED_AESKEY = crypto.scryptSync(CRED_SECRET, "matrix-cred-salt-v1", 32);
function encryptCred(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", CRED_AESKEY, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(obj), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { v: 1, iv: iv.toString("base64"), tag: tag.toString("base64"), ct: ct.toString("base64") };
}
function decryptCred(blob) {
  try {
    if (!blob || !blob.ct) return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", CRED_AESKEY, Buffer.from(blob.iv, "base64"));
    decipher.setAuthTag(Buffer.from(blob.tag, "base64"));
    const pt = Buffer.concat([decipher.update(Buffer.from(blob.ct, "base64")), decipher.final()]);
    return JSON.parse(pt.toString("utf8"));
  } catch (e) { console.error("[autoexit] cred decrypt failed:", e.message); return null; }
}

/* Persist just enough to reconstruct a working session unattended: the access/refresh token
   and any bring-your-own keys. For Delta the server's own env keys are used, so nothing
   per-user is stored. Called only when a user opts a real position into auto-exit. */
async function persistSessionCred(sess) {
  if (!sess || !sess.userId || !sess.broker) return;
  const payload = { accessToken: sess.accessToken || null, refreshToken: sess.refreshToken || null, extra: sess.extra || null };
  await db.saveBrokerCred(sess.userId, sess.broker, encryptCred(payload));
}
/* Rebuild a session-shaped object from stored creds, for the engine to place an exit. */
async function sessionFromCred(userId, broker) {
  if (broker === "delta") return { userId: String(userId), broker, accessToken: "server-signed" };  // Delta uses server env keys
  const blob = await db.getBrokerCred(userId, broker);
  const c = decryptCred(blob);
  if (!c) return null;
  return { userId: String(userId), broker, accessToken: c.accessToken, refreshToken: c.refreshToken, extra: c.extra || {} };
}

/* Map the app's product choice to each broker's code. "Intraday" auto-square-off (MIS) vs
   carry-forward / delivery (CNC on equity, NRML on F&O). Crypto ignores it. */
function mapProduct(broker, product) {
  const p = String(product || "").toLowerCase();
  const intraday = p.startsWith("intra") || p === "mis";
  if (broker === "zerodha") return intraday ? "MIS" : "CNC";
  if (broker === "fyers") return intraday ? "INTRADAY" : "CNC";
  return "CNC";
}

/* R8-lifecycle: FYERS order ACCEPTANCE is not EXECUTION. `POST /orders/sync` returns an order id the
   instant FYERS accepts the order — the fill can still be pending, partial, or rejected a beat later.
   Poll the order book by id and classify with reconcile.classifyFyersOrder until we see a CONCLUSIVE
   outcome (filled or rejected). Anything we can't positively read as filled stays PENDING — the safe
   direction: an entry won't register a phantom position, an exit won't be marked closed while it's
   still open at the broker. Bounded (~4 tries over ~3.2s); market orders normally confirm on the first. */
async function verifyFyersFill(sess, orderId, wantQty = 0) {
  if (!orderId) return { filled: false, rejected: false, pending: true, filledQty: 0, avgPrice: null, status: null };
  const auth = brokerAuth("fyers", sess.accessToken, sess.userId);
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fyFetch(`https://api-t1.fyers.in/api/v3/orders?id=${encodeURIComponent(orderId)}`, { headers: auth });
      const d = await r.json().catch(() => ({}));
      // FYERS returns the matched order under orderBook[] (filtered) or orderDetails; fall back to the body.
      const o = (Array.isArray(d.orderBook) && d.orderBook.find((x) => String(x.id) === String(orderId))) ||
                (Array.isArray(d.orderBook) && d.orderBook[0]) || d.orderDetails || d;
      const c = reconcile.classifyFyersOrder(o);
      if (c.filled || c.rejected) return { ...c, reason: o.message || o.orderStatusDescription || null };
      // still transit/pending → wait and re-poll
    } catch { /* transient — keep polling */ }
    if (attempt < 3) await new Promise((res) => setTimeout(res, 800));
  }
  return { filled: false, rejected: false, pending: true, filledQty: 0, avgPrice: null, status: null };
}

/* R9-P1-01: signed FYERS net quantity for a symbol (positive = long, negative = short, 0 = flat), or null
   when we can't read it. FYERS equity SELLs are NOT reduce-only, so the exit path clamps to this to make a
   retry after a partial fill unable to oversell into a short. */
async function fyersNetQty(sess, symbol) {
  try {
    const r = await fyFetch("https://api-t1.fyers.in/api/v3/positions", { headers: brokerAuth("fyers", sess.accessToken, sess.userId) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.s === "error") return null;
    const net = Array.isArray(d.netPositions) ? d.netPositions : null;
    if (!net) return null;
    const p = net.find((x) => String(x.symbol) === String(symbol));
    return p ? (Number(p.netQty) || 0) : 0;
  } catch { return null; }
}

/* R14-P1-02: the VERIFIED sellable-long quantity for a FYERS symbol, product-aware — the exit path must
   size a SELL from real broker truth, and FYERS splits it across two endpoints:
     • /positions  — today's / unsettled activity (signed netQty);
     • /holdings   — SETTLED demat shares (delivery/CNC), which have NO position row on a later day.
   For a CNC (delivery) product the sellable long = settled holdings + today's signed net position (so a
   same-day buy adds and a same-day partial sell subtracts). For INTRADAY it's the net position only.
   FAIL CLOSED: returns null if a source we NEED can't be read, so the caller never sells a blind quantity
   (positions-only would report a settled holding as flat and leave it unsold — the R14-P1-02 defect). */
async function fyersSellableLong(sess, symbol, product) {
  const auth = brokerAuth("fyers", sess.accessToken, sess.userId);
  let net = null;
  try {
    const r = await fyFetch("https://api-t1.fyers.in/api/v3/positions", { headers: auth });
    const d = await r.json().catch(() => ({}));
    if (r.ok && d.s !== "error" && Array.isArray(d.netPositions)) {
      const p = d.netPositions.find((x) => String(x.symbol) === String(symbol));
      net = p ? (Number(p.netQty) || 0) : 0;
    }
  } catch { net = null; }
  const isCnc = /^(cnc|delivery|c|d)$/i.test(String(product || "")) || product == null;
  if (!isCnc) return net;                     // intraday: positions only (null if unreadable → fail closed)
  let held = null;
  try {
    const r = await fyFetch("https://api-t1.fyers.in/api/v3/holdings", { headers: auth });
    const d = await r.json().catch(() => ({}));
    if (r.ok && d.s !== "error" && Array.isArray(d.holdings)) {
      const h = d.holdings.find((x) => String(x.symbol) === String(symbol));
      held = h ? (Number(h.quantity ?? h.remainingQuantity ?? h.remainingQty ?? 0) || 0) : 0;
    }
  } catch { held = null; }
  if (held == null || net == null) return null;   // CNC needs BOTH to size safely → fail closed
  return held + net;
}

/* R12-P1-01: state of our tagged FYERS EXIT order — "pending" | "resolved" | "absent" | "unknown". Used by
   stale-close recovery to stay idempotent: it must never submit a second SELL while the first is still
   working. "unknown" (couldn't read the book) is treated by the caller like "pending" — never resubmit. */
async function fyersExitOrderState(sess, exitTag) {
  const tag = exitTag ? reconcile.fyersOrderTag(exitTag) : null;
  if (!tag) return "absent";
  try {
    const r = await fyFetch("https://api-t1.fyers.in/api/v3/orders", { headers: brokerAuth("fyers", sess.accessToken, sess.userId) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.s === "error") return "unknown";
    const book = Array.isArray(d.orderBook) ? d.orderBook : null;
    return reconcile.fyersTaggedExitState(book, tag);
  } catch { return "unknown"; }
}

/* REDUCE-ONLY exit executor. CLOSES a position by trading the OPPOSITE side: a long is closed
   with a sell, a short (Delta perpetual only) with a buy. Delta additionally sets reduce_only so
   it can never flip the position by accident. The exit MUST use the same product the entry used
   (closing an MIS position with CNC would fail). Spot brokers can't hold shorts, so they always sell. */
async function placeExitOrder(sess, symbol, qty, market, product, short = false, exitTag = null) {
  const broker = sess.broker;
  const token = sess.accessToken;
  const prod = mapProduct(broker, product);
  if (broker === "delta") {
    const prods = await deltaCall("GET", "/v2/products", { signed: false });
    const prod = (prods.result || []).find((p) => p.symbol === symbol);
    if (!prod) throw new Error(`Delta does not list ${symbol}`);
    // qty is stored in COIN units — convert back to contracts to close the exact position.
    const size = deltaCoinToContracts(prod, qty);
    const d = await deltaCall("POST", "/v2/orders", {
      userId: sess.userId,
      body: { product_id: prod.id, size, side: short ? "buy" : "sell", order_type: "market_order", reduce_only: true },
    });
    // R6-lifecycle: verify the exit actually FILLED — a partial/rejected reduce-only leaves the position
    // open at the broker, so we must NOT let the caller mark it fully closed. Report the fill truth.
    const c = reconcile.classifyDeltaOrder(d.result || {}, size);
    return { orderId: c.orderId, filled: c.fullyFilled, partial: c.partial, state: c.state, remainingContracts: c.unfilled };
  }
  if (broker === "coindcx") {
    const { apiKey, apiSecret } = sess.extra || {};
    const base = String(symbol).replace(/(INR|USDT)$/i, "").toUpperCase();
    const { r, d } = await coindcxCall(apiKey, apiSecret, "/exchange/v1/orders/create", {
      side: "sell", order_type: "market_order", market: `${base}INR`, total_quantity: Number(qty),
    });
    if (!r.ok || d.message || d.code) throw new Error(d.message || `CoinDCX exit failed (${r.status})`);
    const o = (d.orders && d.orders[0]) || d;
    return { orderId: o.id || o.order_id || null };
  }
  if (broker === "binance") {
    const { apiKey, apiSecret } = sess.extra || {};
    const base = String(symbol).replace(/(USDT|USD|INR)$/i, "").toUpperCase();
    const { r, d } = await binanceSigned(apiKey, apiSecret, "/api/v3/order", { symbol: `${base}USDT`, side: "SELL", type: "MARKET", quantity: Number(qty) }, "POST");
    if (!r.ok) throw new Error((d && d.msg) || `Binance exit failed (${r.status})`);
    return { orderId: d.orderId ?? null };
  }
  if (broker === "coinswitch") {
    const { apiKey, apiSecret } = sess.extra || {};
    const base = String(symbol).replace(/(USDT|USD|INR)$/i, "").toUpperCase();
    const { r, d } = await coinswitchSigned(apiKey, apiSecret, "POST", "/trade/api/v2/order", { symbol: `${base}/INR`, side: "sell", type: "market", quantity: Number(qty), exchange: "coinswitchx" });
    if (!r.ok || (d && (d.error || d.message))) throw new Error((d && (d.message || d.error)) || `CoinSwitch exit failed (${r.status})`);
    return { orderId: (d && d.data && (d.data.order_id || d.data.id)) || null };
  }
  if (broker === "dhan") {
    const securityId = await dhanSecurityId(String(symbol).replace(/^NSE:/, "").replace(/-EQ$/, ""));
    const body = { dhanClientId: sess.extra && sess.extra.clientId, transactionType: "SELL", exchangeSegment: "NSE_EQ", productType: "INTRADAY", orderType: "MARKET", validity: "DAY", securityId, quantity: String(Number(qty)), price: "", afterMarketOrder: false };
    const r = await fetch("https://api.dhan.co/v2/orders", { method: "POST", headers: { ...brokerAuth("dhan", token, sess.userId), "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.orderStatus === "REJECTED") throw new Error(d.errorMessage || d.omsErrorDescription || `Dhan exit failed (${r.status})`);
    return { orderId: d.orderId ?? null };
  }
  if (broker === "angelone") {
    const { token: symboltoken, tradingsymbol } = await angelToken(String(symbol).replace(/^NSE:/, "").replace(/-EQ$/, ""));
    const body = { variety: "NORMAL", tradingsymbol, symboltoken, transactiontype: "SELL", exchange: "NSE", ordertype: "MARKET", producttype: "INTRADAY", duration: "DAY", price: "0", squareoff: "0", stoploss: "0", quantity: String(Number(qty)) };
    const r = await fetch("https://apiconnect.angelone.in/rest/secure/angelbroking/order/v1/placeOrder", { method: "POST", headers: angelHeaders(sess.extra && sess.extra.apiKey, token), body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.status === false || d.errorcode) throw new Error(d.message || `Angel One exit failed (${r.status})`);
    return { orderId: (d.data && (d.data.orderid || d.data.uniqueorderid)) || null };
  }
  if (broker === "groww") {
    const bare = String(symbol).replace(/^NSE:/, "").replace(/-EQ$/, "");
    const r = await fetch("https://api.groww.in/v1/order/create", { method: "POST", headers: { ...brokerAuth("groww", token, sess.userId), "Content-Type": "application/json" }, body: JSON.stringify({ trading_symbol: bare, quantity: Number(qty), validity: "DAY", exchange: "NSE", segment: "CASH", product: "MIS", order_type: "MARKET", transaction_type: "SELL" }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.status === "FAILURE" || d.error) throw new Error((d.error && (d.error.message || d.error)) || d.message || `Groww exit failed (${r.status})`);
    return { orderId: (d.payload && d.payload.groww_order_id) || d.groww_order_id || null };
  }
  if (broker === "indmoney") {
    const securityId = await dhanSecurityId(String(symbol).replace(/^NSE:/, "").replace(/-EQ$/, ""));
    const body = { txn_type: "SELL", exchange: "NSE", segment: "EQUITY", security_id: String(securityId), qty: Number(qty), order_type: "MARKET", product: "INTRADAY", validity: "DAY", is_amo: false, algo_id: "99999" };
    const r = await fetch("https://api.indstocks.com/order", { method: "POST", headers: { ...brokerAuth("indmoney", token, sess.userId), "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.status !== "success") throw new Error((d && d.message) || `IND Money exit failed (${r.status})`);
    return { orderId: (d.data && d.data.order_id) || null };
  }
  if (broker === "zerodha") {
    const [exchange, tradingsymbol] = String(symbol).split(":");
    const body = new URLSearchParams({ exchange, tradingsymbol, transaction_type: "SELL", quantity: String(qty), order_type: "MARKET", product: prod, validity: "DAY" });
    const r = await fetch("https://api.kite.trade/orders/regular", { method: "POST", headers: { ...brokerAuth(broker, token, sess.userId), "Content-Type": "application/x-www-form-urlencoded" }, body });
    const d = await r.json();
    if (!r.ok || d.status === "error") throw new Error(d.message || `kite exit ${r.status}`);
    return { orderId: d.data.order_id };
  }
  if (broker === "fyers") {
    /* R9-P1-01: FYERS equity SELL is NOT reduce-only. Before EVERY exit (initial or retry) clamp the
       quantity to the broker's actual net-long holding, so a retry after a partial fill can never sell
       more than we still hold and flip us into a short. If FYERS reports the account already flat (or
       short), there is nothing to close — report it closed instead of firing another SELL. */
    const held = await fyersSellableLong(sess, symbol, product);   // R14-P1-02: product-aware (incl. settled CNC holdings)
    // R10-P1-01: size the SELL from the broker's real holding (pure, unit-tested). Fail CLOSED — if the
    // holdings read failed we place NO order and throw so the exit engine retries next tick, rather than
    // selling an unverified internal quantity that a partial-fill retry could oversell into a short.
    const plan = reconcile.fyersExitPlan(held, qty);
    if (plan.action === "unverified") throw new Error("Couldn't read FYERS positions to size the exit safely — retrying (won't sell an unverified quantity).");
    if (plan.action === "flat") return { orderId: null, filled: true, alreadyFlat: true, state: "closed", filledQty: 0, remaining: 0 };
    const sellQty = plan.sellQty;
    // R12-P1-01: stamp the durable exit orderTag on the SELL so stale-close recovery can find THIS order in
    // the FYERS order book and never fire a duplicate SELL while it's still working.
    const exTag = exitTag ? reconcile.fyersOrderTag(exitTag) : null;
    const r = await fyFetch("https://api-t1.fyers.in/api/v3/orders/sync", {
      method: "POST", headers: { ...brokerAuth(broker, token, sess.userId), "Content-Type": "application/json" },
      body: JSON.stringify({ symbol, qty: sellQty, type: 2, side: -1, productType: prod, limitPrice: 0, stopPrice: 0, validity: "DAY", disclosedQty: 0, offlineOrder: false, ...(exTag ? { orderTag: exTag } : {}) }),
    });
    const d = await r.json();
    if (!r.ok || d.s === "error") throw new Error(d.message || `fyers exit ${r.status}`);
    // Acceptance ≠ execution. Verify the actual fill before letting the caller mark the position closed.
    const c = await verifyFyersFill(sess, d.id, sellQty);
    if (c.rejected) throw new Error(c.reason || `FYERS rejected the exit (status ${c.status})`);
    const filledQty = Number(c.filledQty) || 0;
    const filledAll = c.filled && filledQty >= sellQty;
    // Remaining is what the ORIGINAL requested qty still needs closed after this fill — the caller uses it
    // to shrink the managed position so the next retry only sells the unsold remainder.
    const remaining = Math.max(0, Number(qty) - filledQty);
    // R13-P1-01: distinguish a still-WORKING order (accepted, not yet confirmed filled — c.pending) from a
    // TERMINAL partial. The caller must NOT fire a second SELL while this order is still pending; it keeps
    // the position "closing" with the SAME exitTag and reconciles this order instead.
    return { orderId: d.id, filled: filledAll, partial: c.filled && !filledAll, pending: !filledAll && !!c.pending, state: filledAll ? "closed" : "open", avgPrice: c.avgPrice, filledQty, remaining };
  }
  throw new Error(`auto-exit not supported for ${broker}`);
}

/* Register a real position for the engine to watch. Called from /api/broker/order after a
   real buy that opted into auto-exit. Persists the creds needed to act on it later. */
async function registerManagedPosition({ sess, symbol, brokerSym, qty, entry, market, sl, tp, tsl, cfg, yahoo, interval, product, short = false, entryOrderId = null }) {
  await persistSessionCred(sess);
  /* R17-P1-03: when the caller supplies the broker entry-order id, registration is IDEMPOTENT by
     (broker,user,entryOrderId) — if a managed position for that entry already exists (e.g. another replica's
     delayed-protection worker got there first), reuse it instead of arming a second exit for one holding. */
  if (entryOrderId) {
    const existing = (await db.getManagedPositionsForUser(String(sess.userId)).catch(() => []))
      .find((p) => p && String(p.entryOrderId) === String(entryOrderId) && p.broker === sess.broker);
    if (existing) return existing;
  }
  const pos = {
    id: crypto.randomBytes(16).toString("hex"),
    userId: String(sess.userId), broker: sess.broker,
    symbol, brokerSym, qty: Number(qty), entry: Number(entry) || null,
    entryAt: Date.now(), market: market || "Crypto",
    sl: sl || null, tp: tp || null, tsl: tsl || null,
    short: !!short,                         // SHORT position → exit/SL/TP are mirrored, close with a BUY
    product: product || "CNC",              // so the exit closes with the SAME product as entry
    cfg: cfg || null,                       // strategy { defs, exit } for indicator exits
    yahoo: yahoo || symbol, interval: interval || (market === "IN" || market === "Commodity" ? "5m" : "5m"),
    ...(entryOrderId ? { entryOrderId: String(entryOrderId) } : {}),
    status: "open",
  };
  try {
    await db.saveManagedPosition(pos);
  } catch (e) {
    // Unique (broker,user,entryOrderId) violation → another worker just armed it. Reuse theirs.
    if (entryOrderId) { const other = (await db.getManagedPositionsForUser(String(sess.userId)).catch(() => [])).find((p) => p && String(p.entryOrderId) === String(entryOrderId) && p.broker === sess.broker); if (other) return other; }
    throw e;
  }
  return pos;
}

/* R4-P1-01 ADOPT: register a managed position for an order the user CONFIRMS filled but which we never
   linked (the unknown-order case). Places NO new broker order — it only records the position so the exit
   engine protects it and the strategy won't open a duplicate. Adoption uses the broker's ACTUAL open
   position (real size + entry) — supported for Delta today; refused for brokers without a position
   lookup (R6-P1-01), since guessing quantity/price is unsafe. Returns the managed position, or null if
   the broker shows FLAT, is unsupported, or we can't read it. */
async function adoptBrokerPosition(st) {
  const sess = await sessionFromCred(st.userId, st.broker);
  if (!sess) return null;
  if (st.broker === "delta") {
    let held = [];
    try { const pr = await deltaCall("GET", "/v2/positions/margined", { userId: st.userId }); held = (pr && pr.result) || []; } catch { return null; }
    let dprod = null;
    try { const prods = await deltaCall("GET", "/v2/products", { signed: false }); dprod = (prods.result || []).find((p) => p.symbol === st.brokerSym) || null; } catch { /* ignore */ }
    const pid = dprod ? dprod.id : null;
    const p = held.find((x) => (pid != null && Number(x.product_id) === Number(pid)) || String(x.product_symbol || "") === String(st.brokerSym));
    if (!p || !Number(p.size)) return null;   // broker shows FLAT → nothing to adopt
    const cv = dprod ? (Number(dprod.contract_value) || 1) : 1;
    const qty = Math.abs(Number(p.size)) * cv;   // coin units
    const entry = Number(p.entry_price) || Number(p.avg_price) || null;
    const short = Number(p.size) < 0;
    return registerManagedPosition({ sess, symbol: st.symbol, brokerSym: st.brokerSym, qty, entry, market: st.market, sl: st.sl, tp: st.tp, tsl: st.tsl, cfg: st.cfg, yahoo: st.yahoo, interval: st.interval, product: st.product, short });
  }
  if (st.broker === "fyers") {
    /* R9-P2-02: adopt ONLY the quantity attributable to OUR stamped order (matched by orderTag in the
       order book), NEVER the aggregate net position — which could include shares the user already held
       and must not be managed or sold by this strategy. The net position is used only as a safety
       CEILING (never adopt more than the broker actually holds net-long) and to refuse shorts. */
    const tag = reconcile.fyersOrderTag(st.pendingClientId);
    if (!tag) return null;                                  // no durable key → can't attribute → don't adopt
    let book = null;
    try {
      const r = await fyFetch("https://api-t1.fyers.in/api/v3/orders", { headers: brokerAuth("fyers", sess.accessToken, st.userId) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.s === "error") return null;
      book = Array.isArray(d.orderBook) ? d.orderBook : null;
    } catch { return null; }
    if (!book) return null;
    // Attribute only OUR tagged, filled quantity + weighted-average price (pure, unit-tested).
    let { filledQty, avgPrice } = reconcile.attributeFyersFills(book, tag);
    if (filledQty <= 0) return null;                        // none of OUR order filled → nothing to adopt
    // R11-P2-02: without a usable fill price we CAN'T compute SL/TP or link the position (link requires
    // entry > 0). Registering an entry-less managed position would leave it unprotected/orphaned — so
    // refuse to adopt and keep the strategy paused for review rather than create an unusable position.
    if (!(avgPrice > 0)) return null;
    const held = await fyersNetQty(sess, st.brokerSym);     // signed net; safety ceiling
    if (held != null) { if (held <= 0) return null; filledQty = Math.min(filledQty, held); }   // never exceed real holding, refuse if flat/short
    return registerManagedPosition({ sess, symbol: st.symbol, brokerSym: st.brokerSym, qty: filledQty, entry: avgPrice, market: st.market, sl: st.sl, tp: st.tp, tsl: st.tsl, cfg: st.cfg, yahoo: st.yahoo, interval: st.interval, product: st.product, short: false });
  }
  // R6-P1-01: for brokers WITHOUT an actual position lookup we refuse to adopt. Synthesizing a managed
  // position from the intended notional + current price is unsafe — a partial fill, a different fill
  // price, or pre-existing exposure would make the reduce-only exit under-/over-close or reverse. Better
  // to keep the strategy paused than to invent real-money position truth. (Delta/FYERS handled above.)
  return null;
}

/* R6-P2-01: read the broker's open size for a strategy's instrument, so "no fill" can require BROKER
   EVIDENCE (that the account is flat) rather than a bare user assertion. Returns { size } in contracts
   (0 = flat) for Delta, or null when we can't read the broker (unsupported broker or a transport error).
   The caller treats null as "unverifiable → don't clear". */
async function brokerOpenSize(st) {
  if (st.broker === "delta") {
    let held = null;
    try { const pr = await deltaCall("GET", "/v2/positions/margined", { userId: st.userId }); held = (pr && pr.result); } catch { return null; }
    if (!Array.isArray(held)) return null;
    let dprod = null;
    try { const prods = await deltaCall("GET", "/v2/products", { signed: false }); dprod = (prods.result || []).find((p) => p.symbol === st.brokerSym) || null; } catch { /* ignore */ }
    const pid = dprod ? dprod.id : null;
    const p = held.find((x) => (pid != null && Number(x.product_id) === Number(pid)) || String(x.product_symbol || "") === String(st.brokerSym));
    return { size: p ? Math.abs(Number(p.size) || 0) : 0 };
  }
  if (st.broker === "fyers") {
    // R8-P2-01 / R14-P1-02: product-aware sellable long (positions + settled CNC holdings), so a settled
    // holding isn't mistaken for flat. null when unreadable → caller treats as unverifiable.
    const sess = await sessionFromCred(st.userId, "fyers");
    if (!sess) return null;
    const q = await fyersSellableLong(sess, st.brokerSym, st.product);
    return q == null ? null : { size: Math.abs(q) };
  }
  return null;
}

let autoExitRunning = false;
let lastAutoExit = { at: null, checked: 0, exited: 0, live: false };
/* R11-P1-01: how long a "closing" claim may sit before we treat it as STRANDED (crash or unrecovered
   error between the claim and the resolution) and reconcile it, rather than skipping it forever. Must be
   comfortably longer than one exit attempt (order placement + fill polling). */
const CLOSING_STALE_MS = Number(process.env.CLOSING_STALE_MS) || 3 * 60 * 1000;
async function runAutoExitEngine() {
  if (autoExitRunning) return;
  autoExitRunning = true;
  const live = String(process.env.AUTO_EXIT_LIVE || "").toLowerCase() === "true";
  let checked = 0, exited = 0;
  let reconciled = 0;
  try {
    const open = await db.getOpenManagedPositions(500);

    /* RECONCILE (display-truth): for each user with open Delta positions, fetch THEIR actual
       Delta positions (signed with their own BYOA keys). Any managed position whose symbol Delta
       reports as FLAT (size 0 / absent) was closed outside the app — a manual close in the Delta
       app, or Delta's own bracket SL/TP. Mark it closed so the phantom "in position" P&L clears.
       Only acts when we could actually read that user's Delta; on any error we leave it untouched. */
    const deltaHeldByUser = new Map();
    async function deltaHeldFor(uid) {
      if (deltaHeldByUser.has(uid)) return deltaHeldByUser.get(uid);
      let held = null;
      try {
        const pr = await withTimeout(deltaCall("GET", "/v2/positions/margined", { userId: uid }), 8000);
        held = new Set((pr && pr.result || []).filter((x) => Number(x.size) !== 0)
          .map((x) => String(x.product_symbol || (x.product && x.product.symbol) || "")));
      } catch { held = null; }
      deltaHeldByUser.set(uid, held);
      return held;
    }

    for (const pos of open) {
      if (pos.status === "closing") {
        /* R11-P1-01: "closing" is a transient claim — set just before the broker call and cleared to
           open/closed in the SAME sweep. If we still see it on a LATER sweep it was STRANDED (a crash or
           an unrecovered error between the claim and the resolution). NEVER skip it forever — that abandons
           a live, unprotected position. Give the in-flight attempt a grace window, then reconcile against
           broker truth: flat → closed; otherwise return it to "open" so SL/TP monitoring + exit retries
           resume next tick. (A legacy stranded row with no closingSince reconciles immediately.) */
        if (!reconcile.closingIsStale(pos.closingSince, Date.now(), CLOSING_STALE_MS)) continue;   // fresh — let it finish
        /* R12-P1-01 IDEMPOTENCY: before reopening (which would re-fire the exit), check whether OUR prior
           exit order is still WORKING at the broker. If it is (or we can't tell), we must NOT submit a
           second SELL — a non-reduce-only FYERS SELL could then oversell the long into a short. Wait. */
        if (pos.broker === "fyers" && pos.exitTag) {
          try {
            const sess = await sessionFromCred(pos.userId, "fyers");
            const exState = sess ? await fyersExitOrderState(sess, pos.exitTag) : "unknown";
            if (exState === "pending" || exState === "unknown") {
              await db.updateManagedPosition(pos.id, { closingSince: Date.now(), lastError: `prior exit order ${exState} at FYERS — waiting, not resubmitting (no duplicate SELL)` });
              console.warn(`[autoexit] stale closing ${pos.symbol}: prior exit ${exState} → waiting, not resubmitting`);
              continue;
            }
            // "resolved"/"absent" → the prior order is terminal/gone → safe to reconcile net position below.
          } catch { await db.updateManagedPosition(pos.id, { closingSince: Date.now() }); continue; }   // unknown → wait
        }
        let flat = false;
        try {
          if (pos.broker === "delta") { const held = await deltaHeldFor(pos.userId); if (held && !held.has(String(pos.brokerSym))) flat = true; }
          else if (pos.broker === "fyers") { const sess = await sessionFromCred(pos.userId, "fyers"); const q = sess ? await fyersSellableLong(sess, pos.brokerSym, pos.product) : null; if (q != null && q <= 0) flat = true; }   // R14-P1-02: product-aware, so a settled CNC holding isn't seen as flat
        } catch { /* couldn't verify → reopen to keep it protected */ }
        if (flat) { await db.updateManagedPosition(pos.id, { status: "closed", closedAt: Date.now(), exitReason: "reconciled — flat after stale close", closingSince: null, exitTag: null }); reconciled++; continue; }
        await db.updateManagedPosition(pos.id, { status: "open", closingSince: null, exitTag: null, lastError: "recovered a stranded 'closing' state — resumed monitoring" });
        console.warn(`[autoexit] recovered STRANDED closing ${pos.symbol} for ${pos.userId} → resumed monitoring`);
        continue;   // re-processed as an open position on the next sweep
      }
      /* R14-P1-06: NEVER auto-exit a broker we can't get fill truth from — a SELL on acceptance could
         over-/under-sell and we'd falsely mark it closed. New managed positions are only armed for verified
         brokers (Delta/FYERS); any legacy position on another broker is left for the user to manage in their
         broker app (flagged once) rather than auto-sold on unverified execution. */
      if (!FILL_VERIFIED_BROKERS.has(pos.broker)) {
        if (!pos.exitUnsupportedFlagged) await db.updateManagedPosition(pos.id, { exitUnsupportedFlagged: true, lastError: `App-managed exit isn't supported for ${pos.broker} — please set/monitor SL/TP in your broker app.` });
        continue;
      }
      // Broker says this position is gone -> reconcile it closed and skip the exit check.
      if (pos.broker === "delta") {
        const held = await deltaHeldFor(pos.userId);
        if (held && !held.has(String(pos.brokerSym))) {
          await db.updateManagedPosition(pos.id, { status: "closed", closedAt: Date.now(), exitReason: "reconciled — closed on Delta" });
          reconciled++;
          continue;
        }
      }
      checked++;
      try {
        const range = pos.interval === "1d" ? "6mo" : "1mo";
        const candles = await candlesFor(pos.yahoo || pos.symbol, range, pos.interval || "5m");
        if (!candles || candles.length < 30) continue;

        let hit = strat.priceExitFired(pos, candles);
        if (!hit.fired && pos.cfg) { const s = strat.exitSignalFired(pos.cfg, candles); if (s.fired) hit = { fired: true, reason: s.reason }; }
        // INTRADAY square-off: force a reduce-only exit ~15 min before close so an MIS position never
        // carries overnight (matches the broker's own square-off). Delivery/CNC positions are exempt.
        const posIntraday = /^(mis|intraday|intra)$/i.test(String(pos.product || "")) || pos.intraday === true;
        if (!hit.fired && posIntraday && intradaySquareDue(pos.market)) hit = { fired: true, reason: "Intraday square-off" };
        if (!hit.fired) continue;

        /* R13-P1-01 IDEMPOTENCY (the decisive guard): NEVER create a new exit order while a PRIOR tagged
           FYERS exit may still be working at the broker — that is the duplicate-SELL / oversell-to-short
           path, whether the prior order lingered via a crash OR a normal pending-past-poll return. If a
           persisted exitTag is still pending/unverifiable, wait; only once it is terminal (or absent) do we
           clear it and start a fresh exit. This makes "at most one active SELL" hold across every sweep. */
        if (pos.broker === "fyers" && pos.exitTag) {
          const sessChk = await sessionFromCred(pos.userId, "fyers");
          const exState = sessChk ? await fyersExitOrderState(sessChk, pos.exitTag) : "unknown";
          if (reconcile.exitPreflightAction(exState) === "wait") {
            await db.updateManagedPosition(pos.id, { status: "closing", closingSince: Date.now(), lastError: `Prior exit order ${exState} at FYERS — waiting, not resubmitting.` });
            console.warn(`[autoexit] ${pos.symbol}: prior exit ${exState} → holding, not firing a new SELL`);
            continue;
          }
          // terminal/absent → the prior order is done → clear the stale tag and fire a fresh, clamped exit.
          await db.updateManagedPosition(pos.id, { exitTag: null });
          pos.exitTag = null;
        }

        // R14-P1-03: ATOMICALLY claim the position (open → closing) so a concurrent Close Now (or another
        // actor) can't also fire a SELL. Only ONE caller wins; a null return means someone else is already
        // closing it → skip. Stamp closingSince (crash-stale reconciliation, R11) + a durable exitTag (R12).
        const exitTag = reconcile.fyersOrderTag(`mxx${pos.id}x${Date.now()}`);
        const claimed = await db.claimManagedForExit(pos.id, { exitReason: hit.reason, closingSince: Date.now(), exitTag });
        if (!claimed) { console.warn(`[autoexit] ${pos.symbol} for ${pos.userId}: exit already claimed elsewhere — skipping`); continue; }
        pos.exitTag = exitTag;

        if (!live) {
          console.log(`[autoexit] DRY-RUN (AUTO_EXIT_LIVE!=true): would exit ${pos.symbol} for ${pos.userId} — ${hit.reason}`);
          await db.updateManagedPosition(pos.id, { status: "open" });
          continue;
        }

        const sess = await sessionFromCred(pos.userId, pos.broker);
        if (!sess) { await db.updateManagedPosition(pos.id, { status: "open", lastError: "no stored credentials — reconnect broker" }); continue; }

        const r = await placeExitOrder(sess, pos.brokerSym, pos.qty, pos.market, pos.product, !!pos.short, exitTag);
        // R6/R8-lifecycle: only mark CLOSED when the exit actually flattened. A verified-partial/unfilled
        // exit (r.filled === false) leaves a real position open, so we return it to "open" — the reduce-only
        // retry on the next tick (and the flat-reconcile) will finish the job instead of losing track of
        // live exposure. Delta and FYERS both report fill truth; other brokers leave r.filled undefined
        // (=== false is not true) → treated as closed.
        if (r.filled === false) {
          /* R13-P1-01: if the exit order is still WORKING at the broker (accepted, not yet confirmed
             filled), keep the position "closing" with the SAME exitTag — the next sweep reconciles THIS
             order rather than firing a second SELL. closingSince=null so the next sweep re-checks promptly
             (a quick fill resolves fast; a genuinely stuck order then throttles to the stale window). */
          if (reconcile.exitOutcomeAction(r) === "hold") {
            await db.updateManagedPosition(pos.id, { status: "closing", closingSince: null, exitOrderId: r.orderId || null, lastError: `Exit order pending at broker (state ${r.state}) — awaiting fill; not resubmitting.` });
            console.warn(`[autoexit] exit PENDING ${pos.symbol} for ${pos.userId} — holding tagged order ${r.orderId} (no second SELL)`);
            continue;
          }
          /* R9-P1-01: TERMINAL partial — shrink the managed quantity to what the broker CONFIRMED still
             needs closing, so the next retry sells only the unsold remainder — never the full original qty
             again (which, on a non-reduce-only FYERS SELL, could oversell into a short). `r.remaining` is
             broker-confirmed (FYERS); Delta is reduce-only so it can't oversell and reports contracts. */
          const patch = { status: "open", exitTag: null, lastError: `Exit not fully filled (state ${r.state}${r.remaining != null ? `, ${r.remaining} left` : (r.remainingContracts != null ? `, ~${r.remainingContracts} left` : "")}) — will retry`, exitOrderId: r.orderId || null };
          if (Number(r.remaining) >= 0 && r.remaining != null) {
            if (r.remaining === 0) { await db.updateManagedPosition(pos.id, { status: "closed", closedAt: Date.now(), exitReason: hit.reason, exitOrderId: r.orderId || null }); exited++; continue; }
            patch.qty = Number(r.remaining);
          }
          await db.updateManagedPosition(pos.id, patch);
          console.warn(`[autoexit] PARTIAL/UNFILLED exit ${pos.symbol} for ${pos.userId} — retrying remaining next tick (order ${r.orderId})`);
          continue;
        }
        await db.updateManagedPosition(pos.id, { status: "closed", closedAt: Date.now(), exitReason: hit.reason, exitOrderId: r.orderId || null });
        exited++;
        console.log(`[autoexit] EXITED ${pos.symbol} for ${pos.userId} via ${pos.broker} — ${hit.reason} (order ${r.orderId})`);
      } catch (e) {
        /* SELF-REVIEW fix: a FYERS exit that THREW may still have reached the broker (e.g. the order was
           accepted but the response/verify failed). Flipping straight to "open" would let the next sweep
           fire a SECOND SELL — the exact duplicate the R12 idempotency guard prevents. So for a FYERS exit
           that had a stamped exitTag, keep it "closing" with closingSince=null: the very next sweep's
           stale-recovery reconciles by that tag (pending → wait; absent/resolved → reopen/close) instead of
           blindly resubmitting. Other brokers (Delta reduce_only-safe; no tag) retry via "open" as before. */
        if (pos.broker === "fyers" && pos.exitTag) {
          await db.updateManagedPosition(pos.id, { status: "closing", closingSince: null, lastError: String(e.message || e) });
        } else {
          await db.updateManagedPosition(pos.id, { status: "open", lastError: String(e.message || e) });
        }
        console.error(`[autoexit] ${pos.symbol} (${pos.broker}):`, e.message);
      }
    }
  } catch (e) { console.error("[autoexit] sweep failed:", e.message); }
  finally { autoExitRunning = false; lastAutoExit = { at: Date.now(), checked, exited, reconciled, live }; }
}
/* REAL-money managed-exit engine. Kept responsive (60s default) since it guards live positions, but
   still env-tunable. It only reads OPEN managed positions, so egress is small when nothing is live. */
const AUTO_EXIT_MS = Math.max(30_000, Number(process.env.AUTO_EXIT_MS) || 60_000);
if (process.env.EXIT_MONITOR !== "off") {
  setInterval(runAutoExitEngine, AUTO_EXIT_MS);
  setTimeout(runAutoExitEngine, 15_000);
}

/* The user's own managed positions (to show + cancel in the app). */
app.get("/api/autoexit", requireAuth, async (req, res) => {
  const userId = routeUserId(req);
  const list = await db.getManagedPositionsForUser(userId).catch(() => []);
  res.json({ engineLive: String(process.env.AUTO_EXIT_LIVE || "").toLowerCase() === "true", last: lastAutoExit, positions: list });
});
/* Cancel auto-exit for a position (stops the engine watching it; does NOT touch the position
   at the broker). The user must own it. */
app.post("/api/autoexit/cancel", requireAuth, requireActiveUser, async (req, res) => {
  const userId = routeUserId(req);
  const { id } = req.body || {};
  if (!userId || !id) return res.status(400).json({ error: "userId and id required" });
  const list = await db.getManagedPositionsForUser(userId).catch(() => []);
  const mine = list.find((p) => p.id === id);
  if (!mine) return res.status(404).json({ error: "not found" });
  await db.updateManagedPosition(id, { status: "cancelled", cancelledAt: Date.now() });
  res.json({ ok: true });
});
/* Arm an auto-exit (stop-loss / take-profit / trailing) on an EXISTING broker holding — the
   one the user already owns, not one we just bought. Registers a managed position so the exit
   engine watches it and places a reduce-only SELL when SL/TP is hit. Entry defaults to the
   holding's average cost, so "SL 2%" means 2% below what they paid. Requires stored creds. */
app.post("/api/autoexit/register", requireAuth, requireActiveUser, async (req, res) => {
  try {
    const userId = routeUserId(req);
    const { broker, symbol, brokerSym, qty, entry, market, sl, tp, tsl, product } = req.body || {};
    if (!userId || !symbol || !brokerSym || !(Number(qty) > 0)) return res.status(400).json({ error: "userId, symbol, brokerSym and qty are required" });
    if (!(Number(sl) > 0) && !(Number(tp) > 0) && !(Number(tsl) > 0)) return res.status(400).json({ error: "set at least one of stop-loss, take-profit or trailing-stop" });
    // R14-P1-05/06: only arm an app-managed exit for brokers whose exit path returns VERIFIED fill truth.
    if (!FILL_VERIFIED_BROKERS.has(broker)) return res.status(400).json({ error: `App-managed SL/TP isn't supported for ${broker} yet (we can't confirm its exit fills). Supported: Delta, FYERS. Manage protection in your broker app.` });
    // R14-P1-04: percentage SL/TP is inert without a usable entry price — require one so protection is real.
    if (!(Number(entry) > 0)) return res.status(400).json({ error: "A valid average/entry price is required to arm SL/TP (percentage levels can't be computed from an unknown entry)." });
    const sess = await sessionFromCred(userId, broker);
    if (!sess) return res.status(400).json({ error: "no stored credentials for this broker — reconnect it first" });
    /* R12-P1-02 / R14-P1-02: for FYERS, app-managed exits are LONG-ONLY (the exit executor can only SELL,
       not buy-to-cover). Verify the broker's PRODUCT-AWARE sellable long (positions + settled CNC holdings):
       refuse a short/flat holding, require broker truth, and CLAMP the managed quantity to the real holding
       so we never try to sell more than the user actually owns. */
    let regQty = Number(qty);
    if (broker === "fyers") {
      const net = await fyersSellableLong(sess, brokerSym, product || "CNC");
      if (net == null) return res.status(502).json({ error: "Couldn't read your FYERS holding to arm protection safely — try again in a moment." });
      if (net <= 0) return res.status(409).json({ error: "App-managed SL/TP on FYERS supports LONG holdings only. This symbol shows no long position (it may be flat or short) — manage a short in your FYERS app." });
      regQty = Math.min(regQty, net);   // never manage/sell more than the verified long holding
    }
    // Avoid arming two engines on the same instrument.
    const existing = (await db.getManagedPositionsForUser(userId).catch(() => [])).find((p) => (p.status === "open" || p.status === "closing") && String(p.brokerSym) === String(brokerSym));
    if (existing) { await db.updateManagedPosition(existing.id, { sl: sl || null, tp: tp || null, tsl: tsl || null, qty: regQty }); return res.json({ ok: true, id: existing.id, updated: true, protectionActive: true }); }
    const pos = await registerManagedPosition({
      sess, symbol, brokerSym, qty: regQty, entry: Number(entry), market: market || "Crypto",
      sl: Number(sl) || null, tp: Number(tp) || null, tsl: Number(tsl) || null, product: product || "CNC",
    });
    res.json({ ok: true, id: pos.id, protectionActive: true });
  } catch (e) { serverError(res, e); }
});
app.get("/api/autoexit/status", (_, res) => res.json({ enabled: process.env.EXIT_MONITOR !== "off", live: String(process.env.AUTO_EXIT_LIVE || "").toLowerCase() === "true", last: lastAutoExit }));

/* ═══════════════════════ REAL-MONEY AUTO-BUY (opt-in per strategy) ═══════════════════════
   The biggest safety jump in the app: the server places a real ENTRY when a strategy's entry
   rule fires, unattended. Guardrails:
     • OPT-IN per strategy (the user arms it with a broker + rupee/dollar amount).
     • KILL SWITCH: does nothing real unless AUTO_BUY_LIVE=true (else dry-run + log).
     • CAPS: AUTO_BUY_MAX_POSITIONS (default 5) open real positions per user, and an optional
       AUTO_BUY_MAX_NOTIONAL ceiling per order on top of the user's own amount.
     • ONE position per strategy at a time — no pyramiding, no re-entry until the exit closes.
     • COOLDOWN so a still-true signal can't fire twice inside one candle.
   Exits are handed to the auto-exit engine (SL/TP/trailing + the strategy's own exit signal). */

/* R8-audit: brokers whose ENTRY path verifies the actual fill before we register a managed position.
   Others return on mere order ACCEPTANCE, which would create a phantom position — so LIVE auto-buy is
   fail-closed to this set. Keep in sync with placeBuyOrder's per-broker fill verification. */
const FILL_VERIFIED_BROKERS = new Set(["delta", "fyers"]);
const AB_MAX_POSITIONS = Number(process.env.AUTO_BUY_MAX_POSITIONS) || 100000;   // effectively no cap (user asked to remove real limits)
const AB_MAX_NOTIONAL = Number(process.env.AUTO_BUY_MAX_NOTIONAL) || 0;   // 0 = only the user's amount
const AB_RECONCILE_MS = Number(process.env.AUTO_BUY_RECONCILE_MS) || 5 * 60 * 1000;   // in-flight window: never re-submit while a pending order is unresolved

/* A real order to OPEN a position. `short` opens a SELL (Delta perpetual only) instead of a buy;
   spot brokers can't short, so they always buy. Same per-broker plumbing as the manual order route. */
async function placeBuyOrder(sess, symbol, qty, market, product, slPct = null, tpPct = null, short = false, clientOrderId = null) {
  const broker = sess.broker, token = sess.accessToken;
  const prod = mapProduct(broker, product);
  // R8-audit F-1 (defense in depth): only Delta's entry path handles a short (opens a SELL). Every other
  // branch hardcodes a BUY, so a short here would open the OPPOSITE direction — refuse instead.
  if (short && broker !== "delta") throw new Error(`invalid: short (SELL) entry not supported on ${broker} — would open a long`);
  if (broker === "delta") {
    const prods = await deltaCall("GET", "/v2/products", { signed: false });
    const dprod = (prods.result || []).find((p) => p.symbol === symbol);
    if (!dprod) throw new Error(`Delta does not list ${symbol}`);
    // Delta trades in whole CONTRACTS. Convert our coin-unit qty to an integer contract count
    // (fractional sizes are invalid and get rejected). If the amount can't buy one contract, say
    // so with the real minimum instead of letting the broker bounce it.
    const { cv, contracts } = deltaContracts(dprod, qty);
    if (contracts < 1) throw new Error(`Amount too small for ${symbol} on Delta — one contract is ≈ ${cv} unit(s). Increase your amount.`);
    assertDeltaTradable(sess.userId);   // sign with the user's own keys; refuse if they have none
    const entrySide = short ? "sell" : "buy";
    // R3-#1: stamp our own client_order_id so a timed-out order can be found in Delta's order book
    // later (the durable dedupe key). Delta echoes it back on both live and historical orders.
    const orderBody = { product_id: dprod.id, size: contracts, side: entrySide, order_type: "market_order" };
    if (clientOrderId) orderBody.client_order_id = String(clientOrderId).slice(0, 64);
    const d = await deltaCall("POST", "/v2/orders", { userId: sess.userId, body: orderBody });
    // HTTP 200 is NOT a fill — verify, and throw the real reason on a reject/no-fill.
    const o = d.result || {};
    const sizeC = Number(o.size) || contracts;                                   // contracts
    const unfilledC = o.unfilled_size != null ? Number(o.unfilled_size) : (o.state === "closed" ? 0 : sizeC);
    const filledC = Math.max(0, sizeC - unfilledC);
    if (o.state === "cancelled" || o.state === "rejected" || filledC <= 0) {
      throw new Error(o.cancellation_reason || o.meta_data?.reason || `Order not filled (state: ${o.state || "unknown"}) — likely insufficient balance/margin`);
    }
    /* Attach the SAME native Delta bracket the manual/Automate order does, so an AUTO-BUY position
       gets exchange-side SL/TP that fire on Delta itself — not just the server-side exit monitor.
       Best-effort: the entry has already filled, so a bracket hiccup must not throw. */
    let bracket = null;
    if (Number(slPct) > 0 || Number(tpPct) > 0) {
      const entryRef = o.average_fill_price != null ? Number(o.average_fill_price) : (await liveMarkForOrder(symbol, "Crypto"));
      try { bracket = await placeDeltaBracket(dprod, entrySide, entryRef, slPct, tpPct, sess.userId); }
      catch (e) { bracket = { placed: false, message: String(e.message || e) }; }
    }
    // Return COIN units (contracts × contract_value) so the stored position + P&L stay correct.
    return { orderId: o.id ?? null, filledQty: filledC * cv, avgPrice: o.average_fill_price != null ? Number(o.average_fill_price) : null, state: o.state, partial: filledC < sizeC, bracket };
  }
  if (broker === "coindcx") {
    const { apiKey, apiSecret } = sess.extra || {};
    const base = String(symbol).replace(/(INR|USDT)$/i, "").toUpperCase();
    const { r, d } = await coindcxCall(apiKey, apiSecret, "/exchange/v1/orders/create", { side: "buy", order_type: "market_order", market: `${base}INR`, total_quantity: Number(qty) });
    if (!r.ok || d.message || d.code) throw new Error(d.message || `CoinDCX buy failed (${r.status})`);
    const o = (d.orders && d.orders[0]) || d; return { orderId: o.id || o.order_id || null };
  }
  if (broker === "zerodha") {
    const [exchange, tradingsymbol] = String(symbol).split(":");
    const body = new URLSearchParams({ exchange, tradingsymbol, transaction_type: "BUY", quantity: String(qty), order_type: "MARKET", product: prod, validity: "DAY" });
    const r = await fetch("https://api.kite.trade/orders/regular", { method: "POST", headers: { ...brokerAuth(broker, token, sess.userId), "Content-Type": "application/x-www-form-urlencoded" }, body });
    const d = await r.json(); if (!r.ok || d.status === "error") throw new Error(d.message || `kite buy ${r.status}`);
    return { orderId: d.data.order_id };
  }
  if (broker === "fyers") {
    // R8-P2-01: stamp our durable orderTag so a timed-out entry can be found in FYERS' order book later
    // (the FYERS analogue of Delta's client_order_id — the dedupe/reconciliation key).
    const orderTag = clientOrderId ? reconcile.fyersOrderTag(clientOrderId) : null;
    const r = await fyFetch("https://api-t1.fyers.in/api/v3/orders/sync", {
      method: "POST", headers: { ...brokerAuth(broker, token, sess.userId), "Content-Type": "application/json" },
      body: JSON.stringify({ symbol, qty: Number(qty), type: 2, side: 1, productType: prod, limitPrice: 0, stopPrice: 0, validity: "DAY", disclosedQty: 0, offlineOrder: false, ...(orderTag ? { orderTag } : {}) }),
    });
    const d = await r.json(); if (!r.ok || d.s === "error") throw new Error(d.message || `fyers buy ${r.status}`);
    // Acceptance ≠ execution. Confirm the fill before we register a managed position at the entry — a
    // rejected order throws the real reason; an order accepted but not confirmed filled throws an
    // "unconfirmed" error so the pending marker survives and reconciliation/review handles it (rather
    // than opening a phantom position on a fill that never happened).
    const c = await verifyFyersFill(sess, d.id, Number(qty));
    if (c.rejected) throw new Error(c.reason || `FYERS rejected the order (status ${c.status})`);
    if (!c.filled) throw new Error(`FYERS order ${d.id} accepted but not confirmed filled (status ${c.status ?? "pending"}) — awaiting fill`);
    return { orderId: d.id, filledQty: c.filledQty || Number(qty), avgPrice: c.avgPrice, state: "filled", partial: Number(qty) > 0 && c.filledQty > 0 && c.filledQty < Number(qty) };
  }
  throw new Error(`auto-buy not supported for ${broker}`);
}

/* Market hours (evaluated in IST). The auto-buy engine must never place an order into a CLOSED
   market — an Indian order at 8pm or on a weekend would queue/reject and is simply wrong.
   IN/FNO 9:15–15:30 · Commodity 9:00–23:30 · US 7:00pm–1:30am IST, all Mon–Fri · Crypto 24/7. */
let autoBuyRunning = false;
let lastAutoBuy = { at: null, checked: 0, bought: 0, live: false };
/* LIVE flag: the env var (case-insensitive — "TRUE"/"true"/"1" all count) OR a runtime admin
   override toggled from the app. Override wins when set so the admin can flip it without a
   redeploy; unset falls back to the env default. */
let autoBuyLiveOverride = null;
const autoBuyLiveOn = () => autoBuyLiveOverride != null ? autoBuyLiveOverride : /^(true|1|yes)$/i.test(String(process.env.AUTO_BUY_LIVE || ""));

/* KILL SWITCH — per-user pause of NEW real entries. In-memory Set for zero-cost engine reads, seeded
   from the DB at boot so a halt SURVIVES a restart (a kill switch that forgets on restart is worse
   than useless). Exits are a separate engine, so a halted account still gets protected. */
const haltedEntries = new Set();
(async () => { try { (await db.getHaltedEntryUsers()).forEach((u) => haltedEntries.add(String(u))); if (haltedEntries.size) console.log(`[killswitch] ${haltedEntries.size} account(s) have new entries paused`); } catch (e) { console.error("[killswitch] load failed:", e.message); } })();
app.get("/api/automation/entry-halt", requireAuth, (req, res) => {
  res.json({ halted: haltedEntries.has(String(storageKeyFor(req.authUserId))) });
});
app.post("/api/automation/entry-halt", requireAuth, requireActiveUser, async (req, res) => {
  const uid = String(storageKeyFor(req.authUserId));
  const halt = !!(req.body && req.body.halt);
  if (halt) haltedEntries.add(uid); else haltedEntries.delete(uid);
  try { await db.setEntryHalt(uid, halt); } catch (e) { return res.status(500).json({ error: "Could not save — try again." }); }
  // R21-P1-03: resuming means the user reconciled — also clear the durable risk-ledger lock so manual orders flow again.
  if (!halt && typeof db.setRiskLock === "function") { try { await db.setRiskLock(uid, false); } catch { /* best-effort */ } }
  logFinancial(halt ? "killswitch.halt" : "killswitch.resume", { userId: uid });
  res.json({ ok: true, halted: halt });
});

/* R3-#1 DURABLE RECONCILIATION. When an order times out we can't tell if the broker accepted it.
   Before we ever clear the pending marker (which would let the signal re-enter and DUPLICATE the
   trade), ask the broker's own order book whether our stamped client_order_id is there.
     true  = the order reached the broker (found in live or historical orders) → do NOT re-enter.
     false = the broker has NO record of it → nothing executed, safe to reset and evaluate afresh.
     null  = we couldn't check (broker we don't query yet, or the query itself failed) → treat as
             unresolved and block, never re-enter.
   Only Delta (the supported real-crypto broker) is queryable today; other brokers return null and
   are handled conservatively (paused for manual review) by the caller. */
/* R4-P1-02: absence must be CONCLUSIVE before we ever return `false` (which lets the strategy re-enter).
   A truncated page (result length == page_size ⇒ there may be more we didn't see), a non-array result,
   or a transport error are all INCONCLUSIVE → return null so the caller keeps the strategy blocked. Only
   a schema-valid, COMPLETE (short) page in BOTH the live and history sets, with our id absent, is a
   definitive "no order". We use a large page and match by our own client_order_id (the durable key). */
const DELTA_PROBE_PAGE = 500;
/* Brokers where we can establish EXECUTION TRUTH from the broker's own API — probe an order by our durable
   tag, read the actual open position to adopt, and confirm the account is flat. Only these may resume an
   unknown-order review by adopting/clearing; others must STOP the strategy (no duplicate possible). */
const RECONCILABLE_BROKERS = new Set(["delta", "fyers"]);
async function brokerOrderProbe(st) {
  if (st.broker === "fyers") return fyersOrderProbe(st);
  if (st.broker !== "delta" || !st.pendingClientId) return null;
  const cid = String(st.pendingClientId);
  // R6-P2-02: our order was placed at `pendingSince`, and Delta returns newest-first, so even a FULL page is
  // conclusive once it contains a record older than that boundary. Conclusiveness + id-match are PURE and
  // unit-tested in reconcile.js. Timestamps we can't parse only keep the result inconclusive, never clear it.
  const boundary = Number(st.pendingSince) || 0;
  const scan = async (path) => {
    const resp = await deltaCall("GET", path, { query: `?page_size=${DELTA_PROBE_PAGE}`, userId: st.userId });
    const records = resp && resp.result;
    return { found: reconcile.hasClientOrderId(records, cid), conclusive: reconcile.pageConclusive(records, DELTA_PROBE_PAGE, boundary) };
  };
  try {
    const live = await scan("/v2/orders");
    if (live.found) return true;
    const hist = await scan("/v2/orders/history");
    if (hist.found) return true;
    // Neither set carries our id. Only trust that as "never landed" if BOTH sets were complete.
    return (live.conclusive && hist.conclusive) ? false : null;
  } catch { return null; }   // any failure → unknown; caller must NOT re-enter on an unknown
}

/* R8-P2-01: FYERS analogue of the Delta probe. We stamped our orderTag on the entry (placeBuyOrder), so
   we can ask FYERS' own order book whether that tag is present. FYERS returns the full CURRENT-DAY order
   book in one call (no pagination), and auto-buy reconciles within minutes of placing, so a schema-valid
   book WITHOUT our tag is a conclusive "never landed" (false); the tag present → true; any transport/schema
   failure → null (unknown → caller keeps the strategy blocked, never re-enters). */
async function fyersOrderProbe(st) {
  if (!st.pendingClientId) return null;
  const tag = reconcile.fyersOrderTag(st.pendingClientId);
  if (!tag) return null;
  try {
    const sess = await sessionFromCred(st.userId, "fyers");
    if (!sess) return null;
    const r = await fyFetch("https://api-t1.fyers.in/api/v3/orders", { headers: brokerAuth("fyers", sess.accessToken, st.userId) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.s === "error") return null;
    const book = Array.isArray(d.orderBook) ? d.orderBook : null;
    if (!book) return null;                                  // bad schema → unknown
    if (reconcile.hasFyersOrderTag(book, tag)) return true;  // the order reached FYERS → do NOT re-enter
    return false;                                            // complete same-day book, tag absent → never landed
  } catch { return null; }
}

async function runAutoBuyEngine() {
  if (autoBuyRunning) return;
  autoBuyRunning = true;
  const live = autoBuyLiveOn();
  let checked = 0, bought = 0;
  /* One DB read of a user's managed positions per SWEEP, not per strategy. The loop previously called
     db.getManagedPositionsForUser up to 3× for every strategy — the single biggest source of repeated
     Neon egress. We fetch once, cache for the tick, and invalidate only after we open a new position. */
  const posCache = new Map();
  const positionsFor = async (uid) => {
    if (!posCache.has(uid)) posCache.set(uid, await db.getManagedPositionsForUser(uid).catch(() => []));
    return posCache.get(uid);
  };
  try {
    const strategies = await db.getActiveRealStrategies(500);
    for (const st of strategies) {
      checked++;
      try {
        if (!marketOpenIST(st.market)) continue;   // market closed — do not enter
        // R4/R5-P2-02 FAIL CLOSED: if we don't have the exchange holiday calendar for this market's
        // current year, we can't know weekday holidays — so a LIVE entry must NOT be placed (it could
        // land on a closed exchange day). Skip with a clear flag until the calendar is loaded.
        if (live && !holidayCalendarReady(st.market)) {
          await db.updateRealStrategy(st.id, { lastError: `Holiday calendar for ${st.market} isn't loaded for this year — new real entries are paused (fail-closed) until it's updated.` });
          continue;
        }
        // One position per strategy: if it still holds an open managed position, do nothing.
        if (st.openPositionId) {
          const pos = (await positionsFor(st.userId)).find((p) => p.id === st.openPositionId);
          if (pos && (pos.status === "open" || pos.status === "closing")) continue;
          await db.updateRealStrategy(st.id, { openPositionId: null });   // position closed -> may re-enter
          st.openPositionId = null;
        }
        /* IDEMPOTENCY (audit P1-01). We stamp `pendingSince` BEFORE sending an order; if we
           crash after the broker fills but before we persist the position link, a naive retry
           would BUY AGAIN. So when a pending marker exists we reconcile instead of re-ordering:
           adopt any open position that already matches this instrument; otherwise, within a
           reconcile window, skip (the order is in-flight or just filled) rather than double-buy;
           only after the window with no trace do we clear it and flag for manual verification. */
        if (st.pendingSince) {
          const openMatch = (await positionsFor(st.userId)).find((p) => (p.status === "open" || p.status === "closing") && String(p.brokerSym) === String(st.brokerSym) && Number(p.entry) > 0);
          if (openMatch) { await db.updateRealStrategy(st.id, { openPositionId: openMatch.id, pendingSince: null, pendingClientId: null }); st.openPositionId = openMatch.id; st.pendingSince = null; continue; }
          if (Date.now() - st.pendingSince < AB_RECONCILE_MS) continue;   // in-flight — never double-submit
          /* R3-#1: window elapsed and NO managed position appeared. Never blindly clear-and-re-enter
             (a timed-out-but-accepted order would become a duplicate). Consult the broker's order book. */
          const probe = await brokerOrderProbe(st);
          if (probe === false) {
            // Verified absent at the broker — nothing executed. Reset and let it evaluate a fresh signal.
            await db.updateRealStrategy(st.id, { pendingSince: null, pendingClientId: null, lastOrderStatus: "no-order", lastError: "Previous order never reached the broker (verified absent) — cleared." });
            st.pendingSince = null; st.pendingClientId = null;
          } else {
            // Order EXISTS at the broker (probe===true) or we couldn't verify (null) → BLOCK resubmission.
            // Pause for manual review and KEEP the marker. The exit engine is separate, so any real
            // position stays managed; Resume (one tap) clears the marker once the user has checked.
            await db.updateRealStrategy(st.id, { status: "paused", needsReview: true, lastOrderStatus: "unknown", lastError: probe === true
              ? "An order for this strategy reached your broker but MatrixOne couldn't link the position. Paused to avoid a duplicate — check the position on your broker, then Resume."
              : "Previous order outcome couldn't be verified with your broker. Paused to avoid a duplicate — verify on your broker, then Resume." });
            logFinancial("autobuy.review", { userId: st.userId, broker: st.broker, symbol: st.symbol, probe: String(probe) });
            continue;
          }
        }
        // KILL SWITCH: the user paused NEW real entries. Reconciliation above still ran, and the exit
        // engine is SEPARATE — so open positions keep their stop-loss/target managed; we only skip
        // placing any new entry. Resume is instant (one tap), no re-connect / re-login.
        if (haltedEntries.has(String(st.userId))) continue;
        /* R8-audit F-1 (wrong-way trade): a SHORT entry is only correctly implemented for Delta — every
           other broker's entry path hardcodes a BUY, so a short-armed strategy would silently open a LONG.
           Refuse rather than trade the opposite direction. */
        if (st.short && st.broker !== "delta") { await db.updateRealStrategy(st.id, { lastError: "Short (SELL) auto-buy is only supported on Delta right now — re-arm this strategy as BUY, or use Delta for shorts.", lastOrderStatus: "blocked" }); continue; }
        /* R8-audit F-3 (phantom position): only brokers whose entry path VERIFIES the fill may place a LIVE
           entry. Others return on mere acceptance, which would register a position for an order that may
           never fill. Fail closed. (Dry-run still simulates below.) */
        if (live && !FILL_VERIFIED_BROKERS.has(st.broker)) { await db.updateRealStrategy(st.id, { lastError: `Live auto-buy isn't enabled for ${st.broker} yet — we can't confirm its fills, which risks a phantom position. Supported: Delta, FYERS.`, lastOrderStatus: "blocked" }); continue; }
        // Cooldown: don't re-fire a still-true signal inside the same candle.
        const intervalMs = (st.interval === "1d" ? 86400 : (Number((st.interval || "5m").replace(/[^\d]/g, "")) || 5) * 60) * 1000;
        if (st.lastOrderAt && Date.now() - st.lastOrderAt < intervalMs) continue;

        const range = st.interval === "1d" ? "6mo" : "1mo";
        const candles = await candlesFor(st.yahoo || st.symbol, range, st.interval || "5m");
        if (!candles || candles.length < 30) continue;

        const sig = strat.entrySignalFired(st.cfg, candles);
        if (!sig.fired) continue;

        // Cap: total open real positions for this user.
        const openCount = (await positionsFor(st.userId)).filter((p) => p.status === "open" || p.status === "closing").length;
        if (openCount >= AB_MAX_POSITIONS) { await db.updateRealStrategy(st.id, { lastError: `open-position cap (${AB_MAX_POSITIONS}) reached` }); continue; }

        const px = sig.price || await liveMarkForOrder(st.brokerSym, st.market) || null;
        if (!(px > 0)) { await db.updateRealStrategy(st.id, { lastError: "no live price" }); continue; }
        let notional = Number(st.notional) || 0;
        if (AB_MAX_NOTIONAL > 0) notional = Math.min(notional, AB_MAX_NOTIONAL);
        const qty = st.market === "Crypto" ? +(notional / px).toFixed(6) : Math.max(1, Math.floor(notional / px));
        if (!(qty > 0)) { await db.updateRealStrategy(st.id, { lastError: "amount too small for one unit" }); continue; }

        if (!live) {
          console.log(`[autobuy] DRY-RUN (AUTO_BUY_LIVE!=true): would BUY ${qty} ${st.symbol} for ${st.userId} — ${sig.reason}`);
          await db.updateRealStrategy(st.id, { lastError: null, lastSignalAt: Date.now() });
          continue;
        }
        const sess = await sessionFromCred(st.userId, st.broker);
        if (!sess) { await db.updateRealStrategy(st.id, { lastError: "no stored credentials — reconnect broker" }); continue; }

        /* R19-P1-03: authorization for a new real entry FAILS CLOSED. Require a present owner who is
           approved === true, not blocked, not deleted. A DB-read failure or a missing/unapproved row must
           SKIP the entry (never place blind during the exact incident when we can't verify identity).
           Protective EXIT engines are separate and keep running, so existing positions stay managed. */
        let owner, ownerLookupFailed = false;
        try { owner = await db.getUser(stripPh(String(st.userId))); }
        catch { ownerLookupFailed = true; }
        if (ownerLookupFailed) {
          await db.updateRealStrategy(st.id, { lastError: "Couldn't verify the account to authorize this automated entry — skipped this cycle.", lastOrderStatus: "blocked" });
          continue;   // transient — do NOT pause (retry next sweep), but never trade unverified
        }
        if (!owner || owner.blocked || owner.deleted || owner.approved !== true) {
          await db.updateRealStrategy(st.id, { status: "paused", lastError: "New entries paused — account is not active (blocked, closed, or not approved).", lastOrderStatus: "blocked" });
          continue;
        }

        /* R17-P1-01: the SAME shared risk engine that guards manual orders must guard unattended auto-buy —
           ALWAYS, not only when the user saved a custom policy. Fetch broker account truth and run
           serverValidateOrder every cycle. If the user saved caps we pass them (tightening the DEFAULT_LIMITS
           floor); if not, we pass no `limits` so the engine applies its built-in DEFAULT_LIMITS (25% daily-loss
           breaker, open-position/trade caps, per-symbol cooldown, funds/margin). Fail CLOSED if the account
           can't be verified — never trade blind with real money. */
        const abMarketKind = st.market === "Crypto" ? "Crypto" : (st.market === "US" ? "US" : "IN");
        const abStoreKey = storageKeyFor(st.userId);   // same key manual orders + /api/risk-policy use
        const abPolicy = cleanRiskPolicy(await db.getRiskPolicy(abStoreKey).catch(() => null));
        {
          const abAccount = await fetchBrokerAccount(sess).catch(() => null);
          if (!abAccount) { await db.updateRealStrategy(st.id, { lastError: "Couldn't verify account with broker to risk-check this automated entry — skipped this cycle.", lastOrderStatus: "blocked" }); continue; }
          const abTrades = await db.getTrades(abStoreKey, 0, Date.now()).catch(() => []);
          const abCheck = serverValidateOrder(
            { sym: String(st.brokerSym).replace(/^NSE:/, "").replace(/-EQ$/, ""), side: st.short ? "SELL" : "BUY", qty, price: px, market: abMarketKind },
            { wallet: abAccount.wallet, portfolio: abAccount.portfolio, trades: riskEligibleTrades(abTrades), ...(Object.keys(abPolicy).length ? { limits: abPolicy } : {}) },
          );
          if (!abCheck.ok) {
            await db.updateRealStrategy(st.id, { lastError: "Blocked by risk checks: " + (abCheck.reasons[0] || "not allowed"), lastOrderStatus: "risk-blocked" });
            logFinancial("autobuy.risk_blocked", { userId: st.userId, broker: st.broker, symbol: st.symbol, reasons: abCheck.reasons, usedDefaults: !Object.keys(abPolicy).length });
            continue;
          }
        }

        /* STAMP THE INTENT before we touch the broker (R16-P1-01). The claim is candle-idempotent and
           version-guarded: it succeeds only if the strategy is still active, holds no open position, has no
           in-flight pending marker AND has not already fired on this exact closed candle. Across replicas a
           UNIQUE (strategy, candle) row guarantees at-most-once even if a fast winner clears pendingSince
           before a delayed replica arrives, and it blocks an order after the user pauses/cancels. The broker
           client_order_id derives from the same candle key so a timed-out order is found by it. */
        const candleKey = String(sig.candleTime ?? (candles[candles.length - 1] && candles[candles.length - 1].t) ?? Date.now());
        const pendingClientId = `mx_${st.id}_${candleKey}`;
        const claimed = await db.claimRealStrategyForEntry(st.id, candleKey, { pendingSince: Date.now(), pendingClientId, lastOrderAt: Date.now(), userId: st.userId });
        if (!claimed) continue;
        st.pendingSince = claimed.pendingSince; st.pendingClientId = pendingClientId; st.lastOrderAt = claimed.lastOrderAt;

        /* R16-P2-01 last-mile guard: close the tiny window between claiming and sending the order. If the
           user paused/cancelled (or the kill-switch fired) in that gap, abort and release the pending marker
           BEFORE we touch the broker — no post-pause order. The candle intent stays consumed so we won't
           re-fire this bar on resume. */
        const fresh = (await db.getRealStrategiesForUser(String(st.userId)).catch(() => [])).find((x) => x && x.id === st.id);
        if ((fresh && fresh.status !== "active") || haltedEntries.has(String(st.userId))) {
          await db.updateRealStrategy(st.id, { pendingSince: null, pendingClientId: null, lastOrderStatus: "skipped", lastError: "Paused/cancelled before the order was sent — no entry placed." });
          continue;
        }

        // placeBuyOrder THROWS on a rejected/unfilled order (caught below → recorded as a reject
        // with reason, no position). Register the managed position at the ACTUAL fill quantity and
        // price, so P&L reflects what really executed, not what we requested.
        const r = await placeBuyOrder(sess, st.brokerSym, qty, st.market, st.product, st.sl || null, st.tp || null, !!st.short, pendingClientId);
        const fillQty = Number(r.filledQty) > 0 ? Number(r.filledQty) : qty;
        const fillPx = Number(r.avgPrice) > 0 ? Number(r.avgPrice) : px;
        const pos = await registerManagedPosition({
          sess, symbol: st.symbol, brokerSym: st.brokerSym, qty: fillQty, entry: fillPx, market: st.market,
          sl: st.sl || null, tp: st.tp || null, tsl: st.tsl || null, cfg: st.cfg, yahoo: st.yahoo, interval: st.interval, product: st.product, short: !!st.short,
        });
        await db.updateRealStrategy(st.id, { openPositionId: pos.id, lastOrderAt: Date.now(), lastError: r.partial ? `Partial fill: ${fillQty}/${qty} filled` : null, lastOrderStatus: r.partial ? "partial" : "filled", pendingSince: null, pendingClientId: null });
        /* R19-P1-04: write an AUTHORITATIVE server-owned trade row on a real fill, keyed the same way the risk
           engine reads (storageKeyFor), so the daily trade-count / daily-loss / cooldown controls count this
           automated entry even though no browser was open to post a journal row. This is the safety source of
           record; the client journal is a display projection. */
        /* Persist with retry; on total failure this HALTS this user's further auto-entries (via
           haltUserIdOnFail) so the engine never keeps trading against a book it can't record. Fall back to a
           deterministic ab_ id only when the fill has no broker orderId (saveTrade canonicalizes by orderId
           otherwise, collapsing any duplicate client post). */
        const journaled = await recordAuthoritativeFill(storageKeyFor(st.userId), {
          id: `ab_${st.id}_${candleKey}`, sym: st.symbol, side: st.short ? "SELL" : "BUY", qty: fillQty,
          entry: fillPx, entryAt: Date.now(), market: st.market, real: true, broker: st.broker,
          tradeType: "Auto Buy", orderId: r.orderId || null, managedId: pos.id, serverAuthored: true,
        }, { haltUserIdOnFail: st.userId });
        if (!journaled) {
          /* R21-P1-03: the fill could NOT be journaled. The durable halt+risk-lock are already set, but the
             CURRENTLY RUNNING engine also reads the in-memory kill-switch set — engage it NOW so no further
             strategy for this user places an entry in this same sweep against an incomplete risk book. */
          haltedEntries.add(String(st.userId));
          logFinancial("autobuy.halted_unjournaled_fill", { userId: st.userId, symbol: st.symbol, orderId: r.orderId });
        }
        posCache.delete(st.userId);   // this user's positions changed — re-read next time it's needed
        bought++;
        logFinancial(r.partial ? "autobuy.partial" : "autobuy.filled", { userId: st.userId, broker: st.broker, symbol: st.symbol, side: st.short ? "SELL" : "BUY", qty: fillQty, reqQty: qty, price: fillPx, orderId: r.orderId, reason: sig.reason });
        console.log(`[autobuy] ${r.partial ? "PARTIAL" : "FILLED"} ${fillQty}/${qty} ${st.symbol} for ${st.userId} via ${st.broker} — ${sig.reason} (order ${r.orderId})`);
      } catch (e) {
        const msg = String((e && (e.message || e)) || "error");
        /* P2-03 / R2: distinguish a CONFIRMED rejection from an AMBIGUOUS failure. A rejection (the
           broker said no — insufficient margin, invalid, too small…) means nothing executed, so it's
           safe to clear the pending marker and let it re-enter. A timeout / network error is NOT proof
           of rejection — the order may have been ACCEPTED — so we KEEP the pending marker and record
           the outcome as "unknown". The reconciliation at the top of the loop then matches it to a real
           position, or, after AB_RECONCILE_MS, clears it with a "verify with your broker" warning. It
           never auto-resubmits an unknown order. */
        const confirmedReject = /reject|insufficient|not filled|unfilled|cancell?ed|invalid|margin|too small|min(?:imum)? size|not enough|balance|bad request|400/i.test(msg);
        if (confirmedReject) {
          await db.updateRealStrategy(st.id, { lastError: msg, lastOrderStatus: "rejected", lastRejectAt: Date.now(), pendingSince: null, pendingClientId: null });
          logFinancial("autobuy.rejected", { userId: st.userId, broker: st.broker, symbol: st.symbol, reason: msg });
          console.error(`[autobuy] REJECTED ${st.symbol} (${st.broker}):`, msg);
        } else {
          await db.updateRealStrategy(st.id, { lastError: "order outcome unknown (no broker confirmation) — reconciling, not resubmitting: " + msg, lastOrderStatus: "unknown" });
          logFinancial("autobuy.unknown", { userId: st.userId, broker: st.broker, symbol: st.symbol, reason: msg });
          console.error(`[autobuy] UNKNOWN outcome ${st.symbol} (${st.broker}) — keeping pending marker for reconciliation:`, msg);
        }
      }
    }
  } catch (e) { console.error("[autobuy] sweep failed:", e.message); }
  finally { autoBuyRunning = false; lastAutoBuy = { at: Date.now(), checked, bought, live }; }
}
/* Auto-BUY entry engine. 120s default (was 60s) halves its Neon reads; a 2-minute entry check is fine
   for the 5m+ strategies it runs, and it early-outs (one small query) when no strategy is armed. */
const AUTO_BUY_MS = Math.max(30_000, Number(process.env.AUTO_BUY_MS) || 120_000);
if (process.env.EXIT_MONITOR !== "off") {
  setInterval(runAutoBuyEngine, AUTO_BUY_MS);
  setTimeout(runAutoBuyEngine, 20_000);
}

/* R16-P2-10 / R17-P1-03 delayed-fill protection watcher. Rows are ATOMICALLY LEASED (claimPendingProtection),
   so exactly one replica processes each — no duplicate managed exits. On a confirmed fill it arms app-managed
   SL/TP, idempotent by (broker,user,entryOrderId), to the ACTUAL filled quantity. R17-P2-01: a fill without a
   usable average price is NOT armed (SL/TP maths would be meaningless) — the job is kept for a later sweep and
   the user is warned. Gives up only on a broker rejection or a real DAY-order horizon. */
async function runProtectionWatcher() {
  let rows = [];
  try { rows = await db.claimPendingProtection(Math.max(90_000, Number(process.env.PROTECTION_LEASE_MS) || 120_000), 200); } catch { return; }
  for (const p of rows) {
    try {
      const ageMs = Date.now() - (p.created_at || 0);
      if ((p.attempts || 0) > 600 || ageMs > 8 * 3600 * 1000) {
        await db.deletePendingProtection(p.id);
        logFinancial("protection.expired", { userId: p.userId, broker: p.broker, orderId: p.orderId });
        await addUserNotice(p.userId, { type: "protection_expired", broker: p.broker, symbol: p.symbol, msg: `Your ${p.symbol} limit order didn't confirm a fill in time — SL/TP was NOT attached. Check it on your broker.` });
        continue;
      }
      if (p.broker !== "fyers") { await db.deletePendingProtection(p.id); continue; }   // only FYERS parks here today
      const sess = await sessionFromCred(p.userId, "fyers");
      if (!sess) continue;   // creds unavailable this cycle — lease will lapse, retried later
      const c = await verifyFyersFill(sess, p.orderId, Number(p.qty));
      if (c.filled) {
        const avg = Number(c.avgPrice);
        if (!(avg > 0)) {
          // R17-P2-01: filled but no usable average price — do NOT arm an inert exit. Keep for retry.
          logFinancial("protection.filled_no_price", { userId: p.userId, broker: "fyers", orderId: p.orderId });
          continue;
        }
        /* R21-P1-03: a DELAYED fill is still a real fill — write the authoritative journal event BEFORE we do
           anything else, so the risk ledger includes this entry (previously the watcher attached protection but
           never recorded the fill, under-counting daily trades/loss/cooldown). Dedupes by (user,broker,orderId). */
        await recordAuthoritativeFill(storageKeyFor(p.userId), {
          sym: p.symbol, side: p.short ? "SELL" : "BUY", qty: c.filledQty || Number(p.qty), entry: avg,
          entryAt: Date.now(), market: p.market, real: true, broker: "fyers",
          tradeType: String(p.tradeType || "Manual"), orderId: p.orderId, serverAuthored: true,
        });
        /* R22-C02: a `plain` row (a no-SL/TP order parked only to RECONCILE its fill) journals the fill above and
           then stops — there's no protection to attach, so we don't register a managed position. */
        if (!p.plain) {
          await registerManagedPosition({
            sess, symbol: p.symbol, brokerSym: p.brokerSym, qty: c.filledQty || Number(p.qty), entry: avg,
            market: p.market, sl: p.sl || null, tp: p.tp || null, tsl: p.tsl || null, cfg: p.cfg || null,
            yahoo: p.yahoo, interval: p.interval, product: p.product, short: !!p.short, entryOrderId: p.orderId,
          });
        }
        await db.deletePendingProtection(p.id);
        logFinancial(p.plain ? "delayed_fill.reconciled" : "protection.attached", { userId: p.userId, broker: "fyers", orderId: p.orderId, qty: c.filledQty || p.qty });
        if (!p.plain) await addUserNotice(p.userId, { type: "protection_attached", broker: "fyers", symbol: p.symbol, msg: `SL/TP is now protecting your ${p.symbol} position (filled at ${avg}).` });
        else await addUserNotice(p.userId, { type: "fill_reconciled", broker: "fyers", symbol: p.symbol, msg: `Your ${p.symbol} order filled at ${avg} and is now recorded.` });
      } else if (c.rejected) {
        await db.deletePendingProtection(p.id);
        await addUserNotice(p.userId, { type: "protection_rejected", broker: "fyers", symbol: p.symbol, msg: `Your ${p.symbol} limit order was rejected — no SL/TP attached.` });
      }
      // else still pending — the lease lapses and it's re-checked next sweep
    } catch (e) { console.error("[protection] sweep item failed:", e.message); }
  }
}
/* R21-P2-05: periodically reconcile stale idempotency records so a dead in-flight request can't block a key
   forever — mark long-in_flight rows 'unknown' (surfaces a reconcile prompt on retry) and purge very old rows. */
if (typeof db.reconcileStaleIdempotency === "function") {
  setInterval(() => { db.reconcileStaleIdempotency().then((r) => { if (r && (r.markedUnknown || r.purged)) logFinancial("idempotency.reconcile", r); }).catch(() => {}); }, 5 * 60 * 1000);
}
const PROTECTION_MS = Math.max(30_000, Number(process.env.PROTECTION_MS) || 60_000);
if (process.env.EXIT_MONITOR !== "off") {
  setInterval(runProtectionWatcher, PROTECTION_MS);
  setTimeout(runProtectionWatcher, 40_000);
}

/* Arm a strategy for real-money auto-buy. Requires a live broker session (so we can persist
   the creds the engine will act with). Supported brokers only. */
app.post("/api/autobuy/register", requireAuth, requireActiveUser, async (req, res) => {
  const sess = getBrokerSession(req);
  if (!sess) return res.status(401).json({ error: "connect the broker first" });
  const b = sess.broker;
  if (!["delta", "coindcx", "zerodha", "fyers"].includes(b)) return res.status(400).json({ error: `auto-buy isn't supported for ${b} yet` });
  const { name, symbol, brokerSym, market, cfg, notional, interval, sl, tp, tsl, yahoo, product, short } = req.body || {};
  if (!brokerSym || !cfg || !(Number(notional) > 0)) return res.status(400).json({ error: "brokerSym, cfg and a positive amount are required" });
  if (!Array.isArray(cfg.entry) || !cfg.entry.length) return res.status(400).json({ error: "strategy has no entry rule" });
  try {
    // IDEMPOTENT: a strategy is identified by (user + brokerSym + name). If it's already armed
    // (active or paused), don't create a duplicate — return the existing one. This stops a
    // double-tap on "Go Live" from arming the same strategy two or three times.
    const already = (await db.getRealStrategiesForUser(String(sess.userId)))
      .find((x) => x && x.status !== "cancelled" && String(x.brokerSym) === String(brokerSym) && (x.name || "") === (name || (symbol || String(brokerSym))));
    if (already) return res.status(200).json({ ok: true, id: already.id, live: autoBuyLiveOn(), already: true });
    await persistSessionCred(sess);
    const st = {
      id: crypto.randomBytes(16).toString("hex"),
      userId: String(sess.userId), broker: b, name: name || (symbol || String(brokerSym)),
      symbol: symbol || String(brokerSym), brokerSym, market: market || "Crypto",
      cfg, notional: Number(notional), interval: interval || "5m",
      product: product || "CNC",              // "Intraday" (MIS/INTRADAY) or "Delivery/NRML" (CNC)
      short: !!short,                         // SHORT strategy → open a SELL, mirror the exit
      sl: sl || null, tp: tp || null, tsl: tsl || null,
      yahoo: yahoo || (market === "Crypto" ? `${String(brokerSym).replace(/(USDT|USD|INR)$/i, "")}-USD` : `${String(symbol).replace(/^[A-Z]+:/, "").replace(/-EQ$/i, "")}.NS`),
      status: "active", createdAt: Date.now(), openPositionId: null,
    };
    await db.saveRealStrategy(st);
    res.json({ ok: true, id: st.id, live: autoBuyLiveOn() });
  } catch (e) { serverError(res, e); }
});
app.post("/api/autobuy/pause", requireAuth, requireActiveUser, async (req, res) => {
  const userId = routeUserId(req);
  const { id, paused, resolution } = req.body || {};   // resolution: "filled" (adopt) | "nofill" (clear)
  if (!userId || !id) return res.status(400).json({ error: "userId and id required" });
  const mine = (await db.getRealStrategiesForUser(userId)).find((s) => s.id === id);
  if (!mine) return res.status(404).json({ error: "not found" });

  // Pausing is always safe.
  if (paused) { await db.updateRealStrategy(id, { status: "paused" }); return res.json({ ok: true, status: "paused" }); }

  // RESUMING a strategy that is NOT under unknown-order review → just activate.
  if (!mine.needsReview && !mine.pendingSince) { await db.updateRealStrategy(id, { status: "active" }); return res.json({ ok: true, status: "active" }); }

  /* RESUMING A STRATEGY UNDER REVIEW (unknown order). Clearing the marker blindly is the duplicate hole:
     if the original order actually FILLED, a cleared marker lets the strategy open a SECOND position. So
     re-verify the outcome before we ever clear it — never on faith. */
  // 1) A matching OPEN position already exists → link it and activate. The strategy now holds that
  //    position and will not re-enter until it closes. Safe.
  const managed = await db.getManagedPositionsForUser(userId).catch(() => []);
  const openMatch = managed.find((p) => (p.status === "open" || p.status === "closing") && String(p.brokerSym) === String(mine.brokerSym) && Number(p.entry) > 0);
  if (openMatch) {
    await db.updateRealStrategy(id, { status: "active", openPositionId: openMatch.id, pendingSince: null, pendingClientId: null, needsReview: false, lastError: null });
    logFinancial("autobuy.review.linked", { userId, id, positionId: openMatch.id });
    return res.json({ ok: true, status: "active", linked: openMatch.id, note: "Linked to your open position — the exit engine manages it and no duplicate entry will be placed." });
  }
  // 2) Ask the broker's own order book about the original client_order_id.
  const probe = await brokerOrderProbe(mine);
  if (probe === false) {
    // Broker confirms the order never landed → safe to clear and resume fresh.
    await db.updateRealStrategy(id, { status: "active", pendingSince: null, pendingClientId: null, needsReview: false, lastError: null });
    logFinancial("autobuy.review.resumedClean", { userId, id });
    return res.json({ ok: true, status: "active", note: "Broker confirmed the earlier order never filled — resumed cleanly." });
  }
  // 3) The order EXISTS at the broker (probe===true) or we couldn't verify (null). We NEVER clear on our
  //    own here — the user must declare the outcome EXPLICITLY, and the only safe outcomes are:
  //      • "filled"  → ADOPT the real broker position (no new entry is ever placed), or
  //      • "nofill"  → the user confirms nothing filled → clear and resume.
  //    Anything else keeps the strategy blocked. (Replaces the old blind "force" that could re-enter.)
  if (resolution === "filled") {
    let adopted = null;
    try { adopted = await adoptBrokerPosition(mine); }
    catch { return res.status(502).json({ ok: false, needsReview: true, reason: "Couldn't reach your broker to adopt the position — try again." }); }
    if (adopted) {
      await db.updateRealStrategy(id, { status: "active", openPositionId: adopted.id, pendingSince: null, pendingClientId: null, needsReview: false, lastError: null, lastOrderStatus: "filled" });
      logFinancial("autobuy.review.adopted", { userId, id, positionId: adopted.id });
      return res.json({ ok: true, status: "active", adopted: adopted.id, note: "Adopted your open broker position — the exit engine now manages it and no new entry will be placed." });
    }
    // R6-P1-01 / R8-P2-01: adoption reads the broker's ACTUAL position; Delta and FYERS support it.
    const reason = RECONCILABLE_BROKERS.has(mine.broker)
      ? "No matching OPEN position found at your broker to adopt. If it already closed, choose “Didn't fill”; otherwise flatten it with Stop & sell."
      : `Adopting a real position isn't supported for ${mine.broker} yet (we won't guess quantity/price). Manage the position in your broker app or use “Stop & sell”, then resolve as “Didn't fill” once your account is flat.`;
    return res.status(409).json({ ok: false, needsReview: true, status: "paused", reason });
  }
  if (resolution === "nofill") {
    // Delta/FYERS: require BROKER EVIDENCE the account is flat before clearing + resuming (R6-P2-01 / R8-P2-01).
    if (RECONCILABLE_BROKERS.has(mine.broker)) {
      const os = await brokerOpenSize(mine);
      if (os == null) return res.status(502).json({ ok: false, needsReview: true, reason: "Couldn't confirm with your broker that the account is flat — try again in a moment." });
      if (os.size > 0) return res.status(409).json({ ok: false, needsReview: true, status: "paused", reason: "Your broker shows an OPEN position for this strategy — the order DID fill. Choose “Order filled” to adopt it (or flatten with Stop & sell)." });
      await db.updateRealStrategy(id, { status: "active", pendingSince: null, pendingClientId: null, needsReview: false, lastError: null });
      logFinancial("autobuy.review.resolvedNoFill", { userId, id, verified: true });
      return res.json({ ok: true, status: "active", note: "Broker confirmed no open position — resolved as no-fill and resumed." });
    }
    // R7-P1-04: for a broker with NO position lookup we can't verify the account is flat, so a bare
    // "no fill" assertion isn't safe to RESUME on (a real fill would then be duplicated). STOP the
    // strategy instead — no duplicate is possible while it's stopped — and the user re-arms it after
    // confirming their broker is flat.
    await db.updateRealStrategy(id, { status: "cancelled", pendingSince: null, pendingClientId: null, needsReview: false, lastError: "Stopped: unknown order on a broker we can't verify. Confirm your account is flat, then re-arm." });
    logFinancial("autobuy.review.stoppedUnverifiable", { userId, id, broker: mine.broker });
    return res.json({ ok: true, status: "cancelled", stopped: true, note: "We can't verify this broker, so the strategy was STOPPED to prevent a duplicate. Confirm your account is flat on your broker, then re-arm it." });
  }
  // No explicit resolution → keep blocked and ask the user to choose an outcome.
  return res.status(409).json({
    ok: false, needsReview: true, status: "paused",
    reason: probe === true
      ? "An order for this strategy was found at your broker. If it FILLED, choose “Order filled” to adopt the position; if it did NOT fill, choose “Didn't fill”."
      : "Couldn't confirm the earlier order with your broker. Check it, then choose “Order filled” (adopt the position) or “Didn't fill”.",
  });
});
app.post("/api/autobuy/cancel", requireAuth, requireActiveUser, async (req, res) => {
  const userId = routeUserId(req);
  const { id } = req.body || {};
  if (!userId || !id) return res.status(400).json({ error: "userId and id required" });
  const mine = (await db.getRealStrategiesForUser(userId)).find((s) => s.id === id);
  if (!mine) return res.status(404).json({ error: "not found" });
  await db.updateRealStrategy(id, { status: "cancelled" });
  res.json({ ok: true });
});

/* Helper: find a strategy's currently OPEN managed position (by stamped id, else by instrument). */
async function openPositionForStrategy(userId, strat) {
  const managed = await db.getManagedPositionsForUser(userId).catch(() => []);
  const isOpen = (p) => p && (p.status === "open" || p.status === "closing");
  let pos = strat.openPositionId ? managed.find((p) => String(p.id) === String(strat.openPositionId) && isOpen(p)) : null;
  if (!pos) pos = managed.find((p) => isOpen(p) && String(p.brokerSym || "") === String(strat.brokerSym || "") && (p.market || "") === (strat.market || "") && Number(p.entry) > 0);
  return pos || null;
}

/* CLOSE NOW — flatten an auto-buy strategy's open position with a reduce-only MARKET sell, then stop
   the strategy from re-entering. Real money moves. Honors AUTO_EXIT_LIVE: in dry-run it marks the
   position closed WITHOUT placing a broker order (matching the exit engine's own gating). */
app.post("/api/autobuy/close", requireAuth, requireActiveUser, async (req, res) => {
  try {
    const userId = routeUserId(req);
    const { id } = req.body || {};
    if (!userId || !id) return res.status(400).json({ error: "userId and id required" });
    const strat = (await db.getRealStrategiesForUser(userId)).find((s) => s.id === id);
    if (!strat) return res.status(404).json({ error: "not found" });
    const pos = await openPositionForStrategy(userId, strat);
    // No open position — nothing to sell; just stop the strategy.
    if (!pos) { await db.updateRealStrategy(id, { status: "cancelled" }); return res.json({ ok: true, closed: false, note: "no open position — strategy stopped" }); }
    const live = String(process.env.AUTO_EXIT_LIVE || "").toLowerCase() === "true";
    if (!live) {
      // Dry-run: simulate the close so the UI clears, but place no real order.
      await db.updateManagedPosition(pos.id, { status: "closed", closedAt: Date.now(), exitReason: "manual-close (dry-run)" });
      await db.updateRealStrategy(id, { status: "cancelled" });
      return res.json({ ok: true, closed: true, dryRun: true });
    }
    const sess = await sessionFromCred(userId, pos.broker || strat.broker);
    if (!sess) return res.status(400).json({ error: "no stored credentials for this broker — reconnect it first" });
    // R14-P1-03: ATOMICALLY claim the position so the exit engine (or a second Close Now click) can't also
    // submit a SELL. If the claim fails, another action already owns the close — don't fire a duplicate.
    // R12-P1-01: the durable exitTag makes a crash mid-close idempotent via stale-close reconciliation.
    const exitTag = reconcile.fyersOrderTag(`mxc${pos.id}x${Date.now()}`);
    const claimed = await db.claimManagedForExit(pos.id, { closingSince: Date.now(), exitTag });
    if (!claimed) return res.status(409).json({ ok: false, closed: false, error: "A close is already in progress for this position — it won't be submitted twice. Check back in a moment." });
    let r;
    try {
      r = await placeExitOrder(sess, pos.brokerSym, pos.qty, pos.market, pos.product, !!pos.short, exitTag);
    } catch (exitErr) {
      /* R11-P1-01 + SELF-REVIEW: an exit that THROWS must not strand the position, but for FYERS the SELL
         may have reached the broker — flipping to "open" could let the exit engine fire a duplicate SELL.
         Keep it "closing" with closingSince=null so the engine's idempotent stale-recovery reconciles THIS
         order by its exitTag on the next sweep (pending → wait; absent/resolved → reopen/close). Non-FYERS
         brokers (no tag) restore to "open" and retry as before. Either way SL/TP monitoring continues. */
      if (pos.broker === "fyers") {
        await db.updateManagedPosition(pos.id, { status: "closing", closingSince: null, lastError: `Close failed (${String(exitErr.message || exitErr)}) — reconciling by exit tag; the engine will finish or reopen.` });
      } else {
        await db.updateManagedPosition(pos.id, { status: "open", closingSince: null, lastError: `Close failed (${String(exitErr.message || exitErr)}) — position kept open; the exit engine will keep retrying.` });
      }
      return res.status(502).json({ ok: false, closed: false, error: "Couldn't confirm the close with your broker — the position is kept open and will keep retrying. Try again in a moment." });
    }
    // R8-lifecycle: don't claim a flat close the broker didn't confirm. Delta/FYERS report r.filled; a
    // partial/unfilled close leaves real exposure — keep the position OPEN so the exit engine retries and
    // tell the user, rather than cancelling the strategy over a position that's still live.
    if (r.filled === false) {
      /* R13-P1-01: a still-PENDING FYERS close must stay "closing" with its exitTag so the engine reconciles
         THIS order and never fires a second SELL. A TERMINAL partial reopens to retry the remainder. */
      if (r.pending && pos.broker === "fyers") {
        await db.updateManagedPosition(pos.id, { status: "closing", closingSince: null, exitOrderId: r.orderId || null, lastError: `Close order pending at broker (state ${r.state}) — awaiting fill; not resubmitting.` });
        return res.status(202).json({ ok: false, closed: false, pending: true, orderId: r.orderId || null, error: "Close order placed and pending at your broker — awaiting fill. It won't be submitted twice." });
      }
      await db.updateManagedPosition(pos.id, { status: "open", closingSince: null, exitTag: null, lastError: `Close not fully filled (state ${r.state}) — the exit engine will keep retrying`, exitOrderId: r.orderId || null });
      return res.status(409).json({ ok: false, closed: false, orderId: r.orderId || null, error: "Broker didn't confirm a full close — position is still open and will keep retrying. Try again in a moment." });
    }
    await db.updateManagedPosition(pos.id, { status: "closed", closedAt: Date.now(), exitReason: "manual-close", exitOrderId: r.orderId || null, closingSince: null });
    await db.updateRealStrategy(id, { status: "cancelled" });
    res.json({ ok: true, closed: true, orderId: r.orderId || null });
  } catch (e) {
    // The exit-throw path above already restores "open". Any other stranded "closing" (a db write failing
    // after the claim) is caught by the exit engine's stale-closing reconciliation (R11-P1-01), so it can
    // never be skipped forever.
    serverError(res, e);
  }
});

/* UPDATE SL/TP — change the strategy's stop-loss / take-profit and push the new levels onto its open
   managed position so the exit engine acts on them. */
app.post("/api/autobuy/update", requireAuth, requireActiveUser, async (req, res) => {
  try {
    const userId = routeUserId(req);
    const { id, sl, tp } = req.body || {};
    if (!userId || !id) return res.status(400).json({ error: "userId and id required" });
    const strat = (await db.getRealStrategiesForUser(userId)).find((s) => s.id === id);
    if (!strat) return res.status(404).json({ error: "not found" });
    const patch = {};
    if (sl !== undefined) patch.sl = Number(sl) > 0 ? Number(sl) : null;
    if (tp !== undefined) patch.tp = Number(tp) > 0 ? Number(tp) : null;
    if (!Object.keys(patch).length) return res.status(400).json({ error: "nothing to update" });
    await db.updateRealStrategy(id, patch);
    const pos = await openPositionForStrategy(userId, strat);
    if (pos) await db.updateManagedPosition(pos.id, patch);
    res.json({ ok: true, updated: true, position: pos ? pos.id : null });
  } catch (e) { serverError(res, e); }
});
/* Admin flips the whole auto-buy engine LIVE / dry-run at runtime (no redeploy). */
app.post("/api/autobuy/live", async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "admin only" });
  autoBuyLiveOverride = !!(req.body && req.body.on);
  res.json({ ok: true, live: autoBuyLiveOn() });
});
app.get("/api/autobuy", requireAuth, async (req, res) => {
  const userId = routeUserId(req);
  const list = (await db.getRealStrategiesForUser(userId).catch(() => [])).filter((s) => s.status !== "cancelled");
  // Enrich each with its open position's unrealised P&L (if it holds one right now).
  const managed = await db.getManagedPositionsForUser(userId).catch(() => []);
  const openPos = managed.filter((p) => p.status === "open" || p.status === "closing");
  const enriched = await Promise.all(list.map(async (s) => {
    // Primary link: the position id the engine stamped on the strategy when it bought.
    let pos = s.openPositionId ? openPos.find((p) => String(p.id) === String(s.openPositionId)) : null;
    // Fallback: the order can fill on the exchange while the strategy↔position link fails to
    // save (a DB hiccup right after the Delta order). Without this the card is stuck on
    // "waiting for signal" even though a real position is open. Match the strategy's own
    // instrument so live P&L still shows, and self-heal the link for next time.
    if (!pos) {
      pos = openPos.find((p) => String(p.brokerSym || "") === String(s.brokerSym || "") && (p.market || "") === (s.market || "") && Number(p.entry) > 0);
      if (pos) db.updateRealStrategy(s.id, { openPositionId: pos.id }).catch(() => {});
    }
    if (!pos || !(pos.entry > 0)) return { ...s, inPosition: false, livePnl: 0 };
    let px = null; try { px = await liveMarkForOrder(pos.brokerSym || s.brokerSym, s.market); } catch { px = null; }
    const livePnl = px ? +(((px - pos.entry) * (pos.qty || 0))).toFixed(2) : 0;
    return { ...s, inPosition: true, livePnl, entryPrice: pos.entry, positionQty: pos.qty };
  }));
  res.json({ engineLive: autoBuyLiveOn(), last: lastAutoBuy, strategies: enriched });
});

app.get("/health", (_, res) => res.json({ ok: true }));

/* ── Bring-your-own-app: cache warm-up + daily token refresh ────────────────────────────
   On boot we decrypt every stored app cred into memory so key()/secret() resolve without a
   DB round-trip. Then, for users who supplied a PIN, a periodic job mints a fresh daily
   FYERS access token from their 15-day refresh token — so a connected user stays live for
   ~15 days with only an occasional interactive re-login, instead of every morning. Users
   who DIDN'T give a PIN simply reconnect daily (the token just expires; nothing breaks). */
async function warmAppCredCache() {
  try {
    const rows = await db.getAllBrokerApps();
    let n = 0;
    for (const row of rows) {
      const c = decryptCred(row.data);
      if (c && c.appId) { setUserAppCred(row.userId, row.broker, c); n++; }
    }
    if (n) console.log(`[byoa] warmed ${n} app credential(s) into cache`);
  } catch (e) { console.error("[byoa] cache warm-up failed:", e.message); }
}

/* Refresh ONE user's FYERS daily token from their stored refresh token + PIN. Reuses the same
   validate-refresh-token flow (and static-IP proxy) as the house feed. Returns true on success. */
async function refreshFyersUserToken(userId, app) {
  if (!app || !app.appId || !app.secret || !app.pin) return false;   // no PIN => cannot auto-refresh
  const blob = await db.getBrokerCred(userId, "fyers");
  const cur = decryptCred(blob);
  if (!cur || !cur.refreshToken) return false;                       // nothing to refresh from
  try {
    const appIdHash = crypto.createHash("sha256").update(`${app.appId}:${app.secret}`).digest("hex");
    const r = await pfetch(`${FY_HOST}/api/v3/validate-refresh-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", appIdHash, refresh_token: cur.refreshToken, pin: app.pin }),
      ...fyFetchOpts,
    });
    const d = await r.json().catch(() => ({}));
    if (r.ok && d.access_token) {
      await db.saveBrokerCred(userId, "fyers", encryptCred({ accessToken: d.access_token, refreshToken: cur.refreshToken, extra: cur.extra || null }));
      return true;
    }
    console.error(`[byoa] fyers refresh failed for ${userId}:`, d.message || d.s || r.status);
    return false;
  } catch (e) { console.error(`[byoa] fyers refresh error for ${userId}:`, e.message); return false; }
}

async function refreshAllBrokerTokens() {
  try {
    const rows = await db.getAllBrokerApps();
    let ok = 0;
    for (const row of rows) {
      const c = decryptCred(row.data);
      if (row.broker === "fyers" && c && c.pin) { if (await refreshFyersUserToken(row.userId, c)) ok++; }
    }
    if (ok) console.log(`[byoa] refreshed ${ok} FYERS token(s)`);
  } catch (e) { console.error("[byoa] token refresh sweep failed:", e.message); }
}

// Warm the cache shortly after boot (give initDb a moment), then refresh tokens every 6h.
setTimeout(warmAppCredCache, 3000).unref?.();
setTimeout(refreshAllBrokerTokens, 15000).unref?.();
setInterval(refreshAllBrokerTokens, 6 * 60 * 60 * 1000).unref?.();

/* WARN on missing/weak critical secrets (audit P1-12). A random per-boot JWT secret silently
   logs everyone out on restart; a missing CRED_KEY weakens broker-credential encryption. We log
   loudly but DO NOT exit — crashing the whole service (and taking down real prices + trading) is
   worse than running with a warning. Set these in production; the warning tells you to. */
(function guardSecrets() {
  const prod = process.env.NODE_ENV === "production";
  const credWeak = !process.env.CRED_KEY || String(process.env.CRED_KEY).length < 16;
  /* R14-P2-07: broker credentials protect real accounts, so their encryption key should be a SEPARATE
     strong secret — not silently derived from JWT_SECRET/DATABASE_URL. In production, opt into fail-closed
     with CRED_KEY_REQUIRED=1 once a dedicated CRED_KEY is set (avoids orphaning creds encrypted under the
     old derived key on existing deployments). Otherwise we warn loudly. */
  if (prod && credWeak && /^(1|true|yes)$/i.test(String(process.env.CRED_KEY_REQUIRED || ""))) {
    throw new Error("[startup] CRED_KEY_REQUIRED is set but CRED_KEY is missing/weak (need ≥16 chars). Set a strong, dedicated broker-credential encryption key. Refusing to start.");
  }
  /* R16-P2-11: whenever LIVE trading is enabled, a dedicated strong CRED_KEY is mandatory — real broker
     credentials must not be protected by a key derived from JWT_SECRET/DATABASE_URL. Fail closed in
     production. An existing deployment that still needs the legacy derived key can set CRED_KEY_ALLOW_WEAK=1
     as a deliberate, temporary escape hatch (logs a loud warning instead). */
  if (prod && TRADING_ENABLED && credWeak && !/^(1|true|yes)$/i.test(String(process.env.CRED_KEY_ALLOW_WEAK || ""))) {
    throw new Error("[startup] Live trading is enabled (BROKER_TRADING_ENABLED=true) but CRED_KEY is missing/weak (need ≥16 chars). Real broker credentials require a dedicated strong encryption key. Set CRED_KEY, or set CRED_KEY_ALLOW_WEAK=1 to override temporarily. Refusing to start.");
  }
  const problems = [];
  if (!process.env.JWT_SECRET || String(process.env.JWT_SECRET).length < 16) problems.push("JWT_SECRET (set a long, stable random string)");
  if (credWeak) problems.push("CRED_KEY (set a SEPARATE strong broker-credential encryption key; do not rely on the JWT_SECRET/DATABASE_URL fallback in production)");
  if (!problems.length) return;
  console.warn("[startup] WARNING — missing/weak critical secrets: " + problems.join(", ") + ". Set these in production for secure sessions + credential encryption." + (prod && credWeak ? " Set CRED_KEY_REQUIRED=1 to enforce once configured." : ""));
})();

app.listen(PORT, () => console.log(`Matrix proxy on :${PORT}`));
