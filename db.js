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
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Most hosted Postgres (Neon, Supabase, Render) require SSL:
    ssl: { rejectUnauthorized: false },
  });
}

// Create tables on boot (no-op for flat-file mode).
async function initDb() {
  if (!USING_PG) { console.log("[db] flat-file mode (set DATABASE_URL to use Postgres)"); return; }
  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    phone TEXT PRIMARY KEY, pin TEXT NOT NULL, name TEXT, created_at BIGINT)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS trades (
    id TEXT PRIMARY KEY, user_id TEXT, ts BIGINT, data JSONB)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS trades_user_ts ON trades (user_id, ts)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS app_state (
    user_id TEXT PRIMARY KEY, updated_at BIGINT, data JSONB)`);
  console.log("[db] Postgres ready");
}

/* ---------------------------- flat-file fallback --------------------------- */
const FILES = {
  trades: process.env.TRADES_FILE || path.join(__dirname, "trades.json"),
  users: process.env.USERS_FILE || path.join(__dirname, "users.json"),
  state: process.env.STATE_FILE || path.join(__dirname, "state.json"),
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
  if (USING_PG) { const r = await pool.query(`SELECT pin, name FROM users WHERE phone=$1`, [phone]); return r.rows[0] || null; }
  return readJSON(FILES.users)[phone] || null;
}
async function updateUserPin(phone, pinHash) {
  if (USING_PG) { await pool.query(`UPDATE users SET pin=$2 WHERE phone=$1`, [phone, pinHash]); return; }
  const users = readJSON(FILES.users);
  if (users[phone]) { users[phone].pin = pinHash; writeJSON(FILES.users, users); }
}
async function createUser(phone, pinHash, name) {
  if (USING_PG) { await pool.query(`INSERT INTO users (phone, pin, name, created_at) VALUES ($1,$2,$3,$4)`, [phone, pinHash, name, Date.now()]); return; }
  const users = readJSON(FILES.users);
  users[phone] = { pin: pinHash, name, createdAt: Date.now() };
  writeJSON(FILES.users, users);
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

module.exports = { initDb, saveTrade, getTrades, getUser, createUser, updateUserPin, getState, saveState, getOpenTrades, updateTrade, USING_PG };
