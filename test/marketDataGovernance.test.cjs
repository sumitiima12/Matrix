/**
 * test/marketDataGovernance.test.cjs — REC-3. Proves the market-data contract FAILS CLOSED: only a fresh,
 * trusted, real-time, positive-price quote may back a real order; every ambiguity is a hard stop.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyQuote, gateRealOrder, maxAgeFor } = require("../marketDataGovernance");

const NOW = 1_000_000_000_000;
const base = { symbol: "BTCUSD", price: 100, source: "delta", asOf: NOW, market: "Crypto" };

test("fresh trusted real-time quote → ok", () => {
  const v = classifyQuote(base, { nowMs: NOW });
  assert.equal(v.ok, true);
  assert.equal(v.status, "fresh");
});

test("missing / invalid quote fails closed", () => {
  assert.equal(classifyQuote(null, { nowMs: NOW }).status, "missing");
  assert.equal(classifyQuote({ ...base, price: 0 }, { nowMs: NOW }).status, "invalid");
  assert.equal(classifyQuote({ ...base, price: "abc" }, { nowMs: NOW }).ok, false);
});

test("untrusted / absent source fails closed", () => {
  assert.equal(classifyQuote({ ...base, source: "randomsite" }, { nowMs: NOW }).status, "untrusted");
  assert.equal(classifyQuote({ ...base, source: null }, { nowMs: NOW }).ok, false);
});

test("delayed feed blocked unless explicitly allowed", () => {
  assert.equal(classifyQuote({ ...base, delayed: true }, { nowMs: NOW }).status, "delayed");
  assert.equal(classifyQuote({ ...base, delayed: true }, { nowMs: NOW, allowDelayed: true }).ok, true);
});

test("no timestamp → cannot verify age → fail closed", () => {
  const v = classifyQuote({ ...base, asOf: undefined }, { nowMs: NOW });
  assert.equal(v.ok, false);
  assert.equal(v.status, "stale");
});

test("stale beyond the market max-age fails; within passes", () => {
  const old = classifyQuote({ ...base, asOf: NOW - 20_000 }, { nowMs: NOW });   // 20s > 15s crypto limit
  assert.equal(old.status, "stale");
  const fresh = classifyQuote({ ...base, asOf: NOW - 5_000 }, { nowMs: NOW });  // 5s < 15s
  assert.equal(fresh.ok, true);
});

test("future timestamp beyond skew tolerance is invalid", () => {
  assert.equal(classifyQuote({ ...base, asOf: NOW + 10_000 }, { nowMs: NOW }).status, "invalid");
  assert.equal(classifyQuote({ ...base, asOf: NOW + 2_000 }, { nowMs: NOW }).ok, true);   // small skew OK
});

test("per-market max-age defaults + policy override", () => {
  assert.equal(maxAgeFor("Crypto", {}), 15_000);
  assert.equal(maxAgeFor("IN", {}), 60_000);
  assert.equal(maxAgeFor("Crypto", { maxAgeMs: 3000 }), 3000);   // override wins
  assert.equal(maxAgeFor("Nonexistent", {}), 60_000);            // default fallback
});

test("gateRealOrder mirrors classifyQuote.ok", () => {
  assert.equal(gateRealOrder(base, { nowMs: NOW }).allow, true);
  assert.equal(gateRealOrder({ ...base, asOf: NOW - 999_999 }, { nowMs: NOW }).allow, false);
});
