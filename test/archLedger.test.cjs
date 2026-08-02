/* ARCH-1 + ARCH-2 tests: the immutable fills ledger (flat-file mode) and the normalized broker-fill contract. */
const test = require("node:test");
const assert = require("node:assert");
const os = require("os");
const path = require("path");
const fs = require("fs");

delete process.env.DATABASE_URL;
const tmpFills = path.join(os.tmpdir(), `mx_fills_${process.pid}_${Date.now()}.json`);
process.env.FILLS_FILE = tmpFills;
const db = require("../db.js");
const { normalizeFill } = require("../fillContract.js");

test.after(() => { try { fs.unlinkSync(tmpFills); } catch { /* ignore */ } });

test("ARCH-1: a fill appends once and is idempotent on the broker key", async () => {
  const u = "919000000100";
  const f = { broker: "fyers", orderId: "LEDG1", side: "BUY", qty: 3, entry: 100, market: "IN", tradeType: "Manual", entryAt: Date.now() };
  const a = await db.recordFill(u, f);
  const b = await db.recordFill(u, f);   // same fill replayed (retry/poll/watcher)
  assert.strictEqual(a.inserted, true);
  assert.strictEqual(b.inserted, false, "the same broker fill must not append twice");
  const rows = await db.getFills(u, 0, Date.now() + 60000);
  assert.strictEqual(rows.filter((x) => x.orderId === "LEDG1").length, 1);
});

test("ARCH-2: normalizeFill maps FYERS status codes to the canonical contract", () => {
  const filled = normalizeFill("fyers", { id: "1", status: 2, qty: 5, filledQty: 5, tradedPrice: 101, side: 1 });
  assert.strictEqual(filled.status, "filled");
  assert.strictEqual(filled.filledQty, 5);
  assert.strictEqual(filled.side, "BUY");
  assert.strictEqual(normalizeFill("fyers", { id: "2", status: 6, qty: 5, filledQty: 0 }).status, "pending");
  assert.strictEqual(normalizeFill("fyers", { id: "3", status: 5 }).status, "rejected");
  assert.strictEqual(normalizeFill("fyers", { id: "4", qty: 5, filledQty: 2 }).status, "partial");
});

test("ARCH-2: normalizeFill maps Delta state to the canonical contract", () => {
  const filled = normalizeFill("delta", { id: "d1", state: "closed", size: 4, unfilled_size: 0, average_fill_price: 50, side: "buy" });
  assert.strictEqual(filled.status, "filled");
  assert.strictEqual(filled.filledQty, 4);
  assert.strictEqual(normalizeFill("delta", { id: "d2", state: "open", size: 4, unfilled_size: 4 }).status, "pending");
  assert.strictEqual(normalizeFill("delta", { id: "d3", state: "rejected" }).status, "rejected");
  // An unknown adapter must NEVER claim a fill.
  assert.strictEqual(normalizeFill("somenewbroker", { id: "x" }).status, "unknown");
});
