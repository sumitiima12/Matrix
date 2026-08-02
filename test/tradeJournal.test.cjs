/* R20 regression tests for the trade journal storage layer (flat-file mode).

   Covers:
   - R20-P1-02: a single real fill written by BOTH the server (fy_/dl_ row) and the browser (real- row) under
     the SAME broker orderId must collapse to ONE stored row (no double-count).
   - R20-P1-03: two different users cannot collide on a client-supplied id — stored ids are namespaced per
     user, so one user's write can never address another user's row. */
const test = require("node:test");
const assert = require("node:assert");
const os = require("os");
const path = require("path");
const fs = require("fs");

// Force flat-file mode with an isolated trades file BEFORE requiring db.
delete process.env.DATABASE_URL;
const tmpTrades = path.join(os.tmpdir(), `mx_trades_${process.pid}_${Date.now()}.json`);
process.env.TRADES_FILE = tmpTrades;
const db = require("../db.js");

test.after(() => { try { fs.unlinkSync(tmpTrades); } catch { /* ignore */ } });

test("R20-P1-02: server row and browser row for the same broker fill collapse to one", async () => {
  const user = "919000000001";
  // Server authoritative row (as written by the FYERS/Delta verified-fill path).
  await db.saveTrade(user, { id: "fy_ORDER123", sym: "TCS", side: "BUY", qty: 1, entry: 3000, entryAt: Date.now(), real: true, broker: "fyers", orderId: "ORDER123", serverAuthored: true });
  // Browser posts its OWN row for the same execution under a different raw id.
  await db.saveTrade(user, { id: "real-ORDER123", sym: "TCS", side: "BUY", qty: 1, entry: 3000, entryAt: Date.now(), real: true, broker: "fyers", orderId: "ORDER123", tp: 5, sl: 2 });

  const rows = await db.getTrades(user, 0, Date.now() + 60000);
  const forOrder = rows.filter((t) => t.orderId === "ORDER123");
  assert.strictEqual(forOrder.length, 1, "one broker fill must be exactly one journal row");
});

test("R21-P1-02: a client post cannot overwrite a server-verified fill's financial fields", async () => {
  const user = "919000000002";
  // Server records the verified fill (broker truth): qty 5 @ 100.
  await db.saveTrade(user, { id: "fy_ORD9", sym: "INFY", side: "BUY", qty: 5, entry: 100, entryAt: Date.now(), real: true, broker: "fyers", orderId: "ORD9", serverAuthored: true }, { authoritative: true });
  // Browser posts the SAME order but with a tampered qty/price and tries to drop the authoritative flag.
  const back = await db.saveTrade(user, { id: "real-ORD9", sym: "INFY", side: "BUY", qty: 999, entry: 1, entryAt: Date.now(), real: true, broker: "fyers", orderId: "ORD9", serverAuthored: true, sl: 3 }, { authoritative: false });

  assert.strictEqual(back.qty, 5, "server-verified qty must be preserved");
  assert.strictEqual(back.entry, 100, "server-verified price must be preserved");
  assert.strictEqual(back.serverAuthored, true, "client cannot strip the authoritative flag");
  assert.strictEqual(back.sl, 3, "client may still annotate a presentation field (sl)");

  const rows = await db.getTrades(user, 0, Date.now() + 60000);
  const r = rows.filter((t) => t.orderId === "ORD9");
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].qty, 5);
});

test("R20-P1-03: a client-chosen id cannot collide across users (ids are user-namespaced)", async () => {
  const userA = "919000000010";
  const userB = "919000000011";
  const sharedRawId = "attacker-picked-id";

  const a = await db.saveTrade(userA, { id: sharedRawId, sym: "AAA", side: "BUY", qty: 1, entry: 10, entryAt: Date.now() });
  const b = await db.saveTrade(userB, { id: sharedRawId, sym: "BBB", side: "BUY", qty: 1, entry: 20, entryAt: Date.now() });

  // Stored ids must differ (namespaced per user), so B's write can never have addressed A's row.
  assert.notStrictEqual(a.id, b.id, "stored ids must be namespaced per user");

  const aRows = await db.getTrades(userA, 0, Date.now() + 60000);
  const bRows = await db.getTrades(userB, 0, Date.now() + 60000);
  // Each user sees ONLY their own symbol/data — no cross-user overwrite.
  assert.ok(aRows.some((t) => t.sym === "AAA"), "user A keeps their own row");
  assert.ok(!aRows.some((t) => t.sym === "BBB"), "user A's row was NOT overwritten by user B");
  assert.ok(bRows.some((t) => t.sym === "BBB"), "user B keeps their own row");
});
