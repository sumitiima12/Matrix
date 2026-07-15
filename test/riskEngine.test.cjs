/**
 * test/riskEngine.test.js — server-side order validation (C2).
 * Run: node --test  (from the backend dir)
 *
 * Locks down that real orders are checked against real account state: funds, position size,
 * max positions, sell-vs-held, daily-loss cap, and that clean orders pass.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const { validateOrder } = require("../riskEngine");

const acct = (over = {}) => ({ wallet: 100000, portfolio: [], trades: [], ...over });

test("a clean small buy is allowed", () => {
  const r = validateOrder({ sym: "TCS", side: "BUY", qty: 1, price: 3000, market: "IN" }, acct());
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.reasons.length, 0);
});

test("a buy exceeding available funds is blocked", () => {
  const r = validateOrder({ sym: "RELIANCE", side: "BUY", qty: 1000, price: 2000, market: "IN" }, acct());
  assert.strictEqual(r.ok, false);
  assert.match(r.reasons[0], /funds/i);
});

test("a position larger than the 25% cap is blocked", () => {
  // 20 * 2000 = 40,000 = 40% of a 100k wallet-only equity.
  const r = validateOrder({ sym: "RELIANCE", side: "BUY", qty: 20, price: 2000, market: "IN" }, acct());
  assert.strictEqual(r.ok, false);
  assert.match(r.reasons.join(" "), /Position size/i);
});

test("a position under the cap is allowed", () => {
  const r = validateOrder({ sym: "RELIANCE", side: "BUY", qty: 10, price: 2000, market: "IN" }, acct());
  assert.strictEqual(r.ok, true);
});

test("selling more than held is blocked", () => {
  const a = acct({ portfolio: [{ sym: "RELIANCE", qty: 2, market: "IN", price: 2000 }] });
  const r = validateOrder({ sym: "RELIANCE", side: "SELL", qty: 5, price: 2000, market: "IN" }, a);
  assert.strictEqual(r.ok, false);
  assert.match(r.reasons.join(" "), /Cannot sell/i);
});

test("selling exactly what is held is allowed", () => {
  const a = acct({ portfolio: [{ sym: "RELIANCE", qty: 5, market: "IN", price: 2000 }] });
  const r = validateOrder({ sym: "RELIANCE", side: "SELL", qty: 5, price: 2000, market: "IN" }, a);
  assert.strictEqual(r.ok, true);
});

test("a sell is NOT blocked by a missing price (you can always exit)", () => {
  const a = acct({ portfolio: [{ sym: "RELIANCE", qty: 5, market: "IN", price: 2000 }] });
  const r = validateOrder({ sym: "RELIANCE", side: "SELL", qty: 5, price: null, market: "IN" }, a);
  assert.strictEqual(r.ok, true);
});

test("a buy WITHOUT a price is blocked (never buy blind)", () => {
  const r = validateOrder({ sym: "TCS", side: "BUY", qty: 1, price: null, market: "IN" }, acct());
  assert.strictEqual(r.ok, false);
  assert.match(r.reasons.join(" "), /price/i);
});

test("exceeding the max open positions cap is blocked", () => {
  const portfolio = Array.from({ length: 15 }, (_, i) => ({ sym: "S" + i, qty: 1, market: "IN", price: 10 }));
  const a = acct({ wallet: 1e9, portfolio });
  const r = validateOrder({ sym: "NEW", side: "BUY", qty: 1, price: 10, market: "IN" }, a);
  assert.strictEqual(r.ok, false);
  assert.match(r.reasons.join(" "), /positions/i);
});

test("daily-loss cap is based on start-of-day equity, not current wallet", () => {
  // Started at 100k. maxDailyLossPct 5% -> cap -5000.
  // A 4,000 loss should NOT trip it (cap must not shrink with the wallet).
  const under = acct({ wallet: 96000, trades: [{ exitAt: Date.now(), market: "IN", pnl: -4000 }] });
  const r1 = validateOrder({ sym: "X", side: "BUY", qty: 1, price: 100, market: "IN" }, under);
  assert.ok(!r1.reasons.some((x) => /loss limit/i.test(x)), "4k loss should not trip the 5k cap");

  // A 6,000 loss should trip it.
  const over = acct({ wallet: 94000, trades: [{ exitAt: Date.now(), market: "IN", pnl: -6000 }] });
  const r2 = validateOrder({ sym: "X", side: "BUY", qty: 1, price: 100, market: "IN" }, over);
  assert.ok(r2.reasons.some((x) => /loss limit/i.test(x)), "6k loss should trip the 5k cap");
});

test("a zero or negative quantity is rejected", () => {
  assert.strictEqual(validateOrder({ sym: "X", side: "BUY", qty: 0, price: 100, market: "IN" }, acct()).ok, false);
  assert.strictEqual(validateOrder({ sym: "X", side: "BUY", qty: -5, price: 100, market: "IN" }, acct()).ok, false);
});
