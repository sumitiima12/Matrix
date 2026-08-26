"use strict";
/**
 * derivativeGate.js — the ONE place that decides whether a REAL options/futures order may execute.
 *
 * WHY THIS EXISTS: the live order route (POST /api/broker/order) is symbol-agnostic — it forwards whatever
 * `symbol` string it's given to the broker adapter. A resolved option/future contract (OCC, Delta option symbol,
 * NFO, MCX) therefore flows through it exactly like an equity. That's convenient, but it means nothing there
 * intrinsically knows the order is a derivative whose LIVE execution is validated separately, per market, behind
 * an ops flag (the same flags that gate /api/derivatives/resolve). Without this gate an unvalidated option could
 * go live the moment a client passed its symbol.
 *
 * PRINCIPLE (fail closed): a real ENTRY on an options/futures contract is allowed ONLY when the matching
 * per-market validation flag is set. Unknown market ⇒ blocked. A reduce-only / closing order is always allowed
 * so a user can flatten risk. Pure function — no I/O — so it's unit-testable and callable from the route.
 */

// market → the env flag that certifies real derivative execution for that market.
const MARKET_FLAG = {
  IN: "MATRIX_FO_MASTER_VALIDATED",
  US: "MATRIX_US_OPTIONS_VALIDATED",
  Crypto: "MATRIX_CRYPTO_OPTIONS_VALIDATED",
  Commodity: "MATRIX_DHAN_MCX_VALIDATED",
};

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v == null ? "" : v).trim());

/**
 * @param {object} p
 *   productType : "STOCK" | "FUTURE" | "OPTION" (anything not FUTURE/OPTION is treated as non-derivative)
 *   market      : "IN" | "US" | "Crypto" | "Commodity" (from the resolved contract)
 *   reduceOnly  : boolean — a closing/exit order is always allowed
 * @param {object} env  process.env (or a stub in tests)
 * @returns {{ allowed: boolean, isDerivative: boolean, reason?: string, flag?: string }}
 */
function evaluateDerivativeOrder(p = {}, env = process.env) {
  const pt = String(p.productType || "").toUpperCase();
  const isDerivative = pt === "OPTION" || pt === "FUTURE";
  if (!isDerivative) return { allowed: true, isDerivative: false };
  if (p.reduceOnly === true) return { allowed: true, isDerivative: true, reason: "reduce_only_exit_always_allowed" };

  const market = String(p.market || "").trim();
  const flag = MARKET_FLAG[market];
  if (!flag) return { allowed: false, isDerivative: true, reason: "unknown_market_fail_closed" };
  if (!truthy(env[flag])) return { allowed: false, isDerivative: true, reason: "real_execution_not_validated", flag };
  return { allowed: true, isDerivative: true, flag };
}

module.exports = { evaluateDerivativeOrder, MARKET_FLAG };
