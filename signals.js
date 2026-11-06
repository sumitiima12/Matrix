/* signals.js (backend port of the frontend domain/signals.js technical signal engine).
   Operates on an enriched record `s` (the fields indicatorsFor() produces: rsi, sma50, sma200, macd,
   macdSignal, atr, adx, support, resistance, high52, low52, avgVol, vol, chg, price) plus { sym, market,
   hasData }. Pure — no I/O. Used by the server-side Smart-Auto-Buy engine so its picks MATCH the app's. The
   only frontend deps were `fmt` (display text) and `marketOf`; here text uses a plain formatter and the market
   is read off `s.market`. */
const fmt = (v) => (v == null ? "" : String(v));
const _isCrypto = (s) => { const m = (s && s.market) || ""; return m === "Crypto" || m === "USStockTokens"; };

function techSignal(s) {
  if (!s || !s.hasData || s.rsi == null || s.sma50 == null) return null;
  const px = s.price;
  const cur = (v) => fmt(v);
  const isCrypto = _isCrypto(s);
  const levHi = px * (isCrypto ? 1.6 : 1.4);
  const levLo = px * (isCrypto ? 0.55 : 0.7);
  const res = (s.resistance != null && s.resistance > px && s.resistance <= levHi) ? s.resistance : null;
  const sup = (s.support != null && s.support < px && s.support >= levLo) ? s.support : null;
  const atr = Math.min(s.atr || (px * 0.02), px * 0.10);
  const volRatio = (s.avgVol && s.vol != null) ? s.vol / s.avgVol : null;
  const range52 = (s.high52 != null && s.low52 != null && s.high52 > s.low52) ? (px - s.low52) / (s.high52 - s.low52) : null;
  const macdBull = s.macd != null && s.macdSignal != null && s.macd > s.macdSignal;
  const trendUp = s.sma200 != null ? s.sma50 > s.sma200 : s.price > s.sma50;

  let score = 0, signal = "", why = "", pattern = "flag";
  if (res != null && px >= res * 0.995) {
    pattern = "breakout"; signal = "Resistance breakout";
    why = `Price is pressing through the ${cur(res)} ceiling that capped it over the last 60 sessions.`; score += 3.2;
  } else if (sup != null && (px - sup) / px * 100 < 2.5 && macdBull) {
    pattern = "doubleBottom"; signal = "Bounce off support";
    why = `Price is holding the ${cur(sup)} floor with MACD turning up.`; score += 2.7;
  } else if (trendUp && macdBull && s.rsi > 50 && s.rsi < 70) {
    pattern = "triangle"; signal = "Trend continuation";
    why = `50-DMA above 200-DMA with MACD above its signal and RSI ${s.rsi}.`; score += 2.5;
  } else if (s.rsi < 35) {
    pattern = "cup"; signal = "Oversold"; why = `RSI at ${s.rsi} is oversold.`; score += 1.6;
  } else if (s.rsi > 72) {
    pattern = "flag"; signal = "Overbought"; why = `RSI ${s.rsi} is stretched.`; score -= 0.4;
  } else {
    signal = trendUp ? "Uptrend" : "Range-bound"; why = trendUp ? "Steady uptrend above the 50-DMA." : "Range-bound, no clear edge."; score += trendUp ? 1.2 : 0.2;
  }
  if (macdBull) score += 0.8;
  if (s.adx != null && s.adx > 25) score += 0.7;
  if (volRatio != null && volRatio > 1.3) { score += 0.8; }
  if (range52 != null && range52 > 0.85) score += 0.5;
  if (s.rsi > 50 && s.rsi < 68) score += 0.5;
  if (s.chg != null) score += Math.max(-1, Math.min(1, s.chg * 0.15));

  // WIN-RATE TUNING (kept in sync with the frontend): crypto targets tightened — cap +12% (was +30%) and
  // project 1.5×ATR (was 2.5×) so high-ATR coins stop setting 20%+ targets that rarely fill. Equities unchanged.
  const tpCap = px * (isCrypto ? 1.12 : 1.20);
  // LEVERAGE-AWARE STOP: crypto/US-tokens run on 20–25× leverage, so the stop is capped at 2% of price (already
  // ~40–50% of margin). Never wider. Equities (unleveraged) keep the 10% floor.
  const slFloor = px * (isCrypto ? 0.98 : 0.90);
  let target = (res != null && res <= tpCap) ? res : px + (isCrypto ? 1.5 : 2.5) * atr;
  target = Math.min(Math.max(target, px * 1.01), tpCap);
  let stop = (sup != null && sup >= slFloor) ? Math.max(sup - 0.25 * atr, slFloor) : px - 2 * atr;
  stop = Math.min(Math.max(stop, slFloor), px * 0.995);
  const slPct = +(((px - stop) / px) * 100).toFixed(1);
  const tpPct = +(((target - px) / px) * 100).toFixed(1);
  const rr = slPct > 0 ? Math.min(10, +(tpPct / slPct).toFixed(1)) : null;
  const dp = px < 1 ? 6 : px < 10 ? 4 : 2;
  return { score: +score.toFixed(2), signal, pattern, why, stop: +stop.toFixed(dp), target: +target.toFixed(dp), slPct, tpPct, rr, volRatio: volRatio != null ? +volRatio.toFixed(2) : null };
}

function techSignalShort(s) {
  if (!s || !s.hasData || s.rsi == null || s.sma50 == null) return null;
  const px = s.price;
  const isCrypto = _isCrypto(s);
  const levHi = px * (isCrypto ? 1.6 : 1.4), levLo = px * (isCrypto ? 0.55 : 0.7);
  const res = (s.resistance != null && s.resistance > px && s.resistance <= levHi) ? s.resistance : null;
  const sup = (s.support != null && s.support < px && s.support >= levLo) ? s.support : null;
  const atr = Math.min(s.atr || (px * 0.02), px * 0.10);
  const volRatio = (s.avgVol && s.vol != null) ? s.vol / s.avgVol : null;
  const macdBear = s.macd != null && s.macdSignal != null && s.macd < s.macdSignal;
  const trendDown = s.sma200 != null ? s.sma50 < s.sma200 : s.price < s.sma50;
  let score = 0, signal = "", pattern = "flag";
  if (res != null && px >= res * 0.98 && s.rsi > 58 && macdBear) { pattern = "flag"; signal = "Resistance rejection"; score += 3.2; }
  else if (s.rsi > 70 && macdBear) { pattern = "flag"; signal = "Overbought reversal"; score += 3.0; }
  else if (trendDown && macdBear && s.rsi < 50 && s.rsi > 32) { pattern = "triangle"; signal = "Downtrend continuation"; score += 2.7; }
  else if (macdBear && s.rsi < 46 && (s.chg == null || s.chg < 0)) { pattern = "flag"; signal = "Breaking down"; score += 2.4; }
  else { signal = trendDown ? "Weak / drifting lower" : "No short edge"; score += trendDown ? 1.4 : 0.1; }
  if (macdBear) score += 0.8;
  if (s.adx != null && s.adx > 25) score += 0.7;
  if (volRatio != null && volRatio > 1.3) score += 0.7;
  if (s.rsi < 30) score -= 0.8;
  if (s.chg != null) score += Math.max(-1, Math.min(1, -s.chg * 0.15));
  const tpFloor = px * (isCrypto ? 0.88 : 0.80);
  // Leverage-aware: crypto short stop capped at 2% above entry (vs 10% for unleveraged equities).
  const slCap = px * (isCrypto ? 1.02 : 1.10);
  let target = (sup != null && sup >= tpFloor) ? Math.min(sup + 0.25 * atr, px * 0.99) : px - (isCrypto ? 1.5 : 2.5) * atr;
  target = Math.max(Math.min(target, px * 0.99), tpFloor);
  let stop = (res != null && res <= slCap) ? Math.min(res + 0.25 * atr, slCap) : px + 2 * atr;
  stop = Math.max(Math.min(stop, slCap), px * 1.005);
  const slPct = +(((stop - px) / px) * 100).toFixed(1);
  const tpPct = +(((px - target) / px) * 100).toFixed(1);
  const rr = slPct > 0 ? Math.min(10, +(tpPct / slPct).toFixed(1)) : null;
  const dp = px < 1 ? 6 : px < 10 ? 4 : 2;
  return { score: +score.toFixed(2), signal, pattern, why: "", stop: +stop.toFixed(dp), target: +target.toFixed(dp), slPct, tpPct, rr };
}

/* Ranked picks — only from instruments with REAL data. Mirrors the app's dailyPicks exactly (score≥2.5 longs,
   Overbought/Oversold excluded; optional short picks for crypto). */
function dailyPicks(list, opts = {}) {
  const base = (list || []).filter((s) => s.hasData && s.rsi != null && s.sma50 != null && s.sector !== "Volatility");
  // SELECTIVITY: only take the strongest setups, and cap how many fire in one day. A lower bar (2.5) + no cap
  // meant the engine entered a long tail of marginal signals — a big driver of the low hit rate. Require score
  // >= 2.8 and keep only the top 12 by score, so capital concentrates on the highest-conviction picks.
  const longs = base
    .map((s) => ({ s, t: techSignal(s) }))
    .filter((x) => x.t && x.t.score >= 3.0 && x.t.signal !== "Overbought" && x.t.signal !== "Oversold")
    .sort((a, b) => b.t.score - a.t.score)
    .slice(0, 8)
    .map(({ s, t }) => Object.assign({}, s, { pickDir: "long", pickSide: "BUY", pickSignal: t.signal, pickSlPct: t.slPct, pickTpPct: t.tpPct, pickRR: t.rr, pickScore: t.score }));
  if (!opts.allowShorts) return longs;
  const longSyms = new Set(longs.map((s) => s.sym));
  const shorts = base
    .filter((x) => !longSyms.has(x.sym))
    .map((s) => ({ s, t: techSignalShort(s) }))
    .filter((x) => x.t && x.t.score >= 2.6)
    .sort((a, b) => b.t.score - a.t.score)
    .slice(0, 4)
    .map(({ s, t }) => Object.assign({}, s, { pickDir: "short", pickSide: "SELL", pickSignal: t.signal, pickSlPct: t.slPct, pickTpPct: t.tpPct, pickRR: t.rr, pickScore: t.score }));
  return [...longs, ...shorts];
}

module.exports = { techSignal, techSignalShort, dailyPicks };
