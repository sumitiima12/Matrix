/**
 * strategyEngine.js — server-side port of the app's strategy rule engine.
 *
 * This is a FAITHFUL CommonJS port of frontend lib/series.js + domain/strategyLang.js.
 * It exists so the server can evaluate a strategy's EXIT conditions on its own — with the
 * user's app closed — and decide whether a real position should be closed. Keeping it a
 * straight port (same maths, same names) is deliberate: the unattended exit must fire on
 * exactly the same signal the in-app engine would, or the two would disagree about when a
 * position should close. Pure functions over candle arrays; no I/O, no broker calls.
 *
 * A candle is { o, h, l, c, v, t }.
 */

/* ───────────────────────── indicator series (per-bar values) ───────────────────────── */
function SMAarr(a, p) { const o = Array(a.length).fill(NaN); let s = 0; for (let i = 0; i < a.length; i++) { s += a[i]; if (i >= p) s -= a[i - p]; if (i >= p - 1) o[i] = s / p; } return o; }
function EMAarr(a, p) { const o = Array(a.length).fill(NaN); const k = 2 / (p + 1); let prev = a[0]; o[0] = a[0]; for (let i = 1; i < a.length; i++) { prev = a[i] * k + prev * (1 - k); o[i] = prev; } return o; }
function RSIarr(a, p) { const o = Array(a.length).fill(NaN); let g = 0, l = 0; for (let i = 1; i < a.length; i++) { const d = a[i] - a[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0); if (i <= p) { g += up; l += dn; if (i === p) { g /= p; l /= p; o[i] = 100 - 100 / (1 + (l === 0 ? 100 : g / l)); } } else { g = (g * (p - 1) + up) / p; l = (l * (p - 1) + dn) / p; o[i] = 100 - 100 / (1 + (l === 0 ? 100 : g / l)); } } return o; }
function MACDarr(a) { const e12 = EMAarr(a, 12), e26 = EMAarr(a, 26); const line = a.map((_, i) => e12[i] - e26[i]); const signal = EMAarr(line, 9); const hist = line.map((v, i) => v - signal[i]); return { line, signal, hist }; }
function BBarr(a, p) { const mid = SMAarr(a, p); const upper = Array(a.length).fill(NaN), lower = Array(a.length).fill(NaN); for (let i = p - 1; i < a.length; i++) { let s = 0; for (let j = i - p + 1; j <= i; j++) s += (a[j] - mid[i]) ** 2; const sd = Math.sqrt(s / p); upper[i] = mid[i] + 2 * sd; lower[i] = mid[i] - 2 * sd; } return { upper, middle: mid, lower }; }
function CCIarr(c, p) { const tp = c.map((x) => (x.h + x.l + x.c) / 3); const sma = SMAarr(tp, p); const o = Array(c.length).fill(NaN); for (let i = p - 1; i < c.length; i++) { let md = 0; for (let j = i - p + 1; j <= i; j++) md += Math.abs(tp[j] - sma[i]); md /= p; o[i] = md === 0 ? 0 : (tp[i] - sma[i]) / (0.015 * md); } return o; }
function ATRarr(c, p) { const tr = c.map((x, i) => i === 0 ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - c[i - 1].c), Math.abs(x.l - c[i - 1].c))); return EMAarr(tr, p); }
function VWAParr(c) { let pv = 0, vv = 0; return c.map((x) => { const tp = (x.h + x.l + x.c) / 3, v = x.v || 1; pv += tp * v; vv += v; return pv / vv; }); }
function ADXarr(c, p) {
  const n = c.length, pDM = Array(n).fill(0), mDM = Array(n).fill(0), tr = Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = c[i].h - c[i - 1].h, dn = c[i - 1].l - c[i].l;
    pDM[i] = up > dn && up > 0 ? up : 0; mDM[i] = dn > up && dn > 0 ? dn : 0;
    tr[i] = Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c));
  }
  const atr = EMAarr(tr, p), pdi = EMAarr(pDM, p).map((v, i) => 100 * v / (atr[i] || 1)), mdi = EMAarr(mDM, p).map((v, i) => 100 * v / (atr[i] || 1));
  const dx = pdi.map((v, i) => { const s = v + mdi[i]; return s ? 100 * Math.abs(v - mdi[i]) / s : 0; });
  return EMAarr(dx, p);
}
function STarr(c, p = 10, mult = 3) {
  const n = c.length;
  const atr = ATRarr(c, p);
  const line = Array(n).fill(NaN);
  const dir = Array(n).fill(1);
  let prevFUpper = NaN, prevFLower = NaN, prevLine = NaN, trend = 1;
  for (let i = 0; i < n; i++) {
    const a = atr[i];
    if (isNaN(a)) { line[i] = NaN; dir[i] = 1; continue; }
    const hl2 = (c[i].h + c[i].l) / 2;
    const bUpper = hl2 + mult * a;
    const bLower = hl2 - mult * a;
    const cPrev = i > 0 ? c[i - 1].c : c[i].c;
    const fUpper = (isNaN(prevFUpper) || bUpper < prevFUpper || cPrev > prevFUpper) ? bUpper : prevFUpper;
    const fLower = (isNaN(prevFLower) || bLower > prevFLower || cPrev < prevFLower) ? bLower : prevFLower;
    if (isNaN(prevLine)) trend = 1;
    else if (prevLine === prevFUpper) trend = c[i].c > fUpper ? 1 : -1;
    else trend = c[i].c < fLower ? -1 : 1;
    line[i] = trend === 1 ? fLower : fUpper;
    dir[i] = trend;
    prevFUpper = fUpper; prevFLower = fLower; prevLine = line[i];
  }
  return { line, dir };
}
const CF = { open: "o", high: "h", low: "l", close: "c" };

/** Drop the still-forming last candle so a rule fires on a completed bar (a fact), not a
    rumour that can un-fire seconds later. Mirrors the frontend closedCandles(). */
function closedCandles(c, now = Date.now()) {
  if (!c || c.length < 3) return c || [];
  const last = c[c.length - 1];
  const prev = c[c.length - 2];
  if (last.t == null || prev.t == null) return c;
  const interval = last.t - prev.t;
  if (!(interval > 0)) return c;
  return now < last.t + interval ? c.slice(0, -1) : c;
}

/* ───────────────────────── operand + condition evaluation ───────────────────────── */
function rollExt(c, len, field, max) { const o = Array(c.length).fill(NaN); for (let i = 0; i < c.length; i++) { let v = c[i][field]; for (let j = Math.max(0, i - len + 1); j <= i; j++) v = max ? Math.max(v, c[j][field]) : Math.min(v, c[j][field]); o[i] = v; } return o; }

function resolveOperand(op, defs, c, closes, vols, cache) {
  if (op in cache) return cache[op];
  let series;
  if (op !== "" && !isNaN(Number(op))) { const n = Number(op); series = closes.map(() => n); }
  else if (op === "Price") series = closes;
  else if (op === "Volume") series = vols;
  else {
    const [nm, attr] = op.split(".");
    const d = (defs || []).find((x) => x.name === nm);
    if (!d) series = closes.map(() => NaN);
    else {
      const len = Number(d.len) || 14;
      switch (d.type) {
        case "EMA": series = EMAarr(closes, len); break;
        case "SMA": series = SMAarr(closes, len); break;
        case "RSI": series = RSIarr(closes, len); break;
        case "CCI": series = CCIarr(c, len); break;
        case "ATR": series = ATRarr(c, len); break;
        case "VWAP": series = VWAParr(c); break;
        case "MACD": { const m = MACDarr(closes); series = m[attr || "line"]; break; }
        case "BB": { const b = BBarr(closes, len); series = b[attr || "middle"]; break; }
        case "KC": { const mid = EMAarr(closes, len), at = ATRarr(c, len); series = attr === "upper" ? mid.map((v, i) => v + 1.5 * at[i]) : attr === "lower" ? mid.map((v, i) => v - 1.5 * at[i]) : mid; break; }
        case "ADX": series = ADXarr(c, len); break;
        case "Supertrend": { const st = STarr(c, len, Number(d.mult) || 3); series = attr === "dir" ? st.dir : st.line; break; }
        case "DMA": series = SMAarr(closes, len); break;
        case "Volume": series = vols; break;
        case "CurrentCandle": case "CurrentDay": { const f = CF[attr] || "c"; series = c.map((x) => x[f]); break; }
        case "PrevCandle": case "PrevDay": { const f = CF[attr] || "c"; series = c.map((x, i) => i > 0 ? c[i - 1][f] : NaN); break; }
        case "LastNCandles": { const f = CF[attr] || "c"; series = attr === "high" ? rollExt(c, len, "h", true) : attr === "low" ? rollExt(c, len, "l", false) : c.map((x, i) => (i - len + 1 >= 0 ? c[i - len + 1][f] : x[f])); break; }
        case "FirstNCandles": { const f = CF[attr] || "c"; const head = c.slice(0, Math.max(1, len)); const val = attr === "high" ? Math.max(...head.map((x) => x.h)) : attr === "low" ? Math.min(...head.map((x) => x.l)) : (attr === "open" ? head[0].o : head[head.length - 1].c); series = closes.map(() => val); break; }
        default: series = closes.map(() => NaN);
      }
    }
  }
  cache[op] = series; return series;
}

function evalCond(cond, i, get) {
  const L = get(cond.la), R = cond.bType === "num" ? null : get(cond.b);
  const lv = L[i], rv = cond.bType === "num" ? Number(cond.b) : R[i];
  const plv = L[i - 1], prv = cond.bType === "num" ? Number(cond.b) : (R ? R[i - 1] : NaN);
  if (lv == null || rv == null || isNaN(lv) || isNaN(rv)) return false;
  switch (cond.op) {
    case ">": return lv > rv; case "<": return lv < rv; case ">=": return lv >= rv; case "<=": return lv <= rv;
    case "==": return Math.abs(lv - rv) < 1e-9;
    case "crosses_above": return !isNaN(plv) && !isNaN(prv) && plv <= prv && lv > rv;
    case "crossed_above_within": {
      const n = Math.max(1, Number(cond.n) || 3);
      for (let k = 0; k < n; k++) {
        const a = L[i - k], b = cond.bType === "num" ? Number(cond.b) : (R ? R[i - k] : NaN);
        const pa = L[i - k - 1], pb = cond.bType === "num" ? Number(cond.b) : (R ? R[i - k - 1] : NaN);
        if (!isNaN(a) && !isNaN(b) && !isNaN(pa) && !isNaN(pb) && pa <= pb && a > b) return true;
      }
      return false;
    }
    case "crossed_below_within": {
      const n = Math.max(1, Number(cond.n) || 3);
      for (let k = 0; k < n; k++) {
        const a = L[i - k], b = cond.bType === "num" ? Number(cond.b) : (R ? R[i - k] : NaN);
        const pa = L[i - k - 1], pb = cond.bType === "num" ? Number(cond.b) : (R ? R[i - k - 1] : NaN);
        if (!isNaN(a) && !isNaN(b) && !isNaN(pa) && !isNaN(pb) && pa >= pb && a < b) return true;
      }
      return false;
    }
    case "crosses_below": return !isNaN(plv) && !isNaN(prv) && plv >= prv && lv < rv;
    default: return false;
  }
}

function chainEval(conds, i, get) { if (!conds || !conds.length) return false; let r = evalCond(conds[0], i, get); for (let k = 1; k < conds.length; k++) { const e = evalCond(conds[k], i, get); r = (conds[k].gate || "AND") === "OR" ? (r || e) : (r && e); } return r; }

/**
 * Does this strategy's EXIT rule fire on the latest completed candle?
 * @param cfg      strategy config { defs, exit } (same shape the builder produces)
 * @param rawCandles candles ascending by time, each { o,h,l,c,v,t }
 * @returns { fired, reason }
 */
function exitSignalFired(cfg, rawCandles) {
  try {
    if (!cfg || !Array.isArray(cfg.exit) || !cfg.exit.length) return { fired: false };
    const c = closedCandles((rawCandles || []).filter((x) => x && x.c != null));
    if (!c || c.length < 30) return { fired: false };            // not enough history to trust indicators
    const closes = c.map((x) => x.c);
    const vols = c.map((x) => x.v || 0);
    const cache = {};
    const get = (op) => resolveOperand(op, cfg.defs || [], c, closes, vols, cache);
    const i = c.length - 1;
    const fired = chainEval(cfg.exit, i, get);
    return { fired, reason: fired ? "Strategy exit signal" : undefined };
  } catch (e) {
    return { fired: false, error: String(e && e.message || e) };
  }
}

/**
 * Does this strategy's ENTRY rule fire on the latest completed candle? Same evaluation as
 * the exit, against cfg.entry. Used by the (opt-in, real-money) auto-buy engine to decide
 * whether to open a position — so it must fire on exactly the signal the in-app engine would.
 */
function entrySignalFired(cfg, rawCandles) {
  try {
    if (!cfg || !Array.isArray(cfg.entry) || !cfg.entry.length) return { fired: false };
    const c = closedCandles((rawCandles || []).filter((x) => x && x.c != null));
    if (!c || c.length < 30) return { fired: false };
    const closes = c.map((x) => x.c);
    const vols = c.map((x) => x.v || 0);
    const cache = {};
    const get = (op) => resolveOperand(op, cfg.defs || [], c, closes, vols, cache);
    const i = c.length - 1;
    const fired = chainEval(cfg.entry, i, get);
    return { fired, reason: fired ? "Strategy entry signal" : undefined, price: fired ? closes[i] : null };
  } catch (e) {
    return { fired: false, error: String(e && e.message || e) };
  }
}

/**
 * Price-level exit (stop-loss / take-profit / trailing) against candles since entry.
 * Long-only (we only auto-exit positions we opened with a buy). Mirrors the server's
 * paper resolveExit but returns a normalized shape. Ties inside a bar assume the stop.
 */
function priceExitFired(pos, rawCandles) {
  const { tp, sl, tsl, entry, entryAt } = pos || {};
  if (!(entry > 0) || (!tp && !sl && !tsl)) return { fired: false };
  const target = tp ? entry * (1 + Number(tp) / 100) : null;
  const hardStop = sl ? entry * (1 - Number(sl) / 100) : null;
  let peak = entry;
  const after = (rawCandles || []).filter((c) => c && c.t > (entryAt || 0) && c.c != null);
  for (const c of after) {
    const trailStop = tsl ? peak * (1 - Number(tsl) / 100) : null;
    const stop = Math.max(hardStop == null ? -Infinity : hardStop, trailStop == null ? -Infinity : trailStop);
    const hasStop = stop > -Infinity;
    if (hasStop && c.l <= stop) {
      const label = (trailStop != null && stop === trailStop) ? "Trailing stop" : "Stop loss";
      return { fired: true, price: +stop.toFixed(6), reason: label };
    }
    if (target != null && c.h >= target) return { fired: true, price: +target.toFixed(6), reason: "Take profit" };
    if (c.h > peak) peak = c.h;
  }
  return { fired: false };
}

module.exports = {
  SMAarr, EMAarr, RSIarr, MACDarr, BBarr, CCIarr, ATRarr, VWAParr, ADXarr, STarr,
  CF, closedCandles, resolveOperand, evalCond, chainEval,
  exitSignalFired, entrySignalFired, priceExitFired,
};
