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

  const expiryIntent = expiryIntentOf(opt.expiry);
  const out = [];
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i] || {};
    const optionType = optionTypeOf(leg.type);
    if (!optionType) return { error: PLAN_FAILED, detail: "bad_option_type", legIndex: i };
    const side = leg.side === "SELL" ? "SELL" : "BUY";
    const lots = Math.max(1, Math.floor(Number(leg.lots) || 1));
    const resolved = fyoc.resolveIndiaContract({
      rows, underlying, productType: "OPTION",
      optionType, moneyness: String(leg.mny || "ATM").toUpperCase(),
      expiryIntent, side, spot: Number(spot), lots, nowMs,
    });
    if (resolved.error) return { error: PLAN_FAILED, detail: resolved.detail || resolved.error, legIndex: i };
    // Carry the leg's requested side onto the resolved contract (the resolver echoes side only for FUTURE).
    out.push({ ...resolved, side, legIndex: i });
  }
  return { ok: true, legs: out, expiryIntent, strategy: opt.strategy || null };
}

module.exports = { planOptionLegs, expiryIntentOf, optionTypeOf, PLAN_FAILED };
