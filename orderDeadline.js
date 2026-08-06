"use strict";
/* orderDeadline.js — fill-or-cancel policy for real orders.
 *
 * Rule (user-defined): a real order must NOT be left retrying/resubmitting forever. If it hasn't filled by its
 * deadline it is CANCELLED at the broker:
 *   - MARKET orders  → cancel if unfilled after 60 seconds (a market order that hasn't filled in 60s is wrong).
 *   - LIMIT orders   → cancel if unfilled after 15 minutes (a limit legitimately waits for its price, but not
 *                      indefinitely).
 *
 * Pure + testable: no I/O. The reconcile sweep asks shouldCancelStale() for each still-open attempt, and only
 * issues the broker cancel when this returns true. Unknown order types default to MARKET (the safest: the shorter
 * deadline), so a mis-tagged order still can't linger for 15 minutes.
 */

const MARKET_TIMEOUT_MS = 60 * 1000;        // 60s
const LIMIT_TIMEOUT_MS = 15 * 60 * 1000;    // 15 min

/* Normalize a caller-supplied order type to 'limit' | 'market'. Anything not clearly a limit order is treated as
   market (shorter deadline = fails safe). */
function normalizeOrderType(t) {
  const s = String(t == null ? "" : t).trim().toLowerCase();
  return s === "limit" || s === "lmt" || s === "sl" || s === "sl-l" ? "limit" : "market";
}

function deadlineMsFor(orderType) {
  return normalizeOrderType(orderType) === "limit" ? LIMIT_TIMEOUT_MS : MARKET_TIMEOUT_MS;
}

/* True when an order that is STILL OPEN (accepted/pending, not yet filled/rejected) has passed its deadline and
   should be cancelled. placedAtMs is the order's placement time (order_attempts.created_at). */
function shouldCancelStale({ orderType, placedAtMs, nowMs = Date.now() }) {
  const placed = Number(placedAtMs);
  if (!Number.isFinite(placed) || placed <= 0) return false;   // no trustworthy timestamp ⇒ never auto-cancel
  const age = Number(nowMs) - placed;
  if (!(age >= 0)) return false;
  return age >= deadlineMsFor(orderType);
}

module.exports = { MARKET_TIMEOUT_MS, LIMIT_TIMEOUT_MS, normalizeOrderType, deadlineMsFor, shouldCancelStale };
