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
function MACDarr(a, fast = 12, slow = 26, sig = 9) { const ef = EMAarr(a, Number(fast) || 12), es = EMAarr(a, Number(slow) || 26); const line = a.map((_, i) => ef[i] - es[i]); const signal = EMAarr(line, Number(sig) || 9); const hist = line.map((v, i) => v - signal[i]); return { line, signal, hist }; }
function BBarr(a, p, mult = 2) { const m = Number(mult) || 2; const mid = SMAarr(a, p); const upper = Array(a.length).fill(NaN), lower = Array(a.length).fill(NaN); for (let i = p - 1; i < a.length; i++) { let s = 0; for (let j = i - p + 1; j <= i; j++) s += (a[j] - mid[i]) ** 2; const sd = Math.sqrt(s / p); upper[i] = mid[i] + m * sd; lower[i] = mid[i] - m * sd; } return { upper, middle: mid, lower }; }
function ROLLavg(a, p) { const o = Array(a.length).fill(NaN); for (let i = p - 1; i < a.length; i++) { let s = 0; for (let j = i - p + 1; j <= i; j++) s += (a[j] || 0); o[i] = s / p; } return o; }
function ROLLmedian(a, p) { const o = Array(a.length).fill(NaN); for (let i = p - 1; i < a.length; i++) { const w = a.slice(i - p + 1, i + 1).map((x) => x || 0).sort((x, y) => x - y); const h = Math.floor(w.length / 2); o[i] = w.length % 2 ? w[h] : (w[h - 1] + w[h]) / 2; } return o; }
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
function DMIarr(c, p) {
  const n = c.length, pDM = Array(n).fill(0), mDM = Array(n).fill(0), tr = Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = c[i].h - c[i - 1].h, dn = c[i - 1].l - c[i].l;
    pDM[i] = up > dn && up > 0 ? up : 0; mDM[i] = dn > up && dn > 0 ? dn : 0;
    tr[i] = Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c));
  }
  const atr = EMAarr(tr, p);
  const plus = EMAarr(pDM, p).map((v, i) => 100 * v / (atr[i] || 1));
  const minus = EMAarr(mDM, p).map((v, i) => 100 * v / (atr[i] || 1));
  const dx = plus.map((v, i) => { const s = v + minus[i]; return s ? 100 * Math.abs(v - minus[i]) / s : 0; });
  return { plus, minus, adx: EMAarr(dx, p) };
}
function STOCHarr(c, kLen = 14, kSmooth = 3, dSmooth = 3) {
  const n = c.length, raw = Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (i < kLen - 1) continue;
    let hi = -Infinity, lo = Infinity;
    for (let j = i - kLen + 1; j <= i; j++) { if (c[j].h > hi) hi = c[j].h; if (c[j].l < lo) lo = c[j].l; }
    raw[i] = hi === lo ? 50 : 100 * (c[i].c - lo) / (hi - lo);
  }
  const k = SMAarr(raw.map((v) => (isNaN(v) ? 0 : v)), kSmooth).map((v, i) => (raw[i] == null || isNaN(raw[i]) ? NaN : v));
  const d = SMAarr(k.map((v) => (isNaN(v) ? 0 : v)), dSmooth).map((v, i) => (isNaN(k[i]) ? NaN : v));
  return { k, d };
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
const { pivots, detectPatterns } = require("./patterns");
const PATTERN_OPERAND_PREFIX = "PAT:";
/* Support/resistance series — most recent confirmed swing low/high at or before each bar
   (with a rolling-extreme fallback early on). Mirrors frontend strategyLang.srSeries. */
function srSeries(c, kind) {
  const pv = pivots(c, 3);
  const wantT = kind === "support" ? "L" : "H";
  const out = new Array(c.length).fill(NaN);
  let last = NaN, pi = 0;
  for (let i = 0; i < c.length; i++) {
    while (pi < pv.length && pv[pi].i <= i) { if (pv[pi].t === wantT) last = pv[pi].p; pi++; }
    if (!isNaN(last)) { out[i] = last; continue; }
    let ext = kind === "support" ? Infinity : -Infinity;
    for (let j = 0; j <= i; j++) ext = kind === "support" ? Math.min(ext, c[j].l) : Math.max(ext, c[j].h);
    out[i] = ext;
  }
  return out;
}
/* 1 on bars where a chart pattern of `key` is present (held a few bars), else 0. */
function patternSeries(c, key, within = 3) {
  const s = new Array(c.length).fill(0);
  const pats = detectPatterns(c).filter((p) => p.key === key);
  for (const p of pats) for (let j = p.at; j <= Math.min(c.length - 1, p.at + within); j++) s[j] = 1;
  return s;
}
function rollExt(c, len, field, max) { const o = Array(c.length).fill(NaN); for (let i = 0; i < c.length; i++) { let v = c[i][field]; for (let j = Math.max(0, i - len + 1); j <= i; j++) v = max ? Math.max(v, c[j][field]) : Math.min(v, c[j][field]); o[i] = v; } return o; }

/* Candlestick patterns by name — mirrors frontend strategyLang.candleSeries so an armed
   strategy that says "buy on a hammer" fires the same way live as it did in the backtest. */
const CANDLE_OPERAND_PREFIX = "CDL:";
function candleSeries(c, key) {
  const s = new Array(c.length).fill(0);
  const body = (x) => Math.abs(x.c - x.o);
  const rng = (x) => (x.h - x.l) || 1e-9;
  const upW = (x) => x.h - Math.max(x.o, x.c);
  const loW = (x) => Math.min(x.o, x.c) - x.l;
  const green = (x) => x.c > x.o, red = (x) => x.c < x.o;
  for (let i = 0; i < c.length; i++) {
    const x = c[i], p = i > 0 ? c[i - 1] : null, p2 = i > 1 ? c[i - 2] : null;
    const b = body(x), r = rng(x); let hit = false;
    switch (key) {
      case "doji": hit = b <= 0.1 * r; break;
      case "hammer": hit = b > 0 && b <= 0.4 * r && loW(x) >= 2 * b && upW(x) <= b; break;
      case "hanging-man": hit = b > 0 && b <= 0.4 * r && loW(x) >= 2 * b && upW(x) <= b && !!p && green(p); break;
      case "inverted-hammer": hit = b > 0 && b <= 0.4 * r && upW(x) >= 2 * b && loW(x) <= b; break;
      case "shooting-star": hit = b > 0 && b <= 0.4 * r && upW(x) >= 2 * b && loW(x) <= b && !!p && green(p); break;
      case "marubozu": hit = b >= 0.9 * r; break;
      case "spinning-top": hit = b <= 0.35 * r && upW(x) >= b && loW(x) >= b; break;
      case "bull-engulfing": hit = !!p && red(p) && green(x) && x.o <= p.c && x.c >= p.o && b > body(p); break;
      case "bear-engulfing": hit = !!p && green(p) && red(x) && x.o >= p.c && x.c <= p.o && b > body(p); break;
      case "morning-star": hit = !!p2 && !!p && red(p2) && body(p) <= 0.4 * rng(p) && green(x) && x.c >= (p2.o + p2.c) / 2; break;
      case "evening-star": hit = !!p2 && !!p && green(p2) && body(p) <= 0.4 * rng(p) && red(x) && x.c <= (p2.o + p2.c) / 2; break;
      default: hit = false;
    }
    if (hit) s[i] = 1;
  }
  return s;
}

function resolveOperand(op, defs, c, closes, vols, cache) {
  if (op in cache) return cache[op];
  let series;
  if (op !== "" && !isNaN(Number(op))) { const n = Number(op); series = closes.map(() => n); }
  else if (op === "Price") series = closes;
  else if (op === "Volume") series = vols;
  else if (op === "Support") series = srSeries(c, "support");
  else if (op === "Resistance") series = srSeries(c, "resistance");
  else if (op.startsWith(PATTERN_OPERAND_PREFIX)) series = patternSeries(c, op.slice(PATTERN_OPERAND_PREFIX.length));
  else if (op.startsWith(CANDLE_OPERAND_PREFIX)) series = candleSeries(c, op.slice(CANDLE_OPERAND_PREFIX.length));
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
        case "MACD": { const m = MACDarr(closes, d.fast, d.slow, d.signal); series = m[attr || "line"]; break; }
        case "BB": { const b = BBarr(closes, len, d.mult); series = b[attr || "middle"]; break; }
        case "KC": { const mid = EMAarr(closes, len), at = ATRarr(c, len); series = attr === "upper" ? mid.map((v, i) => v + 1.5 * at[i]) : attr === "lower" ? mid.map((v, i) => v - 1.5 * at[i]) : mid; break; }
        case "ADX": series = ADXarr(c, len); break;
        case "DMI": { const dm = DMIarr(c, len); series = attr === "minus" ? dm.minus : attr === "adx" ? dm.adx : dm.plus; break; }
        case "Stoch": { const st = STOCHarr(c, len, Number(d.smoothK) || 3, Number(d.smoothD) || 3); series = attr === "d" ? st.d : st.k; break; }
        case "Supertrend": { const st = STarr(c, len, Number(d.mult) || 3); series = attr === "dir" ? st.dir : st.line; break; }
        case "DMA": series = SMAarr(closes, len); break;
        case "Volume": { const mode = d.mode || "raw"; series = mode === "avg" ? ROLLavg(vols, len) : mode === "median" ? ROLLmedian(vols, len) : vols; break; }
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
