"use strict";
/**
 * cryptoOptions.js — resolve a Delta Exchange crypto OPTION (BTC / ETH only, per the product ask) to its exact
 * tradable Delta symbol.
 *
 * Delta option symbology:  {C|P}-{ASSET}-{strike}-{DDMMYY}
 *   Call BTC 100000 exp 2025-12-26 -> C-BTC-100000-261225
 *   Put  ETH 3000   exp 2025-12-26 -> P-ETH-3000-261225
 *
 * Only BTC and ETH are supported (fail-closed for any other underlying). Two modes like the US resolver:
 *   (1) EXPLICIT strike + expiry -> deterministic symbol, no chain needed.
 *   (2) MONEYNESS against a provided Delta option-chain ladder -> pick rung/expiry, FAIL CLOSED if not listed.
 * Contract size (coin units per contract) comes from the caller/contractSpecs; real execution stays caller-gated.
 */

const { buildChain } = require("./fyersOptionChain");

const RESOLUTION_FAILED = "DERIVATIVE_CONTRACT_RESOLUTION_FAILED";
const MONEYNESS = new Set(["ATM", "ITM1", "ITM2", "ITM3", "ITM4", "OTM1", "OTM2", "OTM3", "OTM4"]);
const SUPPORTED = new Set(["BTC", "ETH"]);
// Delta option contract size (coin units per contract), same basis as the perps we verified. Fail-closed otherwise.
const CONTRACT_SIZE = { BTC: 0.001, ETH: 0.01 };

function ddmmyy(expiryISO) {
  const m = String(expiryISO || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return `${m[3]}${m[2]}${m[1].slice(2)}`;   // DDMMYY
}
function deltaOptionSymbol(underlying, expiryISO, optionType, strike) {
  const asset = String(underlying || "").toUpperCase();
  if (!SUPPORTED.has(asset)) return null;
  const cp = optionType === "CALL" ? "C" : optionType === "PUT" ? "P" : null;
  const dmy = ddmmyy(expiryISO);
  const k = Number(strike);
  if (!cp || !dmy || !(k > 0)) return null;
  // Strikes on Delta are whole numbers for BTC/ETH; keep integer form when whole, else keep as-is.
  const kStr = Number.isInteger(k) ? String(k) : String(k);
  return `${cp}-${asset}-${kStr}-${dmy}`;
}
function toMs(s) { const t = Date.parse(String(s || "").trim()); return Number.isFinite(t) ? t : null; }

function normaliseChain(rows) {
  const out = [];
  for (const x of rows || []) {
    const und = String((x && x.underlying) || "").toUpperCase();
    const ot = String((x && x.optionType) || "").toUpperCase();
    const strike = Number(x && x.strike);
    const expMs = toMs(x && x.expiry);
    if (!SUPPORTED.has(und) || (ot !== "CALL" && ot !== "PUT") || !(strike > 0) || !(expMs > 0)) continue;
    out.push({ ticker: deltaOptionSymbol(und, x.expiry, ot, strike), underlying: und, productType: "OPTION", optionType: ot, strike, expiryMs: expMs, lotSize: 1, tickSize: null, instrumentId: (x && x.product_id) != null ? String(x.product_id) : null });
  }
  return { rows: out, headerLooksValid: out.length > 0 };
}
function pickExpiry(expiries, intent) {
  if (!expiries.length) return { error: RESOLUTION_FAILED, detail: "no_listed_expiries" };
  if (intent === "TODAY") return { expiry: expiries.find((e) => e.daysOut === 0) || expiries[0] };
  if (intent === "TOMORROW") return { expiry: expiries.find((e) => e.daysOut >= 1) || expiries[0] };
  if (intent === "PLUS_30D") return { expiry: expiries.find((e) => e.daysOut >= 25) || expiries[expiries.length - 1] };
  if (intent === "PLUS_90D") return { expiry: expiries.find((e) => e.daysOut >= 80) || expiries[expiries.length - 1] };
  return { error: RESOLUTION_FAILED, detail: "intent_not_supported_Crypto" };
}
function pickStrike(strikes, spot, optionType, moneyness) {
  if (!MONEYNESS.has(moneyness)) return { error: RESOLUTION_FAILED, detail: "bad_moneyness" };
  if (!strikes.length) return { error: RESOLUTION_FAILED, detail: "empty_strike_ladder" };
  let atm = -1, best = Infinity;
  strikes.forEach((s, i) => { const d = Math.abs(s - spot); if (d < best) { best = d; atm = i; } });
  if (atm < 0) return { error: RESOLUTION_FAILED, detail: "no_atm" };
  if (moneyness === "ATM") return { strike: strikes[atm] };
  const depth = Number(moneyness.slice(3));
  const dir = moneyness.startsWith("ITM") ? (optionType === "CALL" ? -1 : +1) : (optionType === "CALL" ? +1 : -1);
  const idx = atm + dir * depth;
  if (idx < 0 || idx >= strikes.length) return { error: RESOLUTION_FAILED, detail: "strike_rung_not_listed" };
  return { strike: strikes[idx] };
}

function resolveCryptoOption(p = {}) {
  const und = String(p.underlying || "").toUpperCase();
  const { optionType, lots, nowMs = Date.now() } = p;
  if (!SUPPORTED.has(und)) return { error: RESOLUTION_FAILED, detail: "underlying_not_supported_only_BTC_ETH" };
  if (optionType !== "CALL" && optionType !== "PUT") return { error: RESOLUTION_FAILED, detail: "option_missing_call_put" };
  if (!(Number(lots) > 0) || Number(lots) !== Math.floor(Number(lots))) return { error: RESOLUTION_FAILED, detail: "bad_lots" };
  const cs = CONTRACT_SIZE[und];

  if (p.explicitStrike != null && p.explicitExpiry) {
    const strike = Number(p.explicitStrike);
    if (!(strike > 0)) return { error: RESOLUTION_FAILED, detail: "bad_strike" };
    const sym = deltaOptionSymbol(und, p.explicitExpiry, optionType, strike);
    if (!sym) return { error: RESOLUTION_FAILED, detail: "delta_symbol_build_failed" };
    return _out(und, optionType, strike, p.explicitExpiry, null, lots, sym, cs);
  }
  const { rows, headerLooksValid } = normaliseChain(p.rows || []);
  if (!headerLooksValid) return { error: RESOLUTION_FAILED, detail: "chain_unavailable" };
  const chain = buildChain(rows, { underlying: und, productType: "OPTION", nowMs });
  const ex = pickExpiry(chain.expiries, p.expiryIntent);
  if (ex.error) return ex;
  const strikes = chain.strikesByExpiry.get(ex.expiry.date) || [];
  const st = pickStrike(strikes, Number(p.spot), optionType, p.moneyness);
  if (st.error) return st;
  const row = chain.rowsByKey.get(`${ex.expiry.date}|${st.strike}|${optionType}`);
  const sym = (row && row.ticker) || deltaOptionSymbol(und, ex.expiry.date, optionType, st.strike);
  if (!sym) return { error: RESOLUTION_FAILED, detail: "delta_symbol_build_failed" };
  return _out(und, optionType, st.strike, ex.expiry.date, p.moneyness, lots, sym, cs);
}
function _out(underlying, optionType, strike, expiry, moneyness, lots, tradingSymbol, contractSize) {
  return {
    market: "Crypto", exchange: "Delta", underlying, productType: "OPTION", optionType,
    moneyness: moneyness || null, strike, expiry, lots: Number(lots),
    lotSize: 1, contractMultiplier: contractSize, quantity: Number(lots),   // quantity = contracts; coins = ×contractSize
    tradingSymbol, metadataSource: "delta_option_symbology",
  };
}

module.exports = { deltaOptionSymbol, normaliseChain, resolveCryptoOption, SUPPORTED, CONTRACT_SIZE, RESOLUTION_FAILED };
