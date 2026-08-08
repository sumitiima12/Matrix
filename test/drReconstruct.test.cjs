"use strict";
/* OPS-2 — DR reconstruction drill. Proves that open positions and the risk-lock decision can be rebuilt
   from the IMMUTABLE fills ledger alone (no projection tables), which is the recoverability guarantee after
   a point-in-time restore that loses the mutable state. */
const test = require("node:test");
const assert = require("node:assert");
const { reconstructOpenPositions, reconstructRiskState, reconstructUserState } = require("../drReconstruct");

/* A hand-built immutable ledger: entries + exits as they'd be appended by the live system.
   O1: buy 10 @100 (fyers), later sell 4 @110 → 6 still open.
   O2: sell(short) 5 @50 (delta), no exit → 5 still open.
   O3: buy 2 @100 (fyers), sell 2 @90 → fully closed (not open), realized loss 20.  */
function ledger() {
  return [
    { broker: "fyers", orderId: "O1", kind: "entry", side: "BUY", qty: 10, price: 100, market: "IN", ts: 1000, fees: 0 },
    { broker: "fyers", orderId: "X1", kind: "exit", side: "SELL", qty: 4, price: 110, market: "IN", ts: 2000, fees: 0, entryOrderId: "O1" },
    { broker: "delta", orderId: "O2", kind: "entry", side: "SELL", qty: 5, price: 50, market: "Crypto", ts: 1500, fees: 0 },
    { broker: "fyers", orderId: "O3", kind: "entry", side: "BUY", qty: 2, price: 100, market: "IN", ts: 1200, fees: 0 },
    { broker: "fyers", orderId: "X3", kind: "exit", side: "SELL", qty: 2, price: 90, market: "IN", ts: 2200, fees: 0, entryOrderId: "O3" },
  ];
}

test("reconstructOpenPositions rebuilds exactly the still-open positions", () => {
  const open = reconstructOpenPositions(ledger());
  assert.strictEqual(open.length, 2, "only O1 (partial) and O2 (untouched) are open");
  const byId = Object.fromEntries(open.map((p) => [p.entryOrderId, p]));
  assert.ok(byId.O1 && byId.O2, "O1 and O2 open");
  assert.ok(!byId.O3, "O3 fully closed → not open");
  assert.strictEqual(byId.O1.qty, 6, "O1 net open = 10 - 4");
  assert.strictEqual(byId.O1.side, "BUY");
  assert.strictEqual(byId.O2.qty, 5, "O2 untouched short");
  assert.strictEqual(byId.O2.side, "SELL");
  assert.strictEqual(byId.O2.broker, "delta");
});

test("reconstructRiskState derives realized loss and the lock decision from the ledger", () => {
  const r = reconstructRiskState(ledger(), { maxDailyLoss: 15 });
  // O3 closed at a 10-point loss on 2 units = 20 realized loss; O1's exit is a profit and shouldn't add loss.
  assert.strictEqual(r.realizedLoss, 20);
  assert.ok(r.shouldRiskLock, "20 realized loss >= 15 cap → should be locked");

  const r2 = reconstructRiskState(ledger(), { maxDailyLoss: 100 });
  assert.ok(!r2.shouldRiskLock, "under a 100 cap → not locked");
});

test("reconstructUserState gives a full recoverable snapshot", () => {
  const s = reconstructUserState(ledger(), { maxDailyLoss: 15 });
  assert.strictEqual(s.openCount, 2);
  assert.strictEqual(s.totalOpenQty, 11);   // 6 + 5
  assert.ok(s.risk.shouldRiskLock);
});

test("empty ledger reconstructs an empty, unlocked state (no crash)", () => {
  const s = reconstructUserState([], { maxDailyLoss: 10 });
  assert.strictEqual(s.openCount, 0);
  assert.strictEqual(s.totalOpenQty, 0);
  assert.ok(!s.risk.shouldRiskLock);
});

test("an incomplete execution-event set never understates open quantity (conservative)", () => {
  /* Entry recorded as a cumulative snapshot of 10, but only one exec event of 3 landed (a dropped async
     write). projectFills must project the snapshot (10), so the open qty stays the conservative 10 — never 3. */
  const fills = [
    { broker: "fyers", orderId: "O9", kind: "entry", side: "BUY", qty: 10, price: 100, market: "IN", ts: 100, fees: 0 },            // snapshot
    { broker: "fyers", orderId: "O9", kind: "entry", side: "BUY", qty: 3, price: 100, market: "IN", ts: 110, fees: 0, execEvent: true }, // partial exec
  ];
  const open = reconstructOpenPositions(fills);
  assert.strictEqual(open.length, 1);
  assert.strictEqual(open[0].qty, 10, "snapshot (10) wins over incomplete exec sum (3)");
  assert.ok(open[0].incompleteExec, "flagged so risk stays conservative");
});
