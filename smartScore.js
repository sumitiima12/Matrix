/**
 * smartScore.js — REC-2: TRANSPARENT 4-factor scoring for Smart Auto-Buy / screener recommendations.
 *
 * A "Smart" pick used to arrive as a bare BUY with no explanation. This turns it into a score whose every
 * point is EARNED by a measured fact on real candles, with a plain-English reason per factor — the same
 * honesty contract as the frontend conviction engine, distilled to the four things that actually drive an
 * entry decision:
 *
 *    1. TREND      (weight 35) — is price working with a rising structure? (close vs SMA20/SMA50 + slope)
 *    2. MOMENTUM   (weight 30) — is there force behind the move, without being blown off? (RSI-14 band)
 *    3. VOLUME     (weight 20) — is the move backed by participation? (last volume vs 20-bar average)
 *    4. VOLATILITY (weight 15) — is it tradeable, not chaotic? (ATR% penalised at the extremes)
 *
 * Two rules keep the number honest, mirroring conviction.js:
 *   • COVERAGE IS PART OF THE NUMBER. A factor we cannot assess (not enough candles) is excluded from BOTH
 *     the score and the denominator — never scored as a failure. Below MIN_COVERAGE we decline to score and
 *     say why, rather than emit a confident-sounding number we did not earn.
 *   • DIRECTION-AWARE. For a SHORT (side "SELL") the trend/momentum readings are inverted — a falling
 *     structure with weak momentum is a GOOD short, so it scores high.
 *
 * Pure and deterministic (no randomness, no clock) so every branch is unit-tested without a server.
 * Input: candles = [{ o, h, l, c, v }, ...] oldest→newest. Only c (close) is required; h/l enable ATR, v
 * enables the volume factor. Missing inputs reduce coverage instead of inventing data.
 */

const WEIGHTS = { trend: 35, momentum: 30, volume: 20, volatility: 15 };
const MIN_COVERAGE = 0.5;   // need at least half the assessable weight before we score at all

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
/** Linear map of x in [a,b] onto [0,100], clamped. */
const lin = (x, a, b) => clamp(((x - a) / (b - a)) * 100, 0, 100);
/** Piecewise-linear interpolation of x over sorted [x,y] anchor points (flat outside the ends). */
function interp(x, pts) {
  if (x <= pts[0][0]) return pts[0][1];
  if (x >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
    if (x <= x1) return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
  }
  return pts[pts.length - 1][1];
}
/* Momentum score curve over the effective RSI (long-oriented). Peaks in the healthy 55–70 zone, penalised
   when weak (<45) and when overbought (>78). Monotonic up to the peak, then eases off — never rewards a
   collapsing RSI. Used for both directions by mirroring the RSI (100−r) for a short. */
const MOM_CURVE = [[10, 5], [20, 12], [45, 45], [55, 72], [68, 100], [78, 62], [90, 46], [100, 38]];

function sma(vals, n) {
  if (vals.length < n) return null;
  let s = 0; for (let i = vals.length - n; i < vals.length; i++) s += vals[i];
  return s / n;
}

/** Wilder RSI over the last `n` deltas. Needs n+1 closes. */
function rsi(closes, n = 14) {
  if (closes.length < n + 1) return null;
  let gain = 0, loss = 0;
  for (let i = closes.length - n; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  const avgG = gain / n, avgL = loss / n;
  if (avgL === 0) return avgG === 0 ? 50 : 100;   // no losses → maximal (flat → neutral)
  const rs = avgG / avgL;
  return 100 - 100 / (1 + rs);
}

/** Average True Range over the last `n` bars as a fraction of the last close (ATR%). Needs h/l/c. */
function atrPct(candles, n = 14) {
  if (candles.length < n + 1) return null;
  let sum = 0;
  for (let i = candles.length - n; i < candles.length; i++) {
    const c0 = candles[i], p = candles[i - 1];
    const h = Number(c0.h), l = Number(c0.l), pc = Number(p.c);
    if (!Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(pc)) return null;   // reject NaN/Inf highs
    const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    sum += tr;
  }
  const atr = sum / n;
  const last = Number(candles[candles.length - 1].c);
  return (Number.isFinite(atr) && last > 0) ? (atr / last) * 100 : null;
}

/**
 * Score a candle series. `opts.side` "BUY" (default) or "SELL" flips the directional factors.
 * Returns { total, verdict, coverage, assessed, factors:[{id,label,weight,score,why}], reason? }.
 * `total` is null with a `reason` when coverage is too thin to score honestly.
 */
function smartScore(candles, opts = {}) {
  const short = opts.side === "SELL" || opts.short === true;
  const cs = Array.isArray(candles) ? candles.filter((k) => k && Number.isFinite(Number(k.c))) : [];
  const closes = cs.map((k) => Number(k.c));
  const last = closes[closes.length - 1];
  const factors = [];

  // 1) TREND — close vs SMA20 & SMA50, plus SMA20 slope. Inverted for a short.
  const s20 = sma(closes, 20), s50 = sma(closes, 50);
  const s20prev = closes.length > 20 ? sma(closes.slice(0, -1), 20) : null;
  if (s20 != null) {
    let up = 0;
    up += last > s20 ? 50 : 0;                                   // above the fast average
    up += (s50 != null ? (s20 > s50 ? 30 : 0) : 15);            // fast above slow (or half credit if no SMA50)
    up += (s20prev != null ? (s20 > s20prev ? 20 : 0) : 10);   // fast average rising
    const score = short ? 100 - up : up;
    const dir = short ? "below" : "above";
    factors.push({ id: "trend", label: "Trend", weight: WEIGHTS.trend, score: Math.round(score),
      why: `Price ${last > s20 ? "above" : "below"} its 20-bar average${s50 != null ? (s20 > s50 ? ", fast>slow" : ", fast<slow") : ""} — ${score >= 60 ? "structure favours the " + (short ? "short" : "long") : "structure is " + dir + "-biased against it"}.` });
  }

  // 2) MOMENTUM — RSI-14 band. For a long, 55–70 is the sweet spot (force, not yet exhausted); <45 weak,
  //    >78 overbought. For a short the band is mirrored around 50.
  const r = rsi(closes, 14);
  if (r != null) {
    const eff = short ? 100 - r : r;   // mirror RSI for a short
    const score = interp(eff, MOM_CURVE);
    factors.push({ id: "momentum", label: "Momentum", weight: WEIGHTS.momentum, score: Math.round(score),
      why: `RSI-14 at ${r.toFixed(0)} — ${score >= 60 ? "momentum supports the " + (short ? "short" : "long") : score >= 45 ? "momentum is neutral" : "momentum works against it"}.` });
  }

  // 3) VOLUME — last bar vs 20-bar average volume. Direction-neutral: participation validates any move.
  const vols = cs.map((k) => Number(k.v)).filter(Number.isFinite);
  if (vols.length >= 20 && vols.length === cs.length) {
    const avg = sma(vols, 20);
    const ratio = avg > 0 ? vols[vols.length - 1] / avg : null;
    if (ratio != null) {
      const score = lin(ratio, 0.5, 1.8);   // 0.5×→0, 1.8×→100
      factors.push({ id: "volume", label: "Volume", weight: WEIGHTS.volume, score: Math.round(score),
        why: `Last bar ${ratio.toFixed(2)}× the 20-bar average volume — ${score >= 60 ? "well backed by participation" : score >= 35 ? "average participation" : "thin participation"}.` });
    }
  }

  // 4) VOLATILITY — ATR% quality. A moderate band (~1–4%) is ideal; near-zero is untradeable/illiquid, very
  //    high (>8%) is chaotic. Peak score around 2%. Direction-neutral.
  const a = atrPct(cs, 14);
  if (a != null) {
    let score;
    if (a < 0.3) score = 30;                             // dead
    else if (a <= 2) score = lin(a, 0.3, 2) * 0.4 + 60;  // 60→100 as it climbs into a tradeable band
    else if (a <= 4) score = 100 - lin(a, 2, 4) * 0.3;   // still fine, easing off
    else score = clamp(70 - (a - 4) * 8, 10, 70);        // >4% penalised, >8% deep
    factors.push({ id: "volatility", label: "Volatility", weight: WEIGHTS.volatility, score: Math.round(clamp(score, 0, 100)),
      why: `ATR ${a.toFixed(1)}% of price — ${score >= 60 ? "tradeable volatility" : a < 0.3 ? "too quiet / illiquid" : "elevated volatility, size down"}.` });
  }

  const assessedWeight = factors.reduce((s, f) => s + f.weight, 0);
  const totalWeight = Object.values(WEIGHTS).reduce((s, w) => s + w, 0);
  const coverage = assessedWeight / totalWeight;
  if (coverage < MIN_COVERAGE || !factors.length) {
    return { total: null, verdict: "Insufficient data", coverage: +coverage.toFixed(2), assessed: factors.length,
      factors, reason: `Only ${Math.round(coverage * 100)}% of the scoring inputs could be assessed (need ≥${MIN_COVERAGE * 100}%). More price history required.` };
  }
  const total = Math.round(factors.reduce((s, f) => s + f.score * f.weight, 0) / assessedWeight);
  const verdict = total >= 75 ? (short ? "High-conviction short" : "High-conviction buy")
    : total >= 55 ? (short ? "Lean short" : "Lean buy")
    : total >= 40 ? "Neutral" : (short ? "Avoid short" : "Avoid");
  return { total, verdict, coverage: +coverage.toFixed(2), assessed: factors.length, factors };
}

module.exports = { smartScore, WEIGHTS, MIN_COVERAGE, sma, rsi, atrPct };
