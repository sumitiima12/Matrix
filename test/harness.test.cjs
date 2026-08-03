/* C03 harness self-tests — prove the fault-injection toolkit itself behaves before C03 relies on it.
   (The harness must be trustworthy: a false-green from a broken fake would hide a real C03 defect.) */
const test = require("node:test");
const assert = require("node:assert");
const { makeClock } = require("./harness/clock.cjs");
const { makeFaults } = require("./harness/faults.cjs");
const { makeFakeFyers } = require("./harness/fakeFyers.cjs");

test("clock: deterministic advance/set, no wall-clock", () => {
  const c = makeClock(1000);
  assert.equal(c.now(), 1000);
  c.advance(500); assert.equal(c.now(), 1500);
  c.set(9000); assert.equal(c.now(), 9000);
});

test("faults: arm N times then auto-disarm; gate throws exactly N times", () => {
  const f = makeFaults();
  f.arm("db.attempt.prepare", { times: 2 });
  assert.equal(f.tripped("db.attempt.prepare"), true);
  assert.equal(f.tripped("db.attempt.prepare"), true);
  assert.equal(f.tripped("db.attempt.prepare"), false);   // auto-disarmed after 2
  f.arm("fyers.place", { times: 1 });
  assert.throws(() => f.gate("fyers.place"), /injected fault: fyers.place/);
  assert.doesNotThrow(() => f.gate("fyers.place"));       // consumed
});

test("fakeFyers: fill behaviour books the full quantity and shows in positions", async () => {
  const clock = makeClock(); const fy = makeFakeFyers({ clock });
  fy.setNextBehavior("fill");
  const r = await fy.placeOrder({ symbol: "SBIN", side: "BUY", qty: 10, orderTag: "mxT1" });
  assert.equal(r.s, "ok");
  const ob = await fy.getOrders({ tag: "mxT1" });
  assert.equal(ob.orderBook[0].filledQty, 10);
  const pos = await fy.positions();
  assert.deepEqual(pos.netPositions, [{ symbol: "SBIN", netQty: 10 }]);
});

test("fakeFyers: partial fill books half; delayed settle completes it (no duplicate)", async () => {
  const fy = makeFakeFyers({});
  fy.setNextBehavior("partial");
  await fy.placeOrder({ symbol: "INFY", side: "BUY", qty: 10, orderTag: "mxT2" });
  let ob = await fy.getOrders({ tag: "mxT2" });
  assert.equal(ob.orderBook[0].filledQty, 5);
  fy.settle("mxT2", { status: "filled", filledQty: 10 });
  ob = await fy.getOrders({ tag: "mxT2" });
  assert.equal(ob.orderBook[0].filledQty, 10);
  assert.equal(fy._orders.size, 1, "still ONE order (no duplicate)");
});

test("fakeFyers: 'timeout' RECORDS the order but throws (lost response) — recoverable by orderTag", async () => {
  const fy = makeFakeFyers({});
  fy.setNextBehavior("timeout");
  await assert.rejects(() => fy.placeOrder({ symbol: "TCS", side: "BUY", qty: 3, orderTag: "mxLOST" }), /timed out/);
  // The broker still holds it — startup reconciliation must find it by its tag.
  const ob = await fy.getOrders({ tag: "mxLOST" });
  assert.equal(ob.orderBook.length, 1, "lost-response order is discoverable at the broker by tag");
});

test("fakeFyers: reject books zero and never appears in positions", async () => {
  const fy = makeFakeFyers({});
  fy.setNextBehavior("reject");
  await fy.placeOrder({ symbol: "WIPRO", side: "BUY", qty: 4, orderTag: "mxREJ" });
  const pos = await fy.positions();
  assert.equal(pos.netPositions.length, 0);
});

test("fakeFyers: an armed broker-read fault makes the order book unreachable (→ stay locked)", async () => {
  const f = makeFaults(); const fy = makeFakeFyers({ faults: f });
  fy.setNextBehavior("fill");
  await fy.placeOrder({ symbol: "SBIN", side: "BUY", qty: 1, orderTag: "mxUNREACH" });
  f.arm("fyers.orders", { times: 1 });
  await assert.rejects(() => fy.getOrders({ tag: "mxUNREACH" }), /injected fault: fyers.orders/);
  await assert.doesNotReject(() => fy.getOrders({ tag: "mxUNREACH" }));   // fault consumed
});
