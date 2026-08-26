const { test } = require("node:test");
const assert = require("node:assert");
const { evaluateDerivativeOrder, MARKET_FLAG } = require("../derivativeGate");

test("non-derivative (STOCK/undefined) always allowed, not flagged", () => {
  assert.deepEqual(evaluateDerivativeOrder({ productType: "STOCK" }, {}), { allowed: true, isDerivative: false });
  assert.deepEqual(evaluateDerivativeOrder({}, {}), { allowed: true, isDerivative: false });
});

test("derivative blocked when the market flag is off (fail closed)", () => {
  const r = evaluateDerivativeOrder({ productType: "OPTION", market: "US" }, {});
  assert.equal(r.allowed, false);
  assert.equal(r.isDerivative, true);
  assert.equal(r.reason, "real_execution_not_validated");
  assert.equal(r.flag, "MATRIX_US_OPTIONS_VALIDATED");
});

test("derivative allowed when the matching flag is truthy — each market", () => {
  assert.equal(evaluateDerivativeOrder({ productType: "OPTION", market: "US" }, { MATRIX_US_OPTIONS_VALIDATED: "1" }).allowed, true);
  assert.equal(evaluateDerivativeOrder({ productType: "OPTION", market: "Crypto" }, { MATRIX_CRYPTO_OPTIONS_VALIDATED: "true" }).allowed, true);
  assert.equal(evaluateDerivativeOrder({ productType: "FUTURE", market: "Commodity" }, { MATRIX_DHAN_MCX_VALIDATED: "yes" }).allowed, true);
  assert.equal(evaluateDerivativeOrder({ productType: "FUTURE", market: "IN" }, { MATRIX_FO_MASTER_VALIDATED: "on" }).allowed, true);
});

test("wrong flag doesn't unlock a different market", () => {
  const r = evaluateDerivativeOrder({ productType: "OPTION", market: "US" }, { MATRIX_CRYPTO_OPTIONS_VALIDATED: "1" });
  assert.equal(r.allowed, false);
});

test("unknown/blank market fails closed even with flags set", () => {
  const r = evaluateDerivativeOrder({ productType: "OPTION", market: "" }, { MATRIX_US_OPTIONS_VALIDATED: "1", MATRIX_FO_MASTER_VALIDATED: "1" });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "unknown_market_fail_closed");
});

test("reduce-only / closing derivative order is always allowed (flatten risk)", () => {
  const r = evaluateDerivativeOrder({ productType: "OPTION", market: "US", reduceOnly: true }, {});
  assert.equal(r.allowed, true);
  assert.equal(r.reason, "reduce_only_exit_always_allowed");
});

test("MARKET_FLAG covers exactly the four validated markets", () => {
  assert.deepEqual(Object.keys(MARKET_FLAG).sort(), ["Commodity", "Crypto", "IN", "US"]);
});
