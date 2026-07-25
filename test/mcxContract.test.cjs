const test = require("node:test");
const assert = require("node:assert/strict");
const mcx = require("../mcxContract");

/* A representative slice of the FYERS MCX symbol master. Columns are intentionally in a
   FYERS-like order (fytoken, description, type, lot, tick, isin, session, updated, expiry-epoch,
   ticker, exchange, segment, scrip). The parser must not depend on that exact order. */
const AUG_EXP = Math.floor(Date.UTC(2025, 7, 29, 18, 0, 0) / 1000);   // 29 Aug 2025
const SEP_EXP = Math.floor(Date.UTC(2025, 8, 29, 18, 0, 0) / 1000);
const OCT_EXP = Math.floor(Date.UTC(2025, 9, 30, 18, 0, 0) / 1000);
const MASTER = [
  `101000000, GOLD Aug Fut, 11, 1, 1, , 0900-2330, x, ${AUG_EXP}, MCX:GOLD25AUGFUT, MCX, COM, 5001`,
  `101000001, GOLD Oct Fut, 11, 1, 1, , 0900-2330, x, ${OCT_EXP}, MCX:GOLD25OCTFUT, MCX, COM, 5002`,
  `101000002, GOLDM Aug Fut, 11, 1, 1, , 0900-2330, x, ${AUG_EXP}, MCX:GOLDM25AUGFUT, MCX, COM, 5003`,
  `101000003, SILVER Sep Fut, 11, 1, 1, , 0900-2330, x, ${SEP_EXP}, MCX:SILVER25SEPFUT, MCX, COM, 5004`,
  `101000004, CRUDEOIL Aug Fut, 11, 1, 1, , 0900-2330, x, ${AUG_EXP}, MCX:CRUDEOIL25AUGFUT, MCX, COM, 5005`,
  `101000005, ALUMINIUM Aug Fut, 11, 1, 1, , 0900-2330, x, ${AUG_EXP}, MCX:ALUMINIUM25AUGFUT, MCX, COM, 5006`,
  // Noise that must be ignored: an options row and a blank line.
  `101000006, GOLD CE, 11, 1, 1, , 0900-2330, x, ${AUG_EXP}, MCX:GOLD25AUG71000CE, MCX, OPT, 5007`,
  ``,
].join("\n");

test("parseTicker splits base / month and is non-greedy on the base", () => {
  const g = mcx.parseTicker("MCX:GOLD25AUGFUT");
  assert.equal(g.base, "GOLD");
  assert.equal(g.yy, 2025);
  assert.equal(g.mon, 7);
  const gm = mcx.parseTicker("MCX:GOLDM25AUGFUT");
  assert.equal(gm.base, "GOLDM");   // NOT "GOLD"
});

test("parseTicker rejects non-FUT / malformed tickers", () => {
  assert.equal(mcx.parseTicker("MCX:GOLD25AUG71000CE"), null);
  assert.equal(mcx.parseTicker("NSE:RELIANCE-EQ"), null);
  assert.equal(mcx.parseTicker(""), null);
  assert.equal(mcx.parseTicker(null), null);
});

test("parseSymbolMaster extracts only FUT rows", () => {
  const rows = mcx.parseSymbolMaster(MASTER);
  const tickers = rows.map((r) => r.ticker).sort();
  assert.deepEqual(tickers, [
    "MCX:ALUMINIUM25AUGFUT",
    "MCX:CRUDEOIL25AUGFUT",
    "MCX:GOLD25AUGFUT",
    "MCX:GOLD25OCTFUT",
    "MCX:GOLDM25AUGFUT",
    "MCX:SILVER25SEPFUT",
  ]);
  // options row excluded
  assert.ok(!tickers.some((t) => /CE$/.test(t)));
});

test("parseSymbolMaster prefers the real epoch expiry when present", () => {
  const rows = mcx.parseSymbolMaster(MASTER);
  const goldAug = rows.find((r) => r.ticker === "MCX:GOLD25AUGFUT");
  assert.equal(goldAug.expiryMs, AUG_EXP * 1000);
});

test("nearestFut picks the closest non-expired contract for the base", () => {
  const rows = mcx.parseSymbolMaster(MASTER);
  // On 1 Aug 2025 both GOLD Aug and Oct are live; Aug is nearer.
  const now = Date.UTC(2025, 7, 1);
  const near = mcx.nearestFut(rows, "GOLD", now);
  assert.equal(near.ticker, "MCX:GOLD25AUGFUT");
});

test("nearestFut rolls to the next month after expiry", () => {
  const rows = mcx.parseSymbolMaster(MASTER);
  // On 1 Oct 2025 the Aug contract is long gone -> Oct is the near contract.
  const now = Date.UTC(2025, 9, 1);
  const near = mcx.nearestFut(rows, "GOLD", now);
  assert.equal(near.ticker, "MCX:GOLD25OCTFUT");
});

test("nearestFut returns null for a base with no live contract", () => {
  const rows = mcx.parseSymbolMaster(MASTER);
  assert.equal(mcx.nearestFut(rows, "COPPER", Date.UTC(2025, 7, 1)), null);
  // everything expired
  assert.equal(mcx.nearestFut(rows, "GOLD", Date.UTC(2030, 0, 1)), null);
});

test("resolveFromYahoo maps COMEX tickers to the MCX contract with INR + metadata", () => {
  const rows = mcx.parseSymbolMaster(MASTER);
  const now = Date.UTC(2025, 7, 1);
  const gold = mcx.resolveFromYahoo(rows, "GC=F", now);
  assert.equal(gold.ticker, "MCX:GOLD25AUGFUT");
  assert.equal(gold.currency, "INR");
  assert.equal(gold.exchange, "MCX");
  assert.equal(gold.label, "Gold (MCX)");
  assert.ok(gold.unit.startsWith("₹"));
});

test("resolveFromYahoo returns null for a non-commodity ticker", () => {
  const rows = mcx.parseSymbolMaster(MASTER);
  assert.equal(mcx.resolveFromYahoo(rows, "AAPL", Date.UTC(2025, 7, 1)), null);
});

test("COMEX_TO_MCX covers every supported commodity", () => {
  assert.deepEqual(Object.keys(mcx.COMEX_TO_MCX).sort(), ["ALI=F", "CL=F", "GC=F", "SI=F"]);
});
