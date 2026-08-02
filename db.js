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
const crypto = require("crypto");

const USING_PG = !!process.env.DATABASE_URL;
// R20-P1-03: short, stable per-user reference used to NAMESPACE trade ids so one user's row can never share
// a global primary key with another's (broker order numbers are account-scoped, not globally unique).
function userRef(userId) { return crypto.createHash("sha1").update(String(userId)).digest("hex").slice(0, 12); }
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
  // `approved` — admin must approve a new signup before it can do anything. DEFAULT TRUE so
  // EXISTING accounts stay usable; createUser inserts FALSE for genuinely new signups.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS approved BOOLEAN DEFAULT TRUE`);
  // Security-question recovery (set at signup). Answer is bcrypt-hashed, never plaintext.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS sec_question TEXT`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS sec_answer TEXT`);
  // Unique, user-chosen handle. Case-insensitive uniqueness via a functional index.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower ON users (LOWER(username)) WHERE username IS NOT NULL`);
  // Optional referral: the user ID of whoever referred this account (from ?ref= at signup).
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by TEXT`);
  // Last successful login timestamp (admin console shows it).
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login BIGINT`);
  // Optional contact email the user can add from their profile.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT`);
  // Soft-delete: when a user deletes their account we KEEP the row (login disabled) so the admin can
  // still attribute the retained trade history to a real person. `deleted_at` records when.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted BOOLEAN DEFAULT FALSE`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at BIGINT`);
  // M-02: token version — bumped on block / PIN reset / logout / deletion to revoke older 30-day tokens.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INT DEFAULT 0`);
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
  // Screenshot (data URL), optional tags (max 4), and an admin approval workflow.
  await pool.query(`ALTER TABLE ideas ADD COLUMN IF NOT EXISTS screenshot TEXT`);
  await pool.query(`ALTER TABLE ideas ADD COLUMN IF NOT EXISTS tags JSONB`);
  await pool.query(`ALTER TABLE ideas ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending'`);
  await pool.query(`ALTER TABLE ideas ADD COLUMN IF NOT EXISTS reviewed_at BIGINT`);
  /* Encrypted broker credentials — so the server-side auto-exit engine can place a real
     exit while the user's app is closed. `data` is an AES-256-GCM blob (encrypted in
     server.js); the plaintext token/keys NEVER touch this table. One row per user+broker. */
  await pool.query(`CREATE TABLE IF NOT EXISTS broker_creds (
    user_id TEXT, broker TEXT, data JSONB, updated_at BIGINT,
    PRIMARY KEY (user_id, broker))`);
  /* BRING-YOUR-OWN-APP credentials. Unlike broker_creds (which holds the short-lived
     access/refresh TOKENS), this holds the user's own API APP identity — app_id, secret and
     an optional trading PIN used to auto-refresh the daily token. Same AES-256-GCM blob shape,
     encrypted in server.js; plaintext never touches this table. One row per user+broker.
     Kept SEPARATE from broker_creds because app creds are long-lived (they don't expire daily)
     and the daily token-refresh cron reads them without needing a live session. */
  await pool.query(`CREATE TABLE IF NOT EXISTS broker_apps (
    user_id TEXT, broker TEXT, data JSONB, updated_at BIGINT,
    PRIMARY KEY (user_id, broker))`);
  /* Global admin-controlled app settings — a single row (id=1). Holds gates like
     "allow users in Real mode" and per-market "allow users to connect brokers". Read by every
     client to decide what to show; written only by an admin. */
  await pool.query(`CREATE TABLE IF NOT EXISTS app_settings (
    id INT PRIMARY KEY, data JSONB, updated_at BIGINT)`);
  /* Managed real positions the engine is watching for an exit (SL/TP/trailing + strategy
     signal). `data` holds the exit rule and entry context; `status` is open|closing|closed. */
  await pool.query(`CREATE TABLE IF NOT EXISTS managed_positions (
    id TEXT PRIMARY KEY, user_id TEXT, broker TEXT, status TEXT, updated_at BIGINT, data JSONB)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS managed_pos_status ON managed_positions (status)`);
  /* Strategies a user has ARMED for real-money auto-buy (opt-in, per strategy). The engine
     evaluates each one's entry rule and, when it fires, places a real buy + hands the exit to
     the managed-position engine. `status` is active|paused|cancelled. */
  await pool.query(`CREATE TABLE IF NOT EXISTS real_strategies (
    id TEXT PRIMARY KEY, user_id TEXT, status TEXT, updated_at BIGINT, data JSONB)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS real_strats_status ON real_strategies (status)`);
  // Row-version for optimistic, conditional lifecycle transitions (R16-P2-01). Existing rows start at 0.
  await pool.query(`ALTER TABLE real_strategies ADD COLUMN IF NOT EXISTS version BIGINT DEFAULT 0`);
  /* Durable at-most-once entry ledger (R16-P1-01). One row per (strategy, closed-candle) — the UNIQUE
     constraint means only ONE replica can ever claim a given candle's entry, even across restarts. The
     broker client-order-id derives from `client_id` here, so a timed-out order is found by the same key. */
  await pool.query(`CREATE TABLE IF NOT EXISTS order_intents (
    strategy_id TEXT, candle_key TEXT, client_id TEXT, user_id TEXT, created_at BIGINT,
    PRIMARY KEY (strategy_id, candle_key))`);
  /* Durable MANUAL-order idempotency (R16-P2-09). One row per (user, client_request_id). The first request
     claims the key; a double-tap / reload / retry with the same key replays the stored outcome instead of
     placing a second broker order. */
  await pool.query(`CREATE TABLE IF NOT EXISTS order_idempotency (
    user_id TEXT, key TEXT, response JSONB, created_at BIGINT,
    PRIMARY KEY (user_id, key))`);
  // R17-P1-02 / P2-07: request-body hash (reject key reuse with a different payload) + explicit outcome
  // status (in_flight | succeeded | rejected | unknown). An ambiguous/unknown outcome is NEVER released.
  await pool.query(`ALTER TABLE order_idempotency ADD COLUMN IF NOT EXISTS req_hash TEXT`);
  await pool.query(`ALTER TABLE order_idempotency ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'in_flight'`);
  /* Shared, restart-durable OAuth CSRF state (R16-P2-11 / R15-P2-09). One-time nonce per broker-login
     attempt, stored in Postgres so it survives restarts and is shared across replicas — a login started on
     worker A can complete its callback on worker B. Consumed atomically (DELETE ... RETURNING). */
  await pool.query(`CREATE TABLE IF NOT EXISTS oauth_states (
    nonce TEXT PRIMARY KEY, data JSONB, exp BIGINT)`);
  /* R17-P2-03 durable user notices — background jobs (e.g. delayed-fill protection) write terminal outcomes
     here so the user sees "protected / rejected / expired" even though it happened server-side while away. */
  await pool.query(`CREATE TABLE IF NOT EXISTS user_notices (
    id TEXT PRIMARY KEY, user_id TEXT, data JSONB, read BOOLEAN DEFAULT FALSE, created_at BIGINT)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS user_notices_user ON user_notices (user_id, created_at DESC)`);
  /* Delayed-fill protection watcher (R16-P2-10). A manual LIMIT entry that asked for app-managed SL/TP but
     hadn't filled within the sync window is parked here; a background sweep re-checks the broker until the
     order is terminal and, on fill, attaches the requested protection to the CONFIRMED filled quantity. */
  await pool.query(`CREATE TABLE IF NOT EXISTS pending_protection (
    id TEXT PRIMARY KEY, user_id TEXT, broker TEXT, order_id TEXT, data JSONB, attempts INT DEFAULT 0, created_at BIGINT)`);
  // R17-P1-03: a short lease so exactly ONE replica processes a pending-protection row at a time.
  await pool.query(`ALTER TABLE pending_protection ADD COLUMN IF NOT EXISTS leased_until BIGINT DEFAULT 0`);
  await pool.query(`ALTER TABLE pending_protection ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending'`);
  /* R17-P1-03 / R19-P2-06: managed positions are unique per (broker, user, entry order) — NOT globally by
     entryOrderId, or two different users/brokers with colliding order ids would block each other's protection.
     Replace any old global index with the composite one. */
  await pool.query(`DROP INDEX IF EXISTS managed_entry_order`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS managed_entry_order_composite
    ON managed_positions (broker, user_id, (data->>'entryOrderId')) WHERE (data->>'entryOrderId') IS NOT NULL`);
  /* User-built screeners ("My Screeners") — one JSON array per user, so a saved screener survives
     logout / a new device. Small, so stored whole like app_state rather than row-per-screener. */
  await pool.query(`CREATE TABLE IF NOT EXISTS user_screeners (
    user_id TEXT PRIMARY KEY, updated_at BIGINT, data JSONB)`);
  /* KILL SWITCH — per-user pause of NEW real ENTRIES (auto-buy). Protective exits keep running, so a
     halted account still gets its stop-loss/target managed. Its own tiny table so it is never clobbered
     by an app_settings save or the user-state blob (both of which overwrite wholesale). */
  await pool.query(`CREATE TABLE IF NOT EXISTS automation_flags (
    user_id TEXT PRIMARY KEY, halt_entries BOOLEAN DEFAULT false, updated_at BIGINT)`);
  /* SERVER-OWNED risk policy (R15-P1-02) — the authoritative per-user caps enforced on every real order.
     Its own table so it is never clobbered by an app_state blob save. */
  await pool.query(`CREATE TABLE IF NOT EXISTS risk_policy (
    user_id TEXT PRIMARY KEY, data JSONB, updated_at BIGINT)`);
  console.log("[db] Postgres ready");
}

/* ---------------------------- flat-file fallback --------------------------- */
const FILES = {
  trades: process.env.TRADES_FILE || path.join(__dirname, "trades.json"),
  users: process.env.USERS_FILE || path.join(__dirname, "users.json"),
  state: process.env.STATE_FILE || path.join(__dirname, "state.json"),
  public: process.env.PUBLIC_STRATS_FILE || path.join(__dirname, "public_strategies.json"),
  ideas: process.env.IDEAS_FILE || path.join(__dirname, "ideas.json"),
  creds: process.env.CREDS_FILE || path.join(__dirname, "broker_creds.json"),
  brokerApps: process.env.BROKER_APPS_FILE || path.join(__dirname, "broker_apps.json"),
  appSettings: process.env.APP_SETTINGS_FILE || path.join(__dirname, "app_settings.json"),
  managed: process.env.MANAGED_FILE || path.join(__dirname, "managed_positions.json"),
  realStrats: process.env.REAL_STRATS_FILE || path.join(__dirname, "real_strategies.json"),
  screeners: process.env.SCREENERS_FILE || path.join(__dirname, "user_screeners.json"),
  riskPolicy: process.env.RISK_POLICY_FILE || path.join(__dirname, "risk_policy.json"),
  autoFlags: process.env.AUTO_FLAGS_FILE || path.join(__dirname, "automation_flags.json"),
  idem: process.env.IDEM_FILE || path.join(__dirname, "order_idempotency.json"),
  pendingProt: process.env.PENDING_PROT_FILE || path.join(__dirname, "pending_protection.json"),
  notices: process.env.NOTICES_FILE || path.join(__dirname, "user_notices.json"),
  tradeArch: process.env.TRADE_ARCH_FILE || path.join(__dirname, "trade_archives.json"),
};
const readJSON = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return {}; } };
/* M-06: atomic write — serialise to a temp file then rename (rename is atomic on the same filesystem), so a
   crash mid-write can't leave a truncated/corrupt JSON store. Propagates failure instead of only logging, so
   a caller that must persist (e.g. a trade) sees the error rather than a silent loss. NOTE: the flat-file
   store is a DEV/fallback only and is still race-prone under concurrency — real trading requires Postgres
   (the startup check warns when DATABASE_URL is unset). */
const writeJSON = (f, d) => {
  const tmp = `${f}.${process.pid}.${Date.now()}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify(d)); fs.renameSync(tmp, f); }
  catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    console.error("[db] write failed", e.message);
    // R20-P2-13: actually PROPAGATE the failure. A swallowed write let saveTrade() return success while a real
    // trade was silently lost. Callers that must persist (trades, users) now see the error and can fail closed.
    throw e;
  }
};

/* -------------------------------- trades --------------------------------- */
async function saveTrade(userId, trade) {
  const uref = userRef(userId);
  /* R19 + R20-P1-03: a single REAL broker fill must never appear twice, AND one user's row must never be able
     to collide with (or overwrite) another user's. So the STORED id is always NAMESPACED by the user:
       - real trade with a broker orderId → deterministic `t_<uref>_ord_<broker>_<orderId>` (server row and the
         browser's own row for the same fill collapse to ONE; and user A's orderId 123 can't touch user B's).
       - anything else → the caller's id, but hard-prefixed with `t_<uref>_` so a client-chosen id can never
         address another user's row. Idempotent: an already-namespaced id is left as-is. */
  const nsPrefix = `t_${uref}_`;
  let sid;
  if (trade && trade.real && trade.orderId != null && String(trade.orderId) !== "") {
    const brk = String(trade.broker || "x").toLowerCase().replace(/[^a-z0-9]/g, "");
    sid = `${nsPrefix}ord_${brk}_${String(trade.orderId)}`;
  } else {
    const raw = String((trade && trade.id) || crypto.randomUUID());
    sid = raw.startsWith(nsPrefix) ? raw : `${nsPrefix}${raw}`;
  }
  trade = { ...trade, id: sid };
  const ts = trade.exitAt || trade.entryAt || Date.now();
  if (USING_PG) {
    /* Ownership-safe upsert: only update a row that ALREADY belongs to this user. The namespaced id makes a
       cross-user collision practically impossible, and this WHERE clause is the belt-and-suspenders guarantee
       that a write can never mutate another account's row. RETURNING tells us the upsert actually applied. */
    const r = await pool.query(
      `INSERT INTO trades (id, user_id, ts, data) VALUES ($1,$2,$3,$4)
       ON CONFLICT (id) DO UPDATE SET ts = EXCLUDED.ts, data = EXCLUDED.data
       WHERE trades.user_id = EXCLUDED.user_id
       RETURNING id`,
      [trade.id, userId, ts, trade]
    );
    if (!r.rowCount) {
      /* The id exists but is owned by a DIFFERENT user (should be impossible with namespacing, but never lose a
         write or clobber): re-key to a fresh user-namespaced id and insert. Log LOUDLY — hitting this means a
         namespacing assumption was violated and the row can no longer dedupe by orderId. */
      console.error(JSON.stringify({ lvl: "fin", evt: "saveTrade_rekey_on_owner_conflict", user: uref, orderId: trade && trade.orderId, sym: trade && trade.sym }));
      trade = { ...trade, id: `${nsPrefix}${crypto.randomUUID()}` };
      const rr = await pool.query(`INSERT INTO trades (id, user_id, ts, data) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`, [trade.id, userId, ts, trade]);
      if (!rr.rowCount) console.error(JSON.stringify({ lvl: "fin", evt: "saveTrade_rekey_insert_dropped", user: uref, id: trade.id }));
    }
    return trade;
  }
  // Flat-file mode is already partitioned by user bucket, so cross-user collision is structurally impossible.
  const db = readJSON(FILES.trades);
  const list = db[userId] || [];
  const i = list.findIndex((t) => t.id === trade.id);
  if (i >= 0) list[i] = trade; else list.unshift(trade);
  db[userId] = list.slice(0, 5000);
  writeJSON(FILES.trades, db);
  return trade;
}
/* Delete specific trades by their id (scoped to the user). Used by the Delta reconcile to drop phantom
   OPEN real journal records the broker doesn't actually hold. Returns how many were removed. */
async function deleteTradesByIds(userId, ids) {
  const list = (ids || []).map(String).filter(Boolean);
  if (!list.length) return 0;
  if (USING_PG) {
    const r = await pool.query(`DELETE FROM trades WHERE user_id=$1 AND id = ANY($2::text[])`, [userId, list]);
    return r.rowCount || 0;
  }
  const db = readJSON(FILES.trades);
  const arr = db[userId] || [];
  const set = new Set(list);
  const before = arr.length;
  db[userId] = arr.filter((t) => !(t && set.has(String(t.id))));
  writeJSON(FILES.trades, db);
  return before - db[userId].length;
}
/* R17-P2-06: when a soft-deleted phone number is REUSED by a new registration, the previous account's
   retained trades must NOT stay under the live phone-derived key (or the new person would load them). We
   REASSIGN them to an opaque archive key and record it, so the new account starts clean while admin can
   still retrieve the historical trades for that number. */
async function reassignTrades(fromUserId, toUserId) {
  if (USING_PG) { const r = await pool.query(`UPDATE trades SET user_id=$2 WHERE user_id=$1`, [String(fromUserId), String(toUserId)]); return r.rowCount || 0; }
  const d = readJSON(FILES.trades); const arr = d[String(fromUserId)] || []; if (!arr.length) return 0; d[String(toUserId)] = (d[String(toUserId)] || []).concat(arr); delete d[String(fromUserId)]; writeJSON(FILES.trades, d); return arr.length;
}
async function recordTradeArchive(phone, archiveKey) {
  if (USING_PG) { await pool.query(`CREATE TABLE IF NOT EXISTS trade_archives (archive_key TEXT PRIMARY KEY, phone TEXT, created_at BIGINT)`).catch(() => {}); await pool.query(`INSERT INTO trade_archives (archive_key, phone, created_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [String(archiveKey), String(phone), Date.now()]).catch(() => {}); return; }
  const f = FILES.tradeArch || (FILES.tradeArch = path.join(__dirname, "trade_archives.json")); const d = readJSON(f); (d[String(phone)] = d[String(phone)] || []).push({ archiveKey: String(archiveKey), createdAt: Date.now() }); writeJSON(f, d);
}
async function getArchivedTradesForPhone(phone) {
  if (USING_PG) {
    const a = await pool.query(`SELECT archive_key FROM trade_archives WHERE phone=$1`, [String(phone)]).catch(() => ({ rows: [] }));
    let out = [];
    for (const row of a.rows) { const t = await getTrades(row.archive_key, 0, Date.now()).catch(() => []); out = out.concat((t || []).map((x) => ({ ...x, archived: true }))); }
    return out;
  }
  const f = FILES.tradeArch || (FILES.tradeArch = path.join(__dirname, "trade_archives.json")); const keys = (readJSON(f)[String(phone)] || []).map((x) => x.archiveKey);
  let out = []; for (const k of keys) { const t = await getTrades(k, 0, Date.now()).catch(() => []); out = out.concat((t || []).map((x) => ({ ...x, archived: true }))); } return out;
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
/* Delete only the user's VIRTUAL (paper) trades — real broker trades are never touched. A trade is
   "real" when data.real is true; everything else is a paper trade and gets removed. Returns how many
   rows were deleted. Scoped strictly to the passed userId, so a user can only clear their own book. */
async function clearVirtualTrades(userId) {
  if (USING_PG) {
    const r = await pool.query(
      `DELETE FROM trades WHERE user_id=$1 AND COALESCE((data->>'real')::boolean, false) = false`,
      [userId]
    );
    return r.rowCount || 0;
  }
  const db = readJSON(FILES.trades);
  const arr = db[userId] || [];
  const before = arr.length;
  db[userId] = arr.filter((t) => t && t.real === true);   // keep real trades only
  writeJSON(FILES.trades, db);
  return before - db[userId].length;
}

/* Clear ONE trade type's history for a user — Manual / Auto Buy / Screener Auto Buy / Automate.
   `scope` selects which books to clear: "virtual" (default, paper only — real trades never touched),
   "real" (only real broker journal entries), or "all" (both). This only wipes JOURNAL rows shown in the
   dashboard/history — it does NOT touch the broker or the server's managed positions / armed strategies,
   so it's a safe display reset (used to drop phantom/duplicate journal records). */
async function clearTradesByType(userId, tradeType, scope = "virtual") {
  const tt = String(tradeType || "");
  const sc = scope === "real" || scope === "all" ? scope : "virtual";
  // Predicate on a trade's realness that matches the requested scope.
  const scopeMatchJS = (t) => sc === "all" ? true : sc === "real" ? (t.real === true) : (t.real !== true);
  if (USING_PG) {
    // COALESCE((data->>'real')::boolean,false): true=real, false=virtual.
    const realCond = sc === "all" ? "" : sc === "real"
      ? "AND COALESCE((data->>'real')::boolean, false) = true"
      : "AND COALESCE((data->>'real')::boolean, false) = false";
    const r = await pool.query(
      `DELETE FROM trades WHERE user_id=$1 ${realCond} AND COALESCE(data->>'tradeType','Manual') = $2`,
      [userId, tt]
    );
    return r.rowCount || 0;
  }
  const db = readJSON(FILES.trades);
  const arr = db[userId] || [];
  const before = arr.length;
  db[userId] = arr.filter((t) => !(t && scopeMatchJS(t) && (t.tradeType || "Manual") === tt));
  writeJSON(FILES.trades, db);
  return before - db[userId].length;
}

/* --------------------------------- users --------------------------------- */
async function getUser(phone) {
  if (USING_PG) { const r = await pool.query(`SELECT pin, name, username, referred_by, email, last_login, created_at, blocked, approved, deleted, deleted_at, token_version FROM users WHERE phone=$1`, [phone]); const row = r.rows[0]; if (row) { row.referredBy = row.referred_by; row.lastLogin = row.last_login ? Number(row.last_login) : null; row.createdAt = row.created_at ? Number(row.created_at) : null; row.deleted = !!row.deleted; row.deletedAt = row.deleted_at ? Number(row.deleted_at) : null; row.tokenVersion = Number(row.token_version) || 0; } return row || null; }
  const u = readJSON(FILES.users)[phone]; if (u) u.tokenVersion = Number(u.tokenVersion) || 0; return u || null;
}
// Approve (or un-approve) a pending signup.
async function setUserApproved(phone, approved) {
  if (USING_PG) { await pool.query(`UPDATE users SET approved=$2 WHERE phone=$1`, [phone, !!approved]); return; }
  const users = readJSON(FILES.users);
  if (users[phone]) { users[phone].approved = !!approved; writeJSON(FILES.users, users); }
}
/* R20-P2-01: UN-approval is a single financial kill — flip approval AND rotate token_version in ONE atomic
   write, so the API can't return success with tokens still valid. Returns the new token version. (Entry-halt
   lives in a separate store; the route sets it and fails closed if that write can't be persisted.) */
async function unapproveUserAndRevoke(phone) {
  if (USING_PG) {
    const r = await pool.query(`UPDATE users SET approved=FALSE, token_version=COALESCE(token_version,0)+1 WHERE phone=$1 RETURNING token_version`, [phone]);
    return r.rows[0] ? (Number(r.rows[0].token_version) || 0) : 0;
  }
  const users = readJSON(FILES.users);
  if (users[phone]) { users[phone].approved = false; users[phone].tokenVersion = (Number(users[phone].tokenVersion) || 0) + 1; writeJSON(FILES.users, users); return users[phone].tokenVersion; }
  return 0;
}
// Accounts awaiting approval, for the admin console.
async function listPendingUsers(limit = 200) {
  if (USING_PG) { const r = await pool.query(`SELECT phone, name, username, created_at FROM users WHERE approved IS NOT TRUE AND deleted IS NOT TRUE ORDER BY created_at DESC LIMIT $1`, [limit]); return r.rows.map((u) => ({ phone: u.phone, name: u.name, username: u.username, createdAt: u.created_at ? Number(u.created_at) : null })); }
  return Object.entries(readJSON(FILES.users)).filter(([, u]) => u.approved !== true && !u.deleted).map(([phone, u]) => ({ phone, name: u.name, username: u.username, createdAt: u.createdAt || null })).slice(0, limit);
}

/* Set (or change) a user's email. Free-form; validated at the route. */
async function setEmail(phone, email) {
  const e = String(email || "").trim();
  if (USING_PG) { await pool.query(`UPDATE users SET email=$2 WHERE phone=$1`, [phone, e]); return; }
  const users = readJSON(FILES.users);
  if (users[phone]) { users[phone].email = e; writeJSON(FILES.users, users); }
}

/* Record the moment of a successful login (admin console shows it). */
async function setLastLogin(phone, ts = Date.now()) {
  if (USING_PG) { await pool.query(`UPDATE users SET last_login=$2 WHERE phone=$1`, [phone, ts]); return; }
  const users = readJSON(FILES.users);
  if (users[phone]) { users[phone].lastLogin = ts; writeJSON(FILES.users, users); }
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
/* M-02: bump the token version so every existing 30-day token for this account is immediately rejected on
   sensitive routes. Called on block, PIN reset, logout and deletion. */
async function bumpTokenVersion(phone) {
  if (USING_PG) { await pool.query(`UPDATE users SET token_version = COALESCE(token_version,0)+1 WHERE phone=$1`, [phone]).catch(() => {}); return; }
  const users = readJSON(FILES.users); if (users[phone]) { users[phone].tokenVersion = (Number(users[phone].tokenVersion) || 0) + 1; writeJSON(FILES.users, users); }
}
async function getTokenVersion(phone) {
  if (USING_PG) { const r = await pool.query(`SELECT token_version FROM users WHERE phone=$1`, [phone]); return r.rows[0] ? (Number(r.rows[0].token_version) || 0) : 0; }
  return Number((readJSON(FILES.users)[phone] || {}).tokenVersion) || 0;
}
async function updateUserPin(phone, pinHash) {
  if (USING_PG) { await pool.query(`UPDATE users SET pin=$2 WHERE phone=$1`, [phone, pinHash]); return; }
  const users = readJSON(FILES.users);
  if (users[phone]) { users[phone].pin = pinHash; writeJSON(FILES.users, users); }
}

/* R19-P2-01 / H3-04: change the PIN and revoke existing sessions ATOMICALLY, returning the new token
   version. A two-call sequence (updateUserPin then bumpTokenVersion) can leave a window where the PIN
   is changed but old tokens still validate — or crash between the two writes. One statement / one file
   write closes that gap. Returns the fresh token_version so the caller can re-sign immediately. */
async function updateUserPinAndBumpToken(phone, pinHash) {
  if (USING_PG) {
    const r = await pool.query(
      `UPDATE users SET pin=$2, token_version = COALESCE(token_version,0)+1 WHERE phone=$1 RETURNING token_version`,
      [phone, pinHash]
    );
    return r.rows[0] ? (Number(r.rows[0].token_version) || 0) : 0;
  }
  const users = readJSON(FILES.users);
  if (users[phone]) {
    users[phone].pin = pinHash;
    users[phone].tokenVersion = (Number(users[phone].tokenVersion) || 0) + 1;
    writeJSON(FILES.users, users);
    return users[phone].tokenVersion;
  }
  return 0;
}

/* Set or change a user's security question + hashed answer (for existing accounts). */
async function updateSecurityQuestion(phone, secQuestion, secAnswerHash) {
  if (USING_PG) { await pool.query(`UPDATE users SET sec_question=$2, sec_answer=$3 WHERE phone=$1`, [phone, secQuestion, secAnswerHash]); return; }
  const users = readJSON(FILES.users);
  if (users[phone]) { users[phone].secQuestion = secQuestion; users[phone].secAnswer = secAnswerHash; writeJSON(FILES.users, users); }
}
async function createUser(phone, pinHash, name, secQuestion = null, secAnswerHash = null, username = null, referredBy = null, approved = false) {
  if (USING_PG) {
    // Upsert: a fresh signup inserts; a signup reusing a soft-deleted number overwrites the dead stub and
    // clears the deleted flag (its old trade history stays under the same user_id).
    await pool.query(
      `INSERT INTO users (phone, pin, name, created_at, sec_question, sec_answer, username, referred_by, approved, blocked, deleted, deleted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,FALSE,FALSE,NULL)
       ON CONFLICT (phone) DO UPDATE SET pin=EXCLUDED.pin, name=EXCLUDED.name, created_at=EXCLUDED.created_at,
         sec_question=EXCLUDED.sec_question, sec_answer=EXCLUDED.sec_answer, username=EXCLUDED.username,
         referred_by=EXCLUDED.referred_by, approved=EXCLUDED.approved, blocked=FALSE, deleted=FALSE, deleted_at=NULL`,
      [phone, pinHash, name, Date.now(), secQuestion, secAnswerHash, username, referredBy, !!approved]
    );
    return;
  }
  const users = readJSON(FILES.users);
  users[phone] = { pin: pinHash, name, createdAt: Date.now(), secQuestion: secQuestion || null, secAnswer: secAnswerHash || null, username: username || null, referredBy: referredBy || null, approved: !!approved, blocked: false, deleted: false, deletedAt: null };
  writeJSON(FILES.users, users);
}

/* Delete an account and all of its ACTIVE data, but by default RETAIN the trade history so the admin can
   still audit it (product requirement). The account is soft-deleted: the login is disabled (PIN cleared,
   approval revoked, `deleted` flagged) and every sensitive/live artefact is purged — broker credentials,
   broker apps, live positions, armed strategies, risk policy, automation flags, saved screeners, app state,
   ideas and published strategies — but the `users` stub and the `trades` rows survive so the retained
   history stays attributable to a real person.
   Pass { preserveTrades: false } for a genuine right-to-erasure that also wipes the trade history and the
   user row entirely.
   `userId` is the per-user storage key (trades/state/creds); `phone` is the login key. */
async function deleteAccount(userId, phone, { preserveTrades = true } = {}) {
  const uid = String(userId), ph = String(phone);
  if (USING_PG) {
    if (!preserveTrades) await pool.query(`DELETE FROM trades WHERE user_id=$1`, [uid]).catch(() => {});
    await pool.query(`DELETE FROM app_state WHERE user_id=$1`, [uid]).catch(() => {});
    await pool.query(`DELETE FROM broker_creds WHERE user_id=$1`, [uid]).catch(() => {});
    await pool.query(`DELETE FROM broker_apps WHERE user_id=$1`, [uid]).catch(() => {});
    await pool.query(`DELETE FROM managed_positions WHERE user_id=$1`, [uid]).catch(() => {});
    await pool.query(`DELETE FROM real_strategies WHERE user_id=$1`, [uid]).catch(() => {});
    await pool.query(`DELETE FROM risk_policy WHERE user_id=$1`, [uid]).catch(() => {});
    await pool.query(`DELETE FROM automation_flags WHERE user_id=$1`, [uid]).catch(() => {});
    await pool.query(`DELETE FROM user_screeners WHERE user_id=$1`, [uid]).catch(() => {});
    await pool.query(`DELETE FROM ideas WHERE owner=$1`, [uid]).catch(() => {});
    await pool.query(`DELETE FROM public_strategies WHERE owner=$1`, [uid]).catch(() => {});
    await purgeLedgersForUser(uid).catch(() => {});   // R17-P2-09: drop order-intent/idempotency/protection rows
    if (preserveTrades) {
      // Keep the stub (so admin can still see the retained history) but make the account unusable. Bump the
      // token version (M-02) so every existing token for this account is revoked immediately — and, since a
      // re-registration on a recycled number inherits this higher version, the PREVIOUS owner's un-expired
      // token can never validate against the new account.
      await pool.query(
        `UPDATE users SET pin='', approved=FALSE, blocked=TRUE, deleted=TRUE, deleted_at=$2, token_version=COALESCE(token_version,0)+1 WHERE phone=$1`,
        [ph, Date.now()]
      ).catch(() => {});
    } else {
      await pool.query(`DELETE FROM users WHERE phone=$1`, [ph]).catch(() => {});
    }
    return;
  }
  const dropByUser = (file, key = "user_id") => {
    const d = readJSON(file); let changed = false;
    for (const k of Object.keys(d)) { const r = d[k]; if (r && (String(r[key]) === uid || String(r.userId) === uid || String(r.owner) === uid)) { delete d[k]; changed = true; } }
    if (changed) writeJSON(file, d);
  };
  if (!preserveTrades) dropByUser(FILES.trades);
  dropByUser(FILES.creds); dropByUser(FILES.brokerApps);
  dropByUser(FILES.managed); dropByUser(FILES.realStrats); dropByUser(FILES.ideas, "owner"); dropByUser(FILES.public, "owner");
  // Config stores keyed directly by uid.
  for (const f of [FILES.riskPolicy, FILES.autoFlags, FILES.screeners]) { const d = readJSON(f); if (d[uid]) { delete d[uid]; writeJSON(f, d); } }
  await purgeLedgersForUser(uid).catch(() => {});   // R17-P2-09
  const st = readJSON(FILES.state); if (st[uid]) { delete st[uid]; writeJSON(FILES.state, st); }
  const users = readJSON(FILES.users);
  if (users[ph]) {
    if (preserveTrades) { users[ph] = { ...users[ph], pin: "", approved: false, blocked: true, deleted: true, deletedAt: Date.now(), tokenVersion: (Number(users[ph].tokenVersion) || 0) + 1 }; }   // M-02: revoke old tokens
    else { delete users[ph]; }
    writeJSON(FILES.users, users);
  }
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
  const row = { id: rec.id, owner: rec.owner, owner_name: rec.owner_name || "", symbol: rec.symbol || "", direction: rec.direction || "Long", note: rec.note || "", target: rec.target || "", stop: rec.stop || "", created_at: rec.created_at || Date.now(), tags: Array.isArray(rec.tags) ? rec.tags.slice(0, 4) : [], screenshot: rec.screenshot || null, status: rec.status || "pending", reviewed_at: null };
  if (USING_PG) {
    await pool.query(
      `INSERT INTO ideas (id, owner, owner_name, symbol, direction, note, target, stop, created_at, tags, screenshot, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [row.id, row.owner, row.owner_name, row.symbol, row.direction, row.note, row.target, row.stop, row.created_at, JSON.stringify(row.tags), row.screenshot, row.status]
    );
    return row;
  }
  const all = readJSON(FILES.ideas);
  all[row.id] = row;
  writeJSON(FILES.ideas, all);
  return row;
}
/* Admin approve/reject: set status ('approved'|'rejected') + reviewed timestamp. */
async function reviewIdea(id, status) {
  if (USING_PG) { await pool.query(`UPDATE ideas SET status=$2, reviewed_at=$3 WHERE id=$1`, [id, status, Date.now()]); return; }
  const all = readJSON(FILES.ideas);
  if (all[id]) { all[id].status = status; all[id].reviewed_at = Date.now(); writeJSON(FILES.ideas, all); }
}
async function deleteIdea(id, owner) {
  if (USING_PG) { await pool.query(`DELETE FROM ideas WHERE id=$1 AND ($2 = '' OR owner=$2)`, [id, owner || ""]); return; }
  const all = readJSON(FILES.ideas);
  if (all[id] && (!owner || all[id].owner === owner)) { delete all[id]; writeJSON(FILES.ideas, all); }
}
/* The list NEVER returns the base64 `screenshot` blob — that was the single biggest source of DB
   egress (up to 1000 data-URLs per request). Instead it returns a `has_screenshot` flag; the client
   lazy-loads each image from /api/ideas/:id/screenshot only for the cards it actually renders. */
async function listIdeas() {
  if (USING_PG) {
    const r = await pool.query(`SELECT id, owner, owner_name, symbol, direction, note, target, stop, created_at, tags, status, (screenshot IS NOT NULL) AS has_screenshot FROM ideas ORDER BY created_at DESC LIMIT 400`);
    return r.rows.map((x) => ({ ...x, created_at: Number(x.created_at), tags: x.tags || [], status: x.status || "approved", hasScreenshot: !!x.has_screenshot }));
  }
  const all = readJSON(FILES.ideas);
  return Object.values(all).map((x) => { const { screenshot, ...rest } = x; return { ...rest, tags: x.tags || [], status: x.status || "approved", hasScreenshot: !!screenshot }; }).sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
}
/* Fetch ONE idea's screenshot on demand (data-URL string or null). Keeps the heavy blob out of the list. */
async function getIdeaScreenshot(id) {
  if (USING_PG) {
    const r = await pool.query(`SELECT screenshot FROM ideas WHERE id=$1`, [String(id)]);
    return r.rows[0] ? (r.rows[0].screenshot || null) : null;
  }
  const all = readJSON(FILES.ideas);
  return all[id] ? (all[id].screenshot || null) : null;
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

/* ----------------------- user screeners ("My Screeners") ------------------- */
async function getScreeners(userId) {
  if (USING_PG) { const r = await pool.query(`SELECT data FROM user_screeners WHERE user_id=$1`, [userId]); return (r.rows[0] && Array.isArray(r.rows[0].data)) ? r.rows[0].data : []; }
  const v = readJSON(FILES.screeners)[userId]; return Array.isArray(v) ? v : [];
}
async function saveScreeners(userId, list) {
  const arr = Array.isArray(list) ? list : [];
  if (USING_PG) {
    await pool.query(
      `INSERT INTO user_screeners (user_id, updated_at, data) VALUES ($1,$2,$3)
       ON CONFLICT (user_id) DO UPDATE SET updated_at=$2, data=$3`,
      [userId, Date.now(), JSON.stringify(arr)]
    );
    return;
  }
  const all = readJSON(FILES.screeners); all[userId] = arr; writeJSON(FILES.screeners, all);
}

/* ----------------------- kill switch (halt new real entries) ---------------- */
async function setEntryHalt(userId, halt) {
  const u = String(userId), on = !!halt, now = Date.now();
  if (USING_PG) {
    await pool.query(
      `INSERT INTO automation_flags (user_id, halt_entries, updated_at) VALUES ($1,$2,$3)
       ON CONFLICT (user_id) DO UPDATE SET halt_entries=$2, updated_at=$3`,
      [u, on, now]
    );
    return;
  }
  const all = readJSON(FILES.autoFlags); all[u] = { halt_entries: on, updated_at: now }; writeJSON(FILES.autoFlags, all);
}
async function getHaltedEntryUsers() {
  if (USING_PG) { const r = await pool.query(`SELECT user_id FROM automation_flags WHERE halt_entries=true`); return r.rows.map((x) => x.user_id); }
  const all = readJSON(FILES.autoFlags); return Object.keys(all).filter((u) => all[u] && all[u].halt_entries);
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
    const r = await pool.query(`SELECT phone, name, username, referred_by, email, created_at, last_login, blocked, approved, deleted, deleted_at FROM users ORDER BY created_at DESC`);
    return r.rows.map((x) => ({ phone: x.phone, name: x.name, username: x.username || null, referredBy: x.referred_by || null, email: x.email || null, createdAt: x.created_at ? Number(x.created_at) : null, lastLogin: x.last_login ? Number(x.last_login) : null, blocked: !!x.blocked, approved: x.approved !== false, deleted: !!x.deleted, deletedAt: x.deleted_at ? Number(x.deleted_at) : null }));
  }
  const users = readJSON(FILES.users);
  return Object.entries(users).map(([phone, u]) => ({
    phone, name: u.name || "", username: u.username || null, referredBy: u.referredBy || null, email: u.email || null, createdAt: u.createdAt || null, lastLogin: u.lastLogin || null, blocked: !!u.blocked, approved: u.approved !== false, deleted: !!u.deleted, deletedAt: u.deletedAt || null,
  })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

/* Block / unblock a user. A blocked user cannot log in (enforced in /api/login). */
async function setUserBlocked(phone, blocked) {
  if (USING_PG) {
    // M-02: blocking also bumps the token version so existing tokens are revoked on sensitive routes.
    await pool.query(`UPDATE users SET blocked=$2${blocked ? ", token_version = COALESCE(token_version,0)+1" : ""} WHERE phone=$1`, [phone, !!blocked]);
    return;
  }
  const users = readJSON(FILES.users);
  if (users[phone]) { users[phone].blocked = !!blocked; if (blocked) users[phone].tokenVersion = (Number(users[phone].tokenVersion) || 0) + 1; writeJSON(FILES.users, users); }
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
  // R17-P2-06: include trades archived when this number was recycled, so admin audit still sees them.
  try { const archived = await getArchivedTradesForPhone(phone); if (archived && archived.length) trades = (trades || []).concat(archived); } catch { /* non-fatal */ }
  const { pin, ...safeUser } = user;   // never expose the hash
  return { phone, user: safeUser, state: state || null, trades: trades || [] };
}

/* ----------------------- encrypted broker credentials ----------------------- */
async function saveBrokerCred(userId, broker, blob) {
  const now = Date.now();
  if (USING_PG) {
    await pool.query(
      `INSERT INTO broker_creds (user_id, broker, data, updated_at) VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id, broker) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
      [String(userId), broker, blob, now]
    );
    return;
  }
  const db = readJSON(FILES.creds);
  db[`${userId}:${broker}`] = { user_id: String(userId), broker, data: blob, updated_at: now };
  writeJSON(FILES.creds, db);
}
async function getBrokerCred(userId, broker) {
  if (USING_PG) {
    const r = await pool.query(`SELECT data FROM broker_creds WHERE user_id=$1 AND broker=$2`, [String(userId), broker]);
    return r.rows[0] ? r.rows[0].data : null;
  }
  const row = readJSON(FILES.creds)[`${userId}:${broker}`];
  return row ? row.data : null;
}
async function deleteBrokerCred(userId, broker) {
  if (USING_PG) { await pool.query(`DELETE FROM broker_creds WHERE user_id=$1 AND broker=$2`, [String(userId), broker]); return; }
  const db = readJSON(FILES.creds);
  delete db[`${userId}:${broker}`];
  writeJSON(FILES.creds, db);
}

/* ---------------- bring-your-own-app credentials (app_id/secret/pin) ---------------- */
async function saveBrokerApp(userId, broker, blob) {
  const now = Date.now();
  if (USING_PG) {
    await pool.query(
      `INSERT INTO broker_apps (user_id, broker, data, updated_at) VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id, broker) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
      [String(userId), broker, blob, now]
    );
    return;
  }
  const db = readJSON(FILES.brokerApps);
  db[`${userId}:${broker}`] = { user_id: String(userId), broker, data: blob, updated_at: now };
  writeJSON(FILES.brokerApps, db);
}
async function getBrokerApp(userId, broker) {
  if (USING_PG) {
    const r = await pool.query(`SELECT data FROM broker_apps WHERE user_id=$1 AND broker=$2`, [String(userId), broker]);
    return r.rows[0] ? r.rows[0].data : null;
  }
  const row = readJSON(FILES.brokerApps)[`${userId}:${broker}`];
  return row ? row.data : null;
}
/* Every stored app cred, for cache warm-up on boot and the daily token-refresh cron. */
async function getAllBrokerApps() {
  if (USING_PG) {
    const r = await pool.query(`SELECT user_id, broker, data FROM broker_apps`);
    return r.rows.map((x) => ({ userId: x.user_id, broker: x.broker, data: x.data }));
  }
  return Object.values(readJSON(FILES.brokerApps)).map((x) => ({ userId: x.user_id, broker: x.broker, data: x.data }));
}
async function deleteBrokerApp(userId, broker) {
  if (USING_PG) { await pool.query(`DELETE FROM broker_apps WHERE user_id=$1 AND broker=$2`, [String(userId), broker]); return; }
  const db = readJSON(FILES.brokerApps);
  delete db[`${userId}:${broker}`];
  writeJSON(FILES.brokerApps, db);
}

/* ------------------------- global admin app settings ------------------------ */
async function getAppSettings() {
  if (USING_PG) {
    const r = await pool.query(`SELECT data FROM app_settings WHERE id=1`);
    return r.rows[0] ? r.rows[0].data : null;
  }
  const row = readJSON(FILES.appSettings);
  return (row && row.data) ? row.data : null;
}
async function saveAppSettings(obj) {
  const now = Date.now();
  if (USING_PG) {
    await pool.query(
      `INSERT INTO app_settings (id, data, updated_at) VALUES (1,$1,$2)
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
      [obj, now]
    );
    return obj;
  }
  writeJSON(FILES.appSettings, { data: obj, updated_at: now });
  return obj;
}

/* ------------------------- managed real positions --------------------------- */
async function saveManagedPosition(pos) {
  const now = Date.now();
  if (USING_PG) {
    await pool.query(
      `INSERT INTO managed_positions (id, user_id, broker, status, updated_at, data) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, updated_at = EXCLUDED.updated_at, data = EXCLUDED.data`,
      [pos.id, String(pos.userId), pos.broker, pos.status || "open", now, pos]
    );
    return pos;
  }
  const db = readJSON(FILES.managed);
  db[pos.id] = { ...pos, updated_at: now };
  writeJSON(FILES.managed, db);
  return pos;
}
async function getOpenManagedPositions(limit = 500) {
  if (USING_PG) {
    const r = await pool.query(`SELECT data FROM managed_positions WHERE status IN ('open','closing') ORDER BY updated_at ASC LIMIT $1`, [limit]);
    return r.rows.map((x) => x.data);
  }
  return Object.values(readJSON(FILES.managed)).filter((p) => p.status === "open" || p.status === "closing").slice(0, limit);
}
async function getManagedPositionsForUser(userId, limit = 200) {
  if (USING_PG) {
    const r = await pool.query(`SELECT data FROM managed_positions WHERE user_id=$1 ORDER BY updated_at DESC LIMIT $2`, [String(userId), limit]);
    return r.rows.map((x) => x.data);
  }
  return Object.values(readJSON(FILES.managed)).filter((p) => String(p.userId) === String(userId)).slice(0, limit);
}
/* R14-P1-03: ATOMICALLY claim an OPEN managed position for exit (open → closing). Returns the updated row
   to the SINGLE winner, or null to everyone else (already closing/closed). This is the compare-and-set the
   exit engine + Close Now route need so two overlapping actions can't both submit a SELL. In Postgres it's
   a conditional UPDATE (`WHERE status='open'`); in single-threaded flat-file mode the read-check-write runs
   without interleaving, so it is equally atomic. */
async function claimManagedForExit(id, patch = {}) {
  if (USING_PG) {
    const r = await pool.query(`SELECT data FROM managed_positions WHERE id=$1 AND status='open'`, [id]);
    // Do the conditional write in one statement so concurrent callers can't both win.
    const upd = await pool.query(
      `UPDATE managed_positions SET status='closing', updated_at=$2, data = data || $3::jsonb
       WHERE id=$1 AND status='open' RETURNING data`,
      [id, Date.now(), JSON.stringify({ ...patch, status: "closing" })]
    );
    return upd.rows[0] ? upd.rows[0].data : null;
  }
  const db = readJSON(FILES.managed);
  const cur = db[id];
  if (!cur || cur.status !== "open") return null;
  db[id] = { ...cur, ...patch, status: "closing", updated_at: Date.now() };
  writeJSON(FILES.managed, db);
  return db[id];
}
/* Atomic ENTRY claim for a real strategy — the entry-side analogue of claimManagedForExit. Stamps the
   pending marker ONLY if no order is currently in-flight (pendingSince absent/null), in ONE conditional
   UPDATE, so two server replicas can't both place an auto-buy entry for the same strategy. Returns the
   updated row to the winner and null to any other caller. */
/* SERVER-OWNED risk policy (R15-P1-02): the authoritative per-user caps loaded on every real order, so a
   tampered/old client can't drop them by omitting the request body. */
async function saveRiskPolicy(userId, policy) {
  if (USING_PG) {
    await pool.query(
      `INSERT INTO risk_policy (user_id, data, updated_at) VALUES ($1,$2,$3)
       ON CONFLICT (user_id) DO UPDATE SET data=EXCLUDED.data, updated_at=EXCLUDED.updated_at`,
      [userId, policy, Date.now()]
    );
    return policy;
  }
  const db = readJSON(FILES.riskPolicy); db[userId] = policy; writeJSON(FILES.riskPolicy, db); return policy;
}
async function getRiskPolicy(userId) {
  if (USING_PG) { const r = await pool.query(`SELECT data FROM risk_policy WHERE user_id=$1`, [userId]); return r.rows[0] ? r.rows[0].data : null; }
  return readJSON(FILES.riskPolicy)[userId] || null;
}
/* Atomic, candle-idempotent ENTRY claim (R16-P1-01). A claim only succeeds if ALL invariants hold in one
   conditional step: the strategy is column-`status='active'`, has no in-flight pending marker, holds no open
   position, and has NOT already fired on this closed candle. On Postgres a UNIQUE (strategy_id, candle_key)
   row in `order_intents` is inserted first, so across replicas/restarts at most ONE worker can ever own a
   given candle's entry — even if a fast winner clears `pendingSince` before a delayed replica arrives. The
   broker client-order-id derives from the same `client_id`. Returns the updated row to the sole winner, else
   null (which the engine treats as "someone else has it / not eligible" and never double-orders). */
async function claimRealStrategyForEntry(id, candleKey, patch = {}) {
  const key = String(candleKey || "");
  const clientId = patch.pendingClientId || `mx_${id}_${key || Date.now()}`;
  if (USING_PG) {
    if (key) {
      const ins = await pool.query(
        `INSERT INTO order_intents (strategy_id, candle_key, client_id, user_id, created_at)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (strategy_id, candle_key) DO NOTHING RETURNING client_id`,
        [id, key, clientId, patch.userId ? String(patch.userId) : null, Date.now()]
      );
      if (!ins.rows[0]) return null;   // this candle's entry was already claimed elsewhere
    }
    const merge = { ...patch }; if (key) merge.lastEntryCandle = key; delete merge.userId;
    const upd = await pool.query(
      `UPDATE real_strategies SET updated_at=$2, version=COALESCE(version,0)+1, data = data || $3::jsonb
       WHERE id=$1 AND status='active'
         AND (data->>'pendingSince') IS NULL
         AND (data->>'openPositionId') IS NULL
         AND (data->>'lastEntryCandle') IS DISTINCT FROM $4
       RETURNING data`,
      [id, Date.now(), JSON.stringify(merge), key]
    );
    return upd.rows[0] ? upd.rows[0].data : null;   // not eligible (paused / has position / already fired)
  }
  const dbf = readJSON(FILES.realStrats);
  const cur = dbf[id];
  if (!cur) return null;
  if (cur.status !== "active") return null;
  if (cur.pendingSince != null) return null;
  if (cur.openPositionId != null) return null;
  if (key && String(cur.lastEntryCandle || "") === key) return null;
  const { userId, ...rest } = patch;
  dbf[id] = { ...cur, ...rest, lastEntryCandle: key || cur.lastEntryCandle || null, version: (cur.version || 0) + 1, updated_at: Date.now() };
  writeJSON(FILES.realStrats, dbf);
  return dbf[id];
}
/* Versioned lifecycle transition (R16-P2-01). Pause / cancel / review-resolution and engine completion
   each read a row version and write only if it is unchanged, so a late engine write can't silently clobber
   a concurrent user pause/cancel. `expectVersion` null skips the check (used by internal engine writes that
   already hold a fresh row). Returns the new row, or null if the version moved under us. */
async function transitionRealStrategy(id, patch, expectVersion = null) {
  if (USING_PG) {
    const r = await pool.query(`SELECT data, version FROM real_strategies WHERE id=$1`, [id]);
    if (!r.rows[0]) return null;
    const curVer = Number(r.rows[0].version || 0);
    if (expectVersion != null && curVer !== Number(expectVersion)) return null;
    const next = { ...r.rows[0].data, ...patch };
    const upd = await pool.query(
      `UPDATE real_strategies SET status=$2, updated_at=$3, data=$4, version=COALESCE(version,0)+1
       WHERE id=$1 AND COALESCE(version,0)=$5 RETURNING data`,
      [id, next.status || "active", Date.now(), next, curVer]
    );
    return upd.rows[0] ? upd.rows[0].data : null;   // lost the race — caller may re-read and retry
  }
  const dbf = readJSON(FILES.realStrats);
  if (!dbf[id]) return null;
  const curVer = Number(dbf[id].version || 0);
  if (expectVersion != null && curVer !== Number(expectVersion)) return null;
  dbf[id] = { ...dbf[id], ...patch, version: curVer + 1, updated_at: Date.now() };
  writeJSON(FILES.realStrats, dbf);
  return dbf[id];
}
/* R17-P1-02 / P2-07 manual-order idempotency ledger with EXPLICIT outcome states.
   `claimIdempotencyKey` returns true only to the FIRST caller for a (user,key), stamping the request hash
   and status='in_flight'. Later callers get false and must read the record: replay a 'succeeded' response,
   block a still 'in_flight' or 'unknown' one (never auto-duplicate), and reject a reused key whose payload
   hash differs. Only a CONCLUSIVE rejection frees the key for a same-key retry. */
async function claimIdempotencyKey(userId, key, reqHash = null) {
  if (USING_PG) {
    const r = await pool.query(
      `INSERT INTO order_idempotency (user_id, key, response, req_hash, status, created_at)
       VALUES ($1,$2,NULL,$3,'in_flight',$4)
       ON CONFLICT (user_id, key) DO NOTHING RETURNING key`, [String(userId), String(key), reqHash, Date.now()]);
    return !!r.rows[0];
  }
  const d = readJSON(FILES.idem || (FILES.idem = path.join(__dirname, "order_idempotency.json")));
  const k = `${userId}|${key}`;
  if (d[k]) return false;
  d[k] = { response: null, reqHash, status: "in_flight", createdAt: Date.now() }; writeJSON(FILES.idem, d); return true;
}
async function getIdempotencyRecord(userId, key) {
  if (USING_PG) { const r = await pool.query(`SELECT response, req_hash, status FROM order_idempotency WHERE user_id=$1 AND key=$2`, [String(userId), String(key)]); return r.rows[0] ? { response: r.rows[0].response, reqHash: r.rows[0].req_hash, status: r.rows[0].status } : null; }
  const d = readJSON(FILES.idem || (FILES.idem = path.join(__dirname, "order_idempotency.json"))); const row = d[`${userId}|${key}`]; return row ? { response: row.response, reqHash: row.reqHash, status: row.status } : null;
}
/* Finalize the outcome. status ∈ succeeded | rejected | unknown. A 'rejected' (conclusive) DELETES the row
   so a same-key retry may proceed; 'succeeded'/'unknown' persist the response for replay/blocking. */
async function finalizeIdempotency(userId, key, status, response) {
  if (status === "rejected") { await releaseIdempotencyKey(userId, key); return; }
  if (USING_PG) { await pool.query(`UPDATE order_idempotency SET response=$3, status=$4 WHERE user_id=$1 AND key=$2`, [String(userId), String(key), response, status]); return; }
  const f = FILES.idem || (FILES.idem = path.join(__dirname, "order_idempotency.json")); const d = readJSON(f); const cur = d[`${userId}|${key}`] || {}; d[`${userId}|${key}`] = { ...cur, response, status, createdAt: cur.createdAt || Date.now() }; writeJSON(f, d);
}
async function releaseIdempotencyKey(userId, key) {
  if (USING_PG) { await pool.query(`DELETE FROM order_idempotency WHERE user_id=$1 AND key=$2`, [String(userId), String(key)]); return; }
  const f = FILES.idem || (FILES.idem = path.join(__dirname, "order_idempotency.json")); const d = readJSON(f); if (d[`${userId}|${key}`]) { delete d[`${userId}|${key}`]; writeJSON(f, d); }
}
/* R17-P2-09 retention: drop a user's idempotency + order-intent ledger rows (called during erasure). */
async function purgeLedgersForUser(userId) {
  if (USING_PG) {
    await pool.query(`DELETE FROM order_idempotency WHERE user_id=$1`, [String(userId)]).catch(() => {});
    await pool.query(`DELETE FROM order_intents WHERE user_id=$1`, [String(userId)]).catch(() => {});
    await pool.query(`DELETE FROM pending_protection WHERE user_id=$1`, [String(userId)]).catch(() => {});
    // R19-P2-10: personal in-app notices are personal data — purge them on account deletion too.
    await pool.query(`DELETE FROM user_notices WHERE user_id=$1`, [String(userId)]).catch(() => {});
    return;
  }
  for (const key of ["idem"]) { const f = FILES[key]; if (!f) continue; const d = readJSON(f); let ch = false; for (const k of Object.keys(d)) if (k.startsWith(`${userId}|`)) { delete d[k]; ch = true; } if (ch) writeJSON(f, d); }
  // R19-P2-10 (flat-file): drop this user's notices bucket.
  try { const nf = FILES.notices; if (nf) { const nd = readJSON(nf); if (nd[String(userId)]) { delete nd[String(userId)]; writeJSON(nf, nd); } } } catch { /* non-fatal */ }
}
/* R16-P2-11 shared OAuth CSRF state (Postgres-backed; in-memory fallback for flat-file mode lives in
   server.js). `saveOAuthState` upserts the nonce; `consumeOAuthState` deletes-and-returns atomically so a
   nonce can be used at most once even across replicas. */
async function saveOAuthState(nonce, data, exp) {
  if (USING_PG) {
    await pool.query(`INSERT INTO oauth_states (nonce, data, exp) VALUES ($1,$2,$3) ON CONFLICT (nonce) DO UPDATE SET data=EXCLUDED.data, exp=EXCLUDED.exp`, [String(nonce), data, exp]);
    // opportunistic prune of expired nonces
    await pool.query(`DELETE FROM oauth_states WHERE exp < $1`, [Date.now()]).catch(() => {});
    return true;
  }
  return false;
}
async function consumeOAuthStateRow(nonce) {
  if (USING_PG) { const r = await pool.query(`DELETE FROM oauth_states WHERE nonce=$1 RETURNING data, exp`, [String(nonce)]); return r.rows[0] ? { ...r.rows[0].data, exp: Number(r.rows[0].exp) } : null; }
  return null;
}
/* R17-P2-03 durable user notices. */
async function addNotice(userId, notice) {
  const row = { id: `n_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, user_id: String(userId), data: notice, created_at: Date.now() };
  if (USING_PG) { await pool.query(`INSERT INTO user_notices (id,user_id,data,read,created_at) VALUES ($1,$2,$3,FALSE,$4)`, [row.id, row.user_id, notice, row.created_at]).catch(() => {}); return row; }
  const f = FILES.notices || (FILES.notices = path.join(__dirname, "user_notices.json")); const d = readJSON(f); (d[String(userId)] = d[String(userId)] || []).unshift({ ...row, read: false }); d[String(userId)] = d[String(userId)].slice(0, 200); writeJSON(f, d); return row;
}
async function getNotices(userId, limit = 50) {
  if (USING_PG) { const r = await pool.query(`SELECT id, data, read, created_at FROM user_notices WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2`, [String(userId), limit]); return r.rows.map((x) => ({ id: x.id, ...x.data, read: !!x.read, createdAt: Number(x.created_at) })); }
  const f = FILES.notices || (FILES.notices = path.join(__dirname, "user_notices.json")); return (readJSON(f)[String(userId)] || []).slice(0, limit).map((x) => ({ id: x.id, ...x.data, read: !!x.read, createdAt: x.created_at }));
}
async function markNoticesRead(userId) {
  if (USING_PG) { await pool.query(`UPDATE user_notices SET read=TRUE WHERE user_id=$1 AND read=FALSE`, [String(userId)]).catch(() => {}); return; }
  const f = FILES.notices || (FILES.notices = path.join(__dirname, "user_notices.json")); const d = readJSON(f); (d[String(userId)] || []).forEach((n) => { n.read = true; }); writeJSON(f, d);
}
/* R16-P2-10 delayed-fill protection store. */
async function savePendingProtection(rec) {
  const row = { id: rec.id, user_id: String(rec.userId), broker: rec.broker, order_id: String(rec.orderId), data: rec, attempts: 0, created_at: Date.now() };
  if (USING_PG) { await pool.query(`INSERT INTO pending_protection (id,user_id,broker,order_id,data,attempts,created_at) VALUES ($1,$2,$3,$4,$5,0,$6) ON CONFLICT (id) DO NOTHING`, [row.id, row.user_id, row.broker, row.order_id, rec, row.created_at]); return row; }
  const f = FILES.pendingProt || (FILES.pendingProt = path.join(__dirname, "pending_protection.json")); const d = readJSON(f); d[row.id] = row; writeJSON(f, d); return row;
}
async function listPendingProtection(limit = 500) {
  if (USING_PG) { const r = await pool.query(`SELECT data, attempts FROM pending_protection ORDER BY created_at ASC LIMIT $1`, [limit]); return r.rows.map((x) => ({ ...x.data, attempts: x.attempts })); }
  const f = FILES.pendingProt || (FILES.pendingProt = path.join(__dirname, "pending_protection.json")); return Object.values(readJSON(f)).map((x) => ({ ...x.data, attempts: x.attempts })).slice(0, limit);
}
/* R19-P2-11: query pending-protection rows for ONE user directly, so a per-user status endpoint isn't
   capped by a global LIMIT (a busy platform could push a user's own rows past the first page). */
async function listPendingProtectionForUser(userId, limit = 200) {
  if (USING_PG) { const r = await pool.query(`SELECT data, attempts FROM pending_protection WHERE user_id=$1 ORDER BY created_at ASC LIMIT $2`, [String(userId), limit]); return r.rows.map((x) => ({ ...x.data, attempts: x.attempts })); }
  const f = FILES.pendingProt || (FILES.pendingProt = path.join(__dirname, "pending_protection.json"));
  return Object.values(readJSON(f)).map((x) => ({ ...x.data, attempts: x.attempts })).filter((x) => String(x.userId) === String(userId)).slice(0, limit);
}
/* R17-P1-03: atomically LEASE due protection rows so exactly one replica processes each. On Postgres the
   conditional UPDATE (leased_until < now) with RETURNING is the compare-and-set; a leaseholder owns the row
   for `leaseMs` and no other worker will pick it up in that window. Flat-file mode is single-process, so it
   just returns the rows. */
async function claimPendingProtection(leaseMs = 120000, limit = 200) {
  const now = Date.now();
  if (USING_PG) {
    const r = await pool.query(
      `UPDATE pending_protection SET leased_until=$1, attempts=COALESCE(attempts,0)+1
       WHERE id IN (SELECT id FROM pending_protection WHERE COALESCE(leased_until,0) < $2 ORDER BY created_at ASC LIMIT $3 FOR UPDATE SKIP LOCKED)
       RETURNING data, attempts`, [now + leaseMs, now, limit]);
    return r.rows.map((x) => ({ ...x.data, attempts: x.attempts }));
  }
  const f = FILES.pendingProt || (FILES.pendingProt = path.join(__dirname, "pending_protection.json"));
  const d = readJSON(f); const out = [];
  for (const k of Object.keys(d)) { const row = d[k]; if ((row.leased_until || 0) < now) { row.leased_until = now + leaseMs; row.attempts = (row.attempts || 0) + 1; out.push({ ...row.data, attempts: row.attempts }); } }
  writeJSON(f, d); return out.slice(0, limit);
}
async function bumpPendingProtection(id) {
  if (USING_PG) { await pool.query(`UPDATE pending_protection SET attempts=COALESCE(attempts,0)+1 WHERE id=$1`, [id]); return; }
  const f = FILES.pendingProt || (FILES.pendingProt = path.join(__dirname, "pending_protection.json")); const d = readJSON(f); if (d[id]) { d[id].attempts = (d[id].attempts || 0) + 1; writeJSON(f, d); }
}
async function deletePendingProtection(id) {
  if (USING_PG) { await pool.query(`DELETE FROM pending_protection WHERE id=$1`, [id]); return; }
  const f = FILES.pendingProt || (FILES.pendingProt = path.join(__dirname, "pending_protection.json")); const d = readJSON(f); if (d[id]) { delete d[id]; writeJSON(f, d); }
}
async function updateManagedPosition(id, patch) {
  if (USING_PG) {
    const r = await pool.query(`SELECT data FROM managed_positions WHERE id=$1`, [id]);
    if (!r.rows[0]) return null;
    const next = { ...r.rows[0].data, ...patch };
    await pool.query(`UPDATE managed_positions SET status=$2, updated_at=$3, data=$4 WHERE id=$1`, [id, next.status || "open", Date.now(), next]);
    return next;
  }
  const db = readJSON(FILES.managed);
  if (!db[id]) return null;
  db[id] = { ...db[id], ...patch, updated_at: Date.now() };
  writeJSON(FILES.managed, db);
  return db[id];
}

/* ----------------------- real (opt-in) auto-buy strategies ------------------ */
async function saveRealStrategy(s) {
  const now = Date.now();
  if (USING_PG) {
    await pool.query(
      `INSERT INTO real_strategies (id, user_id, status, updated_at, data) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, updated_at = EXCLUDED.updated_at, data = EXCLUDED.data`,
      [s.id, String(s.userId), s.status || "active", now, s]
    );
    return s;
  }
  const dbf = readJSON(FILES.realStrats);
  dbf[s.id] = { ...s, updated_at: now };
  writeJSON(FILES.realStrats, dbf);
  return s;
}
async function getActiveRealStrategies(limit = 500) {
  if (USING_PG) {
    const r = await pool.query(`SELECT data FROM real_strategies WHERE status='active' ORDER BY updated_at ASC LIMIT $1`, [limit]);
    return r.rows.map((x) => x.data);
  }
  return Object.values(readJSON(FILES.realStrats)).filter((s) => s.status === "active").slice(0, limit);
}
async function getRealStrategiesForUser(userId, limit = 200) {
  if (USING_PG) {
    const r = await pool.query(`SELECT data FROM real_strategies WHERE user_id=$1 ORDER BY updated_at DESC LIMIT $2`, [String(userId), limit]);
    return r.rows.map((x) => x.data);
  }
  return Object.values(readJSON(FILES.realStrats)).filter((s) => String(s.userId) === String(userId)).slice(0, limit);
}
/* R16-P2-01: ATOMIC field update — the JSONB merge happens IN the database in a single statement, so two
   concurrent writers (e.g. a late engine fill-completion and a user pause) can't lose each other's fields
   via a read-modify-write race. `status` column is updated only when the patch carries one, otherwise the
   existing status is preserved (so an engine write never silently un-pauses/un-cancels a strategy). */
async function updateRealStrategy(id, patch) {
  if (USING_PG) {
    const upd = await pool.query(
      `UPDATE real_strategies
         SET updated_at=$2, version=COALESCE(version,0)+1,
             status = COALESCE($4, status),
             data = data || $3::jsonb
       WHERE id=$1 RETURNING data`,
      [id, Date.now(), JSON.stringify(patch), (patch && patch.status) || null]
    );
    return upd.rows[0] ? upd.rows[0].data : null;
  }
  const dbf = readJSON(FILES.realStrats);
  if (!dbf[id]) return null;
  dbf[id] = { ...dbf[id], ...patch, version: (dbf[id].version || 0) + 1, updated_at: Date.now() };
  writeJSON(FILES.realStrats, dbf);
  return dbf[id];
}

module.exports = { updateSecurityQuestion, getSecurityQuestion, getSecurityAnswerHash, listUsers, setUserBlocked, isUserBlocked, setUserApproved, unapproveUserAndRevoke, listPendingUsers, getUserFull, initDb, saveTrade, getTrades, reassignTrades, recordTradeArchive, getArchivedTradesForPhone, deleteTradesByIds, clearVirtualTrades, clearTradesByType, getUser, createUser, updateUserPin, updateUserPinAndBumpToken, bumpTokenVersion, getTokenVersion, getState, saveState, getScreeners, saveScreeners, setEntryHalt, getHaltedEntryUsers, getOpenTrades, updateTrade, getUserByUsername, setUsername, setEmail, setLastLogin, publishStrategy, unpublishStrategy, listPublicStrategies, postIdea, deleteIdea, listIdeas, getIdeaScreenshot, reviewIdea, saveBrokerCred, getBrokerCred, deleteBrokerCred, saveBrokerApp, getBrokerApp, getAllBrokerApps, deleteBrokerApp, getAppSettings, saveAppSettings, deleteAccount, saveManagedPosition, getOpenManagedPositions, getManagedPositionsForUser, updateManagedPosition, claimManagedForExit, claimRealStrategyForEntry, transitionRealStrategy, claimIdempotencyKey, getIdempotencyRecord, finalizeIdempotency, releaseIdempotencyKey, purgeLedgersForUser, savePendingProtection, listPendingProtection, listPendingProtectionForUser, claimPendingProtection, bumpPendingProtection, deletePendingProtection, saveOAuthState, consumeOAuthStateRow, addNotice, getNotices, markNoticesRead, saveRiskPolicy, getRiskPolicy, saveRealStrategy, getActiveRealStrategies, getRealStrategiesForUser, updateRealStrategy, USING_PG };
