/**
 * test/reconcilePlan.test.cjs — R16-P2-05/06 Delta reconciliation planner (PURE).
 * Proves reconcile is side/quantity/product aware and that untagged legacy rows are NEVER auto-closed.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildDeltaBook, deltaHoldsCover, deltaReconcilePlan } = require("../reconcile");

test("buildDeltaBook nets long/short by base symbol, ignores zero size", () => {
  const book = buildDeltaBook([
    { product_symbol: "BTCUSD", size: 3 },
    { product_symbol: "BTCUSD", size: -1 },
    { product_symbol: "ETHUSD", size: 0 },
  ]);
  assert.deepEqual(book.get("BTC"), { long: 3, short: 1 });
  assert.equal(book.has("ETH"), false);
});

test("deltaHoldsCover respects SIDE and QUANTITY (not just symbol presence)", () => {
  const book = buildDeltaBook([{ product_symbol: "BTCUSD", size: 2 }]);   // long 2, no short
  assert.equal(deltaHoldsCover({ sym: "BTCUSD", side: "BUY", qty: 2 }, book), true);   // covered
  assert.equal(deltaHoldsCover({ sym: "BTCUSD", side: "BUY", qty: 5 }, book), false);  // not enough qty
  assert.equal(deltaHoldsCover({ sym: "BTC", short: true, qty: 1 }, book), false);     // wrong side (no short)
});

test("plan: delta-tagged phantom is auto-closable; untagged phantom needs confirmation; covered kept", () => {
  const book = buildDeltaBook([{ product_symbol: "BTCUSD", size: 1 }]);
  const rows = [
    { id: "a", broker: "delta", sym: "ETHUSD", side: "BUY", qty: 1 },   // delta-tagged, NOT held → phantomDelta
    { id: "b", broker: "", sym: "SOLUSD", side: "BUY", qty: 1 },        // untagged, NOT held → phantomUnknown
    { id: "c", broker: "delta", sym: "BTCUSD", side: "BUY", qty: 1 },   // delta-tagged, held → kept
    { id: "d", broker: "coindcx", sym: "XRPUSD", side: "BUY", qty: 1 }, // other broker → ignored entirely
  ];
  const { phantomDelta, phantomUnknown } = deltaReconcilePlan(rows, book);
  assert.deepEqual(phantomDelta.map((t) => t.id), ["a"]);
  assert.deepEqual(phantomUnknown.map((t) => t.id), ["b"]);
});
