"use strict";
/**
 * optionQuote.js — LIVE option-premium feed. Resolving a contract gives us its symbol; this gives us its PRICE,
 * which is what paper option P&L and real limit pricing both need.
 *
 * Sources (per market), fail-closed — a missing/parse-failed quote returns { premium: null, reason } and NEVER a
 * fabricated number:
 *   • Crypto (Delta BTC/ETH) — Delta's PUBLIC /v2/tickers/{symbol} returns mark_price (the option premium) + bid/ask.
 *   • US (equity options)    — Yahoo /v7/finance/options/{underlying}?date=<expiryEpoch> option chain (lastPrice/bid/ask).
 *   • Indian (NSE/NFO)       — already available via the FYERS option chain the resolver reads; not re-fetched here.
 *   • Commodity (MCX)        — no accessible public option feed yet → returns null (honest).
 *
 * The NORMALISERS are pure (unit-tested with fixtures). The fetchers take an injected JSON getter so the module has no
 * hidden I/O and stays testable; server.js wires the real getters (pfetch/deltaCall + memo).
 */

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

/** Delta option ticker → premium (mark price) + bid/ask. `result` is the `.result` of /v2/tickers/{symbol}. */
function normalizeDeltaOptionTicker(result) {
  if (!result || typeof result !== "object") return { premium: null, reason: "no_ticker" };
  const premium = num(result.mark_price) ?? num(result.close) ?? num(result.spot_price);
  const q = result.quotes || {};
  const bid = num(q.best_bid);
  const ask = num(q.best_ask);
  // Delta timestamps are microseconds; fall back to now.
  const tsUs = num(result.timestamp);
  const asOf = tsUs && tsUs > 0 ? Math.round(tsUs / 1000) : Date.now();
  if (premium == null) return { premium: null, reason: "no_mark_price" };
  return { premium, bid, ask, source: "delta", asOf };
}

/**
 * Yahoo option chain → the matching contract's premium. `json` is the full /v7/finance/options response.
 * Picks calls[] or puts[] by optionType, then the row whose strike equals `strike` (nearest within a tiny epsilon).
 */
function normalizeYahooOptionChain(json, { strike, optionType } = {}) {
  const res = json && json.optionChain && Array.isArray(json.optionChain.result) ? json.optionChain.result[0] : null;
  const opt = res && Array.isArray(res.options) ? res.options[0] : null;
  if (!opt) return { premium: null, reason: "no_option_chain" };
  const side = String(optionType || "").toUpperCase() === "PUT" ? "puts" : "calls";
  const rows = Array.isArray(opt[side]) ? opt[side] : [];
  const want = Number(strike);
  if (!(want > 0)) return { premium: null, reason: "bad_strike" };
  let best = null, bestD = Infinity;
  for (const r of rows) { const k = num(r && r.strike); if (k == null) continue; const d = Math.abs(k - want); if (d < bestD) { bestD = d; best = r; } }
  if (!best || bestD > 1e-6) return { premium: null, reason: "strike_not_listed" };
  const premium = num(best.lastPrice) ?? ((num(best.bid) != null && num(best.ask) != null) ? +(((num(best.bid) + num(best.ask)) / 2)).toFixed(4) : null);
  if (premium == null) return { premium: null, reason: "no_price_on_contract" };
  return { premium, bid: num(best.bid), ask: num(best.ask), openInterest: num(best.openInterest), impliedVolatility: num(best.impliedVolatility), source: "yahoo", asOf: Date.now() };
}

/** Expiry ISO (YYYY-MM-DD) → Yahoo's expiration query param (UTC midnight epoch seconds). */
function yahooExpiryEpoch(expiryISO) {
  const m = String(expiryISO || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 1000);
}

/**
 * @param p { market, deltaSymbol?, underlying?, strike?, optionType?, expiryISO? }
 * @param deps { deltaGet(symbol)->json, yahooGet(underlying, epoch)->json }  (either may be absent)
 * @returns { premium, bid?, ask?, source, asOf } | { premium: null, reason }
 */
async function fetchOptionPremium(p = {}, deps = {}) {
  const market = String(p.market || "");
  if (market === "Crypto") {
    if (typeof deps.deltaGet !== "function" || !p.deltaSymbol) return { premium: null, reason: "crypto_feed_unavailable" };
    let json; try { json = await deps.deltaGet(p.deltaSymbol); } catch (e) { return { premium: null, reason: "delta_fetch_failed:" + (e && e.message) }; }
    return normalizeDeltaOptionTicker(json && json.result);
  }
  if (market === "US") {
    if (typeof deps.yahooGet !== "function" || !p.underlying) return { premium: null, reason: "us_feed_unavailable" };
    const epoch = yahooExpiryEpoch(p.expiryISO);
    if (epoch == null) return { premium: null, reason: "bad_expiry" };
    let json; try { json = await deps.yahooGet(p.underlying, epoch); } catch (e) { return { premium: null, reason: "yahoo_fetch_failed:" + (e && e.message) }; }
    return normalizeYahooOptionChain(json, { strike: p.strike, optionType: p.optionType });
  }
  if (market === "IN") return { premium: null, reason: "use_fyers_option_chain" };
  return { premium: null, reason: "no_option_feed_for_market" };
}

module.exports = { normalizeDeltaOptionTicker, normalizeYahooOptionChain, yahooExpiryEpoch, fetchOptionPremium };
