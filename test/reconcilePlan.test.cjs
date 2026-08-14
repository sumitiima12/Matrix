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

test("Round18-6: broker qty is ALLOCATED across rows, not compared independently", () => {
  const book = buildDeltaBook([{ product_symbol: "BTCUSD", size: 1 }]);   // Delta holds ONE BTC long
  const rows = [
    { id: "old", broker: "delta", sym: "BTCUSD", side: "BUY", qty: 1, entryAt: 100 },
    { id: "new", broker: "delta", sym: "BTCUSD", side: "BUY", qty: 1, entryAt: 200 },
  ];
  const { phantomDelta } = deltaReconcilePlan(rows, book);
  // Only ONE 1-BTC row can be covered by a 1-BTC holding — the other is a phantom (oldest kept, newest phantom).
  assert.equal(phantomDelta.length, 1);
  assert.equal(phantomDelta[0].id, "new");
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

/* ── Homepage "4 stale open rows" incident — regression guards (ChatGPT item G, planner-level) ── */
test("incident: XAUT/PAXG closed at Delta (empty book) → all delta-tagged rows are phantom (would close)", () => {
  const book = buildDeltaBook([]);   // Delta holds NOTHING (account flat)
  const rows = [
    { id: "xaut", broker: "delta", sym: "XAUT", side: "BUY", qty: 1 },
    { id: "paxg", broker: "delta", sym: "PAXG", side: "BUY", qty: 1 },
    { id: "doge1", broker: "delta", sym: "DOGE", side: "BUY", qty: 143 },
  ];
  const { phantomDelta, phantomUnknown } = deltaReconcilePlan(rows, book);
  assert.deepEqual(phantomDelta.map((t) => t.id).sort(), ["doge1", "paxg", "xaut"]);
  assert.equal(phantomUnknown.length, 0);
});

test("incident: filled-then-sold DOGE — Delta flat → the leftover open journal row is phantom", () => {
  const book = buildDeltaBook([]);   // sold on Delta → no position remains
  const rows = [{ id: "doge", broker: "delta", sym: "DOGEUSD", side: "BUY", qty: 143 }];
  const { phantomDelta } = deltaReconcilePlan(rows, book);
  assert.deepEqual(phantomDelta.map((t) => t.id), ["doge"]);
});

test("incident: one filled + a still-held position → only the unheld rows are phantom (rejected rows never reach the planner)", () => {
  // Rejected bad_schema attempts have entry==null and are filtered out UPSTREAM, so the planner only sees real opens.
  const book = buildDeltaBook([{ product_symbol: "DOGEUSD", size: 143 }]);   // Delta still holds ONE DOGE long
  const rows = [
    { id: "held", broker: "delta", sym: "DOGE", side: "BUY", qty: 143, entryAt: 1 },   // covered → kept
    { id: "ghost", broker: "delta", sym: "DOGE", side: "BUY", qty: 143, entryAt: 2 },  // second open, pool exhausted → phantom
  ];
  const { phantomDelta } = deltaReconcilePlan(rows, book);
  assert.deepEqual(phantomDelta.map((t) => t.id), ["ghost"]);
});

test("incident: broker truth UNAVAILABLE is never proof of closure (empty positions ≠ read failure — guarded by the route/UI, not the planner)", () => {
  // The planner only runs on a SUCCESSFUL positions read; a failed read short-circuits before this in the route.
  // This asserts the planner itself makes no closure claim without an explicit book entry decision.
  const held = buildDeltaBook([{ product_symbol: "DOGEUSD", size: 143 }]);
  const { phantomDelta } = deltaReconcilePlan([{ id: "x", broker: "delta", sym: "DOGE", side: "BUY", qty: 143 }], held);
  assert.equal(phantomDelta.length, 0, "a genuinely-held position is never classified phantom");
});
