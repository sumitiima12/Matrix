const { test } = require("node:test");
const assert = require("node:assert");
const { parseDhanMcxMaster, resolveCommodityContract, RESOLUTION_FAILED } = require("../dhanCommodity");

const day = 864e5, now = Date.parse("2026-08-19T04:00:00Z");
const aug = "2026-08-31", sep = "2026-09-30";
const HDR = "SEM_EXM_EXCH_ID,SEM_INSTRUMENT_NAME,SEM_TRADING_SYMBOL,SEM_CUSTOM_SYMBOL,SEM_SMST_SECURITY_ID,SEM_EXPIRY_DATE,SEM_STRIKE_PRICE,SEM_OPTION_TYPE,SEM_LOT_UNITS,SEM_TICK_SIZE";
function opt(strike, ot, exp = aug, id = "1", lot = 100) {
  return `MCX,OPTFUT,GOLD25AUG${strike}${ot},GOLD 31 AUG ${strike} ${ot === "CE" ? "CALL" : "PUT"},${id},${exp},${strike},${ot},${lot},1`;
}
function fut(exp = aug, id = "9", lot = 100) { return `MCX,FUTCOM,GOLD25AUGFUT,GOLD 31 AUG FUT,${id},${exp},0,,${lot},1`; }
// build a chain: strikes 160000..175000 (5000 steps) CE/PE for AUG + a FUT
const strikes = [160000, 165000, 170000, 175000];
const lines = [HDR];
for (const k of strikes) { lines.push(opt(k, "CE")); lines.push(opt(k, "PE")); }
lines.push(fut());
// a NSE row (must be ignored) + a Sep monthly future
lines.push("NSE,OPTIDX,NIFTY25AUG24800CE,NIFTY,5,2026-08-28,24800,CE,75,0.05");
lines.push(fut(sep, "10"));
const csv = lines.join("\n");

test("parseDhanMcxMaster: header-based, MCX only, CE/PE + FUT normalised", () => {
  const { rows } = parseDhanMcxMaster(csv);
  assert.ok(rows.every((r) => r.underlying === "GOLD"));            // NSE NIFTY row excluded
  assert.equal(rows.filter((r) => r.productType === "OPTION").length, 8);
  assert.equal(rows.filter((r) => r.productType === "FUTURE").length, 2);
  const ce = rows.find((r) => r.optionType === "CALL" && r.strike === 165000);
  assert.equal(ce.lotSize, 100);
  assert.equal(ce.ticker, "GOLD 31 AUG 165000 CALL");
});

test("missing required column → headerLooksValid false (fail closed)", () => {
  const bad = csv.replace("SEM_STRIKE_PRICE", "SEM_WRONG");
  assert.equal(parseDhanMcxMaster(bad).headerLooksValid, false);
});

test("Gold CALL ATM current month → exact Dhan ticker + qty", () => {
  const { rows } = parseDhanMcxMaster(csv);
  const r = resolveCommodityContract({ rows, underlying: "GOLD", productType: "OPTION", optionType: "CALL", moneyness: "ATM", expiryIntent: "CURRENT_MONTH", spot: 166000, lots: 1, nowMs: now });
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.equal(r.strike, 165000);          // nearest to 166000
  assert.equal(r.exchange, "MCX");
  assert.equal(r.market, "Commodity");
  assert.equal(r.quantity, 100);
  assert.equal(r.tradingSymbol, "GOLD 31 AUG 165000 CALL");
});

test("moneyness: CALL OTM1 above, PUT OTM1 below", () => {
  const { rows } = parseDhanMcxMaster(csv);
  const c = resolveCommodityContract({ rows, underlying: "GOLD", productType: "OPTION", optionType: "CALL", moneyness: "OTM1", expiryIntent: "CURRENT_MONTH", spot: 166000, lots: 1, nowMs: now });
  assert.equal(c.strike, 170000);
  const p = resolveCommodityContract({ rows, underlying: "GOLD", productType: "OPTION", optionType: "PUT", moneyness: "OTM1", expiryIntent: "CURRENT_MONTH", spot: 166000, lots: 1, nowMs: now });
  assert.equal(p.strike, 160000);
});

test("FUTURE SELL current month + NEXT_MONTH resolve to distinct expiries", () => {
  const { rows } = parseDhanMcxMaster(csv);
  const cur = resolveCommodityContract({ rows, underlying: "GOLD", productType: "FUTURE", side: "SELL", expiryIntent: "CURRENT_MONTH", lots: 2, nowMs: now });
  assert.equal(cur.side, "SELL");
  assert.equal(cur.quantity, 200);
  const nxt = resolveCommodityContract({ rows, underlying: "GOLD", productType: "FUTURE", side: "BUY", expiryIntent: "NEXT_MONTH", lots: 1, nowMs: now });
  assert.notEqual(cur.expiry, nxt.expiry);
});

test("FAIL CLOSED: rung not listed, missing side, exact contract absent", () => {
  const { rows } = parseDhanMcxMaster(csv);
  assert.equal(resolveCommodityContract({ rows, underlying: "GOLD", productType: "OPTION", optionType: "CALL", moneyness: "OTM4", expiryIntent: "CURRENT_MONTH", spot: 166000, lots: 1, nowMs: now }).detail, "strike_rung_not_listed");
  assert.equal(resolveCommodityContract({ rows, underlying: "GOLD", productType: "FUTURE", expiryIntent: "CURRENT_MONTH", lots: 1, nowMs: now }).detail, "future_missing_side");
});
