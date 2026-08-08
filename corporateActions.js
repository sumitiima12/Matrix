"use strict";
/* corporateActions.js — PURE heuristic that recognises when a broker quantity change LOOKS like a corporate
   action (stock split / bonus / reverse split / consolidation) rather than a genuine reconciliation error.
   FIN-3(a): this is used only to LABEL a discrepancy for the operator ("likely corporate action — verify"),
   never to auto-adopt a position or suppress a safety block. Without a corporate-actions data feed we can't
   *know* a CA happened, so we stay conservative: we only flag when the qty ratio is a clean small-integer
   ratio AND (if prices are given) the notional is roughly preserved — the signature of a split/bonus.

   Kept pure + tested so this classification can't silently drift.  */

/* The clean split ratios worth recognising: forward (2:1, 3:1, 5:1, 10:1, 3:2, 5:4 …) and their inverses
   (reverse splits / consolidations). Expressed as new/old multipliers. */
const FORWARD = [2, 3, 4, 5, 6, 10, 3 / 2, 5 / 2, 5 / 4, 7 / 5, 4 / 3];
const RATIOS = [...FORWARD, ...FORWARD.map((r) => 1 / r)];

const near = (a, b, tol) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

/* Detect a likely split ratio (new/old). Returns { ratio, label } for the closest clean match within
   tolerance, else null. `ratio` > 1 → forward split/bonus; < 1 → reverse split/consolidation. */
function detectSplitRatio(oldQty, newQty, tol = 0.02) {
  const o = Number(oldQty), n = Number(newQty);
  if (!(o > 0) || !(n > 0) || near(n, o, tol)) return null;   // no change (or invalid) → not a CA
  const r = n / o;
  let best = null;
  for (const cand of RATIOS) {
    if (near(r, cand, tol)) {
      const err = Math.abs(r - cand);
      if (!best || err < best.err) best = { ratio: cand, err };
    }
  }
  if (!best) return null;
  const asFrac = best.ratio >= 1
    ? `${Math.round(best.ratio * 2)}:${2}`.replace(/^(\d+):2$/, (m, a) => (a % 2 === 0 ? `${a / 2}:1` : `${a}:2`))
    : `1:${Math.round(1 / best.ratio)}`;
  return { ratio: best.ratio, label: best.ratio >= 1 ? `split/bonus ~${asFrac}` : `reverse split ~${asFrac}` };
}

/* Is a quantity change (with optional avg-price context) LIKELY a corporate action? A split preserves the
   position's notional value: qty×price is ~unchanged (bonus shares halve the price, etc.). If prices aren't
   available we fall back to the clean-ratio test alone (weaker, so mark lowConfidence). Returns
   { likely, ratio, label, notionalPreserved, lowConfidence } — advisory only. */
function looksLikeCorporateAction(oldQty, newQty, oldPrice = null, newPrice = null) {
  const det = detectSplitRatio(oldQty, newQty);
  if (!det) return { likely: false };
  let notionalPreserved = null, lowConfidence = true;
  if (oldPrice > 0 && newPrice > 0) {
    const oldNotional = Number(oldQty) * Number(oldPrice);
    const newNotional = Number(newQty) * Number(newPrice);
    notionalPreserved = near(newNotional, oldNotional, 0.05);   // within 5%
    lowConfidence = false;
  }
  // With prices, require notional preservation; without prices, flag on the clean ratio alone (low confidence).
  const likely = notionalPreserved === null ? true : notionalPreserved === true;
  return { likely, ratio: det.ratio, label: det.label, notionalPreserved, lowConfidence };
}

module.exports = { detectSplitRatio, looksLikeCorporateAction };
