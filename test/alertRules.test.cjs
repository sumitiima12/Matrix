/**
 * test/alertRules.test.cjs — UX-3 price-alert evaluation. Proves each alert type fires exactly when it should,
 * bad input is rejected, and the de-dup cooldown suppresses repeat fires.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeAlert, evaluateAlert, shouldFire } = require("../alertRules");

test("normalizeAlert validates + normalizes; rejects junk", () => {
  const ok = normalizeAlert({ symbol: "btc", market: "Crypto", type: "above", threshold: "70000", note: "x" });
  assert.equal(ok.ok, true);
  assert.equal(ok.alert.symbol, "BTC");
  assert.equal(ok.alert.threshold, 70000);
  assert.equal(ok.alert.active, true);
  assert.equal(normalizeAlert({ symbol: "", type: "above", threshold: 1 }).ok, false);
  assert.equal(normalizeAlert({ symbol: "X", type: "sideways", threshold: 1 }).ok, false);
  assert.equal(normalizeAlert({ symbol: "X", type: "above", threshold: -5 }).ok, false);
});

test("above / below fire at the threshold", () => {
  assert.equal(evaluateAlert({ symbol: "BTC", type: "above", threshold: 100, active: true }, { price: 100 }).fired, true);
  assert.equal(evaluateAlert({ symbol: "BTC", type: "above", threshold: 100, active: true }, { price: 99 }).fired, false);
  assert.equal(evaluateAlert({ symbol: "BTC", type: "below", threshold: 100, active: true }, { price: 100 }).fired, true);
  assert.equal(evaluateAlert({ symbol: "BTC", type: "below", threshold: 100, active: true }, { price: 101 }).fired, false);
});

test("pct_up / pct_down use the day change", () => {
  assert.equal(evaluateAlert({ type: "pct_up", threshold: 3, symbol: "N", active: true }, { price: 10, chgPct: 3.1 }).fired, true);
  assert.equal(evaluateAlert({ type: "pct_up", threshold: 3, symbol: "N", active: true }, { price: 10, chgPct: 2.9 }).fired, false);
  assert.equal(evaluateAlert({ type: "pct_down", threshold: 3, symbol: "N", active: true }, { price: 10, chgPct: -3.1 }).fired, true);
  assert.equal(evaluateAlert({ type: "pct_down", threshold: 3, symbol: "N", active: true }, { price: 10, chgPct: -2.5 }).fired, false);
  // pct alert with no chgPct available → doesn't fire (can't evaluate)
  assert.equal(evaluateAlert({ type: "pct_up", threshold: 3, symbol: "N", active: true }, { price: 10 }).fired, false);
});

test("inactive alerts and bad quotes never fire", () => {
  assert.equal(evaluateAlert({ type: "above", threshold: 1, symbol: "X", active: false }, { price: 999 }).fired, false);
  assert.equal(evaluateAlert({ type: "above", threshold: 1, symbol: "X", active: true }, { price: 0 }).fired, false);
  assert.equal(evaluateAlert({ type: "above", threshold: 1, symbol: "X", active: true }, null).fired, false);
});

test("shouldFire de-dups within the cooldown window, re-fires after", () => {
  const alert = { type: "above", threshold: 100, symbol: "BTC", active: true, lastFiredAt: 1000 };
  const q = { price: 150 };
  assert.equal(shouldFire(alert, q, 1000 + 60_000, 6 * 3600_000).fire, false);          // 1 min later → cooldown
  assert.equal(shouldFire(alert, q, 1000 + 7 * 3600_000, 6 * 3600_000).fire, true);      // after cooldown → fire
  assert.equal(shouldFire({ ...alert, lastFiredAt: 0 }, q, 10_000).fire, true);          // never fired → fire
});
