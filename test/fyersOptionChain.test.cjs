const { test } = require("node:test");
const assert = require("node:assert");
const { buildChain, resolveIndiaContract, RESOLUTION_FAILED } = require("../fyersOptionChain");

// Fixture NIFTY master (normalised rows). Two weeklies + one monthly (the later Aug date is the monthly).
const day = 864e5, now = Date.parse("2026-08-19T04:00:00Z");
const wk1 = Date.parse("2026-08-21T10:00:00Z");   // this week (weekly)
const wk2 = Date.parse("2026-08-28T10:00:00Z");   // last Thursday of Aug → MONTHLY
const sepM = Date.parse("2026-09-25T10:00:00Z");  // Sep monthly
const strikes = [24600, 24700, 24800, 24900, 25000];
const lot = 75;
function optRows(expiryMs) {
  const out = [];
  for (const k of strikes) for (const ot of ["CALL", "PUT"]) {
    const d = new Date(expiryMs); const tag = `${d.getFullYear() % 100}${["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"][d.getMonth()]}`;
    out.push({ ticker: `NSE:NIFTY${tag}${k}${ot === "CALL" ? "CE" : "PE"}`, underlying: "NIFTY", productType: "OPTION", optionType: ot, strike: k, expiryMs, lotSize: lot, tickSize: 0.05, instrumentId: `NFO|${k}${ot[0]}` });
  }
  return out;
}
const rows = [...optRows(wk1), ...optRows(wk2), ...optRows(sepM),
  { ticker: "NSE:NIFTY26AUGFUT", underlying: "NIFTY", productType: "FUTURE", optionType: null, strike: null, expiryMs: wk2, lotSize: lot, instrumentId: "NFO|FUT" }];

test("buildChain: lot from master, weekly/monthly classification", () => {
  const c = buildChain(rows, { underlying: "NIFTY", productType: "OPTION", nowMs: now });
  assert.equal(c.lotSize, 75);
  assert.equal(c.expiries.length, 3);
  assert.equal(c.expiries[0].weekly, true);   // wk1 weekly
  assert.equal(c.expiries[1].weekly, false);  // wk2 is last-of-Aug → monthly
  assert.deepEqual(c.strikesByExpiry.get(wk1), strikes);
});

test("CALL ATM current week → exact master ticker + qty", () => {
  const r = resolveIndiaContract({ rows, underlying: "NIFTY", productType: "OPTION", optionType: "CALL", moneyness: "ATM", expiryIntent: "CURRENT_WEEK", spot: 24810, lots: 1, nowMs: now });
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.equal(r.strike, 24800);
  assert.equal(r.quantity, 75);
  assert.equal(r.tradingSymbol, "NSE:NIFTY26AUG24800CE");
  assert.equal(r.expiryWeekly, true);
});

test("moneyness direction: CALL ITM below, PUT ITM above", () => {
  const call = resolveIndiaContract({ rows, underlying: "NIFTY", productType: "OPTION", optionType: "CALL", moneyness: "ITM1", expiryIntent: "CURRENT_WEEK", spot: 24810, lots: 1, nowMs: now });
  assert.equal(call.strike, 24700);
  const put = resolveIndiaContract({ rows, underlying: "NIFTY", productType: "OPTION", optionType: "PUT", moneyness: "ITM1", expiryIntent: "CURRENT_WEEK", spot: 24810, lots: 1, nowMs: now });
  assert.equal(put.strike, 24900);
  const otm = resolveIndiaContract({ rows, underlying: "NIFTY", productType: "OPTION", optionType: "CALL", moneyness: "OTM2", expiryIntent: "CURRENT_WEEK", spot: 24810, lots: 1, nowMs: now });
  assert.equal(otm.strike, 25000);
});

test("current month resolves to the monthly expiry", () => {
  const r = resolveIndiaContract({ rows, underlying: "NIFTY", productType: "OPTION", optionType: "CALL", moneyness: "ATM", expiryIntent: "CURRENT_MONTH", spot: 24810, lots: 2, nowMs: now });
  assert.equal(r.expiry, wk2);
  assert.equal(r.expiryWeekly, false);
  assert.equal(r.quantity, 150);
});

test("FUTURE SELL resolves with direction + master ticker", () => {
  const r = resolveIndiaContract({ rows, underlying: "NIFTY", productType: "FUTURE", side: "SELL", expiryIntent: "CURRENT_MONTH", lots: 3, nowMs: now });
  assert.equal(r.side, "SELL");
  assert.equal(r.tradingSymbol, "NSE:NIFTY26AUGFUT");
  assert.equal(r.quantity, 225);
});

test("FAIL CLOSED: rung not listed, missing call/put, bad lots, empty master", () => {
  assert.equal(resolveIndiaContract({ rows, underlying: "NIFTY", productType: "OPTION", optionType: "CALL", moneyness: "OTM4", expiryIntent: "CURRENT_WEEK", spot: 24810, lots: 1, nowMs: now }).detail, "strike_rung_not_listed");
  assert.equal(resolveIndiaContract({ rows, underlying: "NIFTY", productType: "OPTION", moneyness: "ATM", expiryIntent: "CURRENT_WEEK", spot: 24810, lots: 1, nowMs: now }).detail, "option_missing_call_put");
  assert.equal(resolveIndiaContract({ rows, underlying: "NIFTY", productType: "OPTION", optionType: "CALL", moneyness: "ATM", expiryIntent: "CURRENT_WEEK", spot: 24810, lots: 0, nowMs: now }).detail, "bad_lots");
  assert.equal(resolveIndiaContract({ rows: [], underlying: "NIFTY", productType: "OPTION", optionType: "CALL", moneyness: "ATM", expiryIntent: "CURRENT_WEEK", spot: 24810, lots: 1, nowMs: now }).error, RESOLUTION_FAILED);
});

test("FAIL CLOSED: exact strike present in ladder but not in rows (gap) → not fabricated", () => {
  const gapRows = rows.filter((r) => !(r.productType === "OPTION" && r.strike === 24800 && r.optionType === "CALL" && r.expiryMs === wk1));
  const r = resolveIndiaContract({ rows: gapRows, underlying: "NIFTY", productType: "OPTION", optionType: "CALL", moneyness: "ATM", expiryIntent: "CURRENT_WEEK", spot: 24810, lots: 1, nowMs: now });
  assert.equal(r.detail, "exact_contract_not_in_master");
});
