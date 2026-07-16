/**
 * db.js — storage layer for Matrix.
 * ---------------------------------
 * If DATABASE_URL is set (Postgres), everything is stored in Postgres and
 * survives redeploys / restarts. If it is NOT set, it transparently falls back
 * to the same flat JSON files as before — so the app works either way and you
 * flip to a real database just by adding one environment variable.
 *
 * To use Postgres:  npm install pg   and set  DATABASE_URL=postgres://...
 */
const fs = require("fs");
const path = require("path");

const USING_PG = !!process.env.DATABASE_URL;
let pool = null;

if (USING_PG) {
  const { Pool } = require("pg");
  // TLS: default lenient (unchanged) so existing deploys keep working. To harden, set
  // DB_SSL_STRICT=true; optionally provide the provider's CA bundle in DB_CA_CERT so the
  // certificate is actually verified. Neon/Supabase/Render all support this.
  const strict = String(process.env.DB_SSL_STRICT || "").toLowerCase() === "true";
  const ca = process.env.DB_CA_CERT || null;
  const ssl = strict
    ? (ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: true })
    : { rejectUnauthorized: false };
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl,
  });
}

// Create tables on boot (no-op for flat-file mode).
async function initDb() {
  if (!USING_PG) { console.log("[db] flat-file mode (set DATABASE_URL to use Postgres)"); return; }
  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    phone TEXT PRIMARY KEY, pin TEXT NOT NULL, name TEXT, created_at BIGINT)`);
  // `blocked` added after launch — ALTER is idempotent, so existing DBs pick it up.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS blocked BOOLEAN DEFAULT FALSE`);
  // Security-question recovery (set at signup). Answer is bcrypt-hashed, never plaintext.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS sec_question TEXT`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS sec_answer TEXT`);
  // Unique, user-chosen handle. Case-insensitive uniqueness via a functional index.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower ON users (LOWER(username)) WHERE username IS NOT NULL`);
  // Optional referral: the user ID of whoever referred this account (from ?ref= at signup).
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by TEXT`);
  await pool.query(`CREATE TABLE IF NOT EXISTS trades (
    id TEXT PRIMARY KEY, user_id TEXT, ts BIGINT, data JSONB)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS trades_user_ts ON trades (user_id, ts)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS app_state (
    user_id TEXT PRIMARY KEY, updated_at BIGINT, data JSONB)`);
  // Public strategies — shared across users. `owner` is the bare phone; `owner_name` is the
  // publisher's username (shown as the "created by" tag and used by the "created by" filter).
  await pool.query(`CREATE TABLE IF NOT EXISTS public_strategies (
    id TEXT PRIMARY KEY, owner TEXT, owner_name TEXT, name TEXT,
    symbols JSONB, data JSONB, created_at BIGINT)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS public_strats_created ON public_strategies (created_at DESC)`);
  // Community ideas — any signed-in user can post; everyone can browse.
  await pool.query(`CREATE TABLE IF NOT EXISTS ideas (
    id TEXT PRIMARY KEY, owner TEXT, owner_name TEXT, symbol TEXT,
    direction TEXT, note TEXT, target TEXT, stop TEXT, created_at BIGINT)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ideas_created ON ideas (created_at DESC)`);
  console.log("[db] Postgres ready");
}

/* ---------------------------- flat-file fallback --------------------------- */
const FILES = {
  trades: process.env.TRADES_FILE || path.join(__dirname, "trades.json"),
  users: process.env.USERS_FILE || path.join(__dirname, "users.json"),
  state: process.env.STATE_FILE || path.join(__dirname, "state.json"),
  public: process.env.PUBLIC_STRATS_FILE || path.join(__dirname, "public_strategies.json"),
  ideas: process.env.IDEAS_FILE || path.join(__dirname, "ideas.json"),
};
const readJSON = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return {}; } };
const writeJSON = (f, d) => { try { fs.writeFileSync(f, JSON.stringify(d)); } catch (e) { console.error("[db] write failed", e.message); } };

/* -------------------------------- trades --------------------------------- */
async function saveTrade(userId, trade) {
  const ts = trade.exitAt || trade.entryAt || Date.now();
  if (USING_PG) {
    // Upsert: the app re-posts a trade when risk orders change or when it closes.
    await pool.query(
      `INSERT INTO trades (id, user_id, ts, data) VALUES ($1,$2,$3,$4)
       ON CONFLICT (id) DO UPDATE SET ts = EXCLUDED.ts, data = EXCLUDED.data`,
      [trade.id, userId, ts, trade]
    );
    return trade;
  }
  const db = readJSON(FILES.trades);
  const list = db[userId] || [];
  const i = list.findIndex((t) => t.id === trade.id);
  if (i >= 0) list[i] = trade; else list.unshift(trade);
  db[userId] = list.slice(0, 5000);
  writeJSON(FILES.trades, db);
  return trade;
}
async function getTrades(userId, from, to) {
  if (USING_PG) {
    const r = await pool.query(
      `SELECT data FROM trades WHERE user_id=$1 AND ts>=$2 AND ts<=$3 ORDER BY ts DESC LIMIT 5000`,
      [userId, from, to]
    );
    return r.rows.map((x) => x.data);
  }
  const all = readJSON(FILES.trades)[userId] || [];
  return all.filter((t) => { const x = t.exitAt || t.entryAt || 0; return x >= from && x <= to; });
}

/* --------------------------------- users --------------------------------- */
async function getUser(phone) {
  if (USING_PG) { const r = await pool.query(`SELECT pin, name, username, referred_by FROM users WHERE phone=$1`, [phone]); const row = r.rows[0]; if (row) row.referredBy = row.referred_by; return row || null; }
  return readJSON(FILES.users)[phone] || null;
}

/* Look up a user by their chosen username (case-insensitive). Returns the phone or null.
   Used to enforce uniqueness at registration and when a user sets/changes their handle. */
async function getUserByUsername(username) {
  const u = String(username || "").trim();
  if (!u) return null;
  if (USING_PG) { const r = await pool.query(`SELECT phone FROM users WHERE LOWER(username)=LOWER($1) LIMIT 1`, [u]); return r.rows[0] ? r.rows[0].phone : null; }
  const users = readJSON(FILES.users);
  const hit = Object.entries(users).find(([, v]) => String(v.username || "").toLowerCase() === u.toLowerCase());
  return hit ? hit[0] : null;
}

/* Set (or change) a user's username. Caller must have checked uniqueness first. */
async function setUsername(phone, username) {
  const u = String(username || "").trim();
  if (USING_PG) { await pool.query(`UPDATE users SET username=$2 WHERE phone=$1`, [phone, u]); return; }
  const users = readJSON(FILES.users);
  if (users[phone]) { users[phone].username = u; writeJSON(FILES.users, users); }
}

/* The user's security QUESTION (public-ish — shown so they know what to answer). Returns
   null if the user never set one (e.g. accounts created before this feature). */
async function getSecurityQuestion(phone) {
  if (USING_PG) { const r = await pool.query(`SELECT sec_question FROM users WHERE phone=$1`, [phone]); return r.rows[0] ? (r.rows[0].sec_question || null) : null; }
  const u = readJSON(FILES.users)[phone];
  return u ? (u.secQuestion || null) : null;
}

/* The hashed security ANSWER — only pulled when verifying a reset attempt. Never sent out. */
async function getSecurityAnswerHash(phone) {
  if (USING_PG) { const r = await pool.query(`SELECT sec_answer FROM users WHERE phone=$1`, [phone]); return r.rows[0] ? (r.rows[0].sec_answer || null) : null; }
  const u = readJSON(FILES.users)[phone];
  return u ? (u.secAnswer || null) : null;
}
async function updateUserPin(phone, pinHash) {
  if (USING_PG) { await pool.query(`UPDATE users SET pin=$2 WHERE phone=$1`, [phone, pinHash]); return; }
  const users = readJSON(FILES.users);
  if (users[phone]) { users[phone].pin = pinHash; writeJSON(FILES.users, users); }
}

/* Set or change a user's security question + hashed answer (for existing accounts). */
async function updateSecurityQuestion(phone, secQuestion, secAnswerHash) {
  if (USING_PG) { await pool.query(`UPDATE users SET sec_question=$2, sec_answer=$3 WHERE phone=$1`, [phone, secQuestion, secAnswerHash]); return; }
  const users = readJSON(FILES.users);
  if (users[phone]) { users[phone].secQuestion = secQuestion; users[phone].secAnswer = secAnswerHash; writeJSON(FILES.users, users); }
}
async function createUser(phone, pinHash, name, secQuestion = null, secAnswerHash = null, username = null, referredBy = null) {
  if (USING_PG) {
    await pool.query(
      `INSERT INTO users (phone, pin, name, created_at, sec_question, sec_answer, username, referred_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [phone, pinHash, name, Date.now(), secQuestion, secAnswerHash, username, referredBy]
    );
    return;
  }
  const users = readJSON(FILES.users);
  users[phone] = { pin: pinHash, name, createdAt: Date.now(), secQuestion: secQuestion || null, secAnswer: secAnswerHash || null, username: username || null, referredBy: referredBy || null };
  writeJSON(FILES.users, users);
}

/* ---------------------------- public strategies -------------------------- */
async function publishStrategy(rec) {
  const row = { id: rec.id, owner: rec.owner, owner_name: rec.owner_name || "", name: rec.name || "Strategy", symbols: rec.symbols || [], data: rec.data || {}, created_at: rec.created_at || Date.now() };
  if (USING_PG) {
    await pool.query(
      `INSERT INTO public_strategies (id, owner, owner_name, name, symbols, data, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET owner_name=EXCLUDED.owner_name, name=EXCLUDED.name, symbols=EXCLUDED.symbols, data=EXCLUDED.data`,
      [row.id, row.owner, row.owner_name, row.name, JSON.stringify(row.symbols), JSON.stringify(row.data), row.created_at]
    );
    return row;
  }
  const all = readJSON(FILES.public);
  all[row.id] = row;
  writeJSON(FILES.public, all);
  return row;
}
async function unpublishStrategy(id, owner) {
  if (USING_PG) { await pool.query(`DELETE FROM public_strategies WHERE id=$1 AND ($2 = '' OR owner=$2)`, [id, owner || ""]); return; }
  const all = readJSON(FILES.public);
  if (all[id] && (!owner || all[id].owner === owner)) { delete all[id]; writeJSON(FILES.public, all); }
}
async function listPublicStrategies() {
  if (USING_PG) {
    const r = await pool.query(`SELECT id, owner, owner_name, name, symbols, data, created_at FROM public_strategies ORDER BY created_at DESC LIMIT 1000`);
    return r.rows.map((x) => ({ id: x.id, owner: x.owner, owner_name: x.owner_name, name: x.name, symbols: x.symbols || [], data: x.data || {}, created_at: Number(x.created_at) }));
  }
  const all = readJSON(FILES.public);
  return Object.values(all).sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
}

/* ------------------------------- ideas ----------------------------------- */
async function postIdea(rec) {
  const row = { id: rec.id, owner: rec.owner, owner_name: rec.owner_name || "", symbol: rec.symbol || "", direction: rec.direction || "Long", note: rec.note || "", target: rec.target || "", stop: rec.stop || "", created_at: rec.created_at || Date.now() };
  if (USING_PG) {
    await pool.query(
      `INSERT INTO ideas (id, owner, owner_name, symbol, direction, note, target, stop, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [row.id, row.owner, row.owner_name, row.symbol, row.direction, row.note, row.target, row.stop, row.created_at]
    );
    return row;
  }
  const all = readJSON(FILES.ideas);
  all[row.id] = row;
  writeJSON(FILES.ideas, all);
  return row;
}
async function deleteIdea(id, owner) {
  if (USING_PG) { await pool.query(`DELETE FROM ideas WHERE id=$1 AND ($2 = '' OR owner=$2)`, [id, owner || ""]); return; }
  const all = readJSON(FILES.ideas);
  if (all[id] && (!owner || all[id].owner === owner)) { delete all[id]; writeJSON(FILES.ideas, all); }
}
async function listIdeas() {
  if (USING_PG) {
    const r = await pool.query(`SELECT id, owner, owner_name, symbol, direction, note, target, stop, created_at FROM ideas ORDER BY created_at DESC LIMIT 1000`);
    return r.rows.map((x) => ({ ...x, created_at: Number(x.created_at) }));
  }
  const all = readJSON(FILES.ideas);
  return Object.values(all).sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
}

/* --------------------------------- state --------------------------------- */
async function getState(userId) {
  if (USING_PG) { const r = await pool.query(`SELECT data FROM app_state WHERE user_id=$1`, [userId]); return r.rows[0] ? r.rows[0].data : null; }
  return readJSON(FILES.state)[userId] || null;
}
async function saveState(userId, state) {
  const payload = { ...state, updatedAt: Date.now() };
  if (USING_PG) {
    await pool.query(
      `INSERT INTO app_state (user_id, updated_at, data) VALUES ($1,$2,$3)
       ON CONFLICT (user_id) DO UPDATE SET updated_at=$2, data=$3`,
      [userId, payload.updatedAt, payload]
    );
    return;
  }
  const all = readJSON(FILES.state);
  all[userId] = payload;
  writeJSON(FILES.state, all);
}

/* ----------------------- open positions (exit monitor) --------------------- */
// All still-open trades across users that carry a target/stop (so the server-side
// monitor can close them at real prices even when nobody has the app open).
async function getOpenTrades(limit = 200) {
  if (USING_PG) {
    const r = await pool.query(
      `SELECT user_id, data FROM trades
        WHERE (data->>'exitAt') IS NULL
          AND ( (data->>'tp') IS NOT NULL OR (data->>'sl') IS NOT NULL OR (data->>'tsl') IS NOT NULL )
        ORDER BY ts DESC LIMIT $1`, [limit]);
    return r.rows.map((x) => ({ userId: x.user_id, trade: x.data }));
  }
  const db = readJSON(FILES.trades);
  const out = [];
  for (const userId of Object.keys(db)) {
    for (const t of db[userId] || []) {
      if (t.exitAt == null && (t.tp || t.sl || t.tsl)) out.push({ userId, trade: t });
    }
  }
  return out.slice(0, limit);
}
async function updateTrade(userId, trade) {
  if (USING_PG) {
    await pool.query(`UPDATE trades SET data=$3, ts=$2 WHERE id=$1`,
      [trade.id, trade.exitAt || trade.entryAt || Date.now(), trade]);
    return;
  }
  const db = readJSON(FILES.trades);
  db[userId] = (db[userId] || []).map((t) => (t.id === trade.id ? trade : t));
  writeJSON(FILES.trades, db);
}

/* ------------------------------- admin ----------------------------------- */
/* List every user with their basic record (NO pin hash leaves the DB layer here —
   the admin route strips it, but we also never select it in PG). */
async function listUsers() {
  if (USING_PG) {
    const r = await pool.query(`SELECT phone, name, username, referred_by, created_at, blocked FROM users ORDER BY created_at DESC`);
    return r.rows.map((x) => ({ phone: x.phone, name: x.name, username: x.username || null, referredBy: x.referred_by || null, createdAt: x.created_at, blocked: !!x.blocked }));
  }
  const users = readJSON(FILES.users);
  return Object.entries(users).map(([phone, u]) => ({
    phone, name: u.name || "", username: u.username || null, referredBy: u.referredBy || null, createdAt: u.createdAt || null, blocked: !!u.blocked,
  })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

/* Block / unblock a user. A blocked user cannot log in (enforced in /api/login). */
async function setUserBlocked(phone, blocked) {
  if (USING_PG) {
    await pool.query(`UPDATE users SET blocked=$2 WHERE phone=$1`, [phone, !!blocked]);
    return;
  }
  const users = readJSON(FILES.users);
  if (users[phone]) { users[phone].blocked = !!blocked; writeJSON(FILES.users, users); }
}

/* Is this user blocked? Used by the login route. */
async function isUserBlocked(phone) {
  if (USING_PG) {
    const r = await pool.query(`SELECT blocked FROM users WHERE phone=$1`, [phone]);
    return r.rows[0] ? !!r.rows[0].blocked : false;
  }
  const u = readJSON(FILES.users)[phone];
  return u ? !!u.blocked : false;
}

/* Everything the admin needs about ONE user: profile, saved state (strategies +
   onboarding answers live here), and full trade history. No pin hash. */
async function getUserFull(phone) {
  const user = await getUser(phone);
  if (!user) return null;
  // The users table is keyed by the bare phone, but the app stores state + trades under the
  // "ph_"-prefixed userId (see useAuth). Look those up under the prefixed id, with a bare
  // fallback in case any older data was stored without the prefix.
  const uid = "ph_" + phone;
  const state = (await getState(uid)) || (await getState(phone));
  let trades = await getTrades(uid, 0, Date.now());
  if (!trades || !trades.length) trades = await getTrades(phone, 0, Date.now());
  const { pin, ...safeUser } = user;   // never expose the hash
  return { phone, user: safeUser, state: state || null, trades: trades || [] };
}

module.exports = { updateSecurityQuestion, getSecurityQuestion, getSecurityAnswerHash, listUsers, setUserBlocked, isUserBlocked, getUserFull, initDb, saveTrade, getTrades, getUser, createUser, updateUserPin, getState, saveState, getOpenTrades, updateTrade, getUserByUsername, setUsername, publishStrategy, unpublishStrategy, listPublicStrategies, postIdea, deleteIdea, listIdeas, USING_PG };
