const { test } = require("node:test");
const assert = require("node:assert");
const { deltaOptionSymbol, resolveCryptoOption } = require("../cryptoOptions");

const now = Date.parse("2025-12-01T12:00:00Z");
const dec26 = "2025-12-26";

test("deltaOptionSymbol builds C|P-ASSET-strike-DDMMYY", () => {
  assert.equal(deltaOptionSymbol("BTC", "2025-12-26", "CALL", 100000), "C-BTC-100000-261225");
  assert.equal(deltaOptionSymbol("ETH", "2025-12-26", "PUT", 3000), "P-ETH-3000-261225");
  assert.equal(deltaOptionSymbol("SOL", "2025-12-26", "CALL", 200), null);   // only BTC/ETH
});

test("explicit BTC call — deterministic, coin contract size", () => {
  const r = resolveCryptoOption({ underlying: "BTC", optionType: "CALL", explicitStrike: 100000, explicitExpiry: dec26, lots: 5 });
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.equal(r.tradingSymbol, "C-BTC-100000-261225");
  assert.equal(r.market, "Crypto");
  assert.equal(r.contractMultiplier, 0.001);   // BTC contract size
  assert.equal(r.quantity, 5);
});

test("moneyness against a Delta ETH chain ladder", () => {
  const strikes = [2800, 2900, 3000, 3100, 3200];
  const rows = strikes.flatMap((k) => [{ underlying: "ETH", optionType: "CALL", strike: k, expiry: dec26 }, { underlying: "ETH", optionType: "PUT", strike: k, expiry: dec26 }]);
  const atm = resolveCryptoOption({ rows, underlying: "ETH", optionType: "CALL", moneyness: "ATM", expiryIntent: "PLUS_30D", spot: 3010, lots: 1, nowMs: now });
  assert.equal(atm.strike, 3000);
  assert.equal(atm.tradingSymbol, "C-ETH-3000-261225");
  const otm = resolveCryptoOption({ rows, underlying: "ETH", optionType: "CALL", moneyness: "OTM2", expiryIntent: "PLUS_30D", spot: 3010, lots: 1, nowMs: now });
  assert.equal(otm.strike, 3200);
});

test("FAIL CLOSED: unsupported coin, no chain, rung not listed", () => {
  assert.equal(resolveCryptoOption({ underlying: "SOL", optionType: "CALL", explicitStrike: 200, explicitExpiry: dec26, lots: 1 }).detail, "underlying_not_supported_only_BTC_ETH");
  assert.equal(resolveCryptoOption({ underlying: "BTC", optionType: "CALL", moneyness: "ATM", expiryIntent: "PLUS_30D", spot: 100000, lots: 1 }).detail, "chain_unavailable");
});
