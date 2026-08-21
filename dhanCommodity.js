"use strict";
/**
 * dhanCommodity.js — resolve an MCX commodity FUTURE/OPTION contract from Dhan's public scrip master.
 *
 * WHY DHAN (not FYERS): the user's commodity broker is Dhan. Dhan publishes a scrip master with NAMED columns
 * (SEM_*), which the codebase already reads for cash equities. This module normalises the MCX derivative rows from
 * that same master into the shared row shape and resolves the exact contract via the PURE, tested buildChain core
 * from fyersOptionChain (the grouping/ladder math is broker-agnostic).
 *
 * SAFETY (mirrors the FYERS resolver): header-based parsing FAILS CLOSED if any required Dhan column is missing
 * (so a renamed/moved column can't be silently mis-read); strike/expiry/lot and the executable id all come from the
 * master, never guessed; and real-money resolution stays gated on headerLooksValid AND MATRIX_DHAN_MCX_VALIDATED
 * until the live detailed master is confirmed for this build. Preview/virtual returns the resolved contract.
 *
 * Dhan detailed scrip master columns used (documented, stable):
 *   SEM_EXM_EXCH_ID (MCX), SEM_INSTRUMENT_NAME (FUTCOM/OPTFUT), SEM_TRADING_SYMBOL, SEM_CUSTOM_SYMBOL,
 *   SEM_SMST_SECURITY_ID, SEM_EXPIRY_DATE (YYYY-MM-DD), SEM_STRIKE_PRICE, SEM_OPTION_TYPE (CE/PE), SEM_LOT_UNITS,
 *   SEM_TICK_SIZE.
 */

const { buildChain } = require("./fyersOptionChain");

const RESOLUTION_FAILED = "DERIVATIVE_CONTRACT_RESOLUTION_FAILED";
const MONEYNESS = new Set(["ATM", "ITM1", "ITM2", "ITM3", "ITM4", "OTM1", "OTM2", "OTM3", "OTM4"]);

// MCX commodity trading-symbol base → canonical Matrix underlying. Extend as the universe grows.
const BASE_TO_UNDERLYING = {
  GOLD: "GOLD", GOLDM: "GOLDMINI", GOLDMINI: "GOLDMINI", GOLDGUINEA: "GOLDGUINEA", GOLDPETAL: "GOLDPETAL",
  SILVER: "SILVER", SILVERM: "SILVERMINI", SILVERMINI: "SILVERMINI",
  CRUDEOIL: "CRUDEOIL", CRUDEOILM: "CRUDEOILMINI", NATURALGAS: "NATURALGAS", NATGASMINI: "NATURALGASMINI",
  COPPER: "COPPER", ZINC: "ZINC", ALUMINIUM: "ALUMINIUM", LEAD: "LEAD", NICKEL: "NICKEL",
};

function toMs(dateStr) {
  const t = Date.parse(String(dateStr || "").trim());
  return Number.isFinite(t) ? t : null;
}
// Underlying base is the leading alpha run of the trading symbol (GOLD25AUG..., SILVERM25SEP...).
function baseOf(tradingSymbol) {
  const m = String(tradingSymbol || "").toUpperCase().match(/^[A-Z]+/);
  if (!m) return null;
  return BASE_TO_UNDERLYING[m[0]] || m[0];
}

/**
 * Normalise Dhan's scrip master (CSV) into resolver rows for MCX FUTCOM/OPTFUT. Header-based + defensive:
 * requires all needed columns (else headerLooksValid=false → caller fails closed), cross-checks the option type,
 * and requires positive lot + numeric strike (options) + parseable expiry. Any bad row is skipped.
 */
function parseDhanMcxMaster(csvText) {
  const lines = String(csvText || "").split(/\r?\n/);
  if (!lines.length) return { rows: [], headerLooksValid: false, skipped: 0 };
  const H = lines[0].split(",").map((s) => s.trim());
  const col = {
    exch: H.indexOf("SEM_EXM_EXCH_ID"), inst: H.indexOf("SEM_INSTRUMENT_NAME"),
    tsym: H.indexOf("SEM_TRADING_SYMBOL"), csym: H.indexOf("SEM_CUSTOM_SYMBOL"),
    id: H.indexOf("SEM_SMST_SECURITY_ID"), exp: H.indexOf("SEM_EXPIRY_DATE"),
    strike: H.indexOf("SEM_STRIKE_PRICE"), ot: H.indexOf("SEM_OPTION_TYPE"),
    lot: H.indexOf("SEM_LOT_UNITS"), tick: H.indexOf("SEM_TICK_SIZE"),
  };
  const required = ["exch", "inst", "tsym", "id", "exp", "strike", "ot", "lot"];
  if (required.some((k) => col[k] < 0)) return { rows: [], headerLooksValid: false, skipped: 0 };

  const rows = []; let skipped = 0;
  for (let k = 1; k < lines.length; k++) {
    const c = lines[k].split(",");
    if (!c.length || (c[col.exch] || "").trim().toUpperCase() !== "MCX") continue;
    const inst = (c[col.inst] || "").trim().toUpperCase();
    const isOption = inst === "OPTFUT" || inst === "OPTCOM";
    const isFuture = inst === "FUTCOM";
    if (!isOption && !isFuture) continue;
    const ticker = (c[col.csym] != null && (c[col.csym] || "").trim()) || (c[col.tsym] || "").trim();
    const underlying = baseOf(c[col.tsym]);
    const expiryMs = toMs(c[col.exp]);
    const lotSize = Number((c[col.lot] || "").trim());
    if (!ticker || !underlying || !(expiryMs > 0) || !(lotSize > 0)) { skipped++; continue; }
    if (isOption) {
      const strike = Number((c[col.strike] || "").trim());
      const otCol = (c[col.ot] || "").trim().toUpperCase();
      if (!(strike > 0) || (otCol !== "CE" && otCol !== "PE")) { skipped++; continue; }
      rows.push({ ticker, underlying, productType: "OPTION", optionType: otCol === "CE" ? "CALL" : "PUT", strike, expiryMs, lotSize, tickSize: col.tick >= 0 ? Number(c[col.tick]) || null : null, instrumentId: (c[col.id] || "").trim() });
    } else {
      rows.push({ ticker, underlying, productType: "FUTURE", optionType: null, strike: null, expiryMs, lotSize, tickSize: col.tick >= 0 ? Number(c[col.tick]) || null : null, instrumentId: (c[col.id] || "").trim() });
    }
  }
  return { rows, headerLooksValid: rows.length > 20, skipped };
}

function pickExpiry(expiries, intent) {
  if (!expiries.length) return { error: RESOLUTION_FAILED, detail: "no_listed_expiries" };
  const monthlies = expiries.filter((e) => !e.weekly);   // MCX contracts are monthly
  if (intent === "CURRENT_MONTH") return { expiry: monthlies[0] || expiries[0] };
  if (intent === "NEXT_MONTH") return monthlies[1] ? { expiry: monthlies[1] } : { error: RESOLUTION_FAILED, detail: "no_next_month" };
  return { error: RESOLUTION_FAILED, detail: "intent_not_supported_Commodity" };
}
function pickStrike(strikes, spot, optionType, moneyness) {
  if (!MONEYNESS.has(moneyness)) return { error: RESOLUTION_FAILED, detail: "bad_moneyness" };
  if (!strikes.length) return { error: RESOLUTION_FAILED, detail: "empty_strike_ladder" };
  let atm = -1, bestD = Infinity;
  strikes.forEach((s, i) => { const d = Math.abs(s - spot); if (d < bestD) { bestD = d; atm = i; } });
  if (atm < 0) return { error: RESOLUTION_FAILED, detail: "no_atm" };
  if (moneyness === "ATM") return { strike: strikes[atm] };
  const depth = Number(moneyness.slice(3));
  const dir = moneyness.startsWith("ITM") ? (optionType === "CALL" ? -1 : +1) : (optionType === "CALL" ? +1 : -1);
  const idx = atm + dir * depth;
  if (idx < 0 || idx >= strikes.length) return { error: RESOLUTION_FAILED, detail: "strike_rung_not_listed" };
  return { strike: strikes[idx] };
}

/** Resolve an MCX commodity option/future to the exact Dhan master row. */
function resolveCommodityContract(p = {}) {
  const { rows, underlying, productType, optionType, moneyness, expiryIntent, side, spot, lots, nowMs = Date.now() } = p;
  if (productType !== "OPTION" && productType !== "FUTURE") return { error: RESOLUTION_FAILED, detail: "bad_product" };
  if (!(Number(lots) > 0) || Number(lots) !== Math.floor(Number(lots))) return { error: RESOLUTION_FAILED, detail: "bad_lots" };
  if (productType === "OPTION" && optionType !== "CALL" && optionType !== "PUT") return { error: RESOLUTION_FAILED, detail: "option_missing_call_put" };
  if (productType === "FUTURE" && side !== "BUY" && side !== "SELL") return { error: RESOLUTION_FAILED, detail: "future_missing_side" };

  const chain = buildChain(rows, { underlying: String(underlying).toUpperCase(), productType, nowMs });
  if (!(Number(chain.lotSize) > 0)) return { error: RESOLUTION_FAILED, detail: "no_lot_size_in_master" };
  const ex = pickExpiry(chain.expiries, expiryIntent);
  if (ex.error) return ex;

  let row, strike = null;
  if (productType === "OPTION") {
    const strikes = chain.strikesByExpiry.get(ex.expiry.date) || [];
    const st = pickStrike(strikes, Number(spot), optionType, moneyness);
    if (st.error) return st;
    strike = st.strike;
    row = chain.rowsByKey.get(`${ex.expiry.date}|${strike}|${optionType}`);
  } else {
    row = chain.rowsByKey.get(`${ex.expiry.date}|FUT`);
  }
  if (!row || !row.ticker) return { error: RESOLUTION_FAILED, detail: "exact_contract_not_in_master" };

  return {
    market: "Commodity", exchange: "MCX", underlying: String(underlying).toUpperCase(), productType,
    side: side || null, optionType: optionType || null, moneyness: productType === "OPTION" ? moneyness : null,
    strike, expiry: ex.expiry.date, expiryIntent,
    lots: Number(lots), lotSize: Number(chain.lotSize), contractMultiplier: 1, quantity: Number(lots) * Number(chain.lotSize),
    tickSize: row.tickSize ?? null, tradingSymbol: row.ticker, instrumentId: row.instrumentId ?? null,
    metadataSource: "dhan_scrip_master",
  };
}

module.exports = { parseDhanMcxMaster, resolveCommodityContract, BASE_TO_UNDERLYING, RESOLUTION_FAILED };
