/* H04 — execution-event modeling + fees. Pure unit tests (no DB) for the two functions that make the immutable
   fills ledger the authoritative, execution-accurate risk source:
     • projectFills — SUMS true per-execution events (quantity-weighted price, summed fees) while keeping the legacy
       max-observation behaviour for cumulative snapshots, and PREFERRING executions when both exist for an order.
     • deriveRiskFromFills — nets fees (exit fees + prorated entry fees) into realized P&L. */
const test = require("node:test");
const assert = require("node:assert");
delete process.env.DATABASE_URL;                 // flat-file mode: no DB needed for pure functions
const db = require("../db.js");

test("projectFills SUMS per-execution events into one order leg (quantity-weighted price + summed fees)", () => {
  const fills = [
    { orderId: "O1", broker: "fyers", execEvent: true, side: "BUY", qty: 3, entry: 100, fees: 6, ts: 10 },
    { orderId: "O1", broker: "fyers", execEvent: true, side: "BUY", qty: 2, entry: 110, fees: 4, ts: 20 },
  ];
  const [p] = db.projectFills(fills);
  assert.equal(p.qty, 5, "quantities summed across executions");
  assert.ok(Math.abs(p.price - 104) < 1e-9, "weighted-average price = (3·100 + 2·110)/5 = 104");
  assert.equal(p.fees, 10, "fees summed across executions");
  assert.equal(p.executions, 2, "projection reports it was derived from 2 execution events");
  assert.equal(p.leg, "entry");
});

test("projectFills keeps MAX-observation for legacy cumulative snapshots (backward compatible)", () => {
  const fills = [
    { orderId: "O2", broker: "fyers", side: "BUY", qty: 2, entry: 100, ts: 10 },   // partial snapshot
    { orderId: "O2", broker: "fyers", side: "BUY", qty: 5, entry: 100, ts: 20 },   // fuller snapshot
  ];
  const [p] = db.projectFills(fills);
  assert.equal(p.qty, 5, "cumulative snapshots collapse to the largest (5), never summed (7)");
  assert.equal(p.executions, 0, "no execution events → legacy snapshot projection");
});

test("projectFills PREFERS execution events over a cumulative snapshot for the same order", () => {
  const fills = [
    { orderId: "O3", broker: "fyers", side: "BUY", qty: 5, entry: 100, ts: 5 },                      // stale cumulative snapshot
    { orderId: "O3", broker: "fyers", execEvent: true, side: "BUY", qty: 3, entry: 100, fees: 3, ts: 10 },
    { orderId: "O3", broker: "fyers", execEvent: true, side: "BUY", qty: 2, entry: 110, fees: 2, ts: 20 },
  ];
  const [p] = db.projectFills(fills);
  assert.equal(p.executions, 2, "executions win over the snapshot");
  assert.ok(Math.abs(p.price - 104) < 1e-9, "uses the execution weighted-average, not the snapshot's 100");
  assert.equal(p.fees, 5);
});

test("deriveRiskFromFills nets fees into realized P&L (gross − exit fees − entry fees)", () => {
  const fills = [
    { orderId: "E1", broker: "fyers", execEvent: true, side: "BUY", qty: 5, entry: 100, fees: 10, ts: 100 },
    { orderId: "X1", broker: "fyers", execEvent: true, kind: "exit", side: "SELL", qty: 5, entry: 120, fees: 8, entryOrderId: "E1", ts: 200 },
  ];
  const r = db.deriveRiskFromFills(fills, { from: 0, to: 1e12 });
  assert.equal(r.realizedPnlGross, 100, "gross = (120−100)·5");
  assert.equal(r.fees, 18, "fees = entry 10 + exit 8");
  assert.equal(r.realizedPnl, 82, "NET realized P&L = 100 − 18");
  assert.equal(r.matched, 1);
});

test("deriveRiskFromFills PRORATES entry fees by the matched quantity on a partial close", () => {
  const fills = [
    { orderId: "E2", broker: "fyers", execEvent: true, side: "BUY", qty: 10, entry: 100, fees: 20, ts: 100 },
    { orderId: "X2", broker: "fyers", execEvent: true, kind: "exit", side: "SELL", qty: 4, entry: 120, fees: 5, entryOrderId: "E2", ts: 200 },
  ];
  const r = db.deriveRiskFromFills(fills, { from: 0, to: 1e12 });
  assert.equal(r.realizedPnlGross, 80, "gross = (120−100)·4");
  // entry fee prorated: 20 · (4/10) = 8; exit fee 5 → cost 13; net = 80 − 13 = 67
  assert.equal(r.fees, 13);
  assert.equal(r.realizedPnl, 67);
});

test("deriveRiskFromFills stays backward-compatible when fees are absent (net == gross)", () => {
  const fills = [
    { orderId: "E3", broker: "fyers", side: "BUY", qty: 2, entry: 100, ts: 100 },
    { orderId: "X3", broker: "fyers", kind: "exit", side: "SELL", qty: 2, entry: 130, entryOrderId: "E3", ts: 200 },
  ];
  const r = db.deriveRiskFromFills(fills, { from: 0, to: 1e12 });
  assert.equal(r.fees, 0);
  assert.equal(r.realizedPnl, 60, "net == gross when no fees are present");
  assert.equal(r.realizedPnlGross, 60);
});
