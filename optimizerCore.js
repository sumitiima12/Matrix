/**
 * optimizerCore.js — the PURE scoring math shared by /api/optimize-exits and /api/optimize-indicators.
 *
 * Kept in its own module (no I/O, no strategy engine) so it can be unit-tested directly: given a set
 * of entry events on real candles, `evalExitPair` reports exactly what win rate / SL-hit / TP-hit /
 * P&L / return a fixed SL-TP pair would have produced. `optRanker` orders candidates by objective and
 * `lenOptions` enumerates the indicator lengths the indicator optimiser sweeps.
 *
 * An "event" is { c, e } where `c` is the closed-candle array [{o,h,l,c,...}] and `e` is the index of
 * the entry bar. The trade enters at c[e].c and is walked forward bar-by-bar.
 */

/**
 * Evaluate ONE (sl, tp) pair across every entry event. Long-only. Ties inside a bar assume the STOP
 * fills first (conservative). If neither level is touched within `maxBars`, the trade exits at the
 * window's last close.
 *
 * @returns null when there are no events, else
 *  { sl, tp, trades, wins, slHit, tpHit, winRate, retPct, pnl, expectancy, profitFactor }
 *  - winRate  = % of trades with a positive return
 *  - retPct   = SUM of per-trade % returns (not the average)
 *  - pnl      = SUM of per-trade absolute moves (exitPx - entryPx), i.e. P&L per 1 unit/contract
 */
function evalExitPair(sl, tp, events, maxBars = 200, short = false) {
  let n = 0, wins = 0, sumWin = 0, sumLoss = 0, sumRet = 0, slHit = 0, tpHit = 0, pnlAbs = 0;
  for (const ev of events) {
    const c = ev.c, e = ev.e, px = c[e].c;
    if (!(px > 0)) continue;
    // A SHORT mirrors the levels: TP sits BELOW entry, stop ABOVE, and it profits when price falls.
    const target = short ? px * (1 - tp / 100) : px * (1 + tp / 100);
    const stop = short ? px * (1 + sl / 100) : px * (1 - sl / 100);
    const end = Math.min(e + maxBars, c.length - 1);
    let ret = null, exitPx = null;
    for (let j = e + 1; j <= end; j++) {
      if (short ? c[j].h >= stop : c[j].l <= stop) { ret = -sl; exitPx = stop; slHit++; break; }   // stop first on a same-bar tie
      if (short ? c[j].l <= target : c[j].h >= target) { ret = tp; exitPx = target; tpHit++; break; }
    }
    if (ret === null) { exitPx = c[end].c; ret = (short ? -1 : 1) * (exitPx / px - 1) * 100; }   // no level hit -> exit at window end
    n++; sumRet += ret; pnlAbs += (short ? (px - exitPx) : (exitPx - px));
    if (ret > 0) { wins++; sumWin += ret; } else { sumLoss += ret; }
  }
  if (!n) return null;
  const pf = sumLoss !== 0 ? Math.abs(sumWin / sumLoss) : (sumWin > 0 ? Infinity : 0);
  return {
    sl, tp, trades: n, wins, slHit, tpHit,
    winRate: +((wins / n) * 100).toFixed(1), retPct: +sumRet.toFixed(1), pnl: +pnlAbs.toFixed(2),
    expectancy: +(sumRet / n).toFixed(3), profitFactor: isFinite(pf) ? +pf.toFixed(2) : null,
  };
}

/* Ranking comparators for the two user objectives. "winrate" maximises % of winning trades (tie-break
   by total return); "pnl" maximises total return (tie-break by win rate). Sorts ascending → the better
   candidate compares as "less than" and lands first. */
function optRanker(objective) {
  return objective === "winrate"
    ? (a, b) => b.winRate - a.winRate || b.retPct - a.retPct
    : (a, b) => b.retPct - a.retPct || b.winRate - a.winRate;
}

/* Candidate lengths the indicator optimiser tries for a given current length: 0.5×, 0.7×, 1×, 1.4×, 2×,
   rounded, floored at 2, de-duplicated and sorted. Non-numeric lengths (MACD/VWAP) return null so they
   are left untouched. */
function lenOptions(len) {
  const nn = Number(len);
  if (!Number.isFinite(nn) || nn <= 0) return null;
  const s = new Set();
  for (const m of [0.5, 0.7, 1, 1.4, 2]) { let v = Math.round(nn * m); if (v < 2) v = 2; s.add(v); }
  return [...s].sort((a, b) => a - b);
}

module.exports = { evalExitPair, optRanker, lenOptions };
