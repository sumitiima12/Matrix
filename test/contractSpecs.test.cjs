const { test } = require("node:test");
const assert = require("node:assert");
const { getContractSpec } = require("../contractSpecs");

test("Delta BTC/ETH futures specs are verified and real-executable", () => {
  const btc = getContractSpec({ market: "Crypto", underlying: "BTC", productType: "FUTURE" }, { mode: "real" });
  assert.equal(btc.lotSize, 0.001);
  assert.equal(btc.realExecution, true);
  const eth = getContractSpec({ market: "Crypto", underlying: "ETH", productType: "FUTURE" }, { mode: "real" });
  assert.equal(eth.lotSize, 0.01);
});

test("crypto options are reference-only → null for real, present for virtual", () => {
  assert.equal(getContractSpec({ market: "Crypto", underlying: "BTC", productType: "OPTION" }, { mode: "real" }), null);
  assert.ok(getContractSpec({ market: "Crypto", underlying: "BTC", productType: "OPTION" }, { mode: "virtual" }));
});

test("US equity option multiplier is 100 (reference)", () => {
  const us = getContractSpec({ market: "US", underlying: "AAPL", productType: "OPTION" }, { mode: "virtual" });
  assert.equal(us.contractMultiplier, 100);
});

test("MCX bullion contract sizes present (reference), gated for real without live master", () => {
  // CONVENTION: lotSize = 1 (one contract per lot; broker qty = lots); contractMultiplier = underlying units/contract.
  const gold = getContractSpec({ market: "Commodity", underlying: "GOLD", productType: "FUTURE" }, { mode: "virtual" });
  assert.equal(gold.lotSize, 1); assert.equal(gold.contractMultiplier, 1000);
  const guinea = getContractSpec({ market: "Commodity", underlying: "GOLDGUINEA", productType: "FUTURE" }, { mode: "virtual" });
  assert.equal(guinea.lotSize, 1); assert.equal(guinea.contractMultiplier, 8);
  const silverMini = getContractSpec({ market: "Commodity", underlying: "SILVERMINI", productType: "FUTURE" }, { mode: "virtual" });
  assert.equal(silverMini.lotSize, 1); assert.equal(silverMini.contractMultiplier, 5);
  // real-money without a live master → fail closed
  assert.equal(getContractSpec({ market: "Commodity", underlying: "GOLD", productType: "FUTURE" }, { mode: "real" }), null);
});

test("India derivatives are NOT seeded → fail closed until live master wired", () => {
  assert.equal(getContractSpec({ market: "IN", underlying: "NIFTY", productType: "OPTION" }, { mode: "real" }), null);
  assert.equal(getContractSpec({ market: "IN", underlying: "NIFTY", productType: "FUTURE" }, { mode: "virtual" }), null);
});

test("live instrument master is preferred and is real-executable", () => {
  const liveMaster = (q) => q.underlying === "NIFTY"
    ? { lotSize: 75, contractMultiplier: 1, quantityStep: 75, minQty: 75, tickSize: 0.05, exchange: "NFO", metadataVersion: "live-2026-08-19" }
    : null;
  const spec = getContractSpec({ market: "IN", underlying: "NIFTY", productType: "OPTION" }, { mode: "real", liveMaster });
  assert.equal(spec.lotSize, 75);
  assert.equal(spec.realExecution, true);
  assert.equal(spec.metadataSource, "live_instrument_master");
});

test("unknown instrument → null (fail closed)", () => {
  assert.equal(getContractSpec({ market: "Mars", underlying: "XYZ", productType: "FUTURE" }, { mode: "virtual" }), null);
});
