/**
 * test/portfolioRisk.test.cjs — REC-1 portfolio-level risk intelligence. These prove the account-wide
 * numbers (concentration, aggregate stop risk, direction skew, unprotected downside) are earned arithmetic.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { normPosition, riskAtStop, summarizePortfolio } = require("../portfolioRisk");

test("normPosition drops junk and defaults price to entry, side to BUY", () => {
  assert.equal(normPosition(null), null);
  assert.equal(normPosition({ qty: 0, entry: 10 }), null);          // no size
  assert.equal(normPosition({ qty: 5, entry: 0 }), null);           // no entry
  const p = normPosition({ symbol: "X", market: "IN", qty: 5, entry: 100 });
  assert.equal(p.price, 100);                                        // mark-to-entry when no live price
  assert.equal(p.side, "BUY");
  assert.equal(p.stop, null);
  assert.equal(normPosition({ qty: 1, entry: 10, short: true }).side, "SELL");
});

test("riskAtStop: loss magnitude for long and short; null when no stop; clamps underwater to 0", () => {
  assert.equal(riskAtStop(normPosition({ qty: 10, entry: 100, price: 100, stop: 95 })), 50);        // long: (100-95)*10
  assert.equal(riskAtStop(normPosition({ qty: 10, entry: 100, price: 100, stop: 105, short: true })), 50); // short: (105-100)*10
  assert.equal(riskAtStop(normPosition({ qty: 10, entry: 100, price: 100 })), null);                // no stop
  assert.equal(riskAtStop(normPosition({ qty: 10, entry: 100, price: 90, stop: 95 })), 0);          // already below stop → no extra
});

test("empty book → all zeros, no flags", () => {
  const s = summarizePortfolio([]);
  assert.equal(s.positions, 0);
  assert.equal(s.grossExposure, 0);
  assert.deepEqual(s.flags, []);
});

test("gross/net/long/short and direction skew", () => {
  const s = summarizePortfolio([
    { symbol: "A", market: "IN", qty: 10, entry: 100, price: 100 },              // long 1000
    { symbol: "B", market: "IN", qty: 10, entry: 100, price: 100, short: true }, // short 1000
    { symbol: "C", market: "US", qty: 5, entry: 100, price: 120 },               // long 600
  ]);
  assert.equal(s.longExposure, 1600);
  assert.equal(s.shortExposure, 1000);
  assert.equal(s.grossExposure, 2600);
  assert.equal(s.netExposure, 600);
  assert.equal(s.directionSkew, +(600 / 2600).toFixed(4));
});

test("single-position concentration flag fires at 60% (high)", () => {
  const s = summarizePortfolio([
    { symbol: "BIG", market: "IN", qty: 1, entry: 700, price: 700 },  // 700 of 1000 = 70%
    { symbol: "S1", market: "IN", qty: 1, entry: 150, price: 150 },
    { symbol: "S2", market: "IN", qty: 1, entry: 150, price: 150 },
  ]);
  assert.equal(s.topPosition.symbol, "BIG");
  assert.equal(s.topConcentrationPct, 70);
  const f = s.flags.find((x) => x.code === "SINGLE_POSITION_CONCENTRATION");
  assert.ok(f && f.level === "high");
});

test("aggregate stop risk vs equity + unprotected flag", () => {
  const s = summarizePortfolio([
    { symbol: "A", market: "IN", qty: 100, entry: 100, price: 100, stop: 98 },   // risk 200
    { symbol: "B", market: "IN", qty: 100, entry: 100, price: 100 },             // no stop → unprotected
  ], { equity: 1000 });
  assert.equal(s.aggregateStopRisk, 200);
  assert.equal(s.aggregateStopRiskPct, 20);                                       // 200/1000
  assert.equal(s.unprotectedCount, 1);
  assert.ok(s.flags.find((x) => x.code === "UNPROTECTED_POSITIONS"));
  const agg = s.flags.find((x) => x.code === "AGGREGATE_STOP_RISK");
  assert.ok(agg && agg.level === "high");                                         // 20% ≥ 20% → high
});

test("market concentration flag when one market ≥80% and there is more than one", () => {
  const s = summarizePortfolio([
    { symbol: "A", market: "IN", qty: 90, entry: 100, price: 100 },   // 9000 IN
    { symbol: "B", market: "US", qty: 10, entry: 100, price: 100 },   // 1000 US
  ]);
  assert.equal(s.byMarket[0].market, "IN");
  assert.equal(s.byMarket[0].sharePct, 90);
  assert.ok(s.flags.find((x) => x.code === "MARKET_CONCENTRATION"));
});
