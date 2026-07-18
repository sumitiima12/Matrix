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
const { validateOrder: serverValidateOrder } = require("./riskEngine");
const { signToken, verifyToken, requireAuth, storageKeyFor } = require("./auth");   // must be required BEFORE any route uses requireAuth
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
  allowedHeaders: ["Content-Type", "Authorization", "X-Broker-Session", "X-User-Id", "X-Confirm-Live", "X-Admin-Key"],
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
    const rec = { id: trade.id || `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, ...trade };
    await db.saveTrade(userId, rec);
    res.json({ ok: true, trade: rec });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Fetch trade history:  GET /api/trades?userId=&from=<ms>&to=<ms>
app.get("/api/trades", requireAuth, async (req, res) => {
  try {
    const userId = storageKeyFor(req.authUserId);   // from the verified token
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
    if (await db.getUser(phone)) return res.status(409).json({ error: "That number is already registered — please log in." });
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
    await db.createUser(phone, hashPin(pin), name, secQuestion || null, answerHash, username, referredBy);
    if (email && typeof db.setEmail === "function") { try { await db.setEmail(phone, email); } catch { email = ""; } }
    if (typeof db.setLastLogin === "function") { try { await db.setLastLogin(phone); } catch { /* non-fatal */ } }
    res.json({ ok: true, userId: phone, name, username, referredBy, email: email || null, createdAt: Date.now(), token: signToken(phone) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/login", authLimiter, async (req, res) => {
  try {
    const phone = cleanPhone(req.body && req.body.phone), pin = req.body && req.body.pin;
    const u = await db.getUser(phone);
    // Unified Login / Sign-up: if there's no account for this number, tell the client so
    // it can switch to the "looks like you're new" sign-up step instead of showing an error.
    if (!u) return res.status(404).json({ ok: false, newAccount: true, error: "No account for this number." });
    if (!verifyPin(pin, u.pin)) return res.status(401).json({ error: "Wrong PIN for this number." });

    // Blocked users are turned away even with a correct PIN.
    if (typeof db.isUserBlocked === "function" && await db.isUserBlocked(phone)) {
      return res.status(403).json({ error: "This account has been blocked. Contact support." });
    }

    /* Upgrade a legacy SHA-256 user to bcrypt now that we've verified their PIN. Best-effort:
       a failed upgrade must not fail the login. */
    if (isLegacyHash(u.pin) && typeof db.updateUserPin === "function") {
      try { await db.updateUserPin(phone, hashPin(pin)); } catch { /* upgrade later */ }
    }
    if (typeof db.setLastLogin === "function") { try { await db.setLastLogin(phone); } catch { /* non-fatal */ } }
    res.json({ ok: true, userId: phone, name: u.name || "", username: u.username || null, email: u.email || null, createdAt: u.createdAt || null, token: signToken(phone) });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---------------------------- PUBLIC STRATEGIES ---------------------------
   Anyone signed in can publish their own strategy; everyone can browse them. */
app.get("/api/public-strategies", async (req, res) => {
  try {
    let list = typeof db.listPublicStrategies === "function" ? await db.listPublicStrategies() : [];
    const sym = (req.query.symbol || "").trim();
    const by = (req.query.by || "").trim().toLowerCase();
    if (sym) list = list.filter((s) => (s.symbols || []).includes(sym));
    if (by) list = list.filter((s) => String(s.owner_name || "").toLowerCase() === by);
    res.json({ strategies: list });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
    res.json({ ok: true, strategy: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/public-strategies/:id", requireAuth, async (req, res) => {
  try {
    const phone = stripPh(req.authUserId);
    const isAdm = isAdmin(req);
    await db.unpublishStrategy(req.params.id, isAdm ? "" : phone);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ------------------------------ COMMUNITY IDEAS ------------------------------
   Any signed-in user can post an idea; everyone can browse them. */
app.get("/api/ideas", async (req, res) => {
  try {
    let list = typeof db.listIdeas === "function" ? await db.listIdeas() : [];
    const sym = (req.query.symbol || "").trim();
    const by = (req.query.by || "").trim().toLowerCase();
    if (sym) list = list.filter((i) => i.symbol === sym);
    if (by) list = list.filter((i) => String(i.owner_name || "").toLowerCase() === by);
    /* APPROVAL GATE: everyone sees APPROVED ideas. An admin sees everything (to review).
       A signed-in author sees their own still-pending ideas so they know it's awaiting review. */
    const admin = isAdmin(req);
    const me = req.get("X-User-Id") ? stripPh(req.get("X-User-Id")) : null;
    if (!admin) list = list.filter((i) => (i.status || "approved") === "approved" || (me && i.owner === me));
    res.json({ ideas: list });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
    res.json({ ok: true, idea: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* Admin approves or rejects a pending idea before it becomes public. */
app.post("/api/ideas/:id/review", requireAuth, async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: "admin only" });
    const status = req.body && req.body.status === "approved" ? "approved" : "rejected";
    if (typeof db.reviewIdea === "function") await db.reviewIdea(req.params.id, status);
    res.json({ ok: true, status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/ideas/:id", requireAuth, async (req, res) => {
  try {
    const phone = stripPh(req.authUserId);
    await db.deleteIdea(req.params.id, isAdmin(req) ? "" : phone);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/forgot/reset", authLimiter, async (req, res) => {
  try {
    const phone = cleanPhone(req.body && req.body.phone);
    const answer = ((req.body && req.body.answer) || "").trim().toLowerCase();
    const newPin = req.body && req.body.newPin;
    if (!phone || !answer || !newPin) return res.status(400).json({ error: "phone, answer and newPin are required." });
    if (String(newPin).length < 4) return res.status(400).json({ error: "PIN must be at least 4 digits." });

    const hash = typeof db.getSecurityAnswerHash === "function" ? await db.getSecurityAnswerHash(phone) : null;
    if (!hash) return res.status(400).json({ error: "No recovery is set up for this number." });
    // verifyPin works for any bcrypt/legacy hash — reuse it to check the answer.
    if (!verifyPin(answer, hash)) return res.status(401).json({ error: "That answer doesn't match." });

    await db.updateUserPin(phone, hashPin(newPin));
    // Log them straight in with a fresh token.
    const u = await db.getUser(phone);
    res.json({ ok: true, userId: phone, name: (u && u.name) || "", token: signToken(phone) });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Save/load a user's app state blob (automations, watchlists, wallets, profile).
app.post("/api/state", requireAuth, async (req, res) => {
  try {
    const { state } = req.body || {};
    const userId = storageKeyFor(req.authUserId);   // from the verified token
    await db.saveState(userId, state || {});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/state", requireAuth, async (req, res) => {
  try {
    const userId = storageKeyFor(req.authUserId);   // from the verified token
    res.json({ state: await db.getState(userId) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ================================ ADMIN ================================== */
/* Locked behind TWO checks: the caller's userId must be in ADMIN_USER_IDS, AND they must
   present the ADMIN_KEY secret. Both are required — a leaked key alone, or a known admin
   userId alone, is not enough. Set ADMIN_USER_IDS (comma-separated) and ADMIN_KEY in env. */
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

// Admin backstop: reset any user's PIN. The last-resort recovery when a user can't answer
// their security question (or never set one).
app.post("/api/admin/reset-pin", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const phone = cleanPhone(req.body && req.body.phone);
    const newPin = req.body && req.body.newPin;
    if (!phone || !newPin || String(newPin).length < 4) return res.status(400).json({ error: "phone and a 4+ digit newPin are required." });
    if (!(await db.getUser(phone))) return res.status(404).json({ error: "user not found" });
    await db.updateUserPin(phone, hashPin(newPin));
    res.json({ ok: true, phone });
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
    const opts = { uri: `${u.protocol}//${u.host}` };
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
async function fyersHouseToken() {
  if (_fyHouse.token && (Date.now() - _fyHouse.at) < 23 * 3600 * 1000) return _fyHouse.token;
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
function yahooToFyers(ySym) {
  const s = String(ySym || "");
  if (s.endsWith(".NS")) return `NSE:${s.slice(0, -3)}-EQ`;
  if (s.endsWith(".BO")) return `BSE:${s.slice(0, -3)}-EQ`;
  return null;
}

/* ── Delta Exchange house crypto feed ─────────────────────────────────────────────────
   Same idea as the FYERS feed, for CRYPTO. Delta's /v2/tickers is PUBLIC (no keys, no
   signature), so this works out of the box with no configuration — it just gives crypto
   prices from Delta instead of Yahoo. "BTC-USD" -> Delta's "BTCUSD" perpetual. */
function yahooToDelta(ySym) {
  const m = String(ySym || "").match(/^([A-Z0-9]+)-USD$/);
  return m ? `${m[1]}USD` : null;
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

/* ── IND Money US house feed ──────────────────────────────────────────────────────────
   REAL-TIME US prices for ALL users (Yahoo is ~15 min delayed on US too). IND Money's
   public graph endpoint returns a live `price` plus intraday candles — no auth needed.
   A US symbol here is a plain ticker (AAPL, NVDA) — crypto is X-USD, Indian is X.NS. */
const INDM_US = "https://apixt-us.indmoney.com/us-stock-broker/us/catalog/get-stock-graph";
let _indmLastError = null;
const isUsTicker = (s) => /^[A-Z]{1,5}$/.test(String(s || ""));
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
async function indmoneyHouseQuotes(ySyms) {
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
async function indmoneyUsCandles(sym, range) {
  const label = ({ "5d": "1W", "1mo": "1M", "3mo": "3M", "6mo": "6M", "1y": "1Y" })[range] || "1M";
  const end = ymd(Date.now());
  const start = ymd(Date.now() - rangeToSeconds(range) * 1000);
  const d = await j(`${INDM_US}/${encodeURIComponent(sym)}?start_date=${start}&end_date=${end}&label=${label}&response_format=json&currency=USD`);
  return ((d && d.candles) || []).map((c) => ({ t: c.ts * 1000, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume })).filter((x) => x.c != null);
}

// Quotes for the Indian-equity subset, keyed back by the ORIGINAL yahoo symbol.
async function fyersHouseQuotes(ySyms) {
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

/* Historical candles from the FYERS house feed. Returns the SAME shape as the Yahoo path
   ({ t, o, h, l, c, v }), or null for anything FYERS can't serve (non-equity, weekly/monthly,
   or when the feed isn't configured) so the caller cleanly falls back to Yahoo. */
const FY_RES = { "1m": "1", "2m": "2", "3m": "3", "5m": "5", "10m": "10", "15m": "15", "30m": "30", "60m": "60", "1h": "60", "90m": "90", "1d": "D", "1D": "D" };
const FY_RANGE_DAYS = { "1d": 2, "5d": 7, "1mo": 31, "3mo": 93, "6mo": 186, "1y": 370, "2y": 740 };
async function fyersHouseHistory(ySym, range, interval) {
  const fy = yahooToFyers(ySym);
  const res = FY_RES[interval];
  const days = FY_RANGE_DAYS[range];
  if (!fy || !res || !days) return null;
  const token = await fyersHouseToken();
  if (!token) return null;
  const appId = process.env.FYERS_APP_ID || "";
  const fmt = (d) => d.toISOString().slice(0, 10);
  const from = fmt(new Date(Date.now() - days * 864e5)), to = fmt(new Date());
  try {
    const url = `${FY_HOST}/data/history?symbol=${encodeURIComponent(fy)}&resolution=${res}&date_format=1&range_from=${from}&range_to=${to}&cont_flag=1`;
    const r = await pfetch(url, { headers: { Authorization: `${appId}:${token}` }, ...fyFetchOpts });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.s === "error" || !Array.isArray(d.candles)) {
      if (d.code === -16 || /token/i.test(d.message || "")) _fyHouse = { token: null, at: 0 };
      return null;
    }
    // FYERS candle rows are [epoch_s, o, h, l, c, v].
    return d.candles
      .map((c) => ({ t: c[0] * 1000, o: c[1], h: c[2], l: c[3], c: c[4], v: c[5] }))
      .filter((x) => x.c != null && x.h != null && x.l != null);
  } catch { return null; }
}

app.get("/api/quote", async (req, res) => {
  const symbols = String(req.query.symbols || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!symbols.length) return res.status(400).json({ error: "symbols required" });
  try {
    const quotes = await memo(`q:${symbols.join(",")}`, 15_000, async () => {
      // Indian equities from the FYERS house feed and crypto from the Delta feed first;
      // Yahoo covers the rest — and anything the house feeds didn't return.
      let fyMap = {}, dMap = {}, imMap = {};
      try { fyMap = await fyersHouseQuotes(symbols); } catch { fyMap = {}; }
      try { dMap = await deltaHouseQuotes(symbols); } catch { dMap = {}; }
      try { imMap = await indmoneyHouseQuotes(symbols); } catch { imMap = {}; }   // real-time US via IND Money
      const houseMap = { ...fyMap, ...dMap, ...imMap };
      const need = symbols.filter((s) => !houseMap[s]);
      const rows = await mapLimit(need, 6, async (sym) => {
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
      return [...Object.values(houseMap), ...rows.filter(Boolean)];
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
    // FYERS house feed first for Indian equities (real, no ~15-min delay); Yahoo otherwise.
    let candles = await memo(`fyh:${symbol}:${range}:${interval}`, 60_000, () => fyersHouseHistory(symbol, range, interval));
    if (!candles || !candles.length) {
      const data = await memo(`h:${symbol}:${range}:${interval}`, 60_000, () =>
        j(`${YF}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`));
      const r = data.chart?.result?.[0];
      const ts = r?.timestamp || [];
      const q = r?.indicators?.quote?.[0] || {};
      candles = ts.map((t, i) => ({
        t: t * 1000,
        o: q.open?.[i], h: q.high?.[i], l: q.low?.[i], c: q.close?.[i], v: q.volume?.[i],
      })).filter((d) => d.c != null);
    }
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
  // Crypto: use Delta's own candles so the exit engine and charts match the perpetual mark
  // the position is actually held against. Fall back to Yahoo if Delta returns nothing.
  const cx = String(symbol).match(/^([A-Z0-9]+)-USD$/);
  if (cx) {
    try {
      const dc = await memo(`dc:${symbol}:${range}:${interval}`, 60_000, () => deltaCandles(`${cx[1]}USD`, interval, range));
      if (dc && dc.length) return dc;
    } catch (e) { /* fall through to Yahoo */ }
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
  if (fy && fy.length) return fy;
  const data = await memo(`h:${symbol}:${range}:${interval}`, 60_000, () =>
    j(`${YF}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`));
  const r = data.chart?.result?.[0];
  const ts = r?.timestamp || [];
  const q = r?.indicators?.quote?.[0] || {};
  return ts.map((t, i) => ({ t: t * 1000, o: q.open?.[i], h: q.high?.[i], l: q.low?.[i], c: q.close?.[i], v: q.volume?.[i] }))
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
  // FYERS house feed first (real 5-min bars with volume); Yahoo otherwise.
  let rows = null;
  const fy = await fyersHouseHistory(sym, "1d", "5m");
  if (fy && fy.length >= 2) {
    rows = fy.map((c) => ({ t: Math.round(c.t / 1000), c: c.c, v: c.v })).filter((x) => x.c != null && !Number.isNaN(x.c));
  } else {
    const d = await j(`${YF}/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=5m`);
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
  // Public health: liveness, engines, DB mode only. No key metadata or env-var names.
  res.json({
    ok: true,
    engines: providers().map((p) => p.name),
    db: db.USING_PG ? "postgres" : "flat-file",
    // Is the FYERS house price feed configured? (true = Indian equities served from FYERS)
    fyersHouseFeed: Boolean((process.env.FYERS_APP_ID && process.env.FYERS_REFRESH_TOKEN && process.env.FYERS_PIN) || process.env.FYERS_ACCESS_TOKEN),
    deltaProxy: Boolean(process.env.DELTA_PROXY_URL || process.env.DELTA_PROXY),
    fyersProxy: Boolean(process.env.FYERS_PROXY_URL),   // routing FYERS via its own static-IP proxy
    build: "feeds-diag-5",   // bump on deploy so we can confirm which build is live
  });
});

/* Live diagnostic for the house price feeds. Hits FYERS + Delta right now and reports what
   came back (and any error). Open in a browser to see WHY a feed is falling back to Yahoo. */
app.get("/api/feeds-status", async (req, res) => {
  let fy = {}, de = {};
  try { fy = await fyersHouseQuotes(["RELIANCE.NS"]); } catch (e) { _fyLastError = e.message; }
  try { de = await deltaHouseQuotes(["BTC-USD"]); } catch (e) { _deltaLastError = e.message; }
  res.json({
    fyers: {
      envConfigured: {
        FYERS_APP_ID: Boolean(process.env.FYERS_APP_ID),
        FYERS_SECRET_ID: Boolean(process.env.FYERS_SECRET_ID),
        FYERS_REFRESH_TOKEN: Boolean(process.env.FYERS_REFRESH_TOKEN),
        FYERS_PIN: Boolean(process.env.FYERS_PIN),
        FYERS_ACCESS_TOKEN: Boolean(process.env.FYERS_ACCESS_TOKEN),
      },
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

  /* BRING-YOUR-OWN-CREDENTIAL brokers. Unlike the OAuth brokers, these don't send the user
     to a login page — the user generates a token (or enters login + TOTP) and hands it to
     us directly. `userCreds:true` means "no server app key needed; credentials arrive in
     the connect body". No secrets sit in the server env for these. */
  dhan: {
    name: "Dhan", userCreds: true,
    key: () => "byo", secret: () => "byo", loginUrl: () => null,
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
const DELTA_BASE = "https://api.india.delta.exchange";

/* ── Delta outbound proxy ─────────────────────────────────────────────────────────
   Delta whitelists API keys by IP. Render's outbound IP isn't (and can't reliably be)
   whitelisted, so Delta rejects our calls with `ip_not_whitelisted_for_api_key`.
   The fix is to route ONLY the Delta requests through a static, whitelisted proxy.
   Set DELTA_PROXY_URL on the server, e.g.
     http://<user>:<pass>@dc46-mum-01.algoip.in:443
   Credentials are pulled out of the URL and sent as a Proxy-Authorization header
   (the most reliable way for undici's ProxyAgent). If the var is unset, Delta calls
   go out directly, exactly as before. */
const deltaDispatcher = makeProxyDispatcher(process.env.DELTA_PROXY_URL || process.env.DELTA_PROXY || "");
if (deltaDispatcher) console.log("[delta] routing Delta API through the configured proxy");

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

  const r = await pfetch(DELTA_BASE + path + query, {
    method,
    headers,
    ...(bodyStr ? { body: bodyStr } : {}),
    ...(deltaDispatcher ? { dispatcher: deltaDispatcher } : {}),   // route via whitelisted proxy when configured
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

    if (broker === "dhan") {
      /* Dhan: no OAuth. The user pastes an access token (+ client id) generated on
         web.dhan.co. We validate by hitting the funds endpoint. */
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
app.post("/api/broker/resume", async (req, res) => {
  const userId = req.get("X-User-Id") || (req.body && req.body.userId);
  const broker = req.body && req.body.broker;
  if (!userId || !broker) return res.status(400).json({ error: "userId and broker required" });
  try {
    const sess = await sessionFromCred(userId, broker);
    if (!sess) return res.status(404).json({ error: "no stored connection — please reconnect" });
    const sid = putBrokerSession(userId, broker, sess.accessToken, sess.refreshToken, sess.extra || null);
    res.json({ sessionId: sid, broker });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
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

/* Fetch the user's REAL account state from their broker: available cash + open positions.
   Used to run risk checks server-side before a live order. Returns { wallet, portfolio } or
   null if it can't be fetched (caller decides how to fail). Reuses the same broker endpoints
   the portfolio view uses. Has an overall timeout so a slow broker can't hang the order. */
async function fetchBrokerAccount(sess) {
  const { broker, accessToken: token } = sess;
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
        fetch("https://api-t1.fyers.in/api/v3/holdings", { headers: brokerAuth(broker, token, sess.userId) }),
        fetch("https://api-t1.fyers.in/api/v3/positions", { headers: brokerAuth(broker, token, sess.userId) }),
        fetch("https://api-t1.fyers.in/api/v3/funds", { headers: brokerAuth(broker, token, sess.userId) }),
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
      const [w, pos] = await withTimeout(Promise.all([
        deltaCall("GET", "/v2/wallet/balances"),
        deltaCall("GET", "/v2/positions/margined"),
      ]));
      const wallet = (w.result || []).reduce((a, b) => a + (Number(b.available_balance) || 0), 0);
      const portfolio = (pos.result || []).filter((x) => Number(x.size) !== 0)
        .map((x) => ({ sym: x.product_symbol || (x.product && x.product.symbol) || null, qty: Number(x.size), avg: x.entry_price != null ? Number(x.entry_price) : null, price: x.mark_price != null ? Number(x.mark_price) : null, market: "Crypto" }));
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
async function placeDeltaBracket(prod, side, entryRef, slPct, tpPct) {
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
        await deltaCall("POST", "/v2/orders/bracket", { body });
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
  async function registerAutoExit() {
    if (!wantAutoExit || String(side).toLowerCase() !== "buy") return null;
    // All brokers now have order placement wired, so any of them can be auto-exited.
    try {
      const bareSym = String(symbol).replace(/^[A-Z]+:/, "").replace(/-EQ$/i, "");
      const entryRef = Number(req.body?.entryPrice) || await liveMarkForOrder(symbol, regMarket) || null;
      const yahoo = req.body?.yahoo || (regMarket === "Crypto"
        ? `${String(symbol).replace(/(USDT|USD|INR)$/i, "")}-USD`
        : `${bareSym}.NS`);
      const pos = await registerManagedPosition({
        sess, symbol: bareSym, brokerSym: symbol, qty: nQty, entry: entryRef,
        market: regMarket, sl: slPct || null, tp: tpPct || null, tsl: tslPct || null,
        cfg: exitCfg, yahoo, interval: req.body?.interval || "5m",
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
      return res.status(503).json({ error: "Could not verify your account state with the broker to risk-check this order. Try again in a moment." });
    }
    const orderSym = String(symbol).replace(/^NSE:/, "").replace(/-EQ$/, "");
    const rkTrades = await db.getTrades(storageKeyFor(sess.userId), 0, Date.now()).catch(() => []);
    let rkPrice = price != null ? Number(price) : (account.portfolio.find((h) => h.sym === orderSym) ? account.portfolio.find((h) => h.sym === orderSym).price : null);
    // Market order, new position: no limit price and nothing held. Fetch a live mark so the
    // risk engine can size the order instead of refusing it for "No live price".
    if (rkPrice == null) rkPrice = await liveMarkForOrder(symbol, rkMarket);
    const check = serverValidateOrder(
      { sym: orderSym, side: String(side).toUpperCase(), qty: nQty, price: rkPrice, market: rkMarket },
      { wallet: account.wallet, portfolio: account.portfolio, trades: rkTrades || [] },
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
      const autoExitId = await registerAutoExit();
      return res.json({ orderId: d.id, status: "PENDING", broker, autoExitId });
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
      /* A 200 is NOT a fill. Verify the order actually executed — a market order with
         insufficient margin returns cancelled/unfilled. Report the REJECT with the broker's
         reason instead of attaching a bracket and pretending a position exists. */
      const o = d.result || {};
      const size = Number(o.size) || Number(qty);
      const unfilled = o.unfilled_size != null ? Number(o.unfilled_size) : (o.state === "closed" ? 0 : size);
      const filled = Math.max(0, size - unfilled);
      const status = (o.state === "cancelled" || o.state === "rejected" || filled <= 0) ? "rejected" : (filled < size ? "partial" : "filled");
      if (status === "rejected") {
        return res.status(400).json({ ok: false, status: "rejected", broker, orderId: o.id ?? null, reason: o.cancellation_reason || o.meta_data?.reason || "Order not filled — likely insufficient balance/margin on your Delta account" });
      }
      /* Attach an exchange-side bracket so the stop-loss / take-profit fire on Delta itself,
         with the app closed. Best-effort and honestly reported: the entry has filled, so a
         bracket failure returns a warning rather than pretending the position is safe. */
      let bracket = null;
      if (String(side).toLowerCase() === "buy" && (slPct > 0 || tpPct > 0)) {
        const entryRef = Number(o.average_fill_price) || Number(req.body?.entryPrice) || await liveMarkForOrder(symbol, "Crypto");
        bracket = await placeDeltaBracket(prod, side, entryRef, slPct, tpPct);
      }
      const autoExitId = await registerAutoExit();
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
          value: (x.mark_price != null && x.size != null) ? Number(x.mark_price) * Number(x.size) : null,
          pnl: x.unrealized_pnl != null ? Number(x.unrealized_pnl) : null,
          source: "positions",
          market: "Crypto",
        }))
        .filter((h) => h.sym);

      return res.json({ broker, holdings, cash, currency: "USD" });
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

/* REDUCE-ONLY exit executor. Sells `qty` to CLOSE a long. Every branch is a plain sell;
   Delta additionally sets reduce_only so it can never flip you short by accident. The exit
   MUST use the same product the entry used (closing an MIS position with CNC would fail). */
async function placeExitOrder(sess, symbol, qty, market, product) {
  const broker = sess.broker;
  const token = sess.accessToken;
  const prod = mapProduct(broker, product);
  if (broker === "delta") {
    const prods = await deltaCall("GET", "/v2/products", { signed: false });
    const prod = (prods.result || []).find((p) => p.symbol === symbol);
    if (!prod) throw new Error(`Delta does not list ${symbol}`);
    const d = await deltaCall("POST", "/v2/orders", {
      body: { product_id: prod.id, size: Number(qty), side: "sell", order_type: "market_order", reduce_only: true },
    });
    return { orderId: d.result?.id ?? null };
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
    const r = await fetch("https://api-t1.fyers.in/api/v3/orders/sync", {
      method: "POST", headers: { ...brokerAuth(broker, token, sess.userId), "Content-Type": "application/json" },
      body: JSON.stringify({ symbol, qty: Number(qty), type: 2, side: -1, productType: prod, limitPrice: 0, stopPrice: 0, validity: "DAY", disclosedQty: 0, offlineOrder: false }),
    });
    const d = await r.json();
    if (!r.ok || d.s === "error") throw new Error(d.message || `fyers exit ${r.status}`);
    return { orderId: d.id };
  }
  throw new Error(`auto-exit not supported for ${broker}`);
}

/* Register a real position for the engine to watch. Called from /api/broker/order after a
   real buy that opted into auto-exit. Persists the creds needed to act on it later. */
async function registerManagedPosition({ sess, symbol, brokerSym, qty, entry, market, sl, tp, tsl, cfg, yahoo, interval, product }) {
  await persistSessionCred(sess);
  const pos = {
    id: crypto.randomBytes(16).toString("hex"),
    userId: String(sess.userId), broker: sess.broker,
    symbol, brokerSym, qty: Number(qty), entry: Number(entry) || null,
    entryAt: Date.now(), market: market || "Crypto",
    sl: sl || null, tp: tp || null, tsl: tsl || null,
    product: product || "CNC",              // so the exit closes with the SAME product as entry
    cfg: cfg || null,                       // strategy { defs, exit } for indicator exits
    yahoo: yahoo || symbol, interval: interval || (market === "IN" || market === "Commodity" ? "5m" : "5m"),
    status: "open",
  };
  await db.saveManagedPosition(pos);
  return pos;
}

let autoExitRunning = false;
let lastAutoExit = { at: null, checked: 0, exited: 0, live: false };
async function runAutoExitEngine() {
  if (autoExitRunning) return;
  autoExitRunning = true;
  const live = String(process.env.AUTO_EXIT_LIVE || "").toLowerCase() === "true";
  let checked = 0, exited = 0;
  try {
    const open = await db.getOpenManagedPositions(500);
    for (const pos of open) {
      if (pos.status === "closing") continue;         // already being handled
      checked++;
      try {
        const range = pos.interval === "1d" ? "6mo" : "1mo";
        const candles = await candlesFor(pos.yahoo || pos.symbol, range, pos.interval || "5m");
        if (!candles || candles.length < 30) continue;

        let hit = strat.priceExitFired(pos, candles);
        if (!hit.fired && pos.cfg) { const s = strat.exitSignalFired(pos.cfg, candles); if (s.fired) hit = { fired: true, reason: s.reason }; }
        if (!hit.fired) continue;

        // Claim it FIRST so a crash/restart can't sell twice.
        await db.updateManagedPosition(pos.id, { status: "closing", exitReason: hit.reason });

        if (!live) {
          console.log(`[autoexit] DRY-RUN (AUTO_EXIT_LIVE!=true): would exit ${pos.symbol} for ${pos.userId} — ${hit.reason}`);
          await db.updateManagedPosition(pos.id, { status: "open" });
          continue;
        }

        const sess = await sessionFromCred(pos.userId, pos.broker);
        if (!sess) { await db.updateManagedPosition(pos.id, { status: "open", lastError: "no stored credentials — reconnect broker" }); continue; }

        const r = await placeExitOrder(sess, pos.brokerSym, pos.qty, pos.market, pos.product);
        await db.updateManagedPosition(pos.id, { status: "closed", closedAt: Date.now(), exitReason: hit.reason, exitOrderId: r.orderId || null });
        exited++;
        console.log(`[autoexit] EXITED ${pos.symbol} for ${pos.userId} via ${pos.broker} — ${hit.reason} (order ${r.orderId})`);
      } catch (e) {
        // Return to 'open' so it retries next sweep; a transient broker/network error must
        // not silently abandon a position that still needs an exit.
        await db.updateManagedPosition(pos.id, { status: "open", lastError: String(e.message || e) });
        console.error(`[autoexit] ${pos.symbol} (${pos.broker}):`, e.message);
      }
    }
  } catch (e) { console.error("[autoexit] sweep failed:", e.message); }
  finally { autoExitRunning = false; lastAutoExit = { at: Date.now(), checked, exited, live }; }
}
if (process.env.EXIT_MONITOR !== "off") {
  setInterval(runAutoExitEngine, 60_000);
  setTimeout(runAutoExitEngine, 15_000);
}

/* The user's own managed positions (to show + cancel in the app). */
app.get("/api/autoexit", async (req, res) => {
  const userId = req.get("X-User-Id") || req.query.userId;
  if (!userId) return res.status(400).json({ error: "userId required" });
  const list = await db.getManagedPositionsForUser(userId).catch(() => []);
  res.json({ engineLive: String(process.env.AUTO_EXIT_LIVE || "").toLowerCase() === "true", last: lastAutoExit, positions: list });
});
/* Cancel auto-exit for a position (stops the engine watching it; does NOT touch the position
   at the broker). The user must own it. */
app.post("/api/autoexit/cancel", async (req, res) => {
  const userId = req.get("X-User-Id") || req.body.userId;
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
app.post("/api/autoexit/register", async (req, res) => {
  try {
    const userId = req.get("X-User-Id") || req.body.userId;
    const { broker, symbol, brokerSym, qty, entry, market, sl, tp, tsl, product } = req.body || {};
    if (!userId || !symbol || !brokerSym || !(Number(qty) > 0)) return res.status(400).json({ error: "userId, symbol, brokerSym and qty are required" });
    if (!(Number(sl) > 0) && !(Number(tp) > 0) && !(Number(tsl) > 0)) return res.status(400).json({ error: "set at least one of stop-loss, take-profit or trailing-stop" });
    const sess = await sessionFromCred(userId, broker);
    if (!sess) return res.status(400).json({ error: "no stored credentials for this broker — reconnect it first" });
    // Avoid arming two engines on the same instrument.
    const existing = (await db.getManagedPositionsForUser(userId).catch(() => [])).find((p) => (p.status === "open" || p.status === "closing") && String(p.brokerSym) === String(brokerSym));
    if (existing) { await db.updateManagedPosition(existing.id, { sl: sl || null, tp: tp || null, tsl: tsl || null, qty: Number(qty) }); return res.json({ ok: true, id: existing.id, updated: true }); }
    const pos = await registerManagedPosition({
      sess, symbol, brokerSym, qty: Number(qty), entry: Number(entry) || null, market: market || "Crypto",
      sl: Number(sl) || null, tp: Number(tp) || null, tsl: Number(tsl) || null, product: product || "CNC",
    });
    res.json({ ok: true, id: pos.id });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
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

const AB_MAX_POSITIONS = Number(process.env.AUTO_BUY_MAX_POSITIONS) || 5;
const AB_MAX_NOTIONAL = Number(process.env.AUTO_BUY_MAX_NOTIONAL) || 0;   // 0 = only the user's amount

/* A real BUY to OPEN a position. Same per-broker plumbing as the manual order route, kept
   to the brokers whose order placement is wired. */
async function placeBuyOrder(sess, symbol, qty, market, product) {
  const broker = sess.broker, token = sess.accessToken;
  const prod = mapProduct(broker, product);
  if (broker === "delta") {
    const prods = await deltaCall("GET", "/v2/products", { signed: false });
    const dprod = (prods.result || []).find((p) => p.symbol === symbol);
    if (!dprod) throw new Error(`Delta does not list ${symbol}`);
    const d = await deltaCall("POST", "/v2/orders", { body: { product_id: dprod.id, size: Number(qty), side: "buy", order_type: "market_order" } });
    // HTTP 200 is NOT a fill. A market order with insufficient margin comes back cancelled/
    // unfilled — registering a position off that would show phantom P&L for a trade that never
    // happened. Verify the fill and, if it didn't happen, throw the broker's real reason so the
    // caller records a REJECT (with reason) instead of a fake position.
    const o = d.result || {};
    const size = Number(o.size) || Number(qty);
    const unfilled = o.unfilled_size != null ? Number(o.unfilled_size) : (o.state === "closed" ? 0 : size);
    const filled = Math.max(0, size - unfilled);
    if (o.state === "cancelled" || o.state === "rejected" || filled <= 0) {
      throw new Error(o.cancellation_reason || o.meta_data?.reason || `Order not filled (state: ${o.state || "unknown"}) — likely insufficient balance/margin`);
    }
    return { orderId: o.id ?? null, filledQty: filled, avgPrice: o.average_fill_price != null ? Number(o.average_fill_price) : null, state: o.state, partial: filled < size };
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
    const r = await fetch("https://api-t1.fyers.in/api/v3/orders/sync", {
      method: "POST", headers: { ...brokerAuth(broker, token, sess.userId), "Content-Type": "application/json" },
      body: JSON.stringify({ symbol, qty: Number(qty), type: 2, side: 1, productType: prod, limitPrice: 0, stopPrice: 0, validity: "DAY", disclosedQty: 0, offlineOrder: false }),
    });
    const d = await r.json(); if (!r.ok || d.s === "error") throw new Error(d.message || `fyers buy ${r.status}`);
    return { orderId: d.id };
  }
  throw new Error(`auto-buy not supported for ${broker}`);
}

let autoBuyRunning = false;
let lastAutoBuy = { at: null, checked: 0, bought: 0, live: false };
/* LIVE flag: the env var (case-insensitive — "TRUE"/"true"/"1" all count) OR a runtime admin
   override toggled from the app. Override wins when set so the admin can flip it without a
   redeploy; unset falls back to the env default. */
let autoBuyLiveOverride = null;
const autoBuyLiveOn = () => autoBuyLiveOverride != null ? autoBuyLiveOverride : /^(true|1|yes)$/i.test(String(process.env.AUTO_BUY_LIVE || ""));
async function runAutoBuyEngine() {
  if (autoBuyRunning) return;
  autoBuyRunning = true;
  const live = autoBuyLiveOn();
  let checked = 0, bought = 0;
  try {
    const strategies = await db.getActiveRealStrategies(500);
    for (const st of strategies) {
      checked++;
      try {
        // One position per strategy: if it still holds an open managed position, do nothing.
        if (st.openPositionId) {
          const pos = (await db.getManagedPositionsForUser(st.userId)).find((p) => p.id === st.openPositionId);
          if (pos && (pos.status === "open" || pos.status === "closing")) continue;
          await db.updateRealStrategy(st.id, { openPositionId: null });   // position closed -> may re-enter
          st.openPositionId = null;
        }
        // Cooldown: don't re-fire a still-true signal inside the same candle.
        const intervalMs = (st.interval === "1d" ? 86400 : (Number((st.interval || "5m").replace(/[^\d]/g, "")) || 5) * 60) * 1000;
        if (st.lastOrderAt && Date.now() - st.lastOrderAt < intervalMs) continue;

        const range = st.interval === "1d" ? "6mo" : "1mo";
        const candles = await candlesFor(st.yahoo || st.symbol, range, st.interval || "5m");
        if (!candles || candles.length < 30) continue;

        const sig = strat.entrySignalFired(st.cfg, candles);
        if (!sig.fired) continue;

        // Cap: total open real positions for this user.
        const openCount = (await db.getManagedPositionsForUser(st.userId)).filter((p) => p.status === "open" || p.status === "closing").length;
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

        // placeBuyOrder now THROWS on a rejected/unfilled order (caught below → recorded as a
        // reject with reason, no position). Register the managed position at the ACTUAL fill
        // quantity and price, so P&L reflects what really executed, not what we requested.
        const r = await placeBuyOrder(sess, st.brokerSym, qty, st.market, st.product);
        const fillQty = Number(r.filledQty) > 0 ? Number(r.filledQty) : qty;
        const fillPx = Number(r.avgPrice) > 0 ? Number(r.avgPrice) : px;
        const pos = await registerManagedPosition({
          sess, symbol: st.symbol, brokerSym: st.brokerSym, qty: fillQty, entry: fillPx, market: st.market,
          sl: st.sl || null, tp: st.tp || null, tsl: st.tsl || null, cfg: st.cfg, yahoo: st.yahoo, interval: st.interval, product: st.product,
        });
        await db.updateRealStrategy(st.id, { openPositionId: pos.id, lastOrderAt: Date.now(), lastError: r.partial ? `Partial fill: ${fillQty}/${qty} filled` : null, lastOrderStatus: r.partial ? "partial" : "filled" });
        bought++;
        console.log(`[autobuy] ${r.partial ? "PARTIAL" : "FILLED"} ${fillQty}/${qty} ${st.symbol} for ${st.userId} via ${st.broker} — ${sig.reason} (order ${r.orderId})`);
      } catch (e) {
        // Rejected / unfilled — record the reason and status, and do NOT open a position.
        await db.updateRealStrategy(st.id, { lastError: String(e.message || e), lastOrderStatus: "rejected", lastRejectAt: Date.now() });
        console.error(`[autobuy] REJECTED ${st.symbol} (${st.broker}):`, e.message);
      }
    }
  } catch (e) { console.error("[autobuy] sweep failed:", e.message); }
  finally { autoBuyRunning = false; lastAutoBuy = { at: Date.now(), checked, bought, live }; }
}
if (process.env.EXIT_MONITOR !== "off") {
  setInterval(runAutoBuyEngine, 60_000);
  setTimeout(runAutoBuyEngine, 20_000);
}

/* Arm a strategy for real-money auto-buy. Requires a live broker session (so we can persist
   the creds the engine will act with). Supported brokers only. */
app.post("/api/autobuy/register", async (req, res) => {
  const sess = getBrokerSession(req);
  if (!sess) return res.status(401).json({ error: "connect the broker first" });
  const b = sess.broker;
  if (!["delta", "coindcx", "zerodha", "fyers"].includes(b)) return res.status(400).json({ error: `auto-buy isn't supported for ${b} yet` });
  const { name, symbol, brokerSym, market, cfg, notional, interval, sl, tp, tsl, yahoo, product } = req.body || {};
  if (!brokerSym || !cfg || !(Number(notional) > 0)) return res.status(400).json({ error: "brokerSym, cfg and a positive amount are required" });
  if (!Array.isArray(cfg.entry) || !cfg.entry.length) return res.status(400).json({ error: "strategy has no entry rule" });
  try {
    await persistSessionCred(sess);
    const st = {
      id: crypto.randomBytes(16).toString("hex"),
      userId: String(sess.userId), broker: b, name: name || (symbol || String(brokerSym)),
      symbol: symbol || String(brokerSym), brokerSym, market: market || "Crypto",
      cfg, notional: Number(notional), interval: interval || "5m",
      product: product || "CNC",              // "Intraday" (MIS/INTRADAY) or "Delivery/NRML" (CNC)
      sl: sl || null, tp: tp || null, tsl: tsl || null,
      yahoo: yahoo || (market === "Crypto" ? `${String(brokerSym).replace(/(USDT|USD|INR)$/i, "")}-USD` : `${String(symbol).replace(/^[A-Z]+:/, "").replace(/-EQ$/i, "")}.NS`),
      status: "active", createdAt: Date.now(), openPositionId: null,
    };
    await db.saveRealStrategy(st);
    res.json({ ok: true, id: st.id, live: autoBuyLiveOn() });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post("/api/autobuy/pause", async (req, res) => {
  const userId = req.get("X-User-Id") || req.body.userId;
  const { id, paused } = req.body || {};
  if (!userId || !id) return res.status(400).json({ error: "userId and id required" });
  const mine = (await db.getRealStrategiesForUser(userId)).find((s) => s.id === id);
  if (!mine) return res.status(404).json({ error: "not found" });
  await db.updateRealStrategy(id, { status: paused ? "paused" : "active" });
  res.json({ ok: true });
});
app.post("/api/autobuy/cancel", async (req, res) => {
  const userId = req.get("X-User-Id") || req.body.userId;
  const { id } = req.body || {};
  if (!userId || !id) return res.status(400).json({ error: "userId and id required" });
  const mine = (await db.getRealStrategiesForUser(userId)).find((s) => s.id === id);
  if (!mine) return res.status(404).json({ error: "not found" });
  await db.updateRealStrategy(id, { status: "cancelled" });
  res.json({ ok: true });
});
/* Admin flips the whole auto-buy engine LIVE / dry-run at runtime (no redeploy). */
app.post("/api/autobuy/live", async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "admin only" });
  autoBuyLiveOverride = !!(req.body && req.body.on);
  res.json({ ok: true, live: autoBuyLiveOn() });
});
app.get("/api/autobuy", async (req, res) => {
  const userId = req.get("X-User-Id") || req.query.userId;
  if (!userId) return res.status(400).json({ error: "userId required" });
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
app.listen(PORT, () => console.log(`Matrix proxy on :${PORT}`));
