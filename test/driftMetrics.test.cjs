"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { costMetrics, slippageBps } = require("../driftMetrics");

/* Ledger: two round-trips.
   O1 fyers BUY 10 @100 → exit 10 @110 = +100 gross, fees 5 → net 95.
   O2 delta SELL(short) 5 @50 → exit 5 @40 = +50 gross (short profits when price falls), fees 2 → net 48. */
function ledger() {
  return [
    { broker: "fyers", orderId: "O1", kind: "entry", side: "BUY", qty: 10, price: 100, market: "IN", ts: 1000, fees: 2, refPrice: 99.9 },
    { broker: "fyers", orderId: "X1", kind: "exit", side: "SELL", qty: 10, price: 110, market: "IN", ts: 2000, fees: 3, entryOrderId: "O1" },
    { broker: "delta", orderId: "O2", kind: "entry", side: "SELL", qty: 5, price: 50, market: "Crypto", ts: 1500, fees: 1 },
    { broker: "delta", orderId: "X2", kind: "exit", side: "BUY", qty: 5, price: 40, market: "Crypto", ts: 2500, fees: 1, entryOrderId: "O2" },
  ];
}

test("realized net/gross and fee drag are computed from the ledger", () => {
  const m = costMetrics(ledger());
  assert.strictEqual(m.realizedGross, 150);          // 100 + 50
  assert.strictEqual(m.totalFees, 7);                // 2+3 + 1+1
  assert.strictEqual(m.realizedNet, 143);            // 150 - 7
  assert.strictEqual(m.roundTrips, 2);
  assert.ok(m.feeDragPct > 4 && m.feeDragPct < 5);   // 7/150 ≈ 4.67%
});

test("per-broker breakdown splits correctly", () => {
  const m = costMetrics(ledger());
  assert.strictEqual(m.byBroker.fyers.gross, 100);
  assert.strictEqual(m.byBroker.fyers.fees, 5);
  assert.strictEqual(m.byBroker.fyers.net, 95);
  assert.strictEqual(m.byBroker.delta.gross, 50);
  assert.strictEqual(m.byBroker.delta.net, 48);
});

test("slippage measured only where a reference price exists", () => {
  const m = costMetrics(ledger());
  assert.ok(m.slippage.available);
  assert.strictEqual(m.slippage.samples, 1);   // only O1 carried refPrice
  // BUY filled at 100 vs ref 99.9 → adverse (paid more) → negative bps
  assert.ok(m.slippage.avgBps < 0);
});

test("no reference prices → slippage unavailable, stated honestly", () => {
  const noRef = ledger().map((f) => { const c = { ...f }; delete c.refPrice; return c; });
  const m = costMetrics(noRef);
  assert.strictEqual(m.slippage.available, false);
  assert.strictEqual(m.slippage.samples, 0);
});

test("model-vs-ledger drift when a projection value is supplied", () => {
  const m = costMetrics(ledger(), { projectionRealizedPnl: 150 });   // projection thinks 150, ledger says 143
  assert.strictEqual(m.modelVsLedgerDrift, 7);
});

test("slippageBps sign: SELL below reference is adverse", () => {
  const s = slippageBps({ side: "SELL", price: 49, refPrice: 50 });   // sold cheaper than intended → adverse
  assert.ok(s < 0);
});

test("empty ledger doesn't crash", () => {
  const m = costMetrics([]);
  assert.strictEqual(m.realizedNet, 0);
  assert.strictEqual(m.roundTrips, 0);
  assert.strictEqual(m.slippage.available, false);
});
