const { test } = require("node:test");
const assert = require("node:assert");
const { occSymbol, resolveUsOption, RESOLUTION_FAILED } = require("../usOptions");

const now = Date.parse("2026-08-10T14:00:00Z");
const aug21 = "2026-08-21", sep18 = "2026-09-18";

test("occSymbol matches OCC compressed form (screenshot exact)", () => {
  assert.equal(occSymbol("TSLA", "2026-08-21", "CALL", 10), "TSLA260821C00010000");
  assert.equal(occSymbol("SPX", "2026-08-21", "CALL", 800), "SPX260821C00800000");
  assert.equal(occSymbol("TSLA", "2026-08-21", "PUT", 10), "TSLA260821P00010000");
  assert.equal(occSymbol("AAPL", "2026-09-18", "CALL", 227.5), "AAPL260918C00227500");   // fractional strike
});

test("MODE 1 explicit strike+expiry — deterministic, no chain", () => {
  const r = resolveUsOption({ underlying: "SPX", optionType: "CALL", explicitStrike: 800, explicitExpiry: aug21, lots: 2 });
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.equal(r.tradingSymbol, "SPX260821C00800000");
  assert.equal(r.market, "US");
  assert.equal(r.contractMultiplier, 100);
  assert.equal(r.quantity, 2);   // 2 contracts
});

test("MODE 2 moneyness against a chain ladder — ATM/OTM/ITM", () => {
  // NIFTY-style ladder for TSLA around spot 300, strikes 280..320 step 10, both CE/PE, expiry aug21.
  const strikes = [280, 290, 300, 310, 320];
  const rows = [];
  for (const k of strikes) { rows.push({ underlying: "TSLA", optionType: "CALL", strike: k, expiry: aug21 }); rows.push({ underlying: "TSLA", optionType: "PUT", strike: k, expiry: aug21 }); }
  const atm = resolveUsOption({ rows, underlying: "TSLA", optionType: "CALL", moneyness: "ATM", expiryIntent: "CURRENT_WEEK", spot: 301, lots: 1, nowMs: now });
  assert.equal(atm.strike, 300);
  assert.equal(atm.tradingSymbol, "TSLA260821C00300000");
  const otm = resolveUsOption({ rows, underlying: "TSLA", optionType: "CALL", moneyness: "OTM1", expiryIntent: "CURRENT_WEEK", spot: 301, lots: 1, nowMs: now });
  assert.equal(otm.strike, 310);
  const itmP = resolveUsOption({ rows, underlying: "TSLA", optionType: "PUT", moneyness: "ITM1", expiryIntent: "CURRENT_WEEK", spot: 301, lots: 1, nowMs: now });
  assert.equal(itmP.strike, 310);   // ITM put = strike above spot
});

test("FAIL CLOSED: rung not listed, no chain, missing call/put", () => {
  const strikes = [300, 310];
  const rows = strikes.flatMap((k) => [{ underlying: "TSLA", optionType: "CALL", strike: k, expiry: aug21 }]);
  assert.equal(resolveUsOption({ rows, underlying: "TSLA", optionType: "CALL", moneyness: "OTM4", expiryIntent: "CURRENT_WEEK", spot: 301, lots: 1, nowMs: now }).detail, "strike_rung_not_listed");
  assert.equal(resolveUsOption({ underlying: "TSLA", optionType: "CALL", moneyness: "ATM", expiryIntent: "CURRENT_WEEK", spot: 301, lots: 1 }).detail, "chain_unavailable");
  assert.equal(resolveUsOption({ underlying: "TSLA", explicitStrike: 300, explicitExpiry: aug21, lots: 1 }).detail, "option_missing_call_put");
});
