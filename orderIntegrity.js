/* Pure order/risk-integrity helpers, extracted from server.js (R23-P3-05 module split) so the
   money-path invariants they encode are independently unit-testable and reused by every order path
   instead of living as closures inside a 7k-line file. No I/O, no server state — pure functions. */

/* R21-P2-04: deterministic JSON — recursively SORT object keys so two semantically-identical payloads
   (differing only in property insertion order) serialize identically. Used for the idempotency payload
   hash so an unchanged strategy object isn't mistaken for a changed order just because the client
   reordered its keys. */
function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(",")}}`;
}

/* R22-C01: the server risk gate must derive state ONLY from VERIFIED executions. A client can POST a
   trade, but a REAL row the browser authored (not stamped serverAuthored by a verified broker fill) must
   never feed the daily-loss / trade-count / cooldown maths — otherwise a fabricated `real:true` row with
   fake P&L could loosen the loss breaker or the cooldown. Virtual (paper) trades and server-verified real
   fills count; client-authored real rows are display-only. */
function riskEligibleTrades(trades) {
  return (trades || []).filter((t) => !(t && t.real === true && t.clientAuthored === true && t.serverAuthored !== true));
}

module.exports = { stableStringify, riskEligibleTrades };
