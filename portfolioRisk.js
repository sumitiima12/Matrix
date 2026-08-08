/**
 * portfolioRisk.js — REC-1: PORTFOLIO-LEVEL risk intelligence (the "cheap parts").
 *
 * Per-order risk limits (riskPolicy.js / riskEngine.js) protect ONE trade. They say nothing about the
 * shape of the whole book: ten separate positions can each pass their own cap yet still leave the account
 * dangerously concentrated in one name, one market, or one direction. This module computes the account-wide
 * picture from the set of currently-open positions — pure arithmetic on data we already have, no new feeds.
 *
 * It is ADVISORY: it surfaces concentration, aggregate stop-loss risk, and direction balance so the user (or
 * an ops reviewer) can SEE the exposure. It does not block orders — enforcement, if ever wanted, is a separate
 * deliberate step. Kept pure so every number is unit-tested without a running server or live prices.
 *
 * A "position" is the normalized shape:
 *    { symbol, market, side ("BUY"|"SELL"), qty>0, entry>0, price?>0, stop?>0 }
 * price defaults to entry when a live mark isn't available (so notional is still meaningful); stop is optional
 * (a position with no stop contributes UNBOUNDED downside, which we flag rather than silently treating as 0).
 */

/** Clean one position into { symbol, market, side, qty, entry, price, stop } or null if unusable. */
function normPosition(p) {
  if (!p || typeof p !== "object") return null;
  const qty = Number(p.qty);
  const entry = Number(p.entry);
  // Guards use Number.isFinite so Infinity/NaN can't slip past a bare `> 0` and poison notionals.
  if (!(Number.isFinite(qty) && qty > 0) || !(Number.isFinite(entry) && entry > 0)) return null;
  const priceN = Number(p.price);
  const price = (Number.isFinite(priceN) && priceN > 0) ? priceN : entry;   // mark-to-entry when no live price
  const side = (p.side === "SELL" || p.short === true) ? "SELL" : "BUY";
  const stopN = Number(p.stop);
  const stop = (Number.isFinite(stopN) && stopN > 0) ? stopN : null;        // optional; null = no protective stop
  return { symbol: String(p.symbol || p.sym || "—"), market: String(p.market || "—"), side, qty, entry, price, stop };
}

/** Notional (absolute market value) of a position at its current mark. */
function notionalOf(p) { return p.qty * p.price; }

/**
 * Money at risk if this position's stop is hit: (mark − stop) × qty for a long, (stop − mark) × qty for a
 * short — always the LOSS magnitude (a non-negative number). A stop already beyond the mark (i.e. the trade
 * is underwater past its stop) is clamped to 0 extra risk here; the loss is already realised on the mark.
 * Returns null when there is no stop (downside is unbounded — the caller flags this separately).
 */
function riskAtStop(p) {
  if (p.stop == null) return null;
  const perUnit = p.side === "BUY" ? (p.price - p.stop) : (p.stop - p.price);
  return Math.max(0, perUnit) * p.qty;
}

/** Herfindahl–Hirschman Index of concentration over a set of weights (0..1). 1 = everything in one bucket. */
function hhi(weights) {
  const total = weights.reduce((a, w) => a + w, 0);
  if (!(total > 0)) return 0;
  return weights.reduce((a, w) => a + (w / total) ** 2, 0);
}

/**
 * Summarise a book of positions into account-wide risk intelligence. Everything is derived, nothing invented:
 *  - grossExposure / netExposure / long / short notionals (net = long − short)
 *  - positions count, and the largest single position as a share of gross (top concentration)
 *  - per-market and per-symbol concentration (share of gross + HHI)
 *  - aggregateStopRisk: total money at risk if EVERY protected position hit its stop at once
 *  - unprotected: positions with no stop (unbounded downside) — count + their gross notional
 *  - directionSkew: net / gross in [-1,1] (+1 all long, −1 all short, 0 balanced)
 * `opts.equity` (optional) expresses aggregateStopRisk and top concentration as a % of account equity.
 */
function summarizePortfolio(positions, opts = {}) {
  const ps = (Array.isArray(positions) ? positions : []).map(normPosition).filter(Boolean);
  const equity = Number(opts.equity) > 0 ? Number(opts.equity) : null;

  if (!ps.length) {
    return {
      positions: 0, grossExposure: 0, netExposure: 0, longExposure: 0, shortExposure: 0,
      directionSkew: 0, topPosition: null, topConcentrationPct: 0,
      byMarket: [], bySymbol: [], marketHHI: 0, symbolHHI: 0,
      aggregateStopRisk: 0, aggregateStopRiskPct: equity ? 0 : null,
      unprotectedCount: 0, unprotectedNotional: 0, flags: [],
    };
  }

  let longExp = 0, shortExp = 0, aggStopRisk = 0, unprotCount = 0, unprotNotional = 0;
  const marketMap = new Map();   // market → gross notional
  const symbolMap = new Map();   // symbol → gross notional
  let top = null;

  for (const p of ps) {
    const n = notionalOf(p);
    if (p.side === "BUY") longExp += n; else shortExp += n;
    marketMap.set(p.market, (marketMap.get(p.market) || 0) + n);
    symbolMap.set(p.symbol, (symbolMap.get(p.symbol) || 0) + n);
    const r = riskAtStop(p);
    if (r == null) { unprotCount += 1; unprotNotional += n; } else { aggStopRisk += r; }
    if (!top || n > top.notional) top = { symbol: p.symbol, market: p.market, side: p.side, notional: n };
  }

  const gross = longExp + shortExp;
  const net = longExp - shortExp;
  const share = (v) => (gross > 0 ? v / gross : 0);
  const byMarket = [...marketMap.entries()].map(([market, notional]) => ({ market, notional, sharePct: +(share(notional) * 100).toFixed(2) })).sort((a, b) => b.notional - a.notional);
  const bySymbol = [...symbolMap.entries()].map(([symbol, notional]) => ({ symbol, notional, sharePct: +(share(notional) * 100).toFixed(2) })).sort((a, b) => b.notional - a.notional);

  const flags = [];
  const topConcPct = top ? +(share(top.notional) * 100).toFixed(2) : 0;
  if (topConcPct >= 40) flags.push({ level: topConcPct >= 60 ? "high" : "warn", code: "SINGLE_POSITION_CONCENTRATION", message: `${top.symbol} is ${topConcPct}% of gross exposure.` });
  if (byMarket[0] && byMarket[0].sharePct >= 80 && byMarket.length > 1) flags.push({ level: "warn", code: "MARKET_CONCENTRATION", message: `${byMarket[0].sharePct}% of exposure is in ${byMarket[0].market}.` });
  if (unprotCount > 0) flags.push({ level: "warn", code: "UNPROTECTED_POSITIONS", message: `${unprotCount} position${unprotCount === 1 ? "" : "s"} have no stop-loss (unbounded downside).` });
  if (equity && aggStopRisk / equity >= 0.1) flags.push({ level: aggStopRisk / equity >= 0.2 ? "high" : "warn", code: "AGGREGATE_STOP_RISK", message: `${(aggStopRisk / equity * 100).toFixed(1)}% of equity is at risk if all stops hit at once.` });

  return {
    positions: ps.length,
    grossExposure: +gross.toFixed(2), netExposure: +net.toFixed(2),
    longExposure: +longExp.toFixed(2), shortExposure: +shortExp.toFixed(2),
    directionSkew: gross > 0 ? +(net / gross).toFixed(4) : 0,
    topPosition: top ? { ...top, notional: +top.notional.toFixed(2) } : null,
    topConcentrationPct: topConcPct,
    byMarket, bySymbol,
    marketHHI: +hhi([...marketMap.values()]).toFixed(4),
    symbolHHI: +hhi([...symbolMap.values()]).toFixed(4),
    aggregateStopRisk: +aggStopRisk.toFixed(2),
    aggregateStopRiskPct: equity ? +((aggStopRisk / equity) * 100).toFixed(2) : null,
    unprotectedCount: unprotCount, unprotectedNotional: +unprotNotional.toFixed(2),
    flags,
  };
}

module.exports = { normPosition, notionalOf, riskAtStop, hhi, summarizePortfolio };
