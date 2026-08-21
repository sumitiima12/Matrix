"use strict";
/**
 * fyersOptionChain.js — resolve an Indian (NSE/NFO) OPTION or FUTURE contract from the FYERS symbol master.
 *
 * SAME ARCHITECTURE AS mcxContract.js: this module is PURE and dependency-free. It takes ALREADY-NORMALISED
 * instrument rows (server.js reads + caches the live FYERS symbol master and maps its columns to the row shape
 * below) plus a spot and a clock, and returns the exact executable contract. All network/caching lives in server.js
 * so this is unit-testable without a live FYERS feed.
 *
 * Row shape (normalised by the caller from the FYERS NSE_FO master):
 *   { ticker, underlying, productType:"OPTION"|"FUTURE", optionType:"CALL"|"PUT"|null,
 *     strike:Number|null, expiryMs:Number, lotSize:Number, tickSize?:Number, instrumentId?:String }
 *
 * SAFETY (Parts 13/16/28/42): lot size, strike ladder, listed expiries and the executable `ticker` ALL come from the
 * master — nothing is guessed or string-built. If the requested strike/expiry/lot is not present, we FAIL CLOSED with
 * a structured error. Indian lot sizes change; we never fall back to a hard-coded table for real execution.
 */

const RESOLUTION_FAILED = "DERIVATIVE_CONTRACT_RESOLUTION_FAILED";
const MONEYNESS = new Set(["ATM", "ITM1", "ITM2", "ITM3", "ITM4", "OTM1", "OTM2", "OTM3", "OTM4"]);

function startOfDay(ts) { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); }
function ymd(ts) { const d = new Date(ts); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); }
/** Weekly = not the last expiry of its calendar month among the listed expiries for the underlying. */
function markWeekly(expiryMsList) {
  const byMonth = new Map();
  for (const ms of expiryMsList) { const k = new Date(ms).getFullYear() * 100 + new Date(ms).getMonth(); byMonth.set(k, Math.max(byMonth.get(k) || 0, ms)); }
  return new Map(expiryMsList.map((ms) => { const k = new Date(ms).getFullYear() * 100 + new Date(ms).getMonth(); return [ms, ms < byMonth.get(k)]; }));
}

/**
 * Build the option/future chain for one underlying from master rows.
 * @returns { lotSize, expiries:[{date,weekly}], strikesByExpiry:Map<expiryMs, number[] asc>, rowsByKey:Map }
 */
function buildChain(rows, { underlying, productType, nowMs = Date.now() } = {}) {
  const u = String(underlying || "").toUpperCase();
  const nowDay = startOfDay(nowMs);
  const mine = (rows || []).filter((r) => r && String(r.underlying || "").toUpperCase() === u && r.productType === productType
    && Number(r.expiryMs) && startOfDay(r.expiryMs) >= nowDay && Number(r.lotSize) > 0);
  if (!mine.length) return { lotSize: null, expiries: [], strikesByExpiry: new Map(), rowsByKey: new Map() };

  const lotSizes = new Set(mine.map((r) => Number(r.lotSize)));
  const expirySet = [...new Set(mine.map((r) => Number(r.expiryMs)))].sort((a, b) => a - b);
  const weeklyMap = markWeekly(expirySet);
  const strikesByExpiry = new Map();
  const rowsByKey = new Map();
  for (const r of mine) {
    if (productType === "OPTION") {
      if (!strikesByExpiry.has(r.expiryMs)) strikesByExpiry.set(r.expiryMs, new Set());
      strikesByExpiry.get(r.expiryMs).add(Number(r.strike));
      rowsByKey.set(`${r.expiryMs}|${Number(r.strike)}|${r.optionType}`, r);
    } else {
      rowsByKey.set(`${r.expiryMs}|FUT`, r);
    }
  }
  for (const [k, set] of strikesByExpiry) strikesByExpiry.set(k, [...set].sort((a, b) => a - b));
  return {
    lotSize: lotSizes.size === 1 ? [...lotSizes][0] : Math.max(...lotSizes),   // per-underlying lot from master
    expiries: expirySet.map((ms) => ({ date: ms, weekly: !!weeklyMap.get(ms) })),
    strikesByExpiry, rowsByKey,
  };
}

function pickExpiry(expiries, intent, nowMs) {
  if (!expiries.length) return { error: RESOLUTION_FAILED, detail: "no_listed_expiries" };
  if (intent === "CURRENT_WEEK") { const w = expiries.find((e) => e.weekly); return { expiry: w || expiries[0] }; }
  if (intent === "CURRENT_MONTH") { const m = expiries.find((e) => !e.weekly) || expiries[expiries.length - 1]; return { expiry: m }; }
  if (intent === "NEXT_MONTH") { const monthlies = expiries.filter((e) => !e.weekly); return monthlies[1] ? { expiry: monthlies[1] } : { error: RESOLUTION_FAILED, detail: "no_next_month" }; }
  return { error: RESOLUTION_FAILED, detail: "intent_not_supported_IN" };
}

function pickStrike(strikes, spot, optionType, moneyness) {
  if (!MONEYNESS.has(moneyness)) return { error: RESOLUTION_FAILED, detail: "bad_moneyness" };
  if (!strikes || !strikes.length) return { error: RESOLUTION_FAILED, detail: "empty_strike_ladder" };
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

/**
 * Resolve an Indian option/future to the exact master row.
 * @param p { rows, underlying, productType, optionType, moneyness, expiryIntent, side, spot, lots, nowMs }
 * @returns canonical contract or { error }.
 */
function resolveIndiaContract(p = {}) {
  const { rows, underlying, productType, optionType, moneyness, expiryIntent, side, spot, lots, nowMs = Date.now() } = p;
  if (productType !== "OPTION" && productType !== "FUTURE") return { error: RESOLUTION_FAILED, detail: "bad_product" };
  if (!(Number(lots) > 0) || Number(lots) !== Math.floor(Number(lots))) return { error: RESOLUTION_FAILED, detail: "bad_lots" };
  if (productType === "OPTION" && optionType !== "CALL" && optionType !== "PUT") return { error: RESOLUTION_FAILED, detail: "option_missing_call_put" };
  if (productType === "FUTURE" && side !== "BUY" && side !== "SELL") return { error: RESOLUTION_FAILED, detail: "future_missing_side" };

  const chain = buildChain(rows, { underlying, productType, nowMs });
  if (!(Number(chain.lotSize) > 0)) return { error: RESOLUTION_FAILED, detail: "no_lot_size_in_master" };

  const ex = pickExpiry(chain.expiries, expiryIntent, nowMs);
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

  const quantity = Number(lots) * Number(chain.lotSize);
  return {
    market: "IN", underlying: String(underlying).toUpperCase(), productType,
    side: side || null, optionType: optionType || null, moneyness: productType === "OPTION" ? moneyness : null,
    strike, expiry: ex.expiry.date, expiryIntent, expiryWeekly: ex.expiry.weekly,
    lots: Number(lots), lotSize: Number(chain.lotSize), contractMultiplier: 1, quantity,
    tickSize: row.tickSize ?? null, exchange: "NFO",
    tradingSymbol: row.ticker, instrumentId: row.instrumentId ?? null,
    metadataSource: "fyers_symbol_master",
  };
}

module.exports = { buildChain, resolveIndiaContract, RESOLUTION_FAILED };
