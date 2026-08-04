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

test("REDUCE-ONLY exit is EXEMPT from entry-side gates (cooldown, funds, sizing, frequency)", () => {
  // Same symbol traded 0s ago (would trip the cooldown), no held position, tiny wallet: an ENTRY here would be
  // blocked on multiple grounds. A reduce-only CLOSE must still pass — the broker guarantees it only reduces.
  const trades = [{ sym: "TCS", entryAt: Date.now(), market: "IN" }];
  const entry = validateOrder({ sym: "TCS", side: "BUY", qty: 5, price: 3000, market: "IN" }, acct({ wallet: 10, trades, limits: { cooldownMs: 15000 } }));
  assert.strictEqual(entry.ok, false, "a fresh ENTRY in cooldown / underfunded is blocked");
  const exit = validateOrder({ sym: "TCS", side: "SELL", qty: 5, price: 3100, market: "IN", reduceOnly: true }, acct({ wallet: 10, trades, limits: { cooldownMs: 15000 } }));
  assert.strictEqual(exit.ok, true, "the reduce-only CLOSE is allowed despite cooldown/funds — you can always flatten");
  assert.strictEqual(exit.reasons.length, 0);
});

test("REDUCE-ONLY still fails basic sanity (a non-positive qty is rejected)", () => {
  const r = validateOrder({ sym: "TCS", side: "SELL", qty: 0, price: 3100, market: "IN", reduceOnly: true }, acct());
  assert.strictEqual(r.ok, false);
});

// Caps are OFF by default (the user opts in from Profile). These tests set an explicit limit to
// prove the ENFORCEMENT LOGIC still works when a user turns a cap on.
test("a position larger than the 25% cap is blocked (when the user sets a 25% cap)", () => {
  // 20 * 2000 = 40,000 = 40% of a 100k wallet-only equity.
  const r = validateOrder({ sym: "RELIANCE", side: "BUY", qty: 20, price: 2000, market: "IN" }, acct({ limits: { maxPositionPct: 25 } }));
  assert.strictEqual(r.ok, false);
  assert.match(r.reasons.join(" "), /Position size/i);
});

test("a position under the cap is allowed (with a 25% cap set)", () => {
  const r = validateOrder({ sym: "RELIANCE", side: "BUY", qty: 10, price: 2000, market: "IN" }, acct({ limits: { maxPositionPct: 25 } }));
  assert.strictEqual(r.ok, true);
});

test("default safety-floor keeps maxPositionPct permissive (a 40% position passes)", () => {
  // Default maxPositionPct is 100, so a single 40% position is fine — the floor guards loss/cooldown/counts.
  const r = validateOrder({ sym: "RELIANCE", side: "BUY", qty: 20, price: 2000, market: "IN" }, acct());
  assert.strictEqual(r.ok, true);
});

test("P1-03: selling more than held OPENS a short (allowed, with a warning)", () => {
  const a = acct({ portfolio: [{ sym: "RELIANCE", qty: 2, market: "IN", price: 2000 }] });
  const r = validateOrder({ sym: "RELIANCE", side: "SELL", qty: 5, price: 2000, market: "IN" }, a);
  assert.strictEqual(r.ok, true);                                  // 3-unit uncovered short, ~5.8% of equity
  assert.match(r.warnings.join(" "), /short/i);
});

test("P1-03: a naked short larger than 100% of equity is blocked by default", () => {
  const a = acct({ wallet: 1000, portfolio: [] });                 // equity 1000
  const r = validateOrder({ sym: "X", side: "SELL", qty: 10, price: 2000, market: "IN" }, a);  // 20,000 short
  assert.strictEqual(r.ok, false);
  assert.match(r.reasons.join(" "), /Short size/i);
});

test("P1-02: default daily-loss circuit breaker (25%) halts after a big loss", () => {
  const over = acct({ wallet: 70000, trades: [{ exitAt: Date.now(), market: "IN", pnl: -30000 }] });   // −30% of 100k start
  assert.ok(validateOrder({ sym: "X", side: "BUY", qty: 1, price: 100, market: "IN" }, over).reasons.some((x) => /loss limit/i.test(x)));
  const under = acct({ wallet: 80000, trades: [{ exitAt: Date.now(), market: "IN", pnl: -20000 }] });   // −20%
  assert.ok(!validateOrder({ sym: "X", side: "BUY", qty: 1, price: 100, market: "IN" }, under).reasons.some((x) => /loss limit/i.test(x)));
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

test("exceeding the max open positions cap is blocked (when the user sets it to 15)", () => {
  const portfolio = Array.from({ length: 15 }, (_, i) => ({ sym: "S" + i, qty: 1, market: "IN", price: 10 }));
  const a = acct({ wallet: 1e9, portfolio, limits: { maxOpenPositions: 15 } });
  const r = validateOrder({ sym: "NEW", side: "BUY", qty: 1, price: 10, market: "IN" }, a);
  assert.strictEqual(r.ok, false);
  assert.match(r.reasons.join(" "), /positions/i);
});

test("daily-loss cap is based on start-of-day equity, not current wallet (with a 5% cap set)", () => {
  // Started at 100k. maxDailyLossPct 5% -> cap -5000.
  // A 4,000 loss should NOT trip it (cap must not shrink with the wallet).
  const under = acct({ wallet: 96000, trades: [{ exitAt: Date.now(), market: "IN", pnl: -4000 }], limits: { maxDailyLossPct: 5 } });
  const r1 = validateOrder({ sym: "X", side: "BUY", qty: 1, price: 100, market: "IN" }, under);
  assert.ok(!r1.reasons.some((x) => /loss limit/i.test(x)), "4k loss should not trip the 5k cap");

  // A 6,000 loss should trip it.
  const over = acct({ wallet: 94000, trades: [{ exitAt: Date.now(), market: "IN", pnl: -6000 }], limits: { maxDailyLossPct: 5 } });
  const r2 = validateOrder({ sym: "X", side: "BUY", qty: 1, price: 100, market: "IN" }, over);
  assert.ok(r2.reasons.some((x) => /loss limit/i.test(x)), "6k loss should trip the 5k cap");
});

test("a zero or negative quantity is rejected", () => {
  assert.strictEqual(validateOrder({ sym: "X", side: "BUY", qty: 0, price: 100, market: "IN" }, acct()).ok, false);
  assert.strictEqual(validateOrder({ sym: "X", side: "BUY", qty: -5, price: 100, market: "IN" }, acct()).ok, false);
});

// R3-#6: a short consumes MARGIN. An uncovered short whose estimated margin exceeds the wallet is
// rejected (before the broker would), while a normal leveraged short passes.
test("a short beyond available margin is blocked (R3-#6)", () => {
  // $10 wallet, shorting 10 units @ $1000 = $10,000 notional. Crypto margin ≈ 4% = $400 > $10 → reject.
  const r = validateOrder({ sym: "BTCUSD", side: "SELL", qty: 10, price: 1000, market: "Crypto" }, acct({ wallet: 10 }));
  assert.strictEqual(r.ok, false);
  assert.match(r.reasons.join(" "), /margin/i);
});

test("a normal leveraged short within margin is allowed (R3-#6)", () => {
  // $1,000 wallet, shorting 1 unit @ $1,000 = $1,000 notional. Crypto margin ≈ 4% = $40 ≤ $1,000 → ok.
  const r = validateOrder({ sym: "BTCUSD", side: "SELL", qty: 1, price: 1000, market: "Crypto" }, acct({ wallet: 1000 }));
  assert.ok(!r.reasons.some((x) => /margin/i.test(x)), "a $40 margin short should pass on a $1000 wallet");
});

/* M2-04: a user policy can only TIGHTEN the platform ceiling, never loosen it. */
test("M2-04: user cannot loosen the daily-loss ceiling above the platform max (25%)", () => {
  const startOfDayMs = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime() + 60000; })();
  // Realised −40% today; user tries to disable the breaker with maxDailyLossPct: 100.
  const trades = [{ exitAt: Date.now(), entryAt: startOfDayMs, pnl: -40000, market: "IN" }];
  const r = validateOrder(
    { sym: "TCS", side: "BUY", qty: 1, price: 3000, market: "IN" },
    { wallet: 60000, portfolio: [], trades, limits: { maxDailyLossPct: 100 } },
  );
  // The platform ceiling (25%) still applies → the order is blocked despite the loose user cap.
  assert.strictEqual(r.ok, false);
  assert.ok(r.reasons.some((x) => /daily loss/i.test(x)));
});

/* C-04: cooldown is a BLOCKING reason for an exposure-increasing entry. */
test("C-04: a BUY inside the same-symbol cooldown is BLOCKED, not just warned", () => {
  const trades = [{ sym: "TCS", entryAt: Date.now() - 2000, market: "IN" }];   // bought 2s ago
  const r = validateOrder(
    { sym: "TCS", side: "BUY", qty: 1, price: 3000, market: "IN" },
    { wallet: 100000, portfolio: [], trades, limits: { cooldownMs: 15000 } },
  );
  assert.strictEqual(r.ok, false);
  assert.ok(r.reasons.some((x) => /cooldown/i.test(x)));
});

/* R19-P2-08: a user cannot DISABLE the same-symbol cooldown by saving cooldownMs:0 — the platform enforces a
   minimum floor (3s). A BUY 1s after the last entry is still blocked even though the user set cooldownMs:0. */
test("R19-P2-08: cooldownMs:0 is floored to the platform minimum, so a rapid re-entry is still blocked", () => {
  const trades = [{ sym: "TCS", entryAt: Date.now() - 1000, market: "IN" }];   // bought 1s ago
  const r = validateOrder(
    { sym: "TCS", side: "BUY", qty: 1, price: 3000, market: "IN" },
    { wallet: 100000, portfolio: [], trades, limits: { cooldownMs: 0 } },
  );
  assert.strictEqual(r.ok, false);
  assert.ok(r.reasons.some((x) => /cooldown/i.test(x)));
});
