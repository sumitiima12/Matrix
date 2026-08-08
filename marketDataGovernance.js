/**
 * marketDataGovernance.js — REC-3: a FORMAL contract for market data, with FAIL-CLOSED enforcement.
 *
 * A real order is only as safe as the price it was decided on. Historically a quote was just a number; if the
 * feed was stale, from an untrusted source, or silently delayed, nothing stopped a real entry from being sized
 * and placed against it. This module makes every price carry PROVENANCE and be judged against an explicit
 * freshness policy, and — crucially — it FAILS CLOSED: when the data is missing, stale, delayed, or from an
 * unapproved source, the verdict is "do not trade on this", never "assume it's fine".
 *
 * It is pure and side-effect-free so the contract is unit-tested without a live feed. The caller (the order
 * route / auto-buy engine) is responsible for ACTING on a non-ok verdict (block the real entry, warn, or fall
 * back to a paper path). Virtual trading may choose to proceed on a "warn" — that's the caller's call — but a
 * real-money entry must treat anything other than ok as a hard stop.
 *
 * A quote envelope:
 *   { symbol, price>0, asOf (epoch ms of the quote), source ("delta"|"fyers"|...), delayed?:bool, market? }
 *
 * A freshness policy (per asset class), all optional with safe defaults:
 *   { maxAgeMs, allowDelayed:false, trustedSources:[...], nowMs }
 */

/** Default max staleness by market. Crypto ticks constantly; equities/commodities tolerate a little more. */
const DEFAULT_MAX_AGE_MS = { Crypto: 15_000, IN: 60_000, US: 60_000, Commodity: 120_000, FNO: 60_000, default: 60_000 };

/** Sources we consider authoritative enough to place a REAL order against, unless the caller overrides. */
const DEFAULT_TRUSTED_SOURCES = ["delta", "fyers", "dhan", "coindcx", "indmoney", "zerodha"];

function maxAgeFor(market, policy) {
  if (policy && Number(policy.maxAgeMs) > 0) return Number(policy.maxAgeMs);
  return DEFAULT_MAX_AGE_MS[market] || DEFAULT_MAX_AGE_MS.default;
}

/**
 * Classify a quote against a policy. Returns:
 *   { ok, status, ageMs, reason, symbol, source }
 * status ∈ "fresh" | "stale" | "delayed" | "untrusted" | "missing" | "invalid".
 * ok === true ONLY for a fresh, non-delayed, trusted, positive-price quote — the ONE state a real order may
 * use. Every failure carries a human reason. This is the fail-closed core: ambiguity (no asOf, NaN price,
 * unknown source) is a FAILURE, never a pass.
 */
function classifyQuote(quote, policy = {}) {
  const now = Number(policy.nowMs) > 0 ? Number(policy.nowMs) : Date.now();
  if (!quote || typeof quote !== "object") return { ok: false, status: "missing", ageMs: null, reason: "No quote available.", symbol: null, source: null };
  const { symbol = null, source = null, market } = quote;
  const price = Number(quote.price);
  if (!(price > 0)) return { ok: false, status: "invalid", ageMs: null, reason: "Quote has no positive price.", symbol, source };

  // Provenance: an unknown/absent source can't be trusted for a real order (fail closed).
  const trusted = Array.isArray(policy.trustedSources) ? policy.trustedSources : DEFAULT_TRUSTED_SOURCES;
  if (!source || !trusted.map(String).includes(String(source))) {
    return { ok: false, status: "untrusted", ageMs: null, reason: `Source ${source ? `"${source}"` : "(none)"} is not on the trusted-feed list.`, symbol, source };
  }

  // A broker-flagged delayed feed is never fresh enough for a real entry unless the caller explicitly allows it.
  if (quote.delayed === true && policy.allowDelayed !== true) {
    return { ok: false, status: "delayed", ageMs: null, reason: "Feed is marked delayed; real orders require a real-time quote.", symbol, source };
  }

  // Staleness: no timestamp is treated as unknown-age → fail closed.
  const asOf = Number(quote.asOf);
  if (!(asOf > 0)) return { ok: false, status: "stale", ageMs: null, reason: "Quote has no timestamp; age can't be verified.", symbol, source };
  const ageMs = now - asOf;
  const maxAge = maxAgeFor(market, policy);
  if (ageMs < 0) {
    // Timestamp in the future beyond a small skew tolerance → clock problem, don't trust it.
    if (ageMs < -5_000) return { ok: false, status: "invalid", ageMs, reason: "Quote timestamp is in the future (clock skew).", symbol, source };
  } else if (ageMs > maxAge) {
    return { ok: false, status: "stale", ageMs, reason: `Quote is ${Math.round(ageMs / 1000)}s old (limit ${Math.round(maxAge / 1000)}s).`, symbol, source };
  }
  return { ok: true, status: "fresh", ageMs: Math.max(0, ageMs), reason: "Fresh, trusted, real-time quote.", symbol, source };
}

/**
 * Fail-closed gate for a REAL order: returns { allow, verdict } where allow is true ONLY for a fresh quote.
 * This is the function the money path calls before sizing/placing on a price.
 */
function gateRealOrder(quote, policy = {}) {
  const verdict = classifyQuote(quote, policy);
  return { allow: verdict.ok === true, verdict };
}

module.exports = { DEFAULT_MAX_AGE_MS, DEFAULT_TRUSTED_SOURCES, maxAgeFor, classifyQuote, gateRealOrder };
