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
  // Best-effort cleanup of the synthetic users' rows (trades + fills + idempotency + pending).
  for (const u of [U_A, U_B]) {
    try { await db.clearTradesByType(u, "all", "all"); } catch { /* ignore */ }
    try { await db.purgeLedgersForUser(u, { preserveFills: false }); } catch { /* ignore */ }
  }
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

/* R25-M03 — Postgres coverage for the R24/R25 safety invariants that only a real transactional DB exercises. */

test("PG-M03: recordFillAndTrade commits BOTH the trade and the fill in one transaction", opts, async () => {
  const t = { broker: "fyers", orderId: "PGTX1", side: "BUY", qty: 4, entry: 120, market: "IN", tradeType: "Manual", entryAt: Date.now(), real: true };
  await db.recordFillAndTrade(U_A, t);
  const trades = await db.getTrades(U_A, 0, Date.now() + 60000);
  const fills = await db.getFills(U_A, 0, Date.now() + 60000);
  assert.ok(trades.some((x) => x.orderId === "PGTX1" && x.serverAuthored === true), "authoritative trade committed");
  assert.strictEqual(fills.filter((x) => x.orderId === "PGTX1").length, 1, "fill committed exactly once");
  await db.recordFillAndTrade(U_A, t);   // idempotent replay
  const fills2 = await db.getFills(U_A, 0, Date.now() + 60000);
  assert.strictEqual(fills2.filter((x) => x.orderId === "PGTX1").length, 1, "replay does not duplicate the fill");
});

test("PG-M03: recycled-number handoff moves fills to the archive key in the same transaction", opts, async () => {
  await db.recordFill(U_B, { broker: "fyers", orderId: "PGMIG1", side: "BUY", qty: 1, entry: 10, market: "IN", entryAt: Date.now() });
  const archiveKey = `arch_${Date.now()}`;
  await db.reassignAndArchiveTrades("919900000002", U_B, archiveKey);
  const oldFills = await db.getFills(U_B, 0, Date.now() + 60000);
  const movedFills = await db.getFills(archiveKey, 0, Date.now() + 60000);
  assert.ok(!oldFills.some((x) => x.orderId === "PGMIG1"), "fills left the recycled key");
  assert.ok(movedFills.some((x) => x.orderId === "PGMIG1"), "fills moved to the archive key");
  try { await db.purgeLedgersForUser(archiveKey, { preserveFills: false }); } catch { /* ignore */ }
});

test("PG-M03: retained-history deletion KEEPS fills; full erasure removes them", opts, async () => {
  const uid = `test_pg_del_${Date.now()}`;
  const phone = uid.replace(/[^0-9]/g, "").slice(-10) || "9999999999";
  await db.recordFill(uid, { broker: "delta", orderId: "PGDEL1", side: "BUY", qty: 1, entry: 5, market: "Crypto", entryAt: Date.now() });
  await db.purgeLedgersForUser(uid, { preserveFills: true });   // retained-history path
  assert.strictEqual((await db.getFills(uid, 0, Date.now() + 60000)).length, 1, "fills preserved with retained trades");
  await db.purgeLedgersForUser(uid, { preserveFills: false });  // full erasure
  assert.strictEqual((await db.getFills(uid, 0, Date.now() + 60000)).length, 0, "fills removed on full erasure");
});

test("PG-M03: countUnknownIdempotency reflects unresolved order intents", opts, async () => {
  const uid = `test_pg_idem_${Date.now()}`;
  await db.claimIdempotencyKey(uid, "pg_key_unknown_1", "hash1");
  await db.finalizeIdempotency(uid, "pg_key_unknown_1", "unknown", null);
  assert.strictEqual(await db.countUnknownIdempotency(uid), 1, "one unknown counted");
  await db.claimIdempotencyKey(uid, "pg_key_ok_1", "hash2");
  await db.finalizeIdempotency(uid, "pg_key_ok_1", "succeeded", { orderId: "x" });
  assert.strictEqual(await db.countUnknownIdempotency(uid), 1, "succeeded rows are not counted as unknown");
  try { await db.purgeLedgersForUser(uid, { preserveFills: false }); } catch { /* ignore */ }
});
