/* C03 slice 2 — startup broker-backed reconciliation, proven against the fake FYERS + fault harness with the
   REAL durable attempt store (flat-file). Covers the mandatory recovery journeys:
     - lost-response/crash then restart ⇒ reconcile the fill by orderTag, adopt EXACTLY ONCE, resolve
     - broker confirms rejection/absence ⇒ close safely, adopt nothing
     - broker unreachable / pending at restart ⇒ attempt stays unresolved AND the lock is re-armed (fail closed)
     - partial fill ⇒ adopt the partial, stay locked
     - concurrent startup workers ⇒ a single advisory-lock owner reconciles; the other is a no-op */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { reconcileUnresolvedAttempts } = require("../orderRecovery.js");
const { makeFakeFyers } = require("./harness/fakeFyers.cjs");
const { makeFaults } = require("./harness/faults.cjs");

let dir, db;
test.before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-c03r-"));
  delete process.env.DATABASE_URL;
  process.env.ORDER_ATTEMPTS_FILE = path.join(dir, "attempts.json");
  db = require("../db.js");
});
test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

// Normalizing probe: fake FYERS order book (by tag) → the outcome shape reconcile expects.
function makeProbe(fy) {
  return async (a) => {
    const ob = await fy.getOrders({ tag: a.orderTag });   // throws if fyers.orders fault is armed
    const o = ob.orderBook[0];
    if (!o) return { status: "absent" };
    if (o.status === 2) return { status: "filled", orderId: o.id, filledQty: o.filledQty, avgPrice: o.tradedPrice };
    if (o.status === 4) return { status: "partial", orderId: o.id, filledQty: o.filledQty, avgPrice: o.tradedPrice };
    if (o.status === 5) return { status: "rejected", orderId: o.id };
    if (o.status === 1) return { status: "absent" };
    return { status: "pending" };
  };
}
const spies = () => { const s = { adopt: [], lock: [], halt: [] }; return {
  s,
  adoptFill: async (a, ob) => { s.adopt.push({ id: a.id, qty: ob.filledQty }); },
  setLock: async (v) => { s.lock.push(v); },
  setHalt: async (v) => { s.halt.push(v); },
}; };

test("C03R: lost-response order is reconciled by orderTag, fill adopted ONCE, attempt resolved", async () => {
  const faults = makeFaults(); const fy = makeFakeFyers({ faults });
  // The broker HAS the order (it was accepted; the response was lost), discoverable by tag.
  fy.setNextBehavior("fill");
  await fy.placeOrder({ symbol: "SBIN", side: "BUY", qty: 10, orderTag: "mxR1" });
  // Our durable attempt is stuck UNKNOWN (finalize never confirmed).
  await db.prepareOrderAttempt({ id: "R1", userId: "u1", broker: "fyers", orderTag: "mxR1", symbol: "SBIN", side: "BUY", qty: 10 });
  await db.finalizeOrderAttempt("R1", "UNKNOWN", {});

  const sp = spies();
  const out = await reconcileUnresolvedAttempts({ db, probeByTag: makeProbe(fy), adoptFill: sp.adoptFill, setLock: sp.setLock, setHalt: sp.setHalt });
  assert.equal(out.adopted, 1);
  assert.equal(sp.s.adopt.length, 1, "fill adopted exactly once");
  assert.equal((await db.getOrderAttempt("R1")).resolved, true);

  // Idempotent: a second sweep must NOT re-adopt (the attempt is already resolved).
  const sp2 = spies();
  await reconcileUnresolvedAttempts({ db, probeByTag: makeProbe(fy), adoptFill: sp2.adoptFill, setLock: sp2.setLock });
  assert.equal(sp2.s.adopt.length, 0, "no duplicate adoption on the next startup");
});

test("C03R: broker rejection/absence closes the attempt safely, adopts nothing", async () => {
  const fy = makeFakeFyers({});
  fy.setNextBehavior("reject");
  await fy.placeOrder({ symbol: "INFY", side: "BUY", qty: 5, orderTag: "mxR2" });
  await db.prepareOrderAttempt({ id: "R2", userId: "u1", broker: "fyers", orderTag: "mxR2", symbol: "INFY", side: "BUY", qty: 5 });
  await db.finalizeOrderAttempt("R2", "UNKNOWN", {});

  const sp = spies();
  await reconcileUnresolvedAttempts({ db, probeByTag: makeProbe(fy), adoptFill: sp.adoptFill, setLock: sp.setLock });
  assert.equal(sp.s.adopt.length, 0, "no fill adopted for a rejected order");
  assert.equal((await db.getOrderAttempt("R2")).status, "REJECTED");
  assert.equal((await db.getOrderAttempt("R2")).resolved, true);

  // An attempt the broker has NO record of → absent → CANCELLED (safe), no fill.
  await db.prepareOrderAttempt({ id: "R2b", userId: "u1", broker: "fyers", orderTag: "mxNONE", symbol: "TCS", side: "BUY", qty: 1 });
  await db.finalizeOrderAttempt("R2b", "UNKNOWN", {});
  const sp2 = spies();
  await reconcileUnresolvedAttempts({ db, probeByTag: makeProbe(fy), adoptFill: sp2.adoptFill, setLock: sp2.setLock });
  assert.equal((await db.getOrderAttempt("R2b")).status, "CANCELLED");
  assert.equal(sp2.s.adopt.length, 0);
});

test("C03R: broker UNREACHABLE at restart ⇒ attempt stays unresolved AND lock is re-armed (fail closed)", async () => {
  const faults = makeFaults(); const fy = makeFakeFyers({ faults });
  fy.setNextBehavior("fill");
  await fy.placeOrder({ symbol: "SBIN", side: "BUY", qty: 2, orderTag: "mxR3" });
  await db.prepareOrderAttempt({ id: "R3", userId: "u1", broker: "fyers", orderTag: "mxR3", symbol: "SBIN", side: "BUY", qty: 2 });
  await db.finalizeOrderAttempt("R3", "UNKNOWN", {});

  faults.arm("fyers.orders", { times: 99 });   // the broker read fails for the whole sweep
  const sp = spies();
  const out = await reconcileUnresolvedAttempts({ db, probeByTag: makeProbe(fy), adoptFill: sp.adoptFill, setLock: sp.setLock, setHalt: sp.setHalt });
  assert.equal(sp.s.adopt.length, 0, "nothing adopted while the broker is unreachable");
  assert.ok(out.keptLocked >= 1);
  assert.equal((await db.getOrderAttempt("R3")).resolved, false, "unresolved until the broker can confirm");
  assert.deepEqual(sp.s.lock.at(-1), true, "risk lock re-armed");
  assert.deepEqual(sp.s.halt.at(-1), true, "entry halt re-armed");
});

test("C03R: partial fill is adopted but the attempt stays unresolved (residual still open)", async () => {
  const fy = makeFakeFyers({});
  fy.setNextBehavior("partial");
  await fy.placeOrder({ symbol: "WIPRO", side: "BUY", qty: 10, orderTag: "mxR4" });
  await db.prepareOrderAttempt({ id: "R4", userId: "u1", broker: "fyers", orderTag: "mxR4", symbol: "WIPRO", side: "BUY", qty: 10 });
  await db.finalizeOrderAttempt("R4", "UNKNOWN", {});

  const sp = spies();
  const out = await reconcileUnresolvedAttempts({ db, probeByTag: makeProbe(fy), adoptFill: sp.adoptFill, setLock: sp.setLock });
  assert.equal(sp.s.adopt.length, 1, "partial fill adopted");
  assert.equal((await db.getOrderAttempt("R4")).status, "PARTIAL");
  assert.equal((await db.getOrderAttempt("R4")).resolved, false, "partial stays open → locked");
  assert.deepEqual(sp.s.lock.at(-1), true);
});

test("C03R: concurrent startup workers ⇒ only the advisory-lock owner reconciles", async () => {
  const fy = makeFakeFyers({});
  fy.setNextBehavior("fill");
  await fy.placeOrder({ symbol: "SBIN", side: "BUY", qty: 1, orderTag: "mxR5" });
  await db.prepareOrderAttempt({ id: "R5", userId: "u1", broker: "fyers", orderTag: "mxR5", symbol: "SBIN", side: "BUY", qty: 1 });
  await db.finalizeOrderAttempt("R5", "UNKNOWN", {});

  // Simulate a single-owner advisory lock: the first acquire wins, the second loses.
  let held = false;
  const acquireOwner = async () => { if (held) return false; held = true; return true; };
  const spA = spies(); const spB = spies();
  const [ra, rb] = await Promise.all([
    reconcileUnresolvedAttempts({ db, probeByTag: makeProbe(fy), adoptFill: spA.adoptFill, setLock: spA.setLock, acquireOwner }),
    reconcileUnresolvedAttempts({ db, probeByTag: makeProbe(fy), adoptFill: spB.adoptFill, setLock: spB.setLock, acquireOwner }),
  ]);
  const owners = [ra, rb].filter((r) => r.owner === true).length;
  const skipped = [ra, rb].filter((r) => r.skipped === true).length;
  assert.equal(owners, 1, "exactly one reconciliation owner");
  assert.equal(skipped, 1, "the other worker is a no-op");
  assert.equal(spA.s.adopt.length + spB.s.adopt.length, 1, "the fill is adopted once across both workers");
});
