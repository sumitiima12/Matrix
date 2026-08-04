/* R32-P2-02 — a fee_final event must be a fee-DELTA OVERLAY, never a phantom execution. projectFills must (a) not
   group it as an entry leg (no phantom zero-qty exposure, no double-counted fee) and (b) add its delta exactly once
   to the referenced order-leg's fees, so deriveRiskFromFills' net P&L reflects the FINAL cost. Uses the real db
   pure functions; no Postgres needed (projectFills/deriveRiskFromFills operate on in-memory fill arrays). */
const test = require("node:test");
const assert = require("node:assert");
const db = require("../db.js");

test("R32-P2-02: fee_final is NOT projected as an execution leg", () => {
  const fills = [
    { fillId: "e1", execEvent: true, broker: "fyers", orderId: "O1", side: "BUY", qty: 10, entry: 100, fees: 3, ts: 1 },
    { fillId: "feefinal_fyers_O1", kind: "fee_final", broker: "fyers", orderId: "O1", leg: "entry", refFillId: "e1", feeDelta: 1.25, ts: 2 },
  ];
  const proj = db.projectFills(fills);
  // Exactly ONE projected leg (the entry) — the fee_final never becomes its own leg.
  assert.equal(proj.length, 1);
  const p = proj[0];
  assert.equal(p.leg, "entry");
  assert.equal(p.qty, 10, "quantity is the execution's, unaffected by the fee event");
  assert.equal(p.fees, 4.25, "the +1.25 fee delta is overlaid onto the entry's fees (3 + 1.25)");
  assert.equal(p.feeFinal, true);
});

test("R32-P2-02: the fee delta is applied ONCE (idempotent), not re-added per duplicate event", () => {
  const fills = [
    { fillId: "e1", execEvent: true, broker: "fyers", orderId: "O1", side: "BUY", qty: 5, entry: 100, fees: 2, ts: 1 },
    { fillId: "feefinal_fyers_O1", kind: "fee_final", broker: "fyers", orderId: "O1", leg: "entry", refFillId: "e1", feeDelta: 1, ts: 2 },
    { fillId: "feefinal_fyers_O1", kind: "fee_final", broker: "fyers", orderId: "O1", leg: "entry", refFillId: "e1", feeDelta: 1, ts: 3 }, // same ref → latest wins, not summed
  ];
  const proj = db.projectFills(fills);
  assert.equal(proj[0].fees, 3, "2 + one 1.0 delta (deduped by refFillId), never 2 + 1 + 1");
});

test("R32-P2-02: fee finality flows into NET realized P&L via deriveRiskFromFills (no double count)", () => {
  // Entry O1 buy 10 @100 (prov fee 3), exit O2 sell 10 @110 (prov fee 3). Gross = +100. Provisional net = 100−6 = 94.
  // EOD finalization adds +2 to the entry fee and +1 to the exit fee → net = 100 − 9 = 91.
  const base = [
    { fillId: "en", execEvent: true, broker: "fyers", orderId: "O1", side: "BUY", qty: 10, entry: 100, fees: 3, ts: 10 },
    { fillId: "ex", execEvent: true, kind: "exit", broker: "fyers", orderId: "O2", side: "SELL", qty: 10, entry: 110, fees: 3, ts: 20, entryOrderId: "O1" },
  ];
  const provisional = db.deriveRiskFromFills(base, { from: 0, to: 1e13 });
  assert.equal(provisional.realizedPnl, 94, "provisional net P&L uses provisional fees");

  const withFinal = base.concat([
    { fillId: "feefinal_fyers_O1", kind: "fee_final", broker: "fyers", orderId: "O1", leg: "entry", refFillId: "en", feeDelta: 2, ts: 30 },
    { fillId: "feefinal_fyers_O2", kind: "fee_final", broker: "fyers", orderId: "O2", leg: "exit", refFillId: "ex", feeDelta: 1, ts: 31 },
  ]);
  const final = db.deriveRiskFromFills(withFinal, { from: 0, to: 1e13 });
  assert.equal(final.realizedPnl, 91, "net P&L reflects the FINAL fees exactly once (100 − 9), never double-counted");
});
