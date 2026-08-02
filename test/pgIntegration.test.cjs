/* R21-P3-02 — PostgreSQL integration tests for the trade-journal safety invariants.

   These exercise the PRODUCTION code path (the ownership-safe upsert, the server-vs-client immutability merge,
   the user-namespaced ids and the composite managed-position migration) against a REAL Postgres, which the
   flat-file unit tests can't reach. They run only when DATABASE_URL points at a disposable test database
   (set it in CI to a throwaway PG); otherwise every case is skipped so `npm test` stays green without PG.

   CI usage:  DATABASE_URL=postgres://user:pass@localhost:5432/matrix_test  npm test
   The suite writes only to a couple of synthetic user ids and cleans them up in test.after. */
const test = require("node:test");
const assert = require("node:assert");

const HAS_PG = !!process.env.DATABASE_URL;
const opts = { skip: HAS_PG ? false : "DATABASE_URL not set — skipping Postgres integration tests" };

let db;
const U_A = "test_pg_userA_919900000001";
const U_B = "test_pg_userB_919900000002";

test.before(async () => { if (!HAS_PG) return; db = require("../db.js"); await db.initDb(); });
test.after(async () => {
  if (!HAS_PG || !db) return;
  // Best-effort cleanup of the synthetic users' rows.
  try { await db.clearTradesByType(U_A, "all", "all"); } catch { /* ignore */ }
  try { await db.clearTradesByType(U_B, "all", "all"); } catch { /* ignore */ }
});

test("PG: server↔browser rows for the same broker fill collapse to one", opts, async () => {
  await db.saveTrade(U_A, { id: "fy_PGORD1", sym: "TCS", side: "BUY", qty: 3, entry: 100, entryAt: Date.now(), real: true, broker: "fyers", orderId: "PGORD1", serverAuthored: true }, { authoritative: true });
  await db.saveTrade(U_A, { id: "real-PGORD1", sym: "TCS", side: "BUY", qty: 3, entry: 100, entryAt: Date.now(), real: true, broker: "fyers", orderId: "PGORD1" }, { authoritative: false });
  const rows = await db.getTrades(U_A, 0, Date.now() + 60000);
  assert.strictEqual(rows.filter((t) => t.orderId === "PGORD1").length, 1);
});

test("PG: a client post cannot overwrite server-verified financial fields", opts, async () => {
  await db.saveTrade(U_A, { id: "fy_PGORD2", sym: "INFY", side: "BUY", qty: 5, entry: 200, entryAt: Date.now(), real: true, broker: "fyers", orderId: "PGORD2", serverAuthored: true }, { authoritative: true });
  const back = await db.saveTrade(U_A, { id: "real-PGORD2", sym: "INFY", side: "BUY", qty: 999, entry: 1, entryAt: Date.now(), real: true, broker: "fyers", orderId: "PGORD2", serverAuthored: true, sl: 4 }, { authoritative: false });
  assert.strictEqual(back.qty, 5);
  assert.strictEqual(back.entry, 200);
  assert.strictEqual(back.serverAuthored, true);
  assert.strictEqual(back.sl, 4);
});

test("PG: a client-chosen id cannot address another user's row", opts, async () => {
  const shared = "attacker-picked-pg-id";
  const a = await db.saveTrade(U_A, { id: shared, sym: "AAA", side: "BUY", qty: 1, entry: 10, entryAt: Date.now() });
  const b = await db.saveTrade(U_B, { id: shared, sym: "BBB", side: "BUY", qty: 1, entry: 20, entryAt: Date.now() });
  assert.notStrictEqual(a.id, b.id);
  const aRows = await db.getTrades(U_A, 0, Date.now() + 60000);
  assert.ok(aRows.some((t) => t.sym === "AAA"));
  assert.ok(!aRows.some((t) => t.sym === "BBB"));
});
