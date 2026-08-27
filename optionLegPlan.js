"use strict";
/**
 * optionLegPlan.js — turn a strategy's saved OptionLeg config into EXACT executable Indian option contracts
 * AT THE MOMENT THE ENTRY SIGNAL FIRES.
 *
 * This is the "Trade options instead of the stock" toggle's execution brain. The frontend (OptionLeg.jsx)
 * stores only a PREFERENCE — expiry intent + per-leg {side, CE/PE, moneyness, lots} — never a frozen strike,
 * because the right strike depends on where spot is when the rule fires. This module resolves that preference
 * against the LIVE FYERS NSE_FO master + the live spot, using the same pure resolver the /api/derivatives/resolve
 * endpoint uses (fyersOptionChain.resolveIndiaContract).
 *
 * FAIL-CLOSED CONTRACT (matches OptionLeg.jsx's promise to the user): a multi-leg strategy is ALL-OR-NOTHING.
 * If ANY leg cannot be resolved to an exact master row (missing strike rung, expiry not listed, no lot size…),
 * the WHOLE plan fails and the strategy does NOT trade — we never place a partial spread or guess a contract.
 *
 * PURE + dependency-injected: it takes the already-normalised master `rows` (server.js loads/caches them) and a
 * clock, so it is unit-testable without a live FYERS feed. No network, no side effects.
 */

const fyoc = require("./fyersOptionChain");

const PLAN_FAILED = "OPTION_LEG_PLAN_FAILED";

/* Index aliases: a strategy's trading symbol isn't always the F&O master's underlying. The indices are the
   common mismatch (equities match 1:1 by their bare symbol). e.g. a strategy on "NIFTY50" must resolve to the
   master's "NIFTY" chain. We only ever MAP to a name the master actually lists (checked below) — never guess. */
const INDEX_ALIASES = {
  NIFTY: "NIFTY", NIFTY50: "NIFTY", "NIFTY 50": "NIFTY", NIFTYINDEX: "NIFTY",
  BANKNIFTY: "BANKNIFTY", NIFTYBANK: "BANKNIFTY", "NIFTY BANK": "BANKNIFTY",
  FINNIFTY: "FINNIFTY", NIFTYFIN: "FINNIFTY", NIFTYFINSERVICE: "FINNIFTY",
  MIDCPNIFTY: "MIDCPNIFTY", NIFTYMIDSELECT: "MIDCPNIFTY", MIDCAPNIFTY: "MIDCPNIFTY",
  SENSEX: "SENSEX", BANKEX: "BANKEX",
};

/** Bare, upper-cased symbol with exchange prefix / -EQ suffix / spaces stripped. */
function cleanSymbol(sym) {
  return String(sym || "").toUpperCase().replace(/^[A-Z]+:/, "").replace(/-EQ$/, "").replace(/\s+/g, "");
}

/**
 * Resolve a strategy symbol to the underlying the F&O master actually lists. Tries, in order: the bare symbol,
 * then an index alias — but ONLY accepts a candidate that is present in `available` (the set of underlyings in the
 * loaded master). Returns null (fail closed) when nothing matches, so we never trade a wrong or nonexistent chain.
 */
function resolveUnderlying(sym, available) {
  const set = available instanceof Set ? available : new Set(available || []);
  const bare = cleanSymbol(sym);
  if (set.has(bare)) return bare;
  const alias = INDEX_ALIASES[bare];
  if (alias && set.has(alias)) return alias;
  return null;
}

/** "Current week"/"Current month" (OptionLeg.jsx) -> the resolver's expiry intent. */
function expiryIntentOf(expiryLabel) {
  const s = String(expiryLabel || "Current week").toLowerCase();
  if (s.includes("month")) return "CURRENT_MONTH";
  return "CURRENT_WEEK";
}

/** CE/PE (OptionLeg.jsx) -> CALL/PUT (resolver). */
function optionTypeOf(t) {
  const s = String(t || "").toUpperCase();
  if (s === "CE" || s === "CALL") return "CALL";
  if (s === "PE" || s === "PUT") return "PUT";
  return null;
}

/**
 * Resolve every leg of an OptionLeg config into concrete contracts.
 * @param p { opt, underlying, spot, rows, nowMs }
 *   opt      = { enabled, expiry, legs:[{ side:"BUY"|"SELL", type:"CE"|"PE", mny:"ATM"|"ITM1".."OTM4", lots }], strategy? }
 *   spot     = live underlying price at fire time (Number)
 *   rows     = normalised FYERS NSE_FO master rows (fyoc row shape)
 * @returns { ok:true, legs:[resolvedContract...], expiryIntent } | { error, detail, legIndex? }
 */
function planOptionLegs(p = {}) {
  const { opt, underlying, spot, rows, nowMs = Date.now() } = p;
  if (!opt || !opt.enabled) return { error: PLAN_FAILED, detail: "option_leg_not_enabled" };
  const legs = Array.isArray(opt.legs) ? opt.legs : [];
  if (!legs.length) return { error: PLAN_FAILED, detail: "no_legs" };
  if (!(Number(spot) > 0)) return { error: PLAN_FAILED, detail: "no_spot" };
  if (!Array.isArray(rows) || !rows.length) return { error: PLAN_FAILED, detail: "instrument_master_unavailable" };

  /* Normalise the strategy symbol to a chain the master actually lists (e.g. NIFTY50 -> NIFTY). Fail closed if
     no listed underlying matches — never resolve strikes against a wrong or empty chain. */
  const available = new Set(rows.map((r) => String((r && r.underlying) || "").toUpperCase()));
  const canonUnderlying = resolveUnderlying(underlying, available);
  if (!canonUnderlying) return { error: PLAN_FAILED, detail: "underlying_not_in_master" };

  const expiryIntent = expiryIntentOf(opt.expiry);
  const out = [];
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i] || {};
    const optionType = optionTypeOf(leg.type);
    if (!optionType) return { error: PLAN_FAILED, detail: "bad_option_type", legIndex: i };
    const side = leg.side === "SELL" ? "SELL" : "BUY";
    const lots = Math.max(1, Math.floor(Number(leg.lots) || 1));
    const resolved = fyoc.resolveIndiaContract({
      rows, underlying: canonUnderlying, productType: "OPTION",
      optionType, moneyness: String(leg.mny || "ATM").toUpperCase(),
      expiryIntent, side, spot: Number(spot), lots, nowMs,
    });
    if (resolved.error) return { error: PLAN_FAILED, detail: resolved.detail || resolved.error, legIndex: i };
    // Carry the leg's requested side onto the resolved contract (the resolver echoes side only for FUTURE).
    out.push({ ...resolved, side, legIndex: i });
  }
  return { ok: true, legs: out, expiryIntent, underlying: canonUnderlying, strategy: opt.strategy || null };
}

module.exports = { planOptionLegs, expiryIntentOf, optionTypeOf, resolveUnderlying, cleanSymbol, INDEX_ALIASES, PLAN_FAILED };
