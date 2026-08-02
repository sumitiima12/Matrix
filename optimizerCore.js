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
function evalExitPair(sl, tp, events, maxBars = 200, short = false, costPct = 0) {
  const cost = Math.max(0, +costPct || 0);           // round-trip cost as % of notional, netted per trade
  let n = 0, wins = 0, sumWin = 0, sumLoss = 0, sumRet = 0, slHit = 0, tpHit = 0, pnlAbs = 0;
  // Fixed-stake equity curve (in % points of stake), to measure max drawdown for the return-on-capital
  // metric — the same model the backtest uses: one fixed stake per trade, gains NOT reinvested.
  let cum = 0, peak = 0, maxDDpts = 0;
  for (const ev of events) {
    const c = ev.c, e = ev.e;
    // CAUSAL: the entry SIGNAL is on closed bar `e`; a trader fills at the NEXT bar's OPEN, never at
    // bar e's own close (that would be same-bar look-ahead). SL/TP then trigger INTRABAR (OHLC) from
    // the entry bar onward, matching the backtest engine exactly.
    const entryIdx = e + 1;
    if (entryIdx >= c.length) continue;
    const px = c[entryIdx].o != null ? c[entryIdx].o : c[entryIdx].c;
    if (!(px > 0)) continue;
    // A SHORT mirrors the levels: TP sits BELOW entry, stop ABOVE, and it profits when price falls.
    const target = short ? px * (1 - tp / 100) : px * (1 + tp / 100);
    const stop = short ? px * (1 + sl / 100) : px * (1 - sl / 100);
    const end = Math.min(entryIdx + maxBars, c.length - 1);
    let ret = null, exitPx = null;
    for (let j = entryIdx; j <= end; j++) {
      if (short ? c[j].h >= stop : c[j].l <= stop) {   // stop first on a same-bar tie
        // R3-#5: a stop is stop-MARKET — a bar that GAPS through it fills at the (worse) open, not the
        // stop price. Fill at whichever is worse for the position so gaps don't understate the loss.
        const o = c[j].o != null ? c[j].o : stop;
        exitPx = short ? Math.max(stop, o) : Math.min(stop, o);
        ret = (short ? -1 : 1) * (exitPx / px - 1) * 100; slHit++; break;
      }
      if (short ? c[j].l <= target : c[j].h >= target) { ret = tp; exitPx = target; tpHit++; break; }
    }
    if (ret === null) { exitPx = c[end].c; ret = (short ? -1 : 1) * (exitPx / px - 1) * 100; }   // no level hit -> exit at window end
    ret -= cost;                                      // net the round-trip cost off the % return …
    n++; sumRet += ret; pnlAbs += (short ? (px - exitPx) : (exitPx - px)) - cost / 100 * px;      // … and off the absolute P&L
    if (ret > 0) { wins++; sumWin += ret; } else { sumLoss += ret; }
    // Fixed-stake cumulative equity (% points) + running max drawdown.
    cum += ret; if (cum > peak) peak = cum; const dd = peak - cum; if (dd > maxDDpts) maxDDpts = dd;
  }
  if (!n) return null;
  const pf = sumLoss !== 0 ? Math.abs(sumWin / sumLoss) : (sumWin > 0 ? Infinity : 0);
  // RETURN ON REQUIRED CAPITAL (headline, matches the backtest): total P&L ÷ (100% stake + 1.5 × max
  // drawdown). e.g. +1/+2/+3 with no drawdown → 6 / 100 = 6%; a drawdown enlarges the denominator.
  const retCap = riskAdjustedReturnPct(sumRet, 100, maxDDpts);
  return {
    sl, tp, trades: n, wins, slHit, tpHit,
    winRate: +((wins / n) * 100).toFixed(1), retPct: +sumRet.toFixed(1), retCap: retCap == null ? null : +retCap.toFixed(1),
    maxDD: +maxDDpts.toFixed(1), pnl: +pnlAbs.toFixed(2),
    expectancy: +(sumRet / n).toFixed(3), profitFactor: isFinite(pf) ? +pf.toFixed(2) : null,
  };
}

/* Return on REQUIRED CAPITAL — the risk-adjusted headline return, identical to the frontend backtest.
   Numerator = total P&L (fixed-stake sum). Denominator = deployed stake + a 1.5× max-drawdown buffer.
   With `base` = 100 (% stake) and `maxDD` in % points, this yields a percentage directly. */
function riskAdjustedReturnPct(pnl, base, maxDD) {
  const denom = (Number(base) || 0) + 1.5 * Math.max(0, Number(maxDD) || 0);
  return denom > 0 ? (pnl / denom) * 100 : null;
}

/* Ranking comparators for the two user objectives. "winrate" maximises % of winning trades (tie-break
   by total return); "pnl" maximises total return (tie-break by win rate). Sorts ascending → the better
   candidate compares as "less than" and lands first. */
function optRanker(objective) {
  // The return objective ranks by RETURN ON REQUIRED CAPITAL (retCap: P&L ÷ (stake + 1.5×maxDD)), the
  // same headline the backtest shows — so the optimiser picks the SL/TP or indicator length the backtest
  // would rate best, not one that just piled up raw return with a brutal drawdown. Falls back to retPct.
  const ret = (x) => (x.retCap != null ? x.retCap : x.retPct);
  return objective === "winrate"
    ? (a, b) => b.winRate - a.winRate || ret(b) - ret(a)
    : (a, b) => ret(b) - ret(a) || b.winRate - a.winRate;
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

/* Round-trip trading cost (% of notional) by market — mirrors frontend backtest.MARKET_COST_DEFAULTS,
   i.e. 2×(slipPct + brokeragePct), so the optimiser's numbers line up with the backtest table. */
const MARKET_COST_PCT = { IN: 0.10, FNO: 0.12, US: 0.04, Crypto: 0.13, Commodity: 0.12 };   // Crypto: fees 0.07% RT (maker buy 0.05% + taker sell 0.02%) + slip 2×0.03% = 0.13%
function costPctFor(market) { return MARKET_COST_PCT[market] != null ? MARKET_COST_PCT[market] : 0.10; }

module.exports = { evalExitPair, optRanker, lenOptions, costPctFor, MARKET_COST_PCT };
