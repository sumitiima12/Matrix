/**
 * test/tradingAnalytics.test.cjs — REC-6. Proves the trustworthy trade statistics are computed correctly and
 * honestly (open trades excluded, shorts handled, drawdown/profit-factor/expectancy exact on known inputs).
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { realizedPnl, maxDrawdown, tradeAnalytics } = require("../tradingAnalytics");

test("realizedPnl: long/short, and open/rejected excluded", () => {
  assert.equal(realizedPnl({ entry: 100, exit: 110, qty: 2, exitAt: 5 }), 20);        // long +20
  assert.equal(realizedPnl({ entry: 100, exit: 90, qty: 2, exitAt: 5, short: true }), 20); // short +20
  assert.equal(realizedPnl({ entry: 100, exit: 0, qty: 2 }), null);                    // no exit → open
  assert.equal(realizedPnl({ entry: 100, exit: 110, qty: 2, exitAt: 5, status: "rejected" }), null);
});

test("empty / all-open → zeroed analytics with estimated marker", () => {
  const a = tradeAnalytics([{ entry: 100, qty: 1 }]);   // open only
  assert.equal(a.estimated, true);
  assert.equal(a.trades, 0);
  assert.equal(a.winRate, null);
});

test("win rate, gross P&L, expectancy, profit factor on known trades", () => {
  const trades = [
    { entry: 100, exit: 110, qty: 1, entryAt: 1, exitAt: 2 },   // +10 win
    { entry: 100, exit: 105, qty: 1, entryAt: 3, exitAt: 4 },   // +5 win
    { entry: 100, exit: 96, qty: 1, entryAt: 5, exitAt: 6 },    // -4 loss
  ];
  const a = tradeAnalytics(trades);
  assert.equal(a.trades, 3);
  assert.equal(a.wins, 2);
  assert.equal(a.losses, 1);
  assert.equal(a.winRate, 66.67);
  assert.equal(a.totalPnl, 11);
  assert.equal(a.grossProfit, 15);
  assert.equal(a.grossLoss, 4);
  assert.equal(a.expectancy, +(11 / 3).toFixed(2));
  assert.equal(a.profitFactor, +(15 / 4).toFixed(2));   // 3.75
  assert.equal(a.avgWin, 7.5);
  assert.equal(a.avgLoss, 4);
  assert.equal(a.payoffRatio, +(7.5 / 4).toFixed(2));   // 1.88
  assert.equal(a.bestTrade, 10);
  assert.equal(a.worstTrade, -4);
});

test("profitFactor is null when there are no losses (undefined ratio, not infinity)", () => {
  const a = tradeAnalytics([{ entry: 100, exit: 110, qty: 1, exitAt: 2 }]);
  assert.equal(a.profitFactor, null);
});

test("maxDrawdown on a known equity curve", () => {
  // P&Ls: +10 (peak 10), -6 (cum 4, dd 6), -6 (cum -2, dd 12 from peak 10), +20 (cum 18)
  const dd = maxDrawdown([10, -6, -6, 20]);
  assert.equal(dd.maxDrawdown, 12);
  assert.equal(dd.maxDrawdownPct, +((12 / 10) * 100).toFixed(2));
});

test("avgHoldMs averages only trades with a valid entry→exit span", () => {
  const a = tradeAnalytics([
    { entry: 10, exit: 11, qty: 1, entryAt: 0, exitAt: 100 },
    { entry: 10, exit: 11, qty: 1, entryAt: 0, exitAt: 300 },
  ]);
  assert.equal(a.avgHoldMs, 200);
});
