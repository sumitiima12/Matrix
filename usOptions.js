"use strict";
/**
 * usOptions.js — resolve a US equity / index OPTION to its exact OCC-symbology tradable symbol.
 *
 * OCC compressed symbol (matches the user's screenshots exactly):
 *   {ROOT}{YYMMDD}{C|P}{strike×1000 zero-padded to 8}
 *   TSLA 2026-08-21 CALL 10.00 -> TSLA260821C00010000
 *   SPX  2026-08-21 CALL 800.00 -> SPX260821C00800000
 * This construction is DETERMINISTIC — no instrument master is needed for the symbol itself. A US equity/index
 * option's multiplier is 100 (1 contract = 100 shares/index units).
 *
 * Two resolution modes:
 *   (1) EXPLICIT — caller gives the exact strike + expiry (YYYY-MM-DD). Fully deterministic, always resolvable.
 *   (2) MONEYNESS — caller gives ATM/ITM1-4/OTM1-4 + an expiry intent + a strike ladder + expiries (from an option
 *       chain). We pick the rung/expiry and FAIL CLOSED if the requested rung/expiry isn't listed (never invents a
 *       strike that isn't tradable). Reuses the pure, tested buildChain grouping from fyersOptionChain.
 *
 * Real execution stays gated by the caller (needs a validated live US chain) — this module only computes the symbol
 * and contract math; it never places an order.
 */

const { buildChain } = require("./fyersOptionChain");

const RESOLUTION_FAILED = "DERIVATIVE_CONTRACT_RESOLUTION_FAILED";
const MONEYNESS = new Set(["ATM", "ITM1", "ITM2", "ITM3", "ITM4", "OTM1", "OTM2", "OTM3", "OTM4"]);
const US_MULTIPLIER = 100;

/** Build the OCC compressed symbol. strike in dollars (e.g. 800 or 10.5), expiry "YYYY-MM-DD". */
function occSymbol(root, expiryISO, optionType, strike) {
  const r = String(root || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const ymd = String(expiryISO || "").replace(/-/g, "");   // YYYYMMDD
  if (!r || ymd.length !== 8) return null;
  const yy = ymd.slice(2);                                 // YYMMDD
  const cp = optionType === "CALL" ? "C" : optionType === "PUT" ? "P" : null;
  if (!cp) return null;
  const milli = Math.round(Number(strike) * 1000);
  if (!(milli > 0)) return null;
  return `${r}${yy}${cp}${String(milli).padStart(8, "0")}`;
}

function toMs(dateStr) { const t = Date.parse(String(dateStr || "").trim()); return Number.isFinite(t) ? t : null; }

/* Normalise a US option chain (array of rows) into resolver rows. Header-agnostic: caller maps its source to
   { underlying, optionType:'CALL'|'PUT', strike, expiry:'YYYY-MM-DD' }. Fails closed (empty) on malformed rows. */
function normaliseUsChain(rows) {
  const out = [];
  for (const x of rows || []) {
    const und = String((x && x.underlying) || "").toUpperCase();
    const ot = String((x && x.optionType) || "").toUpperCase();
    const strike = Number(x && x.strike);
    const expMs = toMs(x && x.expiry);
    if (!und || (ot !== "CALL" && ot !== "PUT") || !(strike > 0) || !(expMs > 0)) continue;
    out.push({ ticker: occSymbol(und, x.expiry, ot, strike), underlying: und, productType: "OPTION", optionType: ot, strike, expiryMs: expMs, lotSize: 1, tickSize: null, instrumentId: null });
  }
  return { rows: out, headerLooksValid: out.length > 0 };
}

function pickExpiry(expiries, intent) {
  if (!expiries.length) return { error: RESOLUTION_FAILED, detail: "no_listed_expiries" };
  const weeklies = expiries;   // US lists many expiries; treat the sorted list generically
  if (intent === "TODAY") { const t = weeklies.find((e) => e.daysOut === 0) || weeklies[0]; return { expiry: t }; }
  if (intent === "TOMORROW") { const t = weeklies.find((e) => e.daysOut >= 1) || weeklies[0]; return { expiry: t }; }
  if (intent === "CURRENT_WEEK") return { expiry: weeklies[0] };
  if (intent === "CURRENT_MONTH") { const m = expiries.filter((e) => !e.weekly); return { expiry: m[0] || weeklies[0] }; }
  return { error: RESOLUTION_FAILED, detail: "intent_not_supported_US" };
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

/** Resolve a US option. See module header for the two modes. `lots` = number of contracts. */
function resolveUsOption(p = {}) {
  const { underlying, optionType, lots, nowMs = Date.now() } = p;
  const und = String(underlying || "").toUpperCase();
  if (!und) return { error: RESOLUTION_FAILED, detail: "missing_underlying" };
  if (optionType !== "CALL" && optionType !== "PUT") return { error: RESOLUTION_FAILED, detail: "option_missing_call_put" };
  if (!(Number(lots) > 0) || Number(lots) !== Math.floor(Number(lots))) return { error: RESOLUTION_FAILED, detail: "bad_lots" };

  // MODE 1 — explicit strike + expiry: deterministic, no chain required.
  if (p.explicitStrike != null && p.explicitExpiry) {
    const strike = Number(p.explicitStrike);
    if (!(strike > 0)) return { error: RESOLUTION_FAILED, detail: "bad_strike" };
    const sym = occSymbol(und, p.explicitExpiry, optionType, strike);
    if (!sym) return { error: RESOLUTION_FAILED, detail: "occ_symbol_build_failed" };
    return _out(und, optionType, strike, p.explicitExpiry, null, lots, sym);
  }

  // MODE 2 — moneyness against a provided chain ladder.
  const { rows, headerLooksValid } = normaliseUsChain(p.rows || []);
  if (!headerLooksValid) return { error: RESOLUTION_FAILED, detail: "chain_unavailable" };
  const chain = buildChain(rows, { underlying: und, productType: "OPTION", nowMs });
  const ex = pickExpiry(chain.expiries, p.expiryIntent);
  if (ex.error) return ex;
  const strikes = chain.strikesByExpiry.get(ex.expiry.date) || [];
  const st = pickStrike(strikes, Number(p.spot), optionType, p.moneyness);
  if (st.error) return st;
  const row = chain.rowsByKey.get(`${ex.expiry.date}|${st.strike}|${optionType}`);
  const sym = (row && row.ticker) || occSymbol(und, ex.expiry.date, optionType, st.strike);
  if (!sym) return { error: RESOLUTION_FAILED, detail: "occ_symbol_build_failed" };
  return _out(und, optionType, st.strike, ex.expiry.date, p.moneyness, lots, sym);
}
function _out(underlying, optionType, strike, expiry, moneyness, lots, tradingSymbol) {
  return {
    market: "US", exchange: "OCC", underlying, productType: "OPTION", optionType,
    moneyness: moneyness || null, strike, expiry, lots: Number(lots),
    lotSize: 1, contractMultiplier: US_MULTIPLIER, quantity: Number(lots),   // quantity = contracts; ×100 for notional
    tradingSymbol, metadataSource: "occ_symbology",
  };
}

module.exports = { occSymbol, normaliseUsChain, resolveUsOption, RESOLUTION_FAILED, US_MULTIPLIER };
