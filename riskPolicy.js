/**
 * riskPolicy.js — PURE helpers for the server-owned risk policy (R15-P1-02).
 *
 * The per-user caps are the REAL safety control on every real order, so they are stored server-side and
 * loaded per request. A per-order client value may only make a cap STRICTER, never looser — omitting or
 * tampering with the request body can never drop a cap the user configured. Kept pure so this security
 * boundary is unit-tested without a running server.
 */

// The caps we recognise. All are "max" ceilings except cooldownMs, which is a "min wait".
const RISK_KEYS = ["maxPositionPct", "maxOpenPositions", "maxTradesPerDay", "maxDailyLossPct", "cooldownMs"];

/* Keep only clean, positive numeric caps. Anything else (NaN, ≤0, wrong type, unknown key) is dropped, so a
   junk/partial client body can't inject a bogus limit. */
function cleanRiskPolicy(obj) {
  const o = obj && typeof obj === "object" ? obj : {};
  const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : undefined; };
  const out = {};
  for (const k of RISK_KEYS) { const v = num(o[k]); if (v !== undefined) out[k] = v; }
  return out;
}

/* Combine two policies into the STRICTER of the two per field. For the max* ceilings, smaller is stricter;
   for cooldownMs (a minimum wait between trades) larger is stricter. A field present in only one policy is
   carried through. This is how a client override can tighten but never loosen the server-owned policy. */
function strictestRiskPolicy(a, b) {
  const A = cleanRiskPolicy(a), B = cleanRiskPolicy(b), out = {};
  for (const k of RISK_KEYS) {
    const va = A[k], vb = B[k];
    if (va == null && vb == null) continue;
    if (va == null) { out[k] = vb; continue; }
    if (vb == null) { out[k] = va; continue; }
    out[k] = k === "cooldownMs" ? Math.max(va, vb) : Math.min(va, vb);
  }
  return out;
}

module.exports = { RISK_KEYS, cleanRiskPolicy, strictestRiskPolicy };
