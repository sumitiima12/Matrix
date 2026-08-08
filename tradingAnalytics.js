/**
 * tradingAnalytics.js — REC-6: TRUSTWORTHY trading analytics (pure).
 *
 * Trust comes from honest numbers, consistently computed and clearly labelled. This turns a user's CLOSED
 * trades into the standard performance statistics a serious trader expects — win rate, average win/loss,
 * expectancy, profit factor, max drawdown on the realised equity curve, best/worst trade, average hold time —
 * with every figure derived the same disciplined way and marked ESTIMATED (they exclude fees/taxes unless the
 * trade rows already carry them, and open positions are not counted as realised).
 *
 * Pure and deterministic so each statistic is unit-tested. A "trade" is normalised from the app's trade rows:
 *   { entry>0, exit>0, exitAt, entryAt, qty>0, side ("BUY"|"SELL") | short:bool, status }
 * Only trades that are actually CLOSED (have an exit + exitAt and aren't rejected) count toward realised stats.
 */

/** Realised P&L of one closed trade (short-aware). null if the trade isn't a usable closed trade. */
function realizedPnl(t) {
  if (!t || t.status === "rejected") return null;
  const entry = Number(t.entry), exit = Number(t.exit), qty = Number(t.qty);
  // Number.isFinite guards so Infinity/NaN can't pass a bare `> 0` and leak a non-finite P&L into the stats.
  if (!(Number.isFinite(entry) && entry > 0) || !(Number.isFinite(exit) && exit > 0) || !(Number.isFinite(qty) && qty > 0)) return null;
  if (t.exitAt == null) return null;                       // still open → not realised
  const dir = (t.side === "SELL" || t.short === true) ? -1 : 1;
  return (exit - entry) * qty * dir;
}

/** Max drawdown (absolute + %) of a cumulative-P&L equity curve built from an ordered list of trade P&Ls. */
function maxDrawdown(pnls) {
  let cum = 0, peak = 0, maxDDabs = 0, peakForPct = 0, maxDDpct = 0;
  for (const p of pnls) {
    cum += p;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDDabs) { maxDDabs = dd; peakForPct = peak; }
  }
  if (maxDDabs > 0 && peakForPct > 0) maxDDpct = (maxDDabs / peakForPct) * 100;
  return { maxDrawdown: +maxDDabs.toFixed(2), maxDrawdownPct: +maxDDpct.toFixed(2) };
}

/**
 * Compute analytics over a set of trades. Returns a flat object of estimated statistics; `estimated: true`
 * is always set as an honesty marker. Trades are ordered by exit time for the equity curve / drawdown.
 */
function tradeAnalytics(trades) {
  const closed = (Array.isArray(trades) ? trades : [])
    .map((t) => ({ t, pnl: realizedPnl(t) }))
    .filter((x) => x.pnl != null)
    .sort((a, b) => (a.t.exitAt || 0) - (b.t.exitAt || 0));

  const n = closed.length;
  if (!n) {
    return { estimated: true, trades: 0, wins: 0, losses: 0, winRate: null, totalPnl: 0,
      grossProfit: 0, grossLoss: 0, avgWin: null, avgLoss: null, expectancy: null, profitFactor: null,
      maxDrawdown: 0, maxDrawdownPct: 0, bestTrade: null, worstTrade: null, avgHoldMs: null, payoffRatio: null };
  }

  let wins = 0, losses = 0, grossProfit = 0, grossLoss = 0, total = 0, holdSum = 0, holdCount = 0;
  let best = -Infinity, worst = Infinity;
  for (const { t, pnl } of closed) {
    total += pnl;
    if (pnl >= 0) { wins += 1; grossProfit += pnl; } else { losses += 1; grossLoss += -pnl; }
    if (pnl > best) best = pnl;
    if (pnl < worst) worst = pnl;
    const eAt = Number(t.entryAt), xAt = Number(t.exitAt);
    if (Number.isFinite(eAt) && Number.isFinite(xAt) && xAt >= eAt) { holdSum += (xAt - eAt); holdCount += 1; }
  }
  const avgWin = wins ? grossProfit / wins : null;
  const avgLoss = losses ? grossLoss / losses : null;                 // magnitude (positive)
  const dd = maxDrawdown(closed.map((x) => x.pnl));
  return {
    estimated: true,
    trades: n, wins, losses,
    winRate: +((wins / n) * 100).toFixed(2),
    totalPnl: +total.toFixed(2),
    grossProfit: +grossProfit.toFixed(2), grossLoss: +grossLoss.toFixed(2),
    avgWin: avgWin == null ? null : +avgWin.toFixed(2),
    avgLoss: avgLoss == null ? null : +avgLoss.toFixed(2),
    expectancy: +(total / n).toFixed(2),                              // average P&L per trade
    profitFactor: grossLoss > 0 ? +(grossProfit / grossLoss).toFixed(2) : (grossProfit > 0 ? null : 0),  // null = no losses (undefined ratio)
    payoffRatio: (avgWin != null && avgLoss != null && avgLoss > 0) ? +(avgWin / avgLoss).toFixed(2) : null,
    maxDrawdown: dd.maxDrawdown, maxDrawdownPct: dd.maxDrawdownPct,
    bestTrade: +best.toFixed(2), worstTrade: +worst.toFixed(2),
    avgHoldMs: holdCount ? Math.round(holdSum / holdCount) : null,
  };
}

module.exports = { realizedPnl, maxDrawdown, tradeAnalytics };
