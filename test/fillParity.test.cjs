/* INC-2: the reconcile classifiers now derive their fill truth from normalizeFill. This test guards that the
   single canonical contract and the money-path classifiers agree across representative broker order shapes, so
   a future edit to either side can't silently drift the two apart. */
const test = require("node:test");
const assert = require("node:assert");
const { normalizeFill } = require("../fillContract.js");
const R = require("../reconcile.js");

test("INC-2: FYERS classifier agrees with normalizeFill on every fill state", () => {
  const cases = [
    { status: 2, qty: 10, filledQty: 10, tradedPrice: 250.5 },   // filled
    { status: 2, qty: 5, filledQty: 0 },                         // status 2 but no qty → NOT filled
    { status: 6, qty: 10, filledQty: 0 },                        // pending
    { status: 4, qty: 5 },                                       // transit → pending/unknown
    { status: 5, qty: 5 },                                       // rejected
    { status: 1, qty: 5 },                                       // cancelled → rejected
    { qty: 5, filledQty: 2 },                                    // partial (no status field)
    {},                                                          // garbage → not filled
  ];
  for (const o of cases) {
    const c = R.classifyFyersOrder(o);
    const n = normalizeFill("fyers", o);
    assert.strictEqual(c.filled, n.status === "filled", `filled parity for ${JSON.stringify(o)}`);
    assert.strictEqual(c.rejected, n.status === "rejected" || n.status === "cancelled", `rejected parity for ${JSON.stringify(o)}`);
  }
});

test("INC-2: Delta classifier agrees with normalizeFill on every fill state", () => {
  const cases = [
    { id: 1, size: 5, unfilled_size: 0, state: "closed", average_fill_price: 100 },  // filled
    { id: 2, size: 5, unfilled_size: 2, state: "open" },                             // partial
    { id: 3, size: 5, unfilled_size: 5, state: "rejected" },                         // rejected
    { id: 4, size: 5, unfilled_size: 5, state: "cancelled" },                        // cancelled
    { id: 5, size: 5, unfilled_size: 5, state: "open" },                             // pending (nothing filled)
  ];
  for (const o of cases) {
    const c = R.classifyDeltaOrder(o, o.size);
    const n = normalizeFill("delta", { ...o, size: o.size });
    assert.strictEqual(c.fullyFilled, n.status === "filled", `filled parity for ${JSON.stringify(o)}`);
    assert.strictEqual(c.partial, n.status === "partial", `partial parity for ${JSON.stringify(o)}`);
    assert.strictEqual(c.rejected, n.status === "rejected" || n.status === "cancelled", `rejected parity for ${JSON.stringify(o)}`);
  }
});
