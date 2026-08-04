/* R31-P3-07 — versioned expand/contract migration runner. Proves the runner against a tiny in-memory `query`
   double (no live DB): it creates the ledger, applies each pending migration exactly once, is idempotent on re-run,
   records versions, stops (and does NOT record) on a throwing migration, and honours the single-runner advisory
   lock. schemaAtVersion ties readiness to a target version. */
const test = require("node:test");
const assert = require("node:assert");
const { applyMigrations, schemaAtVersion, SCHEMA_MIGRATIONS, TARGET_SCHEMA_VERSION } = require("../migrations.js");

// Minimal in-memory Postgres-ish double: understands the exact statements the runner issues.
function fakeDb() {
  const ledger = new Map();   // version -> { name, applied_at }
  const ddl = [];             // record DDL a migration's up() runs, so a test can assert it happened
  async function query(sql, params = []) {
    if (/CREATE TABLE IF NOT EXISTS schema_migrations/i.test(sql)) return { rows: [] };
    if (/^\s*SELECT version FROM schema_migrations WHERE version=/i.test(sql)) {
      return { rows: ledger.has(String(params[0])) ? [{ version: String(params[0]) }] : [] };
    }
    if (/^\s*SELECT version FROM schema_migrations\s*$/i.test(sql)) {
      return { rows: [...ledger.keys()].map((v) => ({ version: v })) };
    }
    if (/INSERT INTO schema_migrations/i.test(sql)) {
      const [version, name, applied_at] = params;
      if (!ledger.has(String(version))) ledger.set(String(version), { name, applied_at });
      return { rows: [] };
    }
    ddl.push({ sql, params });   // a migration's up() DDL
    return { rows: [] };
  }
  return { query, ledger, ddl };
}

test("R31-P3-07: applies the baseline once and is IDEMPOTENT on re-run", async () => {
  const db = fakeDb();
  const r1 = await applyMigrations({ query: db.query });
  assert.equal(r1.applied, SCHEMA_MIGRATIONS.length, "all pending migrations applied on first run");
  assert.equal(db.ledger.size, SCHEMA_MIGRATIONS.length, "each recorded in the ledger");
  const r2 = await applyMigrations({ query: db.query });
  assert.equal(r2.applied, 0, "a second run applies nothing (idempotent)");
  assert.equal(db.ledger.size, SCHEMA_MIGRATIONS.length, "ledger unchanged");
  assert.equal(r2.atVersion, TARGET_SCHEMA_VERSION);
});

test("R31-P3-07: applies migrations IN ORDER and runs each up()'s DDL exactly once", async () => {
  const db = fakeDb();
  const order = [];
  const migs = [
    { version: "v1", name: "a", up: async (q) => { order.push("v1"); await q("ALTER TABLE t ADD COLUMN IF NOT EXISTS a INT"); } },
    { version: "v2", name: "b", up: async (q) => { order.push("v2"); await q("ALTER TABLE t ADD COLUMN IF NOT EXISTS b INT"); } },
  ];
  await applyMigrations({ query: db.query, migrations: migs });
  assert.deepEqual(order, ["v1", "v2"], "ordered application");
  assert.equal(db.ddl.length, 2, "each up() DDL ran once");
  // Re-run: no DDL repeats.
  await applyMigrations({ query: db.query, migrations: migs });
  assert.equal(db.ddl.length, 2, "no DDL repeated on the idempotent re-run");
});

test("R31-P3-07: a THROWING migration stops the run and is NOT recorded (retried next boot)", async () => {
  const db = fakeDb();
  const migs = [
    { version: "ok1", name: "ok", up: async () => {} },
    { version: "boom", name: "bad", up: async () => { throw new Error("bad DDL"); } },
    { version: "never", name: "after", up: async () => {} },
  ];
  await assert.rejects(() => applyMigrations({ query: db.query, migrations: migs }), /bad DDL/);
  assert.equal(db.ledger.has("ok1"), true, "the pre-failure migration is recorded");
  assert.equal(db.ledger.has("boom"), false, "the failed migration is NOT recorded");
  assert.equal(db.ledger.has("never"), false, "a migration after the failure never runs");
  // Fix + re-run: it resumes from the failed one (here we swap in a good up()).
  const fixed = migs.map((m) => (m.version === "boom" ? { ...m, up: async () => {} } : m));
  await applyMigrations({ query: db.query, migrations: fixed });
  assert.equal(db.ledger.has("boom"), true, "resumes and records after the fix");
  assert.equal(db.ledger.has("never"), true, "and continues past it");
});

test("R31-P3-07: the single-runner advisory lock gates migration (non-owner skips)", async () => {
  const db = fakeDb();
  const notOwner = { acquire: async () => false, release: async () => {} };
  const r = await applyMigrations({ query: db.query, advisoryLock: notOwner });
  assert.equal(r.skipped, true, "a non-owner replica does not migrate");
  assert.equal(db.ledger.size, 0, "nothing applied while another replica owns the lock");

  let released = false;
  const owner = { acquire: async () => true, release: async () => { released = true; } };
  await applyMigrations({ query: db.query, advisoryLock: owner });
  assert.equal(db.ledger.size, SCHEMA_MIGRATIONS.length, "the owner applies migrations");
  assert.equal(released, true, "the lock is released after the run");
});

test("R31-P3-07: schemaAtVersion ties readiness to the target version", async () => {
  const db = fakeDb();
  assert.equal(await schemaAtVersion(db.query, TARGET_SCHEMA_VERSION), false, "not ready before migrating");
  await applyMigrations({ query: db.query });
  assert.equal(await schemaAtVersion(db.query, TARGET_SCHEMA_VERSION), true, "ready once migrated to target");
});
