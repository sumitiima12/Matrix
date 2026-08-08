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
const faultHook = require("./faultHook");   // C03: no-op fault seam (only tests arm boundaries)
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
  // A LOOPBACK database (local dev, embedded-postgres in tests, a sidecar) does not speak TLS — forcing SSL there
  // fails with "server does not support SSL connections". Managed providers (Neon/Supabase/Render) are remote and
  // keep SSL. Detect a local host from the connection string (or an explicit sslmode=disable) and turn SSL off.
  const _url = String(process.env.DATABASE_URL || "");
  const _isLocal = /@(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)[:/]/.test(_url) || /[?&]sslmode=disable\b/.test(_url);
  const ssl = _isLocal
    ? false
    : (strict
      ? (ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: true })
      : { rejectUnauthorized: false });
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
  /* ARCH-1: the IMMUTABLE, server-only FILLS ledger. Every verified broker fill is appended here exactly once
     (idempotent on the natural broker key). Clients can NEVER write it. It is the audit/reconciliation source of
     truth and the basis for future risk derivation; the `trades` table above stays as the editable display
     projection. Append-only: rows are never updated or deleted in normal operation. */
  await pool.query(`CREATE TABLE IF NOT EXISTS fills (
    fill_id TEXT PRIMARY KEY, user_id TEXT, broker TEXT, order_id TEXT, side TEXT,
    qty DOUBLE PRECISION, price DOUBLE PRECISION, market TEXT, trade_type TEXT, ts BIGINT, data JSONB)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS fills_user_ts ON fills (user_id, ts)`);
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
  // R26-P1-01: whether the ORIGINAL broker order carried our durable tag (FYERS orderTag / Delta client_order_id).
  // The unknown-order probe may only declare a broker "never received it" (release the key) for a TAGGED order —
  // a legacy/untagged order's absent tag is NOT proof of absence, so it must never be released as absent.
  await pool.query(`ALTER TABLE order_idempotency ADD COLUMN IF NOT EXISTS tagged BOOLEAN NOT NULL DEFAULT FALSE`);
  // R38: last-change timestamp. getIdempotencyRecord SELECTs updated_at; without this column a FRESH database (CI /
  // new deploy) errored on every read (the maintenance/idempotency query silently failed). Expand-only, idempotent.
  await pool.query(`ALTER TABLE order_idempotency ADD COLUMN IF NOT EXISTS updated_at BIGINT`);
  /* C03 — durable WRITE-BEFORE-SEND order-attempt ledger. A row is committed as PREPARED BEFORE any broker
     submission, so a crash/DB-outage after FYERS accepts is always recoverable: startup finds the attempt by
     its deterministic order_tag and reconciles against the broker. Statuses:
       PREPARED → SUBMITTING → (ACCEPTED | PARTIAL | FILLED | REJECTED | CANCELLED | UNKNOWN).
     `resolved` flips true only after broker-backed reconciliation completes. Non-resolved rows re-arm the
     risk-lock at startup. This table is NOT yet wired into the live order path (flag-gated) — see orderRecovery.js. */
  await pool.query(`CREATE TABLE IF NOT EXISTS order_attempts (
    id TEXT PRIMARY KEY, user_id TEXT, broker TEXT, idem_key TEXT, order_tag TEXT,
    fingerprint TEXT, payload JSONB, symbol TEXT, side TEXT, qty DOUBLE PRECISION, product TEXT, protection JSONB,
    status TEXT NOT NULL, broker_order_id TEXT, filled_qty DOUBLE PRECISION, avg_price DOUBLE PRECISION,
    resolved BOOLEAN NOT NULL DEFAULT FALSE, created_at BIGINT, updated_at BIGINT)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_order_attempts_unresolved ON order_attempts (resolved, created_at)`);
  // R33/R35-P3-01: JSONB slot for a durable resolution record (the MANUAL_RECONCILIATION_REQUIRED evidence). This is
  // ALSO registered in the versioned migration chain (migrations.js "2026-08-04-002-order-attempts-resolution") so
  // readiness is tied to it; this inline idempotent ADD stays for rolling-deploy compatibility during the supported
  // upgrade window and is removed a release later once every replica is at that version.
  await pool.query(`ALTER TABLE order_attempts ADD COLUMN IF NOT EXISTS resolution JSONB`);
  /* S3.2 PROJECTION_PENDING: a broker EXIT execution is confirmed but the ledger/projection write failed. The
     payload holds everything needed to REPAIR the projection WITHOUT re-contacting the broker (idempotent by the
     exit order id). A background sweep retries until it commits; the account stays risk-locked until then. */
  await pool.query(`CREATE TABLE IF NOT EXISTS projection_pending (
    id TEXT PRIMARY KEY, user_id TEXT, kind TEXT, order_id TEXT, data JSONB, attempts INT DEFAULT 0,
    leased_until BIGINT DEFAULT 0, created_at BIGINT)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_projection_pending_user ON projection_pending (user_id, created_at)`);
  /* S7 multi-instance safety: durable, fenced leases. Process memory is NEVER authoritative — a single-owner job
     (auto-buy, screener, exit monitor, protection, recovery, token refresh, projection repair) acquires a NAMED lease
     before it runs, so exactly one replica owns it. `fence` is a monotonically increasing token bumped ONLY on a
     change of owner (takeover after expiry). Every fenced write validates the token, so a stale worker that lost the
     lease during a GC pause / network partition cannot resume and double-act. */
  await pool.query(`CREATE TABLE IF NOT EXISTS leases (
    name TEXT PRIMARY KEY, owner TEXT, fence BIGINT DEFAULT 0,
    acquired_at BIGINT, heartbeat_at BIGINT, expiry BIGINT)`);
  /* S7 signal identity: one deterministic signal → at most ONE claim across restarts AND replicas. The PRIMARY KEY is
     the deterministic signal id (strategy+version+symbol+timeframe+candle+direction); the first inserter wins, every
     other replica/retry conflicts and stands down. This is the DB-enforced dedupe behind "one signal = one attempt". */
  await pool.query(`CREATE TABLE IF NOT EXISTS signal_claims (
    id TEXT PRIMARY KEY, user_id TEXT, kind TEXT, claimed_at BIGINT)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_signal_claims_user ON signal_claims (user_id, claimed_at)`);
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
  /* Web Push subscriptions (one row per browser/device). `prefs` is the user's notification-category choices
     (e.g. {all:false, trades:true, broker:true, alerts:true, other:false}); `endpoint` is unique so a
     re-subscribe from the same device upserts rather than duplicating. */
  await pool.query(`CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint TEXT PRIMARY KEY, user_id TEXT, p256dh TEXT, auth TEXT, prefs JSONB, created_at BIGINT)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS push_subs_user ON push_subscriptions (user_id)`);
  /* Append-only admin audit log. Every privileged admin action is recorded here (who, what role, what action,
     which target, when, from which IP). Rows are never updated or deleted by the app — it's an evidence trail. */
  await pool.query(`CREATE TABLE IF NOT EXISTS admin_audit (
    id TEXT PRIMARY KEY, at BIGINT, actor TEXT, role TEXT, action TEXT, target TEXT, detail JSONB, ip TEXT)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS admin_audit_at ON admin_audit (at DESC)`);
  /* UX-3: user-created price alerts. One row per alert; the alert engine reads active ones, evaluates them
     against fresh quotes, and pushes on trigger (with a per-alert cooldown recorded in last_fired_at). */
  await pool.query(`CREATE TABLE IF NOT EXISTS user_alerts (
    id TEXT PRIMARY KEY, user_id TEXT, data JSONB, active BOOLEAN DEFAULT TRUE, last_fired_at BIGINT DEFAULT 0, created_at BIGINT)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS user_alerts_active ON user_alerts (active)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS user_alerts_user ON user_alerts (user_id)`);
  /* Delayed-fill protection watcher (R16-P2-10). A manual LIMIT entry that asked for app-managed SL/TP but
     hadn't filled within the sync window is parked here; a background sweep re-checks the broker until the
     order is terminal and, on fill, attaches the requested protection to the CONFIRMED filled quantity. */
  await pool.query(`CREATE TABLE IF NOT EXISTS pending_protection (
    id TEXT PRIMARY KEY, user_id TEXT, broker TEXT, order_id TEXT, data JSONB, attempts INT DEFAULT 0, created_at BIGINT)`);
  // R17-P1-03: a short lease so exactly ONE replica processes a pending-protection row at a time.
  await pool.query(`ALTER TABLE pending_protection ADD COLUMN IF NOT EXISTS leased_until BIGINT DEFAULT 0`);
  await pool.query(`ALTER TABLE pending_protection ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending'`);
  /* R17-P1-03 / R19-P2-06 / R21-P2-06: managed positions are unique per (broker, user, entry order). This
     migration is made SAFE for concurrent replicas and existing data:
       1. A transaction-scoped ADVISORY LOCK so only ONE process runs the DDL at a time (others wait, then see
          the finished index and no-op).
       2. A duplicate PREFLIGHT that fails LOUDLY (throws → readiness fails) rather than silently dropping the
          old protection and leaving the table without a unique guard.
       3. The old index is dropped only AFTER the composite one exists. */
  {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(4021001)");   // arbitrary app-wide lock id for this migration
      // Preflight: are there existing rows that would violate the new unique constraint?
      const dup = await client.query(
        `SELECT broker, user_id, data->>'entryOrderId' AS eoid, COUNT(*) c
           FROM managed_positions WHERE (data->>'entryOrderId') IS NOT NULL
          GROUP BY broker, user_id, data->>'entryOrderId' HAVING COUNT(*) > 1 LIMIT 1`
      );
      if (dup.rowCount) {
        throw new Error(`managed_positions has duplicate (broker,user,entryOrderId) rows — resolve before the unique index can be created (e.g. ${JSON.stringify(dup.rows[0])})`);
      }
      await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS managed_entry_order_composite
        ON managed_positions (broker, user_id, (data->>'entryOrderId')) WHERE (data->>'entryOrderId') IS NOT NULL`);
      await client.query(`DROP INDEX IF EXISTS managed_entry_order`);   // legacy global index — only after the composite exists
      await client.query("COMMIT");
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch { /* ignore */ }
      throw e;   // surfaces to initDb → readiness fails rather than running without the safety index
    } finally {
      client.release();
    }
  }
  /* User-built screeners ("My Screeners") — one JSON array per user, so a saved screener survives
     logout / a new device. Small, so stored whole like app_state rather than row-per-screener. */
  await pool.query(`CREATE TABLE IF NOT EXISTS user_screeners (
    user_id TEXT PRIMARY KEY, updated_at BIGINT, data JSONB)`);
  /* KILL SWITCH — per-user pause of NEW real ENTRIES (auto-buy). Protective exits keep running, so a
     halted account still gets its stop-loss/target managed. Its own tiny table so it is never clobbered
     by an app_settings save or the user-state blob (both of which overwrite wholesale). */
  await pool.query(`CREATE TABLE IF NOT EXISTS automation_flags (
    user_id TEXT PRIMARY KEY, halt_entries BOOLEAN DEFAULT false, updated_at BIGINT)`);
  // R21-P1-03: durable "risk ledger unhealthy" lock — set when a verified fill can't be journaled, checked by
  // EVERY new-entry path (manual + automated), cleared only after reconciliation.
  await pool.query(`ALTER TABLE automation_flags ADD COLUMN IF NOT EXISTS risk_lock BOOLEAN DEFAULT false`);
  /* SERVER-OWNED risk policy (R15-P1-02) — the authoritative per-user caps enforced on every real order.
     Its own table so it is never clobbered by an app_state blob save. */
  await pool.query(`CREATE TABLE IF NOT EXISTS risk_policy (
    user_id TEXT PRIMARY KEY, data JSONB, updated_at BIGINT)`);
  /* R31-P3-07 / R32-P2-04: after the idempotent inline DDL establishes the baseline, run the VERSIONED
     expand/contract migrations (ordered + recorded in schema_migrations) so readiness can be tied to a target
     version. Single-runner via the pg advisory lock. A migration failure is NOT swallowed — it PROPAGATES so
     initDb throws and readiness stays false (a half-migrated schema must never serve real money). A non-owner
     result (another replica holds the lock) returns without applying; the caller then WAITS for the schema to
     reach the target (see server startup) before flipping ready. */
  const mig = await runSchemaMigrations();
  if (mig && mig.error) throw new Error(`schema migrations failed: ${mig.error}`);
  console.log("[db] Postgres ready", mig && mig.skipped ? "(migrations owned by another replica — will await target)" : "");
}

/* R31-P3-07 wiring: apply the versioned migrations using THIS module's pool + a dedicated advisory lock so exactly
   one replica migrates. Exposed so a startup/health path can also assert schemaAtVersion(TARGET_SCHEMA_VERSION). */
const _migrations = require("./migrations.js");
const SCHEMA_MIGRATION_LOCK_KEY = 0x4d494752 | 0;   // "MIGR"
async function runSchemaMigrations() {
  if (!USING_PG) return { skipped: true, reason: "flat-file" };
  const q = (sql, params) => pool.query(sql, params);
  const advisoryLock = {
    acquire: () => tryAdvisoryLock(SCHEMA_MIGRATION_LOCK_KEY),
    release: () => releaseAdvisoryLock(SCHEMA_MIGRATION_LOCK_KEY),
  };
  return _migrations.applyMigrations({ query: q, advisoryLock, log: (ev, d) => console.log(`[db] ${ev}`, d) });
}
async function schemaIsAtTarget() {
  if (!USING_PG) return true;   // flat-file has no versioned schema to gate on
  return _migrations.schemaAtVersion((sql, params) => pool.query(sql, params), _migrations.TARGET_SCHEMA_VERSION);
}

/* ---------------------------- flat-file fallback --------------------------- */
const FILES = {
  trades: process.env.TRADES_FILE || path.join(__dirname, "trades.json"),
  fills: process.env.FILLS_FILE || path.join(__dirname, "fills.json"),
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
/* R21-P1-02: fields a CLIENT (browser) post may merge onto a row the SERVER already verified. Everything a
   risk calc depends on (qty, entry/price, side, status, entry/exit time, pnl, orderId, broker, real,
   serverAuthored) is EXCLUDED — a browser can annotate a fill, never rewrite broker truth. */
const CLIENT_PRESENTATION_FIELDS = ["sl", "tp", "tsl", "note", "tag", "notes"];
/* saveTrade(userId, trade, { authoritative })
   - authoritative:true  → a SERVER-verified fill (broker truth). Stamps serverAuthored and OVERWRITES.
   - authoritative:false → a CLIENT/browser post. Cannot claim serverAuthored, and if the target row is already
     serverAuthored it may only merge CLIENT_PRESENTATION_FIELDS — the financial payload stays broker truth. */
async function saveTrade(userId, trade, { authoritative = false } = {}) {
  const uref = userRef(userId);
  /* R19 + R20-P1-03: the STORED id is NAMESPACED by user so a real fill dedupes by (user,broker,orderId) and no
     client-chosen id can address another user's row. */
  const nsPrefix = `t_${uref}_`;
  let sid;
  if (trade && trade.real && trade.orderId != null && String(trade.orderId) !== "") {
    const brk = String(trade.broker || "x").toLowerCase().replace(/[^a-z0-9]/g, "");
    sid = `${nsPrefix}ord_${brk}_${String(trade.orderId)}`;
  } else {
    const raw = String((trade && trade.id) || crypto.randomUUID());
    sid = raw.startsWith(nsPrefix) ? raw : `${nsPrefix}${raw}`;
  }
  // A client can NEVER mark itself authoritative; a server fill always is.
  trade = { ...trade, id: sid };
  if (authoritative) trade.serverAuthored = true; else delete trade.serverAuthored;
  const ts = trade.exitAt || trade.entryAt || Date.now();

  if (USING_PG) {
    if (!authoritative) {
      /* Client post: if a SERVER-verified row already exists at this id, merge ONLY presentation fields onto
         broker truth — never let the browser rewrite qty/price/status/etc. */
      const ex = await pool.query(`SELECT data FROM trades WHERE id=$1 AND user_id=$2`, [sid, userId]);
      if (ex.rowCount && ex.rows[0].data && ex.rows[0].data.serverAuthored === true) {
        const merged = { ...ex.rows[0].data };
        for (const k of CLIENT_PRESENTATION_FIELDS) if (trade[k] !== undefined) merged[k] = trade[k];
        await pool.query(`UPDATE trades SET data=$3 WHERE id=$1 AND user_id=$2`, [sid, userId, merged]);
        return merged;
      }
    }
    /* Ownership-safe upsert: only update a row that ALREADY belongs to this user. */
    const r = await pool.query(
      `INSERT INTO trades (id, user_id, ts, data) VALUES ($1,$2,$3,$4)
       ON CONFLICT (id) DO UPDATE SET ts = EXCLUDED.ts, data = EXCLUDED.data
       WHERE trades.user_id = EXCLUDED.user_id
       RETURNING id`,
      [trade.id, userId, ts, trade]
    );
    if (!r.rowCount) {
      /* id exists but owned by a DIFFERENT user (near-impossible with namespacing): re-key and insert. Log
         loudly, and R21-P2-13: if the re-keyed insert ALSO persists nothing, THROW — never acknowledge a lost
         financial write as success. */
      console.error(JSON.stringify({ lvl: "fin", evt: "saveTrade_rekey_on_owner_conflict", user: uref, orderId: trade && trade.orderId, sym: trade && trade.sym }));
      trade = { ...trade, id: `${nsPrefix}${crypto.randomUUID()}` };
      const rr = await pool.query(`INSERT INTO trades (id, user_id, ts, data) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`, [trade.id, userId, ts, trade]);
      if (!rr.rowCount) throw new Error("saveTrade: re-keyed insert persisted no row — refusing to report a lost trade write as success");
    }
    return trade;
  }
  // Flat-file mode is partitioned by user bucket, so cross-user collision is structurally impossible.
  const db = readJSON(FILES.trades);
  const list = db[userId] || [];
  const i = list.findIndex((t) => t.id === trade.id);
  if (i >= 0) {
    if (!authoritative && list[i] && list[i].serverAuthored === true) {
      // Preserve broker truth; merge only presentation fields.
      const merged = { ...list[i] };
      for (const k of CLIENT_PRESENTATION_FIELDS) if (trade[k] !== undefined) merged[k] = trade[k];
      list[i] = merged; trade = merged;
    } else {
      list[i] = trade;
    }
  } else {
    list.unshift(trade);
  }
  db[userId] = list.slice(0, 5000);
  writeJSON(FILES.trades, db);
  return trade;
}
/* R25-H02: write the immutable FILL event and the trades PROJECTION for an authoritative server fill in ONE
   transaction, so the two stores can never diverge. Previously they were two separate writes — a crash between
   them left the ledger and the projection inconsistent until the drift monitor noticed. Postgres wraps both in a
   single BEGIN/COMMIT (all-or-nothing); flat-file writes both (each file write is atomic) and throws if either
   fails. Both writes are idempotent (trades upsert keyed by user+broker+orderId; fills ON CONFLICT DO NOTHING),
   so a retry after a partial failure converges. Only used for AUTHORITATIVE (server-verified) fills. */
async function recordFillAndTrade(userId, trade) {
  const uref = userRef(userId);
  const nsPrefix = `t_${uref}_`;
  let sid;
  if (trade && trade.orderId != null && String(trade.orderId) !== "") {
    const brkId = String(trade.broker || "x").toLowerCase().replace(/[^a-z0-9]/g, "");
    sid = `${nsPrefix}ord_${brkId}_${String(trade.orderId)}`;
  } else {
    const raw = String((trade && trade.id) || crypto.randomUUID());
    sid = raw.startsWith(nsPrefix) ? raw : `${nsPrefix}${raw}`;
  }
  const row = { ...trade, id: sid, serverAuthored: true };
  const ts = row.exitAt || row.entryAt || Date.now();
  const brk = String((trade && trade.broker) || "x").toLowerCase().replace(/[^a-z0-9]/g, "");
  const oid = String((trade && trade.orderId) != null ? trade.orderId : "");
  const serverTid = String((trade && trade.id) != null ? trade.id : "");
  const filledQ = Number(trade && trade.qty) || 0;
  const fillId = String(
    (trade && trade.fillId) ? trade.fillId
      : oid ? `f_${uref}_${brk}_${oid}_q${filledQ}`
      : serverTid ? `f_${uref}_${brk}_t_${serverTid}`
      : `f_${uref}_${brk}_u_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
  );
  const fillTs = Number(trade && (trade.ts || trade.entryAt)) || Date.now();
  const fillRow = { ...trade, fillId };
  if (USING_PG) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const r = await client.query(
        `INSERT INTO trades (id, user_id, ts, data) VALUES ($1,$2,$3,$4)
         ON CONFLICT (id) DO UPDATE SET ts=EXCLUDED.ts, data=EXCLUDED.data WHERE trades.user_id=EXCLUDED.user_id
         RETURNING id`, [sid, userId, ts, row]);
      if (!r.rowCount) throw new Error("recordFillAndTrade: trade upsert persisted no row (owner conflict) — refusing to split the write");
      await client.query(
        `INSERT INTO fills (fill_id, user_id, broker, order_id, side, qty, price, market, trade_type, ts, data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (fill_id) DO NOTHING`,
        [fillId, String(userId), brk, oid, String(trade.side || ""), Number(trade.qty) || 0, Number(trade.entry != null ? trade.entry : trade.price) || 0, String(trade.market || ""), String(trade.tradeType || ""), fillTs, fillRow]);
      await client.query("COMMIT");
      return { trade: row, fillId };
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch { /* ignore */ }
      throw e;
    } finally { client.release(); }
  }
  // Flat-file: write the projection then the immutable event; each writeJSON is atomic, and a throw on either
  // surfaces to the caller (recordAuthoritativeFill retries the pair and fails loud + halts on a persistent error).
  await saveTrade(userId, trade, { authoritative: true });
  await recordFill(userId, trade);
  return { trade: row, fillId };
}

/* R30-C2: ATOMICALLY write a reduce-only CLOSE — the immutable EXIT fill leg AND every trade-projection row the
   close touches (the reduced residual + the booked closed portion, or the fully-closed row) — in ONE transaction.
   Previously these were separate writes, so a crash after the exit fill left the position open but "already
   recorded", making it unrecoverable on replay. Now either the whole close commits or none of it does. `rows` are
   already-namespaced authoritative trade rows (ids from saveTrade's scheme). Idempotent: the fill is ON CONFLICT
   DO NOTHING and each trade row is an ownership-safe upsert, so a replay of the SAME committed close converges. */
async function recordExitAtomic(userId, { fill, rows = [], expect = [] }) {
  const uref = userRef(userId);
  const brk = String((fill && fill.broker) || "x").toLowerCase().replace(/[^a-z0-9]/g, "");
  const oid = String((fill && fill.orderId) != null ? fill.orderId : "");
  const filledQ = Number(fill && fill.qty) || 0;
  const fillId = String((fill && fill.fillId) ? fill.fillId : oid ? `f_${uref}_${brk}_${oid}_q${filledQ}` : `f_${uref}_${brk}_u_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`);
  const fillTs = Number(fill && (fill.ts || fill.entryAt)) || Date.now();
  const fillRow = { ...fill, fillId };
  if (USING_PG) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // C02 (R31): LOCK the user-owned rows this close mutates (SELECT ... FOR UPDATE) so two concurrent closes
      // serialize. The original open rows being consumed (`expect`) are what MUST be locked + re-validated; new
      // split rows don't exist yet. We lock the ORIGINAL rows and any pre-existing planned ids.
      const lockIds = [...new Set([...(expect || []).map((e) => e.id), ...rows.map((r) => r.id)].filter(Boolean))];
      let locked = { rows: [] };
      if (lockIds.length) locked = await client.query(`SELECT id, data FROM trades WHERE user_id=$1 AND id = ANY($2) FOR UPDATE`, [userId, lockIds]);
      /* C02 STALE-PLAN GUARD. The plan (rows) was computed from a read taken BEFORE this lock. A concurrent replica
         could have consumed the same original open row in between. Now that we hold the row lock, RE-READ each
         consumed original row and confirm it is still open with the quantity the plan assumed. Any mismatch means the
         plan is stale — abort so the caller re-reads under fresh state and re-plans (the lock serializes the DECISION,
         not just the write). */
      if (expect && expect.length) {
        const byId = new Map(locked.rows.map((r) => [String(r.id), r.data || {}]));
        for (const e of expect) {
          const d = byId.get(String(e.id));
          if (!d) { const err = new Error("STALE_PLAN: a targeted position row no longer exists"); err.code = "STALE_PLAN"; throw err; }
          const stillOpen = d.exitAt == null && d.exit == null && !d.exitOrderId && d.status !== "closed";
          const qtyMatch = Math.abs((Number(d.qty) || 0) - (Number(e.qty) || 0)) <= 1e-9;
          if (!stillOpen || !qtyMatch) { const err = new Error("STALE_PLAN: targeted position changed under concurrent close"); err.code = "STALE_PLAN"; throw err; }
        }
      }
      await client.query(
        `INSERT INTO fills (fill_id, user_id, broker, order_id, side, qty, price, market, trade_type, ts, data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (fill_id) DO NOTHING`,
        [fillId, String(userId), brk, oid, String(fill.side || ""), filledQ, Number(fill.entry != null ? fill.entry : fill.price) || 0, String(fill.market || ""), String(fill.tradeType || ""), fillTs, fillRow]);
      for (const row of rows) {
        const ts = row.exitAt || row.entryAt || Date.now();
        const r = await client.query(
          `INSERT INTO trades (id, user_id, ts, data) VALUES ($1,$2,$3,$4)
           ON CONFLICT (id) DO UPDATE SET ts=EXCLUDED.ts, data=EXCLUDED.data WHERE trades.user_id=EXCLUDED.user_id
           RETURNING id`, [row.id, userId, ts, { ...row, serverAuthored: true }]);
        if (!r.rowCount) throw new Error("recordExitAtomic: trade upsert persisted no row (owner conflict) — refusing to split the close");
      }
      await client.query("COMMIT");
      return { fillId, rows: rows.length };
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch { /* ignore */ }
      throw e;
    } finally { client.release(); }
  }
  // Flat-file: apply all trade rows (single atomic bucket write), then the immutable fill. On a crash before the
  // fill, the exitOrderId marker on the rows still makes replay idempotent; each writeJSON is atomic.
  const dbf = readJSON(FILES.trades);
  const list = dbf[userId] || [];
  for (const row of rows) {
    const r = { ...row, serverAuthored: true };
    const i = list.findIndex((t) => t.id === r.id);
    if (i >= 0) list[i] = r; else list.unshift(r);
  }
  dbf[userId] = list.slice(0, 5000);
  writeJSON(FILES.trades, dbf);
  await recordFill(userId, fillRow);
  return { fillId, rows: rows.length };
}
/* ARCH-1: append a VERIFIED broker fill to the immutable ledger. Idempotent on the natural broker key
   (`user_broker_order[_fillId]`) so the same fill — replayed by a retry, a poll and the delayed watcher — is
   recorded exactly once. Never updates an existing row. Returns { inserted } so callers can tell first-write
   from a duplicate. Safe to call in addition to saveTrade (write-through); does not touch the trades table. */
async function recordFill(userId, fill) {
  const uref = userRef(userId);
  const brk = String((fill && fill.broker) || "x").toLowerCase().replace(/[^a-z0-9]/g, "");
  const oid = String((fill && fill.orderId) != null ? fill.orderId : "");
  const serverTid = String((fill && fill.id) != null ? fill.id : "");
  const filledQ = Number(fill && fill.qty) || 0;
  /* Dedupe key precedence (R23-P2-02 / P2-03):
       1. explicit broker EXECUTION id (fill.fillId) — the true per-execution key when a broker reports each fill.
       2. order id + filled quantity (`..._<oid>_q<qty>`). Keying on the order ALONE made the FIRST observation
          authoritative forever, so an order first seen PARTIAL (qty 2) then FILLED (qty 5) stayed permanently
          partial and under-counted. Including the filled quantity makes a partial and a later fuller observation
          DISTINCT append-only events (reconciliation takes the largest qty for the order), while a pure replay of
          the same (order, qty) still collapses to one row.
       3. no broker order id but a server-issued trade id (fill.id, e.g. t_<uref>_...) — stable per trade, so two
          different orderless trades don't collide (the old fallback collapsed them) yet the SAME trade replayed
          by a poll/retry dedupes.
       4. nothing identifying at all — a unique id (nothing to dedupe against anyway). */
  const fillId = String(
    (fill && fill.fillId) ? fill.fillId
      : oid ? `f_${uref}_${brk}_${oid}_q${filledQ}`
      : serverTid ? `f_${uref}_${brk}_t_${serverTid}`
      : `f_${uref}_${brk}_u_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
  );
  const ts = Number(fill && (fill.ts || fill.entryAt)) || Date.now();
  const row = { ...fill, fillId };
  if (USING_PG) {
    const r = await pool.query(
      `INSERT INTO fills (fill_id, user_id, broker, order_id, side, qty, price, market, trade_type, ts, data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (fill_id) DO NOTHING`,
      [fillId, String(userId), brk, oid, String(fill.side || ""), Number(fill.qty) || 0, Number(fill.entry != null ? fill.entry : fill.price) || 0, String(fill.market || ""), String(fill.tradeType || ""), ts, row]
    );
    return { inserted: (r.rowCount || 0) > 0, fillId };
  }
  const f = FILES.fills || (FILES.fills = process.env.FILLS_FILE || path.join(__dirname, "fills.json"));
  const d = readJSON(f); const bucket = d[String(userId)] || {};
  const inserted = !(fillId in bucket);
  if (inserted) { bucket[fillId] = { ...row, ts }; d[String(userId)] = bucket; writeJSON(f, d); }
  return { inserted, fillId };
}
/* Read the immutable fills for a user in a time window (audit / reconciliation / future risk derivation). */
async function getFills(userId, from = 0, to = Date.now()) {
  if (USING_PG) {
    const r = await pool.query(`SELECT data FROM fills WHERE user_id=$1 AND ts>=$2 AND ts<=$3 ORDER BY ts DESC LIMIT 5000`, [String(userId), from, to]);
    return r.rows.map((x) => x.data);
  }
  const f = FILES.fills || (FILES.fills = process.env.FILLS_FILE || path.join(__dirname, "fills.json"));
  return Object.values(readJSON(f)[String(userId)] || {}).filter((x) => (x.ts || 0) >= from && (x.ts || 0) <= to).sort((a, b) => (b.ts || 0) - (a.ts || 0));
}
/* R33-P2-01: read one ledger fill by its immutable fill_id (used to verify an on-conflict fee-final write carries
   identical content — an idempotent replay — vs a changed correction that must be flagged, not silently dropped). */
async function getFillById(userId, fillId) {
  if (!fillId) return null;
  if (USING_PG) {
    const r = await pool.query(`SELECT data FROM fills WHERE user_id=$1 AND fill_id=$2 LIMIT 1`, [String(userId), String(fillId)]);
    return r.rows[0] ? r.rows[0].data : null;
  }
  const f = FILES.fills || (FILES.fills = process.env.FILLS_FILE || path.join(__dirname, "fills.json"));
  return (readJSON(f)[String(userId)] || {})[String(fillId)] || null;
}
/* R34-P2-03 — a source execution fill is UNMATCHED (still needs finalizing) when it is a real execution with no
   `fee_final` OVERLAY referencing it. The original execution row's own `feeFinal` is never rewritten (append-only
   ledger), so "feeFinal != true on the source" alone rediscovers already-finalized work forever. This predicate is
   the single source of truth for both discovery and the provisional list, so metrics reflect TRULY unmatched work. */
function _isUnfinalizedSource(row) {
  return row && row.real === true && row.kind !== "fee_final"
    && String(row.feeStatus || "") !== "contract-note" && row.feeFinal !== true;
}
// Build the set of referenced fill ids that already carry a fee_final overlay, from a user's fills bucket (flat mode).
function _finalizedRefIds(bucket) {
  const s = new Set();
  for (const row of Object.values(bucket || {})) if (row && row.kind === "fee_final" && row.refFillId != null) s.add(String(row.refFillId));
  return s;
}
/* R33-P2-03 / R34-P2-03: discover the DISTINCT storage keys that have UNMATCHED provisional real fills in a window —
   users whose fees still need finalizing, regardless of strategy state (manual traders included) AND excluding fills
   that already have a matching fee_final overlay (so a finalized user isn't rediscovered every sweep). Paginated;
   returns [{ userKey, oldest }] where oldest is the earliest still-unmatched provisional ts. */
async function getUsersWithProvisionalFills(from = 0, to = Date.now(), limit = 1000, offset = 0) {
  if (USING_PG) {
    const r = await pool.query(
      `SELECT s.user_id, MIN(s.ts) AS oldest
         FROM fills s
        WHERE s.ts>=$1 AND s.ts<=$2
          AND (s.data->>'real')='true'
          AND COALESCE(s.data->>'kind','')<>'fee_final'
          AND COALESCE(s.data->>'feeStatus','')<>'contract-note'
          AND COALESCE(s.data->>'feeFinal','false')<>'true'
          AND NOT EXISTS (
            SELECT 1 FROM fills o
             WHERE o.user_id=s.user_id AND o.broker=s.broker
               AND (o.data->>'kind')='fee_final'
               AND (o.data->>'refFillId')=s.fill_id )
        GROUP BY s.user_id ORDER BY s.user_id LIMIT $3 OFFSET $4`,
      [from, to, limit, offset]
    );
    return r.rows.map((x) => ({ userKey: x.user_id, oldest: Number(x.oldest) || 0 }));
  }
  const f = FILES.fills || (FILES.fills = process.env.FILLS_FILE || path.join(__dirname, "fills.json"));
  const d = readJSON(f); const out = [];
  for (const [uid, bucket] of Object.entries(d)) {
    const finalized = _finalizedRefIds(bucket);
    let oldest = Infinity;
    for (const row of Object.values(bucket || {})) {
      if (_isUnfinalizedSource(row) && !finalized.has(String(row.fillId)) && (row.ts || 0) >= from && (row.ts || 0) <= to) oldest = Math.min(oldest, row.ts || 0);
    }
    if (oldest !== Infinity) out.push({ userKey: uid, oldest });
  }
  out.sort((a, b) => (a.userKey < b.userKey ? -1 : 1));
  return out.slice(offset, offset + limit);
}
/* R34-P2-02 / P2-03 — return ALL still-unmatched provisional real fills for a user in a window, PAGINATED TO
   EXHAUSTION (no 5,000-row cap that could split an order's executions and misallocate its order-level charge). Excludes
   fills that already carry a fee_final overlay, so a re-sweep doesn't reprocess finalized work. Because it returns the
   COMPLETE execution set per order in the window, order-level allocation is safe. */
async function getProvisionalFills(userId, from = 0, to = Date.now()) {
  if (USING_PG) {
    const out = []; const pageSize = 5000; let offset = 0;
    for (;;) {
      const r = await pool.query(
        `SELECT s.data FROM fills s
          WHERE s.user_id=$1 AND s.ts>=$2 AND s.ts<=$3
            AND (s.data->>'real')='true'
            AND COALESCE(s.data->>'kind','')<>'fee_final'
            AND COALESCE(s.data->>'feeStatus','')<>'contract-note'
            AND COALESCE(s.data->>'feeFinal','false')<>'true'
            AND NOT EXISTS (
              SELECT 1 FROM fills o
               WHERE o.user_id=s.user_id AND o.broker=s.broker
                 AND (o.data->>'kind')='fee_final'
                 AND (o.data->>'refFillId')=s.fill_id )
          ORDER BY s.ts ASC, s.fill_id ASC LIMIT $4 OFFSET $5`,
        [String(userId), from, to, pageSize, offset]);
      out.push(...r.rows.map((x) => x.data));
      if (r.rows.length < pageSize) break;
      offset += pageSize;
    }
    return out;
  }
  const f = FILES.fills || (FILES.fills = process.env.FILLS_FILE || path.join(__dirname, "fills.json"));
  const bucket = readJSON(f)[String(userId)] || {};
  const finalized = _finalizedRefIds(bucket);
  return Object.values(bucket).filter((row) => _isUnfinalizedSource(row) && !finalized.has(String(row.fillId)) && (row.ts || 0) >= from && (row.ts || 0) <= to);
}
/* R35-P2-04 — the COMPLETE real execution set for a window (paginated to exhaustion), each row annotated with
   `feeFinalized` = whether a fee_final overlay already references it. The EOD matcher needs the full set (finalized +
   not) to allocate order-level charges deterministically and CONVERGE: it computes each execution's share across the
   whole order but only emits overlays for the not-yet-finalized ones. Unlike getProvisionalFills (which drops
   finalized rows), this KEEPS them so partial prior writes can still finish. */
async function getReconcilableFills(userId, from = 0, to = Date.now()) {
  if (USING_PG) {
    const out = []; const pageSize = 5000; let offset = 0;
    for (;;) {
      const r = await pool.query(
        `SELECT s.data,
                EXISTS (SELECT 1 FROM fills o
                         WHERE o.user_id=s.user_id AND o.broker=s.broker
                           AND (o.data->>'kind')='fee_final'
                           AND (o.data->>'refFillId')=s.fill_id) AS finalized
           FROM fills s
          WHERE s.user_id=$1 AND s.ts>=$2 AND s.ts<=$3
            AND (s.data->>'real')='true'
            AND COALESCE(s.data->>'kind','')<>'fee_final'
          ORDER BY s.ts ASC, s.fill_id ASC LIMIT $4 OFFSET $5`,
        [String(userId), from, to, pageSize, offset]);
      out.push(...r.rows.map((x) => ({ ...x.data, feeFinalized: x.finalized === true })));
      if (r.rows.length < pageSize) break;
      offset += pageSize;
    }
    return out;
  }
  const f = FILES.fills || (FILES.fills = process.env.FILLS_FILE || path.join(__dirname, "fills.json"));
  const bucket = readJSON(f)[String(userId)] || {};
  const finalized = _finalizedRefIds(bucket);
  return Object.values(bucket)
    .filter((row) => row && row.real === true && row.kind !== "fee_final" && (row.ts || 0) >= from && (row.ts || 0) <= to)
    .map((row) => ({ ...row, feeFinalized: finalized.has(String(row.fillId)) }));
}
/* R34-P2-02 — total EXECUTION count per (broker, orderId) in a window, counting ALL executions of the order (finalized
   or not). The EOD matcher uses this to REFUSE order-level allocation when the visible (unfinalized) execution set is
   smaller than the order's true size — e.g. some executions were finalized in a prior sweep — so a full order charge is
   never divided across an incomplete subset. Key format matches feeReconcile's bkey: `<broker>+0x1F+<orderId>`. */
async function getOrderExecCounts(userId, from = 0, to = Date.now()) {
  const SEP = "\u001F";
  const out = {};
  if (USING_PG) {
    const r = await pool.query(
      `SELECT LOWER(COALESCE(broker,'')) AS b, (data->>'orderId') AS oid, COUNT(*)::int AS n
         FROM fills
        WHERE user_id=$1 AND ts>=$2 AND ts<=$3
          AND (data->>'real')='true' AND COALESCE(data->>'kind','')<>'fee_final'
          AND (data->>'orderId') IS NOT NULL AND (data->>'orderId')<>''
        GROUP BY 1,2`, [String(userId), from, to]);
    for (const row of r.rows) out[String(row.b) + SEP + String(row.oid)] = Number(row.n) || 0;
    return out;
  }
  const f = FILES.fills || (FILES.fills = process.env.FILLS_FILE || path.join(__dirname, "fills.json"));
  const bucket = readJSON(f)[String(userId)] || {};
  for (const row of Object.values(bucket)) {
    if (!row || row.real !== true || row.kind === "fee_final") continue;
    if (row.orderId == null || String(row.orderId) === "") continue;
    if ((row.ts || 0) < from || (row.ts || 0) > to) continue;
    const k = String(row.broker == null ? "" : row.broker).toLowerCase() + SEP + String(row.orderId);
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}
/* INC-1: pure comparator for risk-journal ↔ fills-ledger drift. Compares the VERIFIED entry legs the risk
   engine reads (server-authored real trades with a broker order id) against the entry fills in the immutable
   ledger, by order id. Returns the drift both ways so a monitor can surface a book that is diverging BEFORE it
   loosens/loses a risk control. Exit fills (kind:"exit") are excluded — they're the closing leg, not an entry.
   Pure and side-effect-free (takes already-read arrays) so it unit-tests without a DB. */
/* H04 — project the immutable fills ledger to ONE authoritative fill per (broker, order, leg), from true broker
   EXECUTION EVENTS when they exist, else from legacy CUMULATIVE snapshots.
     • Per-execution events (recorded with execEvent:true, each carrying its own broker execution id, price, qty,
       time and fees) are SUMMED: qty = Σ, price = quantity-weighted average, fees = Σ, ts = latest. This models
       an order that fills across multiple prices/times accurately (H04). When execution events are present for a
       group, any cumulative snapshot in the same group is IGNORED (the executions are the finer truth).
     • Legacy cumulative snapshots (R24-P2-01: a partial qty=2 row then a fuller qty=5 row are NOT additive) keep
       the MAX-observation behaviour, so historical data projects unchanged.
   Pure; unit-tested without a DB. Every projected row carries `qty, price, fees, side, market, ts, entryOrderId,
   managedId, executions` (executions = count of true execution events, 0 for a legacy snapshot). */
function projectFills(fills) {
  const groups = new Map();
  /* R32-P2-02: fee-finalization events (kind:"fee_final") are NOT executions — they carry an idempotent fee DELTA
     that corrects the provisional fee on the referenced order-leg once the EOD contract note is reconciled. They must
     never be grouped as an entry execution (that double-counted fees + added phantom zero-qty legs). We collect their
     net delta per (broker, orderId, leg), deduped by the referenced fill id (latest wins), and OVERLAY it onto the
     matching projected leg's fees below. */
  const feeDeltas = new Map();
  for (const x of (fills || [])) {
    if (!x || x.orderId == null) continue;
    if (x.kind === "fee_final") {
      const key = `${x.broker || ""}|${String(x.orderId)}|${x.leg === "exit" ? "exit" : "entry"}`;
      let m = feeDeltas.get(key); if (!m) { m = new Map(); feeDeltas.set(key, m); }
      const ref = String(x.refFillId ?? x.fillId ?? "");
      const ts = Number(x.ts) || 0; const prev = m.get(ref);
      if (!prev || ts >= prev.ts) m.set(ref, { delta: Number(x.feeDelta) || 0, ts });
      continue;
    }
    const leg = x.kind === "exit" ? "exit" : "entry";
    const key = `${x.broker || ""}|${String(x.orderId)}|${leg}`;
    let g = groups.get(key);
    if (!g) { g = { broker: x.broker || null, orderId: String(x.orderId), leg, exec: [], snap: null }; groups.set(key, g); }
    const rawPx = Number(x.entry != null ? x.entry : x.price);
    const rec = {
      qty: Number(x.qty) || 0, price: Number.isFinite(rawPx) ? rawPx : null, fees: Number(x.fees) || 0,
      side: x.side || null, market: x.market || null, ts: Number(x.ts != null ? x.ts : x.entryAt) || 0,
      entryOrderId: x.entryOrderId != null ? String(x.entryOrderId) : null, managedId: x.managedId != null ? String(x.managedId) : null,
    };
    if (x.execEvent === true) g.exec.push(rec);
    else if (!g.snap || rec.qty > g.snap.qty) g.snap = rec;   // max-observation cumulative snapshot
  }
  const out = [];
  for (const g of groups.values()) {
    if (g.exec.length) {
      let qty = 0, qtyPriced = 0, notional = 0, fees = 0, ts = 0, side = null, market = null, entryOrderId = null, managedId = null;
      for (const e of g.exec) {
        qty += e.qty; fees += e.fees; ts = Math.max(ts, e.ts);
        if (e.price != null) { notional += e.price * e.qty; qtyPriced += e.qty; }
        side = side || e.side; market = market || e.market;
        entryOrderId = entryOrderId || e.entryOrderId; managedId = managedId || e.managedId;
      }
      const price = qtyPriced > 0 ? notional / qtyPriced : null;
      /* C01 (R31) — an INCOMPLETE execution-event set must NEVER override the correct cumulative snapshot and
         understate quantity/exposure/risk. A best-effort per-execution recorder can drop an event (a failed async
         write); if so, Σ(executions) < the broker's cumulative snapshot. When that happens we project the SNAPSHOT
         (the authoritative cumulative qty), keep the larger fee observation, and flag `incompleteExec` so risk stays
         conservative until the event set reconciles. Only when Σ(executions) ≥ snapshot do the finer per-execution
         values (weighted price + summed fees) win. A snapshot never present ⇒ executions are the sole truth. */
      if (g.snap && g.snap.qty > qty + 1e-9) {
        const s = g.snap;
        out.push({ broker: g.broker, orderId: g.orderId, leg: g.leg, qty: s.qty, price: s.price != null ? s.price : price, fees: Math.max(fees, s.fees), side: side || s.side, market: market || s.market, ts: Math.max(ts, s.ts), entryOrderId: entryOrderId || s.entryOrderId, managedId: managedId || s.managedId, executions: g.exec.length, incompleteExec: true });
      } else {
        out.push({ broker: g.broker, orderId: g.orderId, leg: g.leg, qty, price, fees, side, market, ts, entryOrderId, managedId, executions: g.exec.length });
      }
    } else if (g.snap) {
      const s = g.snap;
      out.push({ broker: g.broker, orderId: g.orderId, leg: g.leg, qty: s.qty, price: s.price, fees: s.fees, side: s.side, market: s.market, ts: s.ts, entryOrderId: s.entryOrderId, managedId: s.managedId, executions: 0 });
    }
  }
  // R32-P2-02: OVERLAY the net EOD fee correction onto the matching projected leg — applied exactly once per
  // (broker, orderId, leg), never re-added as a separate execution. This is what makes fee finality flow into
  // deriveRiskFromFills' net P&L / daily-loss and all display consumers without double-counting.
  if (feeDeltas.size) {
    for (const p of out) {
      const m = feeDeltas.get(`${p.broker || ""}|${p.orderId}|${p.leg}`);
      if (!m) continue;
      let d = 0; for (const v of m.values()) d += v.delta;
      p.fees = +(((Number(p.fees) || 0) + d)).toFixed(6);
      p.feeFinal = true;
    }
  }
  return out;
}
/* R25-H03/H04: derive the RISK-relevant counters straight from the immutable FILLS ledger (the authoritative
   event source), instead of the editable `trades` projection. Entries are projected max-observation fills; a
   round-trip's realized P&L is the matched entry↔exit legs (exit fills carry entryOrderId/managedId set by
   recordExitFill). Direction: a BUY entry profits when the exit price is higher, a SELL (short) when lower.
   Returns the daily entry count, last-entry timestamp, net realized P&L and realized loss over [from,to] — the
   inputs a risk gate needs (trade-count / cooldown / daily-loss). Pure; unit-tests without a DB.
   Currently run in SHADOW MODE (logged, compared to the trades-based gate) before it becomes the source. */
function deriveRiskFromFills(fills, { from = 0, to = Date.now() } = {}) {
  const proj = projectFills(fills);
  const entries = proj.filter((p) => p.leg === "entry");
  const exits = proj.filter((p) => p.leg === "exit");
  const entryById = new Map();
  for (const e of entries) entryById.set(`${e.broker || ""}|${e.orderId}`, e);
  const inWin = (ts) => ts >= from && ts <= to;
  const windowEntries = entries.filter((e) => inWin(e.ts));
  const entryCount = windowEntries.length;
  const lastEntryTs = windowEntries.reduce((m, e) => Math.max(m, e.ts), 0);
  let realizedPnl = 0, realizedPnlGross = 0, realizedLoss = 0, fees = 0, matched = 0, unmatchedExits = 0;
  for (const x of exits) {
    if (!inWin(x.ts)) continue;
    // Match the exit to its entry by the stamped entryOrderId (broker-scoped), else by managedId fallback.
    let e = x.entryOrderId != null ? entryById.get(`${x.broker || ""}|${x.entryOrderId}`) : null;
    if (!e && x.managedId != null) e = entries.find((y) => y.managedId === x.managedId);
    if (!e || x.price == null || e.price == null) { unmatchedExits++; continue; }
    const dir = String(e.side || "").toUpperCase() === "SELL" ? -1 : 1;   // short profits when price falls
    const qty = Math.min(Number(e.qty) || 0, Number(x.qty) || 0) || (Number(x.qty) || 0);
    const gross = (Number(x.price) - Number(e.price)) * qty * dir;
    /* H04: NET realized P&L includes costs — the full exit-leg fees plus the entry-leg fees PRORATED by the
       matched quantity (a partial close only bears its share of the entry cost). deriveRiskFromFills is the
       authoritative risk source, so the daily-loss / P&L counters must be net of brokerage, taxes and exchange
       fees carried on the execution events. Legacy snapshots carry fees:0, so net == gross for historical data. */
    const entryFee = (Number(e.fees) || 0) * ((Number(e.qty) || 0) > 0 ? Math.min(qty, Number(e.qty) || 0) / (Number(e.qty) || 1) : 0);
    const exitFee = Number(x.fees) || 0;
    const cost = entryFee + exitFee;
    const net = gross - cost;
    realizedPnl += net; realizedPnlGross += gross; fees += cost;
    if (net < 0) realizedLoss += -net;
    matched++;
  }
  return { entryCount, lastEntryTs, realizedPnl: +realizedPnl.toFixed(2), realizedPnlGross: +realizedPnlGross.toFixed(2), fees: +fees.toFixed(2), realizedLoss: +realizedLoss.toFixed(2), matched, unmatchedExits };
}
/* R24-P2-02: drift now compares FINANCIAL truth (quantity), not just order-id presence. It matches the risk
   journal's verified entry legs against the ledger's PROJECTED entry fills (max-observation, above) by order id,
   and flags a material quantity mismatch (relative tolerance) in addition to presence gaps. */
function computeLedgerDrift(trades, fills) {
  // R25-H05: key by (broker, orderId) end-to-end. Order ids are only unique PER broker — two brokers can hand the
  // same numeric id to one user, so keying by orderId alone would collide (false zero drift or false mismatch).
  const bkey = (broker, orderId) => `${String(broker || "").toLowerCase()}|${String(orderId)}`;
  const journalEntry = (trades || []).filter((t) => t && t.real === true && t.serverAuthored === true && t.orderId != null && t.status !== "rejected");
  const projectedEntry = projectFills(fills).filter((p) => p.leg === "entry");
  const jById = new Map(journalEntry.map((t) => [bkey(t.broker, t.orderId), t]));
  const lById = new Map(projectedEntry.map((p) => [bkey(p.broker, p.orderId), p]));
  // Matching is broker-scoped, but the REPORTED ids are the bare broker order ids (not the internal composite key).
  const missingInLedger = [...jById.entries()].filter(([k]) => !lById.has(k)).map(([, t]) => String(t.orderId));   // journalled but never made it to the ledger
  const missingInJournal = [...lById.entries()].filter(([k]) => !jById.has(k)).map(([, p]) => String(p.orderId));  // in the ledger but absent from the risk journal
  const qtyMismatch = [];
  for (const [k, t] of jById) {
    const p = lById.get(k);
    if (!p) continue;
    const jq = Number(t.qty) || 0, lq = Number(p.qty) || 0;
    const diff = Math.abs(jq - lq);
    if (diff > 1e-9 && diff / Math.max(1, Math.max(jq, lq)) > 0.001) qtyMismatch.push({ orderId: String(t.orderId), broker: t.broker || null, journalQty: jq, ledgerQty: lq });
  }
  return { journalEntries: jById.size, ledgerEntries: lById.size, missingInLedger, missingInJournal, qtyMismatch, drift: missingInLedger.length + missingInJournal.length + qtyMismatch.length };
}
/* R24-P2-03: exit drift — a CLOSED managed position whose closing leg never reached the immutable ledger. The
   entry-only drift comparator can't see this (exits are excluded there by design), so a lost exit fill would be
   invisible. This matches closed positions to exit fills by managed-position id and reports the ones with no
   recorded exit — a durable repair signal. Pure. */
function computeExitDrift(closedPositions, fills) {
  const exitByManaged = new Set((fills || []).filter((x) => x && x.kind === "exit" && x.managedId != null).map((x) => String(x.managedId)));
  const closed = (closedPositions || []).filter((p) => p && p.status === "closed" && p.id != null);
  const missingExitFill = closed.filter((p) => !exitByManaged.has(String(p.id))).map((p) => String(p.id));
  return { closedPositions: closed.length, exitFills: exitByManaged.size, missingExitFill, drift: missingExitFill.length };
}
/* Read both stores for a user and compute the drift.
   R24-follow-up: this MUST NOT swallow a read failure into an empty array. It is the proof behind the Resume
   unlock (server.js): if either the journal or the fills read fails during an outage, treating the result as
   "[] ⇒ zero drift" would FAIL OPEN and clear the risk lock without any real reconciliation. So a read failure
   now PROPAGATES — the Resume caller wraps this in try/catch and keeps the lock engaged (fail closed) on error.
   A genuinely empty book (no trades / no fills) still returns cleanly with drift 0, which is a valid unlock. */
async function reconcileRiskVsLedger(userId, { from = 0, to = Date.now() } = {}) {
  const [trades, fills] = await Promise.all([
    getTrades(String(userId), from, to),
    getFills(String(userId), from, to),
  ]);
  return computeLedgerDrift(trades, fills);
}
/* R25-C02 / H06: the FULL pre-unlock reconciliation. The Resume unlock must not clear the risk lock while ANY
   order outcome is unresolved, so this aggregates every unresolved signal we hold:
     • entry ledger↔journal drift (presence + quantity, broker-scoped),
     • exit drift (a closed managed position with no recorded exit fill),
     • outstanding pending-protection rows (accepted-but-unfilled orders still being tracked),
     • unknown idempotency rows (orders whose broker outcome we never confirmed).
   ALL reads propagate errors (no catch-to-empty) so a DB outage keeps the lock (fail closed). A genuinely clean,
   fully-reconciled book returns drift 0 → safe to unlock. NOTE: this is still a comparison of Matrix's own
   authoritative stores, not a live broker query — a broker-backed watermark is the remaining hardening (tracked). */
async function reconcileForUnlock(userId) {
  const uid = String(userId);
  const [trades, fills, pending, unknownIntents, positions] = await Promise.all([
    getTrades(uid, 0, Date.now()),
    getFills(uid, 0, Date.now()),
    listPendingProtectionForUser(uid, 500),
    countUnknownIdempotency(uid),
    getManagedPositionsForUser(uid),
  ]);
  const ledger = computeLedgerDrift(trades, fills);
  const exit = computeExitDrift(positions, fills);
  const pendingCount = (pending || []).length;
  const drift = ledger.drift + exit.drift + pendingCount + (unknownIntents || 0);
  return {
    drift,
    ledgerDrift: ledger.drift, exitDrift: exit.drift, pending: pendingCount, unknownIntents: unknownIntents || 0,
    missingInLedger: ledger.missingInLedger, missingInJournal: ledger.missingInJournal, qtyMismatch: ledger.qtyMismatch, missingExitFill: exit.missingExitFill,
  };
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
/* R21-P2-08: recycled-number handoff done ATOMICALLY. When a soft-deleted phone is reused, the previous
   owner's trades must be moved to an opaque archive key AND that archive registered as ONE unit — otherwise a
   crash between the two steps could move history without recording where it went (orphan) or vice-versa. On
   Postgres this runs in a single transaction; flat-file does both writes then only reports success if both
   land. Returns the number of trades reassigned. Throws on failure so the caller can abort the registration. */
async function reassignAndArchiveTrades(phone, fromUserId, archiveKey) {
  if (USING_PG) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`CREATE TABLE IF NOT EXISTS trade_archives (archive_key TEXT PRIMARY KEY, phone TEXT, created_at BIGINT)`);
      await client.query(`INSERT INTO trade_archives (archive_key, phone, created_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [String(archiveKey), String(phone), Date.now()]);
      const r = await client.query(`UPDATE trades SET user_id=$2 WHERE user_id=$1`, [String(fromUserId), String(archiveKey)]);
      // R23-P2-05 / R24-P2-05: move the previous owner's immutable fills to the SAME archive key IN THIS
      // TRANSACTION, so a recycled phone number never inherits the prior person's verified executions. This is NOT
      // swallowed — if the fills move fails, the whole handoff (trade reassign + archive record) rolls back, so we
      // never commit a half-migrated identity that leaves fills on the reusable phone key.
      await client.query(`UPDATE fills SET user_id=$2 WHERE user_id=$1`, [String(fromUserId), String(archiveKey)]);
      await client.query("COMMIT");
      return r.rowCount || 0;
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch { /* ignore */ }
      throw e;
    } finally { client.release(); }
  }
  // Flat-file: reassign then record; if the record write throws, the reassign already happened but we surface
  // the error so the caller aborts and can retry (idempotent — the archive key is deterministic).
  const n = await reassignTrades(fromUserId, archiveKey);
  // R24-P2-05 (flat-file): move the previous owner's fills bucket to the archive key too, so a recycled number
  // doesn't inherit their verified executions. Deterministic/idempotent — merges into any existing archive bucket.
  try {
    const ff = FILES.fills || (FILES.fills = process.env.FILLS_FILE || path.join(__dirname, "fills.json"));
    const fd = readJSON(ff);
    if (fd[String(fromUserId)]) {
      fd[String(archiveKey)] = { ...(fd[String(archiveKey)] || {}), ...fd[String(fromUserId)] };
      delete fd[String(fromUserId)];
      writeJSON(ff, fd);
    }
  } catch (e) { throw new Error(`fills migration failed during account handoff: ${e.message}`); }
  await recordTradeArchive(phone, archiveKey);
  return n;
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
/* R21-P2-09 — ERASURE CONTRACT. On account deletion we ERASE all personal + operational data (credentials,
   config, strategies, positions, ledgers, screeners, ideas). Past TRADES are RETAINED by default
   (preserveTrades) as a financial/audit record under a de-identified stub; the UI states this explicitly.
   This function no longer swallows every failure: it deletes as much as possible, then if ANY store failed it
   THROWS with the list — so the caller reports partial deletion honestly instead of a false "deleted". */
async function deleteAccount(userId, phone, { preserveTrades = true } = {}) {
  const uid = String(userId), ph = String(phone);
  if (USING_PG) {
    const failed = [];
    const del = async (label, sql, params) => { try { await pool.query(sql, params); } catch (e) { failed.push(label); console.error(`[delete] ${label} failed`, e.message); } };
    if (!preserveTrades) await del("trades", `DELETE FROM trades WHERE user_id=$1`, [uid]);
    await del("app_state", `DELETE FROM app_state WHERE user_id=$1`, [uid]);
    await del("broker_creds", `DELETE FROM broker_creds WHERE user_id=$1`, [uid]);
    await del("broker_apps", `DELETE FROM broker_apps WHERE user_id=$1`, [uid]);
    await del("managed_positions", `DELETE FROM managed_positions WHERE user_id=$1`, [uid]);
    await del("real_strategies", `DELETE FROM real_strategies WHERE user_id=$1`, [uid]);
    await del("risk_policy", `DELETE FROM risk_policy WHERE user_id=$1`, [uid]);
    await del("automation_flags", `DELETE FROM automation_flags WHERE user_id=$1`, [uid]);
    await del("user_screeners", `DELETE FROM user_screeners WHERE user_id=$1`, [uid]);
    await del("ideas", `DELETE FROM ideas WHERE owner=$1`, [uid]);
    await del("public_strategies", `DELETE FROM public_strategies WHERE owner=$1`, [uid]);
    try { await purgeLedgersForUser(uid, { preserveFills: preserveTrades }); } catch (e) { failed.push("ledgers"); console.error("[delete] ledgers failed", e.message); }
    if (failed.length) throw new Error(`Account deletion incomplete — these stores could not be cleared: ${failed.join(", ")}. Retry.`);
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
/* FIN-1: single-user DURABLE entry-halt read (survives restart, shared across replicas). The auto-buy engine
   consults this before every automated entry so a reconciliation halt set elsewhere still blocks it. */
async function getEntryHalt(userId) {
  const u = String(userId);
  if (USING_PG) { const r = await pool.query(`SELECT halt_entries FROM automation_flags WHERE user_id=$1`, [u]); return !!(r.rows[0] && r.rows[0].halt_entries); }
  const all = readJSON(FILES.autoFlags); return !!(all[u] && all[u].halt_entries);
}
/* R21-P1-03 / ARCH-3: durable per-user risk-ledger lock. Set when a verified fill can't be persisted; checked by
   every new-entry route so trading can't continue against an incomplete risk history. Cleared on reconciliation.
   MULTI-INSTANCE NOTE: this state — and the entry-halt flag — live in POSTGRES, so they are ALREADY a shared,
   strongly-consistent safety store across replicas (any instance reads the same row). The only process-local
   pieces left are the in-memory `haltedEntries` kill-switch CACHE (a fast mirror of the durable halt, rebuilt at
   startup) and the express rate limiters. For true multi-instance those two would move to Redis (activated by a
   REDIS_URL env), but the AUTHORITATIVE gates are already shared via PG — so a second instance can't bypass a
   set lock. Single-instance today, so no Redis is wired. */
async function setRiskLock(userId, locked) {
  const u = String(userId), on = !!locked, now = Date.now();
  if (USING_PG) {
    await pool.query(
      `INSERT INTO automation_flags (user_id, risk_lock, updated_at) VALUES ($1,$2,$3)
       ON CONFLICT (user_id) DO UPDATE SET risk_lock=$2, updated_at=$3`,
      [u, on, now]
    );
    return;
  }
  const all = readJSON(FILES.autoFlags); all[u] = { ...(all[u] || {}), risk_lock: on, updated_at: now }; writeJSON(FILES.autoFlags, all);
}
async function isRiskLocked(userId) {
  const u = String(userId);
  if (USING_PG) { const r = await pool.query(`SELECT risk_lock FROM automation_flags WHERE user_id=$1`, [u]); return !!(r.rows[0] && r.rows[0].risk_lock); }
  const all = readJSON(FILES.autoFlags); return !!(all[u] && all[u].risk_lock);
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
      `INSERT INTO order_idempotency (user_id, key, response, req_hash, status, created_at, updated_at)
       VALUES ($1,$2,NULL,$3,'in_flight',$4,$4)
       ON CONFLICT (user_id, key) DO NOTHING RETURNING key`, [String(userId), String(key), reqHash, Date.now()]);
    return !!r.rows[0];
  }
  const d = readJSON(FILES.idem || (FILES.idem = path.join(__dirname, "order_idempotency.json")));
  const k = `${userId}|${key}`;
  if (d[k]) return false;
  d[k] = { response: null, reqHash, status: "in_flight", createdAt: Date.now() }; writeJSON(FILES.idem, d); return true;
}
async function getIdempotencyRecord(userId, key) {
  if (USING_PG) { const r = await pool.query(`SELECT response, req_hash, status, updated_at, created_at, tagged FROM order_idempotency WHERE user_id=$1 AND key=$2`, [String(userId), String(key)]); return r.rows[0] ? { response: r.rows[0].response, reqHash: r.rows[0].req_hash, status: r.rows[0].status, updatedAt: r.rows[0].updated_at != null ? Number(r.rows[0].updated_at) : null, createdAt: r.rows[0].created_at != null ? Number(r.rows[0].created_at) : null, tagged: r.rows[0].tagged === true } : null; }
  const d = readJSON(FILES.idem || (FILES.idem = path.join(__dirname, "order_idempotency.json"))); const row = d[`${userId}|${key}`]; return row ? { response: row.response, reqHash: row.reqHash, status: row.status, updatedAt: row.updated_at != null ? Number(row.updated_at) : (row.updatedAt || null), createdAt: row.createdAt != null ? Number(row.createdAt) : null, tagged: row.tagged === true } : null;
}
/* R26-P1-01: record that the ORIGINAL broker order carried our durable tag (FYERS orderTag / Delta
   client_order_id). Only a TAGGED order may later be resolved as "broker never received it" — an untagged
   (legacy) order's missing tag is not proof of absence. Best-effort (never blocks placement). */
async function markIdempotencyTagged(userId, key) {
  if (USING_PG) { await pool.query(`UPDATE order_idempotency SET tagged=TRUE, updated_at=$3 WHERE user_id=$1 AND key=$2`, [String(userId), String(key), Date.now()]).catch(() => {}); return; }
  const f = FILES.idem || (FILES.idem = path.join(__dirname, "order_idempotency.json")); const d = readJSON(f); const row = d[`${userId}|${key}`]; if (row) { row.tagged = true; row.updatedAt = Date.now(); writeJSON(f, d); }
}

/* ─────────────────────────── C03 durable order-attempt state machine ───────────────────────────
   WRITE-BEFORE-SEND: the caller commits a PREPARED attempt (prepareOrderAttempt) and, ONLY if that commits,
   submits to the broker. A crash/outage anywhere after that is recoverable because the attempt (with its
   deterministic order_tag) is already durable. All boundaries consult faultHook so tests can inject failures.
   NOT yet wired into the live order path — flag-gated in orderRecovery.js until the fault-injection suite passes.
   Terminal statuses: FILLED, REJECTED, CANCELLED. Non-terminal (need reconciliation): PREPARED, SUBMITTING,
   ACCEPTED, PARTIAL, UNKNOWN. `resolved` flips true only after broker-backed reconciliation. */
const _ATTEMPT_TERMINAL = new Set(["FILLED", "REJECTED", "CANCELLED"]);
function _attemptFile() { return FILES.orderAttempts || (FILES.orderAttempts = process.env.ORDER_ATTEMPTS_FILE || path.join(__dirname, "order_attempts.json")); }
function _rowFromPg(r) {
  if (!r) return null;
  return { id: r.id, userId: r.user_id, broker: r.broker, idemKey: r.idem_key, orderTag: r.order_tag,
    fingerprint: r.fingerprint, payload: r.payload, symbol: r.symbol, side: r.side, qty: r.qty != null ? Number(r.qty) : null,
    product: r.product, protection: r.protection, status: r.status, brokerOrderId: r.broker_order_id,
    filledQty: r.filled_qty != null ? Number(r.filled_qty) : null, avgPrice: r.avg_price != null ? Number(r.avg_price) : null,
    resolution: r.resolution != null ? r.resolution : null,
    resolved: r.resolved === true, createdAt: r.created_at != null ? Number(r.created_at) : null, updatedAt: r.updated_at != null ? Number(r.updated_at) : null };
}

/* Commit a PREPARED attempt. Consults the fault boundary FIRST — if it (or the DB) fails, this THROWS and the
   caller must NOT touch the broker (no durable identity ⇒ no send). Idempotent on `id`. */
async function prepareOrderAttempt(attempt) {
  faultHook.gate("db.attempt.prepare");
  const a = attempt || {};
  if (!a.id || !a.userId || !a.orderTag) throw new Error("prepareOrderAttempt requires id, userId, orderTag");
  const now = Date.now();
  const row = { id: String(a.id), userId: String(a.userId), broker: a.broker || null, idemKey: a.idemKey || null, orderTag: String(a.orderTag),
    fingerprint: a.fingerprint || null, payload: a.payload || null, symbol: a.symbol || null, side: a.side || null,
    qty: a.qty != null ? Number(a.qty) : null, product: a.product || null, protection: a.protection || null,
    status: "PREPARED", brokerOrderId: null, filledQty: null, avgPrice: null, resolved: false, createdAt: now, updatedAt: now };
  /* C03 ownership/CAS-collision guard: the attempt id is the PK. If a row with this id ALREADY exists, it must
     belong to the SAME user AND carry the SAME order fingerprint (a legit same-request retry) — otherwise it is a
     DIFFERENT request colliding on the id, and proceeding would submit a fresh order while finalizing someone
     else's attempt row. In that case we THROW (the caller must NOT submit). A matching existing row is returned
     as-is (idempotent retry). This makes prepare a safe claim, not a silent no-op. */
  if (USING_PG) {
    const ins = await pool.query(
      `INSERT INTO order_attempts (id,user_id,broker,idem_key,order_tag,fingerprint,payload,symbol,side,qty,product,protection,status,resolved,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'PREPARED',FALSE,$13,$13)
       ON CONFLICT (id) DO NOTHING RETURNING id`,
      [row.id, row.userId, row.broker, row.idemKey, row.orderTag, row.fingerprint, row.payload ? JSON.stringify(row.payload) : null,
       row.symbol, row.side, row.qty, row.product, row.protection ? JSON.stringify(row.protection) : null, now]);
    if (ins.rowCount === 1) return row;               // fresh claim
    const ex = _rowFromPg((await pool.query(`SELECT * FROM order_attempts WHERE id=$1`, [row.id])).rows[0]);
    if (!ex || ex.userId !== row.userId || String(ex.fingerprint || "") !== String(row.fingerprint || "")) {
      throw Object.assign(new Error("order_attempt id collision — refusing to reuse another request's attempt"), { code: "ATTEMPT_ID_COLLISION" });
    }
    return ex;                                          // same user + same fingerprint → legit retry
  }
  const f = _attemptFile(); const d = readJSON(f); const ex = d[row.id];
  if (ex) {
    if (ex.userId !== row.userId || String(ex.fingerprint || "") !== String(row.fingerprint || "")) {
      throw Object.assign(new Error("order_attempt id collision — refusing to reuse another request's attempt"), { code: "ATTEMPT_ID_COLLISION" });
    }
    return ex;
  }
  d[row.id] = row; writeJSON(f, d); return row;
}

/* CAS transition: only moves the row if it is currently in `fromStatus`. Returns the updated row, or null if
   the guard didn't match (someone else already advanced it) — the caller must treat null as "not my turn". */
async function transitionOrderAttempt(id, fromStatus, toStatus, patch = {}) {
  faultHook.gate("db.attempt.transition");
  const now = Date.now();
  if (USING_PG) {
    const r = await pool.query(
      `UPDATE order_attempts SET status=$3, broker_order_id=COALESCE($4,broker_order_id), updated_at=$5
       WHERE id=$1 AND status=$2 RETURNING *`,
      [String(id), String(fromStatus), String(toStatus), patch.brokerOrderId || null, now]);
    return _rowFromPg(r.rows[0]);
  }
  const f = _attemptFile(); const d = readJSON(f); const row = d[String(id)];
  if (!row || row.status !== fromStatus) return null;
  row.status = toStatus; if (patch.brokerOrderId != null) row.brokerOrderId = patch.brokerOrderId; row.updatedAt = now;
  writeJSON(f, d); return row;
}

/* Record the broker outcome. Sets status + broker fields; marks `resolved` when the outcome is terminal (or the
   caller passes resolved:true after a full reconciliation). Idempotent — safe to replay during recovery. */
async function finalizeOrderAttempt(id, status, patch = {}) {
  faultHook.gate("db.attempt.finalize");
  const now = Date.now();
  const resolved = patch.resolved === true || _ATTEMPT_TERMINAL.has(String(status));
  /* R33 follow-up: PERSIST the resolution record (manual flag + evidence) that was previously ignored. Only build a
     non-null value when the caller supplied evidence/manual, and COALESCE on write so an ordinary finalize never wipes
     a previously-recorded resolution. This makes the MANUAL_RECONCILIATION_REQUIRED evidence durable and auditable. */
  const resolution = (patch.evidence !== undefined || patch.manual !== undefined || patch.resolution !== undefined)
    ? (patch.resolution !== undefined ? patch.resolution : { manual: !!patch.manual, evidence: patch.evidence ?? null, at: now })
    : null;
  if (USING_PG) {
    const r = await pool.query(
      `UPDATE order_attempts SET status=$2, broker_order_id=COALESCE($3,broker_order_id),
         filled_qty=COALESCE($4,filled_qty), avg_price=COALESCE($5,avg_price), resolved=$6, updated_at=$7,
         resolution=COALESCE($8::jsonb, resolution)
       WHERE id=$1 RETURNING *`,
      [String(id), String(status), patch.brokerOrderId || null, patch.filledQty != null ? Number(patch.filledQty) : null,
       patch.avgPrice != null ? Number(patch.avgPrice) : null, !!resolved, now, resolution ? JSON.stringify(resolution) : null]);
    return _rowFromPg(r.rows[0]);
  }
  const f = _attemptFile(); const d = readJSON(f); const row = d[String(id)]; if (!row) return null;
  row.status = String(status);
  if (patch.brokerOrderId != null) row.brokerOrderId = patch.brokerOrderId;
  if (patch.filledQty != null) row.filledQty = Number(patch.filledQty);
  if (patch.avgPrice != null) row.avgPrice = Number(patch.avgPrice);
  if (resolution != null) row.resolution = resolution;
  row.resolved = !!resolved; row.updatedAt = now; writeJSON(f, d); return row;
}

async function getOrderAttempt(id) {
  if (USING_PG) { const r = await pool.query(`SELECT * FROM order_attempts WHERE id=$1`, [String(id)]); return _rowFromPg(r.rows[0]); }
  const d = readJSON(_attemptFile()); return d[String(id)] || null;
}

/* C04 single-owner coordination: a session-level pg advisory lock so exactly ONE instance runs the broker-backed
   reconciliation sweep at a time (others no-op). Flat-file/dev has a single process, so it's trivially the owner.
   tryAdvisoryLock returns true iff THIS connection acquired it; releaseAdvisoryLock frees it. Best-effort/fail-open
   on the release; fail-closed (returns false ⇒ not owner ⇒ skip) if the lock can't be acquired. */
/* A session-level pg advisory lock lives on the CONNECTION that took it — `pg_advisory_unlock` and any re-acquire
   MUST run on that SAME connection. Going through `pool.query` picks an arbitrary idle connection each time, so the
   lock would be taken on connection A, "released" on connection B (a no-op — A still holds it), and the next
   acquire from connection C would fail. That silently wedges the single-owner sweep (e.g. the C03 reconciler)
   after its first run. So we CHECK OUT and hold a dedicated client per lock key for the lifetime of the lock, and
   release it back to the pool only after unlocking on that same client. */
const _advisoryClients = new Map();   // key -> checked-out pg client currently holding the lock
async function tryAdvisoryLock(key) {
  if (!USING_PG) return true;
  const k = Number(key) | 0;
  if (_advisoryClients.has(k)) return true;   // already held by this process (re-entrant)
  let client;
  try {
    client = await pool.connect();
    const r = await client.query("SELECT pg_try_advisory_lock($1) AS ok", [k]);
    if (r.rows[0] && r.rows[0].ok === true) { _advisoryClients.set(k, client); return true; }
    client.release(); return false;
  } catch { try { if (client) client.release(); } catch { /* ignore */ } return false; }
}
async function releaseAdvisoryLock(key) {
  if (!USING_PG) return;
  const k = Number(key) | 0;
  const client = _advisoryClients.get(k);
  if (!client) return;                         // not held here
  _advisoryClients.delete(k);
  try { await client.query("SELECT pg_advisory_unlock($1)", [k]); } catch { /* best-effort */ }
  finally { try { client.release(); } catch { /* ignore */ } }
}

/* S7 durable fenced leases. Semantics:
     • acquireLease(name, owner, ttlMs) → { acquired, fence, owner }. Acquires iff the lease is ABSENT, already held by
       THIS owner (renew — fence unchanged), or EXPIRED (takeover — fence incremented so the previous holder is fenced
       out). Held-by-another-and-live ⇒ { acquired:false } plus the current holder's info. The name PK + single UPDATE
       makes the race atomic: exactly one of two concurrent acquirers wins.
     • renewLease(name, owner, fence, ttlMs) → new fence, or null if this worker no longer holds it with that fence
       (it was taken over / expired). A heartbeat that returns null MUST make the worker stand down.
     • fenceValid(name, fence) → true iff `fence` is the CURRENT live fence. A stale worker holds a lower fence ⇒ false,
       so its writes are rejected. This is the guard every single-owner side effect checks before acting.
   Flat-file/dev is a single process, so it is trivially the sole owner (fence persisted in a JSON file for parity). */
function _leaseFile() { return FILES.leases || (FILES.leases = process.env.LEASES_FILE || path.join(__dirname, "leases.json")); }
async function acquireLease(name, owner, ttlMs = 30000) {
  const nm = String(name), ow = String(owner), now = Date.now(), ttl = Number(ttlMs) || 30000;
  if (USING_PG) {
    const r = await pool.query(
      `INSERT INTO leases (name, owner, fence, acquired_at, heartbeat_at, expiry)
         VALUES ($1,$2,1,$3,$3,$4)
       ON CONFLICT (name) DO UPDATE
         SET owner = EXCLUDED.owner,
             fence = CASE WHEN leases.owner = EXCLUDED.owner THEN leases.fence ELSE leases.fence + 1 END,
             acquired_at = CASE WHEN leases.owner = EXCLUDED.owner THEN leases.acquired_at ELSE EXCLUDED.acquired_at END,
             heartbeat_at = EXCLUDED.heartbeat_at,
             expiry = EXCLUDED.expiry
         WHERE leases.owner = EXCLUDED.owner OR leases.expiry <= $3
       RETURNING owner, fence`,
      [nm, ow, now, now + ttl]);
    if (r.rows[0]) return { acquired: true, fence: Number(r.rows[0].fence), owner: ow };
    const cur = await pool.query(`SELECT owner, fence, expiry FROM leases WHERE name=$1`, [nm]);
    const c = cur.rows[0] || {};
    return { acquired: false, fence: Number(c.fence || 0), owner: c.owner || null, expiry: Number(c.expiry || 0) };
  }
  const f = _leaseFile(), d = readJSON(f), cur = d[nm];
  if (cur && cur.owner !== ow && Number(cur.expiry || 0) > now) return { acquired: false, fence: Number(cur.fence || 0), owner: cur.owner, expiry: Number(cur.expiry || 0) };
  const fence = cur ? (cur.owner === ow ? Number(cur.fence || 1) : Number(cur.fence || 0) + 1) : 1;
  d[nm] = { owner: ow, fence, acquiredAt: cur && cur.owner === ow ? cur.acquiredAt : now, heartbeatAt: now, expiry: now + ttl };
  writeJSON(f, d); return { acquired: true, fence, owner: ow };
}
async function renewLease(name, owner, fence, ttlMs = 30000) {
  const nm = String(name), ow = String(owner), fc = Number(fence), now = Date.now(), ttl = Number(ttlMs) || 30000;
  if (USING_PG) {
    const r = await pool.query(
      `UPDATE leases SET heartbeat_at=$4, expiry=$5 WHERE name=$1 AND owner=$2 AND fence=$3 AND expiry > $4 RETURNING fence`,
      [nm, ow, fc, now, now + ttl]);
    return r.rows[0] ? Number(r.rows[0].fence) : null;
  }
  const f = _leaseFile(), d = readJSON(f), cur = d[nm];
  if (!cur || cur.owner !== ow || Number(cur.fence) !== fc || Number(cur.expiry || 0) <= now) return null;
  cur.heartbeatAt = now; cur.expiry = now + ttl; writeJSON(f, d); return fc;
}
async function releaseLease(name, owner) {
  const nm = String(name), ow = String(owner);
  if (USING_PG) { await pool.query(`DELETE FROM leases WHERE name=$1 AND owner=$2`, [nm, ow]); return; }
  const f = _leaseFile(), d = readJSON(f); if (d[nm] && d[nm].owner === ow) { delete d[nm]; writeJSON(f, d); }
}
async function fenceValid(name, fence) {
  const nm = String(name), fc = Number(fence), now = Date.now();
  if (USING_PG) { const r = await pool.query(`SELECT 1 FROM leases WHERE name=$1 AND fence=$2 AND expiry > $3`, [nm, fc, now]); return r.rowCount > 0; }
  const d = readJSON(_leaseFile()), cur = d[nm];
  return !!(cur && Number(cur.fence) === fc && Number(cur.expiry || 0) > now);
}
async function getLease(name) {
  const nm = String(name);
  if (USING_PG) { const r = await pool.query(`SELECT owner, fence, acquired_at, heartbeat_at, expiry FROM leases WHERE name=$1`, [nm]); const x = r.rows[0]; return x ? { owner: x.owner, fence: Number(x.fence), acquiredAt: Number(x.acquired_at), heartbeatAt: Number(x.heartbeat_at), expiry: Number(x.expiry) } : null; }
  const d = readJSON(_leaseFile()); return d[nm] || null;
}

/* S7 signal identity: claim a deterministic signal id exactly once. Returns true iff THIS caller won the claim (first
   inserter); false if some replica/retry already claimed it. The DB PRIMARY KEY is the sole arbiter — no process memory. */
async function claimSignal(id, userId, kind = "signal") {
  const sid = String(id), now = Date.now();
  if (!sid) throw new Error("claimSignal requires an id");
  if (USING_PG) {
    const r = await pool.query(
      `INSERT INTO signal_claims (id, user_id, kind, claimed_at) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING RETURNING id`,
      [sid, String(userId || ""), String(kind || "signal"), now]);
    return r.rowCount > 0;
  }
  const f = FILES.signalClaims || (FILES.signalClaims = process.env.SIGNAL_CLAIMS_FILE || path.join(__dirname, "signal_claims.json"));
  const d = readJSON(f); if (d[sid]) return false; d[sid] = { id: sid, userId: String(userId || ""), kind, claimedAt: now }; writeJSON(f, d); return true;
}

/* Every attempt that hasn't been reconciled yet — the startup-recovery work list. Oldest first. */
async function listUnresolvedOrderAttempts(limit = 500) {
  if (USING_PG) { const r = await pool.query(`SELECT * FROM order_attempts WHERE resolved=FALSE ORDER BY created_at ASC LIMIT $1`, [Number(limit) || 500]); return r.rows.map(_rowFromPg); }
  const d = readJSON(_attemptFile()); return Object.values(d).filter((x) => x && !x.resolved).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)).slice(0, Number(limit) || 500);
}

/* S3.2 PROJECTION_PENDING durable-repair store. A confirmed EXIT execution whose ledger/projection write failed is
   parked here (idempotent on `id`) so a background sweep can REPAIR the projection without re-contacting the broker.
   Never blocks the caller; a persistent failure keeps the account risk-locked. */
function _projFile() { return FILES.projectionPending || (FILES.projectionPending = process.env.PROJECTION_PENDING_FILE || path.join(__dirname, "projection_pending.json")); }
async function saveProjectionPending(item) {
  const id = String(item && item.id);
  if (!id) throw new Error("saveProjectionPending requires an id");
  const now = Date.now();
  if (USING_PG) {
    await pool.query(
      `INSERT INTO projection_pending (id, user_id, kind, order_id, data, attempts, created_at)
       VALUES ($1,$2,$3,$4,$5,0,$6) ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data`,
      [id, String(item.userId || ""), String(item.kind || "exit"), String(item.orderId || ""), item, now]);
    return { id };
  }
  const f = _projFile(); const d = readJSON(f); d[id] = { ...item, id, attempts: (d[id] && d[id].attempts) || 0, createdAt: (d[id] && d[id].createdAt) || now }; writeJSON(f, d); return { id };
}
async function listProjectionPending(limit = 200) {
  if (USING_PG) { const r = await pool.query(`SELECT data, attempts FROM projection_pending ORDER BY created_at ASC LIMIT $1`, [Number(limit) || 200]); return r.rows.map((x) => ({ ...x.data, attempts: x.attempts })); }
  const d = readJSON(_projFile()); return Object.values(d).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)).slice(0, Number(limit) || 200);
}
async function deleteProjectionPending(id) {
  if (USING_PG) { await pool.query(`DELETE FROM projection_pending WHERE id=$1`, [String(id)]); return; }
  const f = _projFile(); const d = readJSON(f); delete d[String(id)]; writeJSON(f, d);
}
async function bumpProjectionPending(id) {
  if (USING_PG) { await pool.query(`UPDATE projection_pending SET attempts=attempts+1 WHERE id=$1`, [String(id)]); return; }
  const f = _projFile(); const d = readJSON(f); if (d[String(id)]) { d[String(id)].attempts = (d[String(id)].attempts || 0) + 1; writeJSON(f, d); }
}
/* R21-P2-05 / R23-P1-02: reclaim STALE idempotency records so a key can't block a user forever — WITHOUT ever
   freeing an UNRESOLVED key into a fresh, duplicate order.
     • An `in_flight` row older than the response deadline means the original request DIED before finalizing
       (crash/timeout); its outcome is unknown, so we mark it `unknown` (never release it) so the UI prompts the
       user to reconcile with the broker.
     • `unknown` rows are NEVER purged. Their whole purpose is to block a same-key retry until a human/broker
       reconciliation resolves them. The frontend now persists ambiguous action IDs indefinitely, so purging an
       `unknown` row would let a returning user win a brand-new claim and place the SAME order twice — the exact
       R23-P1-02 duplicate-order hazard. An `unknown` key becomes reusable only when finalizeIdempotency records a
       conclusive `rejected` (deletes the row) or `succeeded` (replays the stored response instead of re-placing).
     • `succeeded` rows are terminal and are NEVER deleted (R24-P1-02). A client that retained an ambiguous action
       through a lost success response would, after a purge, get `status:none` on reload and could resubmit the
       SAME historical order. So the idempotency identity of a succeeded order is kept permanently — the stored
       response is replayed on any reused key, and `none` never appears for an order that actually went through.
   Returns counts. Safe to run periodically from any instance. */
async function reconcileStaleIdempotency({ inflightMs = 5 * 60 * 1000 } = {}) {
  const now = Date.now();
  if (USING_PG) {
    const m = await pool.query(`UPDATE order_idempotency SET status='unknown', updated_at=$2 WHERE status='in_flight' AND created_at < $1`, [now - inflightMs, now]).catch(() => ({ rowCount: 0 }));
    // Nothing is deleted: 'unknown' rows block until reconciled, 'succeeded' rows are kept forever to replay.
    return { markedUnknown: m.rowCount || 0, purged: 0 };
  }
  const f = FILES.idem || (FILES.idem = path.join(__dirname, "order_idempotency.json"));
  const d = readJSON(f); let marked = 0, changed = false;
  for (const k of Object.keys(d)) {
    const r = d[k]; const created = Number(r.createdAt) || 0;
    if (r.status === "in_flight" && created < now - inflightMs) { r.status = "unknown"; marked++; changed = true; }
    // NOTE: neither 'unknown' nor 'succeeded' is ever purged — terminal identity must survive so a lost success
    // can't become a duplicate, and an unresolved key stays blocked until a broker reconciliation resolves it.
  }
  if (changed) writeJSON(f, d);
  return { markedUnknown: marked, purged: 0 };
}
/* R25: count a user's UNRESOLVED (unknown) idempotency rows — an outstanding order whose broker outcome we
   couldn't confirm. Used by the unlock reconciliation and the account-level new-entry gate: while any exist, the
   book is provably not reconciled. Reads propagate errors (fail closed). */
/* R25-M04: monitoring for the (intentionally never-auto-deleted) idempotency ledger. Retention is unbounded by
   design — deleting terminal keys would let a lost success become a duplicate — so growth must be OBSERVED and
   governed by a defined archive policy (see docs/DATA_GOVERNANCE.md): succeeded rows older than the archive
   window are candidates for a compact archive table that is still consulted for replay/uniqueness; unknown rows
   feed an operational resolution queue. This returns the counts a periodic monitor logs. */
async function idempotencyStats() {
  if (USING_PG) {
    const r = await pool.query(`SELECT status, COUNT(*)::int AS n FROM order_idempotency GROUP BY status`).catch(() => ({ rows: [] }));
    const by = {}; for (const row of r.rows) by[row.status] = row.n;
    const total = Object.values(by).reduce((a, b) => a + b, 0);
    return { total, unknown: by.unknown || 0, succeeded: by.succeeded || 0, inFlight: by.in_flight || 0 };
  }
  const d = readJSON(FILES.idem || (FILES.idem = path.join(__dirname, "order_idempotency.json")));
  const by = {}; for (const k of Object.keys(d)) { const s = (d[k] && d[k].status) || "?"; by[s] = (by[s] || 0) + 1; }
  return { total: Object.keys(d).length, unknown: by.unknown || 0, succeeded: by.succeeded || 0, inFlight: by.in_flight || 0 };
}
async function countUnknownIdempotency(userId) {
  if (USING_PG) {
    const r = await pool.query(`SELECT COUNT(*)::int AS n FROM order_idempotency WHERE user_id=$1 AND status='unknown'`, [String(userId)]);
    return (r.rows[0] && r.rows[0].n) || 0;
  }
  const d = readJSON(FILES.idem || (FILES.idem = path.join(__dirname, "order_idempotency.json")));
  let n = 0; for (const k of Object.keys(d)) if (k.startsWith(`${userId}|`) && d[k] && d[k].status === "unknown") n++;
  return n;
}
/* Finalize the outcome. status ∈ succeeded | rejected | unknown. A 'rejected' (conclusive) DELETES the row
   so a same-key retry may proceed; 'succeeded'/'unknown' persist the response for replay/blocking. */
async function finalizeIdempotency(userId, key, status, response) {
  if (status === "rejected") { await releaseIdempotencyKey(userId, key); return; }
  if (USING_PG) { await pool.query(`UPDATE order_idempotency SET response=$3, status=$4, updated_at=$5 WHERE user_id=$1 AND key=$2`, [String(userId), String(key), response, status, Date.now()]); return; }
  const f = FILES.idem || (FILES.idem = path.join(__dirname, "order_idempotency.json")); const d = readJSON(f); const cur = d[`${userId}|${key}`] || {}; d[`${userId}|${key}`] = { ...cur, response, status, createdAt: cur.createdAt || Date.now(), updatedAt: Date.now() }; writeJSON(f, d);
}
async function releaseIdempotencyKey(userId, key) {
  if (USING_PG) { await pool.query(`DELETE FROM order_idempotency WHERE user_id=$1 AND key=$2`, [String(userId), String(key)]); return; }
  const f = FILES.idem || (FILES.idem = path.join(__dirname, "order_idempotency.json")); const d = readJSON(f); if (d[`${userId}|${key}`]) { delete d[`${userId}|${key}`]; writeJSON(f, d); }
}
/* R17-P2-09 retention: drop a user's idempotency + order-intent ledger rows (called during erasure).
   R24-P2-04: `preserveFills` keeps the immutable fills ledger when trade history is being RETAINED — the fills
   are the audit evidence FOR those retained trades, so deleting them would leave a projection with no proof.
   Only a genuine full erasure (preserveFills=false) removes the fills. */
async function purgeLedgersForUser(userId, { preserveFills = false } = {}) {
  if (USING_PG) {
    await pool.query(`DELETE FROM order_idempotency WHERE user_id=$1`, [String(userId)]).catch(() => {});
    await pool.query(`DELETE FROM order_intents WHERE user_id=$1`, [String(userId)]).catch(() => {});
    await pool.query(`DELETE FROM pending_protection WHERE user_id=$1`, [String(userId)]).catch(() => {});
    // The immutable fills ledger is the verification source for retained trades — only wipe it on full erasure.
    if (!preserveFills) await pool.query(`DELETE FROM fills WHERE user_id=$1`, [String(userId)]).catch(() => {});
    // R19-P2-10: personal in-app notices are personal data — purge them on account deletion too.
    await pool.query(`DELETE FROM user_notices WHERE user_id=$1`, [String(userId)]).catch(() => {});
    return;
  }
  for (const key of ["idem"]) { const f = FILES[key]; if (!f) continue; const d = readJSON(f); let ch = false; for (const k of Object.keys(d)) if (k.startsWith(`${userId}|`)) { delete d[k]; ch = true; } if (ch) writeJSON(f, d); }
  // R23-P2-05 / R24-P2-04 (flat-file): fills are bucketed by user id — drop this user's bucket ONLY on full erasure.
  if (!preserveFills) { try { const ff = FILES.fills; if (ff) { const fd = readJSON(ff); if (fd[String(userId)]) { delete fd[String(userId)]; writeJSON(ff, fd); } } } catch { /* non-fatal */ } }
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

/* Web Push subscriptions. One row per browser (endpoint is the key), carrying the user's per-category
   notification prefs. Re-subscribe from the same device upserts. */
const PUSH_FILE = () => (FILES.push || (FILES.push = process.env.PUSH_SUBS_FILE || path.join(__dirname, "push_subscriptions.json")));
async function savePushSubscription(userId, sub, prefs) {
  const endpoint = sub && sub.endpoint;
  if (!endpoint) return;
  const p256dh = sub.keys && sub.keys.p256dh, auth = sub.keys && sub.keys.auth;
  if (USING_PG) {
    await pool.query(
      `INSERT INTO push_subscriptions (endpoint,user_id,p256dh,auth,prefs,created_at) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (endpoint) DO UPDATE SET user_id=EXCLUDED.user_id, p256dh=EXCLUDED.p256dh, auth=EXCLUDED.auth, prefs=EXCLUDED.prefs`,
      [endpoint, String(userId), p256dh, auth, prefs || {}, Date.now()]
    ).catch(() => {});
    return;
  }
  const d = readJSON(PUSH_FILE()); d[endpoint] = { endpoint, user_id: String(userId), p256dh, auth, prefs: prefs || {}, created_at: Date.now() }; writeJSON(PUSH_FILE(), d);
}
async function deletePushSubscription(endpoint) {
  if (!endpoint) return;
  if (USING_PG) { await pool.query(`DELETE FROM push_subscriptions WHERE endpoint=$1`, [endpoint]).catch(() => {}); return; }
  const d = readJSON(PUSH_FILE()); delete d[endpoint]; writeJSON(PUSH_FILE(), d);
}
async function updatePushPrefs(userId, prefs) {
  if (USING_PG) { await pool.query(`UPDATE push_subscriptions SET prefs=$2 WHERE user_id=$1`, [String(userId), prefs || {}]).catch(() => {}); return; }
  const d = readJSON(PUSH_FILE()); let n = 0; for (const k of Object.keys(d)) { if (d[k].user_id === String(userId)) { d[k].prefs = prefs || {}; n++; } } if (n) writeJSON(PUSH_FILE(), d);
}
async function getPushSubscriptions(userId) {
  if (USING_PG) { const r = await pool.query(`SELECT endpoint,p256dh,auth,prefs FROM push_subscriptions WHERE user_id=$1`, [String(userId)]); return r.rows.map((x) => ({ endpoint: x.endpoint, keys: { p256dh: x.p256dh, auth: x.auth }, prefs: x.prefs || {} })); }
  const d = readJSON(PUSH_FILE()); return Object.values(d).filter((x) => x.user_id === String(userId)).map((x) => ({ endpoint: x.endpoint, keys: { p256dh: x.p256dh, auth: x.auth }, prefs: x.prefs || {} }));
}

/* UX-3: user price alerts. `data` holds the alert config (symbol, market, type, threshold, note). */
const ALERTS_FILE = () => (FILES.alerts || (FILES.alerts = process.env.ALERTS_FILE || path.join(__dirname, "user_alerts.json")));
async function saveAlert(userId, alert) {
  const id = `al_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const row = { id, user_id: String(userId), data: alert, active: true, last_fired_at: 0, created_at: Date.now() };
  if (USING_PG) {
    await pool.query(`INSERT INTO user_alerts (id,user_id,data,active,last_fired_at,created_at) VALUES ($1,$2,$3,TRUE,0,$4)`, [id, String(userId), alert, row.created_at]);
    return { id, ...alert, active: true, createdAt: row.created_at };
  }
  const d = readJSON(ALERTS_FILE()); d[id] = row; writeJSON(ALERTS_FILE(), d);
  return { id, ...alert, active: true, createdAt: row.created_at };
}
async function getAlertsForUser(userId) {
  if (USING_PG) { const r = await pool.query(`SELECT id,data,active,last_fired_at,created_at FROM user_alerts WHERE user_id=$1 ORDER BY created_at DESC`, [String(userId)]); return r.rows.map((x) => ({ id: x.id, ...x.data, active: x.active, lastFiredAt: Number(x.last_fired_at) || 0, createdAt: Number(x.created_at) })); }
  const d = readJSON(ALERTS_FILE()); return Object.values(d).filter((x) => x.user_id === String(userId)).sort((a, b) => b.created_at - a.created_at).map((x) => ({ id: x.id, ...x.data, active: x.active, lastFiredAt: Number(x.last_fired_at) || 0, createdAt: Number(x.created_at) }));
}
async function deleteAlert(userId, id) {
  if (USING_PG) { const r = await pool.query(`DELETE FROM user_alerts WHERE id=$1 AND user_id=$2`, [id, String(userId)]); return r.rowCount > 0; }
  const d = readJSON(ALERTS_FILE()); if (d[id] && d[id].user_id === String(userId)) { delete d[id]; writeJSON(ALERTS_FILE(), d); return true; } return false;
}
async function setAlertActive(userId, id, active) {
  if (USING_PG) { const r = await pool.query(`UPDATE user_alerts SET active=$3 WHERE id=$1 AND user_id=$2`, [id, String(userId), !!active]); return r.rowCount > 0; }
  const d = readJSON(ALERTS_FILE()); if (d[id] && d[id].user_id === String(userId)) { d[id].active = !!active; writeJSON(ALERTS_FILE(), d); return true; } return false;
}
/* Engine reads: all ACTIVE alerts (across users) to evaluate against fresh quotes. */
async function getActiveAlerts(limit = 2000) {
  if (USING_PG) { const r = await pool.query(`SELECT id,user_id,data,last_fired_at FROM user_alerts WHERE active=TRUE LIMIT $1`, [limit]); return r.rows.map((x) => ({ id: x.id, userId: x.user_id, ...x.data, lastFiredAt: Number(x.last_fired_at) || 0 })); }
  const d = readJSON(ALERTS_FILE()); return Object.values(d).filter((x) => x.active).slice(0, limit).map((x) => ({ id: x.id, userId: x.user_id, ...x.data, lastFiredAt: Number(x.last_fired_at) || 0 }));
}
/* Stamp the fire time (for the per-alert cooldown) after an alert has pushed. */
async function markAlertFired(id, atMs) {
  if (USING_PG) { await pool.query(`UPDATE user_alerts SET last_fired_at=$2 WHERE id=$1`, [id, Number(atMs) || Date.now()]).catch(() => {}); return; }
  const d = readJSON(ALERTS_FILE()); if (d[id]) { d[id].last_fired_at = Number(atMs) || Date.now(); writeJSON(ALERTS_FILE(), d); }
}

/* Append-only admin audit trail. Records are inserted, never updated/deleted by the app. */
const AUDIT_FILE = () => (FILES.adminAudit || (FILES.adminAudit = process.env.ADMIN_AUDIT_FILE || path.join(__dirname, "admin_audit.json")));
async function logAdminAction(entry) {
  const row = {
    id: `aa_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    at: Date.now(),
    actor: String(entry.actor || "unknown"),
    role: String(entry.role || ""),
    action: String(entry.action || ""),
    target: entry.target != null ? String(entry.target) : null,
    detail: entry.detail || {},
    ip: entry.ip != null ? String(entry.ip) : null,
  };
  if (USING_PG) {
    await pool.query(
      `INSERT INTO admin_audit (id,at,actor,role,action,target,detail,ip) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [row.id, row.at, row.actor, row.role, row.action, row.target, row.detail, row.ip]
    );
    return row;
  }
  const d = readJSON(AUDIT_FILE()); const arr = Array.isArray(d.rows) ? d.rows : []; arr.unshift(row); d.rows = arr.slice(0, 5000); writeJSON(AUDIT_FILE(), d); return row;
}
async function getAdminAudit(limit = 200, offset = 0) {
  if (USING_PG) { const r = await pool.query(`SELECT id,at,actor,role,action,target,detail,ip FROM admin_audit ORDER BY at DESC LIMIT $1 OFFSET $2`, [limit, offset]); return r.rows.map((x) => ({ ...x, at: Number(x.at) })); }
  const d = readJSON(AUDIT_FILE()); const arr = Array.isArray(d.rows) ? d.rows : []; return arr.slice(offset, offset + limit);
}
/* R16-P2-10 delayed-fill protection store. */
async function savePendingProtection(rec) {
  const row = { id: rec.id, user_id: String(rec.userId), broker: rec.broker, order_id: String(rec.orderId), data: rec, attempts: 0, created_at: Date.now() };
  if (USING_PG) { await pool.query(`INSERT INTO pending_protection (id,user_id,broker,order_id,data,attempts,created_at) VALUES ($1,$2,$3,$4,$5,0,$6) ON CONFLICT (id) DO NOTHING`, [row.id, row.user_id, row.broker, row.order_id, rec, row.created_at]); return row; }
  const f = FILES.pendingProt || (FILES.pendingProt = path.join(__dirname, "pending_protection.json")); const d = readJSON(f); d[row.id] = row; writeJSON(f, d); return row;
}
async function listPendingProtection(limit = 500) {
  if (USING_PG) { const r = await pool.query(`SELECT data, attempts, created_at FROM pending_protection ORDER BY created_at ASC LIMIT $1`, [limit]); return r.rows.map((x) => ({ ...x.data, attempts: x.attempts, created_at: Number(x.created_at) || (x.data && x.data.createdAt) || null })); }
  const f = FILES.pendingProt || (FILES.pendingProt = path.join(__dirname, "pending_protection.json")); return Object.values(readJSON(f)).map((x) => ({ ...x.data, attempts: x.attempts, created_at: Number(x.created_at) || (x.data && x.data.createdAt) || null })).slice(0, limit);
}
/* R19-P2-11: query pending-protection rows for ONE user directly, so a per-user status endpoint isn't
   capped by a global LIMIT (a busy platform could push a user's own rows past the first page). */
async function listPendingProtectionForUser(userId, limit = 200) {
  if (USING_PG) { const r = await pool.query(`SELECT data, attempts, created_at FROM pending_protection WHERE user_id=$1 ORDER BY created_at ASC LIMIT $2`, [String(userId), limit]); return r.rows.map((x) => ({ ...x.data, attempts: x.attempts, created_at: Number(x.created_at) || (x.data && x.data.createdAt) || null })); }
  const f = FILES.pendingProt || (FILES.pendingProt = path.join(__dirname, "pending_protection.json"));
  return Object.values(readJSON(f)).map((x) => ({ ...x.data, attempts: x.attempts, created_at: Number(x.created_at) || (x.data && x.data.createdAt) || null })).filter((x) => String(x.userId) === String(userId)).slice(0, limit);
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
       RETURNING data, attempts, created_at`, [now + leaseMs, now, limit]);
    // R22-fix: created_at is a top-level column (NOT inside data). The watcher ages rows by p.created_at,
    // so it MUST be carried through — otherwise every freshly-claimed row reads created_at=0 and the
    // watcher treats it as >8h old and expires it immediately (plain + protected FYERS fills never reconcile).
    return r.rows.map((x) => ({ ...x.data, attempts: x.attempts, created_at: Number(x.created_at) || (x.data && x.data.createdAt) || now }));
  }
  const f = FILES.pendingProt || (FILES.pendingProt = path.join(__dirname, "pending_protection.json"));
  const d = readJSON(f); const out = [];
  for (const k of Object.keys(d)) { const row = d[k]; if ((row.leased_until || 0) < now) { row.leased_until = now + leaseMs; row.attempts = (row.attempts || 0) + 1; out.push({ ...row.data, attempts: row.attempts, created_at: Number(row.created_at) || (row.data && row.data.createdAt) || now }); } }
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
    // §8/§9: surface the row VERSION so the engine can build a version-aware signal identity (an edit bumps the
    // version, so a new version re-evaluates a candle fresh and never collides with the old consumed signal).
    const r = await pool.query(`SELECT data, version FROM real_strategies WHERE status='active' ORDER BY updated_at ASC LIMIT $1`, [limit]);
    return r.rows.map((x) => ({ ...x.data, version: Number(x.version) || Number(x.data && x.data.version) || 1 }));
  }
  return Object.values(readJSON(FILES.realStrats)).filter((s) => s.status === "active").slice(0, limit).map((s) => ({ ...s, version: Number(s.version) || 1 }));
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
/* R21-P2-10 concurrency contract: on Postgres this is an ATOMIC field-level merge — `data = data || $3::jsonb`
   runs entirely inside one UPDATE, so two concurrent patches to DIFFERENT fields BOTH land (no read-modify-write
   lost update), same-field patches serialize last-writer-wins, and `version` bumps atomically. The money-
   critical mutual-exclusion (no double entry / double exit) is handled separately by the compare-and-set claims
   (claimRealStrategyForEntry / claimManagedForExit) and by transitionRealStrategy for expected-version edges;
   this generic merge is for telemetry + non-conflicting lifecycle fields. Flat-file mode below is a racy
   read-modify-write and is DEV-ONLY — real trading requires Postgres (startup warns when DATABASE_URL is unset). */
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

module.exports = { updateSecurityQuestion, getSecurityQuestion, getSecurityAnswerHash, listUsers, setUserBlocked, isUserBlocked, setUserApproved, unapproveUserAndRevoke, listPendingUsers, getUserFull, initDb, saveTrade, recordFill, recordFillAndTrade, recordExitAtomic, getFills, getFillById, getUsersWithProvisionalFills, getProvisionalFills, getReconcilableFills, getOrderExecCounts, computeLedgerDrift, projectFills, deriveRiskFromFills, computeExitDrift, reconcileRiskVsLedger, reconcileForUnlock, countUnknownIdempotency, idempotencyStats, getTrades, reassignTrades, recordTradeArchive, reassignAndArchiveTrades, getArchivedTradesForPhone, deleteTradesByIds, clearVirtualTrades, clearTradesByType, getUser, createUser, updateUserPin, updateUserPinAndBumpToken, bumpTokenVersion, getTokenVersion, getState, saveState, getScreeners, saveScreeners, setEntryHalt, getHaltedEntryUsers, setRiskLock, isRiskLocked, getOpenTrades, updateTrade, getUserByUsername, setUsername, setEmail, setLastLogin, publishStrategy, unpublishStrategy, listPublicStrategies, postIdea, deleteIdea, listIdeas, getIdeaScreenshot, reviewIdea, saveBrokerCred, getBrokerCred, deleteBrokerCred, saveBrokerApp, getBrokerApp, getAllBrokerApps, deleteBrokerApp, getAppSettings, saveAppSettings, deleteAccount, saveManagedPosition, getOpenManagedPositions, getManagedPositionsForUser, updateManagedPosition, claimManagedForExit, claimRealStrategyForEntry, transitionRealStrategy, claimIdempotencyKey, getIdempotencyRecord, markIdempotencyTagged, finalizeIdempotency, releaseIdempotencyKey, reconcileStaleIdempotency, purgeLedgersForUser, savePendingProtection, listPendingProtection, listPendingProtectionForUser, claimPendingProtection, bumpPendingProtection, deletePendingProtection, saveOAuthState, consumeOAuthStateRow, addNotice, getNotices, markNoticesRead, savePushSubscription, deletePushSubscription, updatePushPrefs, getPushSubscriptions, saveAlert, getAlertsForUser, deleteAlert, setAlertActive, getActiveAlerts, markAlertFired, getEntryHalt, logAdminAction, getAdminAudit, saveRiskPolicy, getRiskPolicy, saveRealStrategy, getActiveRealStrategies, getRealStrategiesForUser, updateRealStrategy, prepareOrderAttempt, transitionOrderAttempt, finalizeOrderAttempt, getOrderAttempt, listUnresolvedOrderAttempts, tryAdvisoryLock, releaseAdvisoryLock, saveProjectionPending, listProjectionPending, deleteProjectionPending, bumpProjectionPending, acquireLease, renewLease, releaseLease, fenceValid, getLease, claimSignal, runSchemaMigrations, schemaIsAtTarget, USING_PG };
