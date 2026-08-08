/**
 * test/smartScore.test.cjs — REC-2 transparent 4-factor scoring. Proves the score is earned, coverage-aware,
 * and direction-aware, on synthetic candle series where the "right" answer is known by construction.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { smartScore, MIN_COVERAGE } = require("../smartScore");

/** Build `n` candles trending at `slopePctPerBar`, with given volume and intrabar range fraction. */
function series(n, { start = 100, slopePct = 0, vol = 1000, rangeFrac = 0.01, lastVolMult = 1 } = {}) {
  const out = [];
  let c = start;
  for (let i = 0; i < n; i++) {
    const prev = c;
    c = prev * (1 + slopePct / 100);
    const hi = Math.max(prev, c) * (1 + rangeFrac);
    const lo = Math.min(prev, c) * (1 - rangeFrac);
    out.push({ o: prev, h: hi, l: lo, c, v: vol * (i === n - 1 ? lastVolMult : 1) });
  }
  return out;
}

test("thin history → declines to score (coverage below threshold)", () => {
  const r = smartScore(series(5, { slopePct: 1 }));
  assert.equal(r.total, null);
  assert.match(r.verdict, /Insufficient/);
  assert.ok(r.coverage < MIN_COVERAGE);
});

test("strong uptrend + participation → high-conviction BUY, trend/momentum score high", () => {
  const r = smartScore(series(60, { slopePct: 0.8, lastVolMult: 1.8, rangeFrac: 0.012 }));
  assert.ok(r.total >= 70, `expected strong score, got ${r.total}`);
  assert.match(r.verdict, /buy/i);
  const trend = r.factors.find((f) => f.id === "trend");
  assert.ok(trend.score >= 80, `trend ${trend.score}`);
  // every factor carries a plain-English reason
  assert.ok(r.factors.every((f) => typeof f.why === "string" && f.why.length > 0));
});

test("same uptrend scored as a SHORT → low score (direction-aware inversion)", () => {
  const long = smartScore(series(60, { slopePct: 0.8, lastVolMult: 1.5 }), { side: "BUY" });
  const short = smartScore(series(60, { slopePct: 0.8, lastVolMult: 1.5 }), { side: "SELL" });
  assert.ok(short.total < long.total, `short ${short.total} should be < long ${long.total}`);
  assert.match(short.verdict, /avoid|neutral/i);
});

test("downtrend scored as a SHORT → favourable", () => {
  const short = smartScore(series(60, { slopePct: -0.8, lastVolMult: 1.6 }), { side: "SELL" });
  assert.ok(short.total >= 60, `expected favourable short, got ${short.total}`);
  const trend = short.factors.find((f) => f.id === "trend");
  assert.ok(trend.score >= 70);
});

test("coverage excludes volume factor when volume is missing (not scored as failure)", () => {
  const noVol = series(60, { slopePct: 0.5 }).map(({ o, h, l, c }) => ({ o, h, l, c }));  // strip v
  const r = smartScore(noVol);
  assert.ok(!r.factors.find((f) => f.id === "volume"), "volume factor must be absent, not zero");
  assert.ok(r.coverage < 1 && r.coverage >= MIN_COVERAGE);   // still scores on the other three
  assert.ok(Number.isFinite(r.total));
});

test("weighted total equals the coverage-normalised factor blend", () => {
  const r = smartScore(series(60, { slopePct: 0.3, lastVolMult: 1.2 }));
  const aw = r.factors.reduce((s, f) => s + f.weight, 0);
  const expect = Math.round(r.factors.reduce((s, f) => s + f.score * f.weight, 0) / aw);
  assert.equal(r.total, expect);
});
