/* R31-P3-07 — VERSIONED EXPAND/CONTRACT SCHEMA MIGRATIONS.
 *
 * The historical schema is created inline in db.initDb() with CREATE TABLE / ALTER … IF NOT EXISTS (idempotent, but
 * unversioned — a rolling release can't tell which schema is live, and "expand then contract" changes have no ordered
 * ledger). This module adds that ledger WITHOUT ripping out the working inline init: a `schema_migrations` table
 * records every applied version, and NEW schema changes are appended here as ordered, expand/contract-safe steps so
 * readiness can be tied to a target schema version.
 *
 * Design rules for every migration `up`:
 *   • EXPAND-only per release: add columns/tables/indexes (all IF NOT EXISTS) — never drop or rename in the same
 *     release a rolling deploy still reads/writes the old shape. A CONTRACT (drop the now-unused old column) ships a
 *     release LATER, as its own migration, once no instance uses it.
 *   • IDEMPOTENT: safe to run twice (the ledger also guards, but belt-and-suspenders).
 *   • TRANSACTIONAL per step is the caller's choice; DDL here is individually idempotent.
 *
 * Pure + injected (`query`, optional `advisoryLock`) so it unit-tests with a fake query and no live DB. db.js wires
 * the real pool.query + its advisory lock (single-runner across replicas) and calls this at startup.
 */

// Ordered list. APPEND new migrations; never reorder or mutate an already-shipped version's `up`.
const SCHEMA_MIGRATIONS = [
  {
    version: "2026-08-04-000-baseline",
    name: "baseline — existing tables are owned by db.initDb()'s idempotent inline DDL",
    // No-op: marks the pre-migration schema as version 0 so future expand/contract steps have an ordered anchor.
    up: async () => {},
  },
  {
    // R32-P4-01: a REAL expand migration (idempotent). The EOD fee-reconciliation (R31-P2-08) and the risk-vs-ledger
    // drift join both look up fills by (user_id, order_id); this index makes those order-scoped scans fast. EXPAND-only
    // (adds an index, drops nothing), CREATE INDEX IF NOT EXISTS ⇒ safe to run twice and on an existing DB.
    version: "2026-08-04-001-fills-order-index",
    name: "expand: index fills(user_id, order_id) for order-scoped fee/drift reconciliation",
    up: async (query) => { await query(`CREATE INDEX IF NOT EXISTS fills_user_order ON fills (user_id, order_id)`); },
  },
  {
    // R35-P3-01: the manual-reconciliation evidence column (order_attempts.resolution JSONB) is now part of the ORDERED
    // versioned chain, so readiness can be tied to it and migration artifacts prove when it was applied. EXPAND-only,
    // idempotent. db.initDb() also keeps an inline `ADD COLUMN IF NOT EXISTS` for rolling-deploy compatibility during
    // the supported upgrade window; that inline DDL is removed a release LATER once every replica is at this version.
    version: "2026-08-04-002-order-attempts-resolution",
    name: "expand: order_attempts.resolution JSONB for durable manual-reconciliation evidence",
    up: async (query) => { await query(`ALTER TABLE order_attempts ADD COLUMN IF NOT EXISTS resolution JSONB`); },
  },
];

// The version the code EXPECTS to be live — readiness can gate real-money features on reaching it.
const TARGET_SCHEMA_VERSION = SCHEMA_MIGRATIONS[SCHEMA_MIGRATIONS.length - 1].version;

/* Apply all pending migrations in order. Single-runner via the optional advisoryLock so exactly one replica migrates.
   Records each applied version in schema_migrations; a migration that throws STOPS the run (not recorded ⇒ retried).
   Returns { applied, total, atVersion } or { skipped, reason } when another replica holds the lock. */
async function applyMigrations({ query, migrations = SCHEMA_MIGRATIONS, advisoryLock = null, log = () => {} }) {
  if (typeof query !== "function") throw new Error("applyMigrations requires a query(sql, params) function");
  let owner = true;
  if (advisoryLock) { owner = await advisoryLock.acquire(); if (!owner) return { skipped: true, reason: "not-owner" }; }
  try {
    await query(`CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, name TEXT, applied_at BIGINT)`);
    const res = await query(`SELECT version FROM schema_migrations`);
    const done = new Set((res && res.rows ? res.rows : []).map((r) => String(r.version)));
    let applied = 0;
    for (const m of migrations) {
      if (done.has(String(m.version))) continue;
      await m.up(query);   // throws ⇒ propagate (below), leaving it UNrecorded so the next boot retries it
      await query(
        `INSERT INTO schema_migrations (version, name, applied_at) VALUES ($1,$2,$3) ON CONFLICT (version) DO NOTHING`,
        [String(m.version), String(m.name || ""), Date.now()],
      );
      applied++;
      log("migration.applied", { version: m.version, name: m.name });
    }
    const atVersion = migrations.length ? migrations[migrations.length - 1].version : null;
    return { applied, total: migrations.length, atVersion };
  } finally {
    if (advisoryLock && owner) { try { await advisoryLock.release(); } catch { /* best-effort */ } }
  }
}

/* Is the live schema at (or past) a target version? Used to tie readiness to the target schema — a real-money flag
   should refuse to serve until the DB has migrated to the version the running code expects. Fail-closed: any read
   error ⇒ false (treat as not-ready). */
async function schemaAtVersion(query, target = TARGET_SCHEMA_VERSION) {
  try {
    await query(`CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, name TEXT, applied_at BIGINT)`);
    const res = await query(`SELECT version FROM schema_migrations WHERE version=$1`, [String(target)]);
    return !!(res && res.rows && res.rows.length);
  } catch { return false; }
}

module.exports = { SCHEMA_MIGRATIONS, TARGET_SCHEMA_VERSION, applyMigrations, schemaAtVersion };
