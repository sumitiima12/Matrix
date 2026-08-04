/**
 * signalGuards.js — spec §10/§13 pre-entry guards for automated real trading (pure, dependency-free).
 *
 *  • staleSignal      — never execute a stale/expired recommendation. A closed-candle signal must be acted on
 *                       promptly; if the engine is far behind (restart, outage, backlog) the signal is stale and a
 *                       real entry must be skipped rather than firing on old data.
 *  • duplicateOpenSymbol — the §10 CONFLICT POLICY: when a Screener, Smart Auto-Buy or another strategy selects a
 *                       symbol the account ALREADY holds an open real position in (same broker), the second entry
 *                       is skipped so automations can't silently stack duplicate exposure on one symbol. First
 *                       claim wins; a strategy may opt out with allowDuplicateSymbol.
 * Pure and unit-tested; these only ever BLOCK an entry, never place one.
 */

// Timeframe string ("1m","5m","15m","1h","4h","1d","1w") → milliseconds. Unknown → 15m default.
function timeframeMs(tf) {
  const m = String(tf || "").trim().toLowerCase().match(/^(\d+)\s*(m|min|h|hr|d|day|w|wk)?$/);
  if (!m) return 15 * 60 * 1000;
  const n = Number(m[1]) || 1;
  const unit = m[2] || "m";
  const per = unit.startsWith("w") ? 7 * 24 * 3600e3 : unit.startsWith("d") ? 24 * 3600e3 : unit.startsWith("h") ? 3600e3 : 60e3;
  return n * per;
}

/* Is the signal stale? A closed-candle signal fires right after the bar closes; we allow a generous grace of
   `bars` timeframes (default 3) with a 10-minute floor, so normal same-tick entries never trip but a signal left
   over from a long delay/outage is rejected. Returns true ⇒ SKIP the entry. */
function staleSignal(candleTime, now = Date.now(), timeframe = "15m", { bars = 3, floorMs = 10 * 60 * 1000 } = {}) {
  const ct = Number(candleTime);
  if (!Number.isFinite(ct) || ct <= 0) return false;          // unknown candle time → don't block on staleness
  const maxAge = Math.max(timeframeMs(timeframe) * bars, floorMs);
  return (Number(now) - ct) > maxAge;
}

// Normalize a symbol for comparison: drop exchange prefix (NSE:/BSE:), the -EQ suffix, the crypto quote suffix
// (USDT/USD/INR) and any punctuation, so "NSE:SBIN-EQ" ~ "SBIN" and "BTCUSD" ~ "BTC".
const _norm = (s) => String(s || "").toUpperCase().replace(/^[A-Z]+:/, "").replace(/-EQ$/, "").replace(/(USDT|USD|INR)$/i, "").replace(/[^A-Z0-9]/g, "");

/* Does the account already hold an OPEN/closing real position in this (broker, symbol)? If so, a second
   automation entry on the same symbol is a duplicate — skip it. Matches on broker + normalized symbol. */
function duplicateOpenSymbol(openPositions, broker, brokerSym) {
  const b = String(broker || "");
  const sym = _norm(brokerSym);
  return (openPositions || []).some((p) =>
    p && (p.status === "open" || p.status === "closing") &&
    String(p.broker || "") === b &&
    _norm(p.brokerSym || p.symbol) === sym);
}

module.exports = { timeframeMs, staleSignal, duplicateOpenSymbol };
