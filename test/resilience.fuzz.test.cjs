/**
 * test/resilience.fuzz.test.cjs — REC-9: RESILIENCE / robustness testing.
 *
 * A multi-user product feeds its decision logic an enormous variety of inputs — partial, malformed, extreme,
 * concurrent. These functions sit on the money path, so a single unhandled NaN or thrown exception is an
 * outage. This suite hammers every pure decision module with thousands of randomized + adversarial inputs and
 * asserts the CONTRACT holds under all of them: never throws, always returns a well-formed result with finite
 * numbers (no NaN / Infinity leaking into a price, a size, or a risk cap). It complements the deterministic
 * unit tests (which prove correctness on known inputs) by proving ROBUSTNESS on unknown ones.
 *
 * A companion load-test script for the live HTTP endpoints lives in loadtest/ (run against a deployed URL).
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const { summarizePortfolio } = require("../portfolioRisk");
const { smartScore } = require("../smartScore");
const { effectiveRiskPolicy, strictestRiskPolicy } = require("../riskPolicy");
const { classifyQuote } = require("../marketDataGovernance");
const { tradeAnalytics } = require("../tradingAnalytics");
const { gradeSuitability } = require("../suitability");
const { normalizeTicket, autoSeverity, canTransition } = require("../incidents");

// Deterministic PRNG so a failure is reproducible.
let _s = 0x2545f491;
const rnd = () => { _s ^= _s << 13; _s ^= _s >>> 17; _s ^= _s << 5; return ((_s >>> 0) / 0xffffffff); };
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
// A grab-bag of hostile scalar values.
const WILD = [NaN, Infinity, -Infinity, 0, -0, 1e-9, 1e12, -1e12, null, undefined, "", "abc", "10", true, false, {}, []];
const wild = () => pick(WILD);
const maybeNum = () => (rnd() < 0.6 ? (rnd() - 0.5) * 10 ** Math.floor(rnd() * 8) : wild());

const finiteOrNull = (v) => v === null || (typeof v === "number" && Number.isFinite(v));
function assertNoBadNumbers(obj, label) {
  const seen = new Set();
  (function walk(o) {
    if (o == null || seen.has(o)) return;
    if (typeof o === "number") { assert.ok(Number.isFinite(o), `${label}: non-finite number ${o}`); return; }
    if (typeof o !== "object") return;
    seen.add(o);
    for (const v of Array.isArray(o) ? o : Object.values(o)) walk(v);
  })(obj);
}

test("portfolioRisk.summarizePortfolio survives 3000 random books", () => {
  for (let i = 0; i < 3000; i++) {
    const positions = Array.from({ length: Math.floor(rnd() * 12) }, () => ({
      symbol: pick(["A", "B", "C", "", null]), market: pick(["IN", "US", "Crypto", null]),
      side: pick(["BUY", "SELL", "x", null]), short: rnd() < 0.3,
      qty: maybeNum(), entry: maybeNum(), price: maybeNum(), stop: maybeNum(),
    }));
    const r = summarizePortfolio(positions, { equity: maybeNum() });
    assertNoBadNumbers(r, "portfolioRisk");
    assert.ok(Array.isArray(r.flags));
  }
});

test("smartScore survives 2000 random candle series + sides", () => {
  for (let i = 0; i < 2000; i++) {
    const n = Math.floor(rnd() * 80);
    const candles = Array.from({ length: n }, () => ({ o: maybeNum(), h: maybeNum(), l: maybeNum(), c: maybeNum(), v: maybeNum() }));
    const r = smartScore(candles, { side: pick(["BUY", "SELL", "x", null]) });
    assert.ok(r.total === null || Number.isFinite(r.total), "smartScore total finite-or-null");
    assert.ok(finiteOrNull(r.coverage));
    for (const f of r.factors) assert.ok(Number.isFinite(f.score) && f.score >= 0 && f.score <= 100, `factor ${f.id} in range`);
  }
});

test("risk policy merges survive 3000 hostile pairs and never loosen to garbage", () => {
  for (let i = 0; i < 3000; i++) {
    const mk = () => ({ maxPositionPct: maybeNum(), maxOpenPositions: maybeNum(), maxTradesPerDay: maybeNum(), maxDailyLossPct: maybeNum(), cooldownMs: maybeNum() });
    const eff = effectiveRiskPolicy(mk(), mk(), mk());
    assertNoBadNumbers(eff, "effectiveRiskPolicy");
    // every emitted cap is a clean positive number (cleanRiskPolicy contract holds through the merge)
    for (const v of Object.values(eff)) assert.ok(typeof v === "number" && v > 0);
    assertNoBadNumbers(strictestRiskPolicy(mk(), mk()), "strictestRiskPolicy");
  }
});

test("marketDataGovernance.classifyQuote always returns a fail-closed verdict, never throws", () => {
  for (let i = 0; i < 2000; i++) {
    const q = rnd() < 0.15 ? wild() : { symbol: pick(["X", null]), price: maybeNum(), source: pick(["delta", "evil", null]), asOf: maybeNum(), delayed: rnd() < 0.3, market: pick(["IN", "Crypto", null]) };
    const v = classifyQuote(q, { nowMs: 1e12, allowDelayed: rnd() < 0.5 });
    assert.equal(typeof v.ok, "boolean");
    assert.ok(["fresh", "stale", "delayed", "untrusted", "missing", "invalid"].includes(v.status));
    if (v.ok) assert.equal(v.status, "fresh");   // ok is ONLY ever fresh — the fail-closed invariant
  }
});

test("tradeAnalytics survives 2000 random trade sets", () => {
  for (let i = 0; i < 2000; i++) {
    const trades = Array.from({ length: Math.floor(rnd() * 20) }, () => ({
      entry: maybeNum(), exit: maybeNum(), qty: maybeNum(), entryAt: maybeNum(), exitAt: maybeNum(),
      side: pick(["BUY", "SELL"]), short: rnd() < 0.3, status: pick(["ok", "rejected", null]),
    }));
    const a = tradeAnalytics(trades);
    assertNoBadNumbers(a, "tradeAnalytics");
    assert.equal(a.estimated, true);
    assert.ok(a.trades >= 0);
  }
});

test("suitability + incidents never throw on hostile submissions", () => {
  for (let i = 0; i < 1000; i++) {
    const g = gradeSuitability(rnd() < 0.2 ? wild() : { "real-orders": Math.floor(rnd() * 6), bogus: wild() });
    assert.equal(typeof g.passed, "boolean");
    const t = normalizeTicket({ category: pick(["order-issue", "x", null]), subject: pick(["hi", "", null]), body: pick(["lost money", "", wild()]), severity: pick(["sev1", "x", null]) });
    assert.ok(typeof t.severity === "string" && t.status === "new");
    assert.equal(typeof canTransition(pick(["new", "x"]), pick(["closed", "y"])), "boolean");
    assert.ok(typeof autoSeverity({ category: pick(["bug", null]), body: pick(["down", null]) }) === "string");
  }
});
