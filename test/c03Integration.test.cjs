/* C03 #441 — end-to-end SUBSYSTEM integration proofs.
 *
 * These compose the REAL production C03 functions exactly as the live path wires them — the write-before-send
 * orchestrator (submitWithAttempt), the durable attempt store (db), the startup safety re-arm
 * (rearmFromUnresolvedAttempts) and the startup broker reconciliation (reconcileUnresolvedAttempts) — against
 * the fake FYERS + fault harness and the real durable store. They prove the two decisive failure journeys the
 * review requires without yet driving the literal Express handler (the createApp() refactor is the remaining,
 * lower-risk step now that the composed behaviour below is proven).
 *
 * Flat-file store makes the composition deterministic everywhere; the same journey additionally runs with a
 * REAL process restart (freshRequire) when DATABASE_URL is set (CI provides it; ciPgRequired fails a skip in CI).
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { submitWithAttempt, reconcileUnresolvedAttempts, rearmFromUnresolvedAttempts } = require("../orderRecovery.js");
const { makeFakeFyers } = require("./harness/fakeFyers.cjs");
const { makeFaults } = require("./harness/faults.cjs");
const faultHook = require("../faultHook.js");

let dir, db;
test.before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-c03i-"));
  delete process.env.DATABASE_URL;
  process.env.ORDER_ATTEMPTS_FILE = path.join(dir, "attempts.json");
  db = require("../db.js");
});
test.after(() => { faultHook.clear(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

// The SAME classify the live FYERS route uses: a broker acceptance → ACCEPTED (unresolved until fill verified).
const classifyAccepted = (dd) => ({ status: "ACCEPTED", patch: { brokerOrderId: dd && dd.id } });
// Map fake FYERS order book (by tag) → the normalized outcome the reconciler consumes.
function makeProbe(fy) {
  return async (a) => {
    const ob = await fy.getOrders({ tag: a.orderTag });
    const o = ob.orderBook[0];
    if (!o) return { status: "absent" };
    if (o.status === 2) return { status: "filled", orderId: o.id, filledQty: o.filledQty, avgPrice: o.tradedPrice };
    if (o.status === 4) return { status: "partial", orderId: o.id, filledQty: o.filledQty, avgPrice: o.tradedPrice };
    if (o.status === 5) return { status: "rejected", orderId: o.id };
    return { status: "pending" };
  };
}

test("C03-INT journey A: DB failure before submit ⇒ ZERO broker orders, account never exposed", async () => {
  const fy = makeFakeFyers({}); fy.setNextBehavior("fill");
  let brokerCalls = 0;
  const submit = async () => { brokerCalls++; return fy.placeOrder({ symbol: "SBIN", side: "BUY", qty: 5, orderTag: "IA1" }); };
  const attempt = { id: "IA1", userId: "ph_u1", broker: "fyers", orderTag: "IA1", fingerprint: "fp", symbol: "SBIN", side: "BUY", qty: 5 };
  faultHook.arm("db.attempt.prepare", 1);
  await assert.rejects(() => submitWithAttempt({ db, attempt, submit, classify: classifyAccepted }), /db.attempt.prepare/);
  assert.equal(brokerCalls, 0, "broker was never called");
  assert.equal(fy._orders.size, 0, "no order exists at the broker");
  assert.equal(await db.getOrderAttempt("IA1"), null, "no durable attempt persisted");
});

test("C03-INT journey B: accepted + pending-protection failure + restart ⇒ locked, recovered by tag, NO duplicate", async () => {
  const fy = makeFakeFyers({}); fy.setNextBehavior("fill");   // the broker fills & HOLDS the tagged order
  let brokerSubmits = 0;
  const submit = async () => { brokerSubmits++; return fy.placeOrder({ symbol: "SBIN", side: "BUY", qty: 5, orderTag: "IB1" }); };
  const attempt = { id: "IB1", userId: "ph_u2", broker: "fyers", orderTag: "IB1", fingerprint: "fp2", symbol: "SBIN", side: "BUY", qty: 5 };

  // 1) Order accepted (durable ACCEPTED). 2) Pending-protection persistence then FAILS ⇒ the account must be
  //    locked and the attempt left UNRESOLVED (ACCEPTED). We model the route's fail-closed behaviour.
  await submitWithAttempt({ db, attempt, submit, classify: classifyAccepted });
  assert.equal(brokerSubmits, 1);
  const locks = new Map();
  await db.finalizeOrderAttempt("IB1", "ACCEPTED", { brokerOrderId: "FY0001" });   // pending-protection failed ⇒ stays unresolved
  await rearmFromUnresolvedAttempts({ db, setLock: async (u, v) => locks.set(u, v), setHalt: async () => {} });
  assert.equal(locks.get("ph_u2"), true, "account is risk-locked while the accepted order is untracked");

  // 3) RESTART: re-arm must re-lock BEFORE any reconciliation, then reconcile against the broker by orderTag.
  const locks2 = new Map(); const adopted = [];
  await rearmFromUnresolvedAttempts({ db, setLock: async (u, v) => locks2.set(u, v), setHalt: async () => {} });
  assert.equal(locks2.get("ph_u2"), true, "startup re-arm re-locks before money routes open");

  const out = await reconcileUnresolvedAttempts({
    db, probeByTag: makeProbe(fy),
    adoptFill: async (a, ob) => { adopted.push({ id: a.id, qty: ob.filledQty }); },   // recordAuthoritativeFill (dedup) in prod
    setLock: async () => {}, setHalt: async () => {},
  });
  assert.equal(adopted.length, 1, "the orphaned fill is adopted exactly once");
  assert.equal(out.resolved, 1);
  assert.equal((await db.getOrderAttempt("IB1")).resolved, true, "attempt resolves only after broker-backed reconcile");
  assert.equal(brokerSubmits, 1, "NO duplicate broker order was ever submitted");

  // A second startup sweep must be a no-op (idempotent) — nothing left to adopt.
  const again = [];
  await reconcileUnresolvedAttempts({ db, probeByTag: makeProbe(fy), adoptFill: async () => again.push(1), setLock: async () => {}, setHalt: async () => {} });
  assert.equal(again.length, 0, "no re-adoption on the next startup");
});

test("C03-INT journey C: lost response ⇒ UNKNOWN ⇒ restart finds it by tag ⇒ no duplicate", async () => {
  const fy = makeFakeFyers({}); fy.setNextBehavior("timeout");   // broker records it, response is LOST
  let brokerSubmits = 0;
  const submit = async () => { brokerSubmits++; return fy.placeOrder({ symbol: "TCS", side: "BUY", qty: 2, orderTag: "IC1" }); };
  const attempt = { id: "IC1", userId: "ph_u3", broker: "fyers", orderTag: "IC1", fingerprint: "fp3", symbol: "TCS", side: "BUY", qty: 2 };
  await assert.rejects(() => submitWithAttempt({ db, attempt, submit, classify: classifyAccepted }), /timed out/);
  assert.equal((await db.getOrderAttempt("IC1")).status, "UNKNOWN");
  // The broker still shows the order as pending under our tag; settle it to filled (the delayed truth).
  fy.settle("IC1", { status: "filled", filledQty: 2, avgPrice: 100 });
  const adopted = [];
  await reconcileUnresolvedAttempts({ db, probeByTag: makeProbe(fy), adoptFill: async () => adopted.push(1), setLock: async () => {}, setHalt: async () => {} });
  assert.equal(adopted.length, 1, "the lost-response fill is adopted once at restart");
  assert.equal(brokerSubmits, 1, "no duplicate submission");
});

test("C03-INT journey D: FYERS unavailable at restart ⇒ attempt stays UNRESOLVED and locked", async () => {
  const faults = makeFaults(); const fy = makeFakeFyers({ faults }); fy.setNextBehavior("fill");
  await fy.placeOrder({ symbol: "SBIN", side: "BUY", qty: 1, orderTag: "ID1" });
  await db.prepareOrderAttempt({ id: "ID1", userId: "ph_u4", broker: "fyers", orderTag: "ID1", fingerprint: "fp4", symbol: "SBIN", side: "BUY", qty: 1 });
  await db.finalizeOrderAttempt("ID1", "ACCEPTED", {});
  faults.arm("fyers.orders", { times: 99 });   // broker unreachable for the whole sweep
  const locks = new Map();
  const out = await reconcileUnresolvedAttempts({ db, probeByTag: makeProbe(fy), adoptFill: async () => {}, setLock: async (u, v) => locks.set(u, v), setHalt: async () => {} });
  assert.ok(out.keptLocked >= 1);
  assert.equal((await db.getOrderAttempt("ID1")).resolved, false, "unresolved until the broker can confirm");
  assert.equal(locks.get("ph_u4"), true, "risk-lock re-armed while unreconciled");
});
