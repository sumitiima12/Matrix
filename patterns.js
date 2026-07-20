/**
 * patterns.js — CommonJS port of frontend domain/patterns.js.
 *
 * Chart-pattern recognition from real candles, kept byte-for-byte faithful to the frontend
 * detectors so a pattern-based strategy fires on EXACTLY the same signal in live trading as it
 * does in the in-app backtest. A candle is { o, h, l, c, v }.
 */
const EPS = 0.02;

function pivots(c, k = 3) {
  const out = [];
  for (let i = k; i < c.length - k; i++) {
    let isH = true, isL = true;
    for (let j = 1; j <= k; j++) {
      if (!(c[i].h > c[i - j].h && c[i].h > c[i + j].h)) isH = false;
      if (!(c[i].l < c[i - j].l && c[i].l < c[i + j].l)) isL = false;
    }
    if (isH) out.push({ i, p: c[i].h, t: "H" });
    if (isL) out.push({ i, p: c[i].l, t: "L" });
  }
  return out.sort((a, b) => a.i - b.i);
}

const near = (a, b, eps = EPS) => Math.abs(a - b) <= eps * Math.abs(a || 1);
const lastClose = (c) => c[c.length - 1].c;
function fit(pts) {
  const n = pts.length; if (n < 2) return { m: 0, b: pts[0] ? pts[0].p : 0 };
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const q of pts) { sx += q.i; sy += q.p; sxx += q.i * q.i; sxy += q.i * q.p; }
  const d = n * sxx - sx * sx || 1;
  const m = (n * sxy - sx * sy) / d;
  return { m, b: (sy - m * sx) / n };
}

function doubleBottom(c, pv) {
  const lows = pv.filter((x) => x.t === "L").slice(-2);
  const highs = pv.filter((x) => x.t === "H");
  if (lows.length < 2) return null;
  const [l1, l2] = lows;
  const peak = highs.filter((h) => h.i > l1.i && h.i < l2.i).sort((a, b) => b.p - a.p)[0];
  if (!peak || !near(l1.p, l2.p)) return null;
  const height = peak.p - Math.min(l1.p, l2.p);
  if (height <= 0) return null;
  const px = lastClose(c);
  if (px <= Math.min(l1.p, l2.p)) return null;
  return { key: "double-bottom", name: "Double Bottom", dir: "bull", breakLevel: peak.p, target: peak.p + height, at: l2.i };
}
function doubleTop(c, pv) {
  const highs = pv.filter((x) => x.t === "H").slice(-2);
  const lows = pv.filter((x) => x.t === "L");
  if (highs.length < 2) return null;
  const [h1, h2] = highs;
  const valley = lows.filter((l) => l.i > h1.i && l.i < h2.i).sort((a, b) => a.p - b.p)[0];
  if (!valley || !near(h1.p, h2.p)) return null;
  const height = Math.max(h1.p, h2.p) - valley.p;
  if (height <= 0) return null;
  return { key: "double-top", name: "Double Top", dir: "bear", breakLevel: valley.p, target: valley.p - height, at: h2.i };
}
function headShoulders(c, pv, inverse) {
  const T = inverse ? "L" : "H", V = inverse ? "H" : "L";
  const ext = pv.filter((x) => x.t === T).slice(-3);
  if (ext.length < 3) return null;
  const [ls, head, rs] = ext;
  const higher = inverse ? (head.p < ls.p && head.p < rs.p) : (head.p > ls.p && head.p > rs.p);
  if (!higher || !near(ls.p, rs.p, EPS * 1.5)) return null;
  const vs = pv.filter((x) => x.t === V && x.i > ls.i && x.i < rs.i).sort((a, b) => a.i - b.i);
  if (vs.length < 2) return null;
  const { m, b } = fit([vs[0], vs[vs.length - 1]]);
  const yAt = (t) => m * t + b;
  const lastI = c.length - 1;
  const neck = yAt(lastI);
  const height = inverse ? (yAt(head.i) - head.p) : (head.p - yAt(head.i));
  if (height <= 0) return null;
  return inverse
    ? { key: "inv-head-shoulders", name: "Inverse Head & Shoulders", dir: "bull", breakLevel: neck, target: neck + height, at: rs.i }
    : { key: "head-shoulders", name: "Head & Shoulders", dir: "bear", breakLevel: neck, target: neck - height, at: rs.i };
}
function triangle(c, pv) {
  const highs = pv.filter((x) => x.t === "H").slice(-3);
  const lows = pv.filter((x) => x.t === "L").slice(-3);
  if (highs.length < 2 || lows.length < 2) return null;
  const up = fit(highs), lo = fit(lows);
  const base = Math.min(highs[0].i, lows[0].i);
  const yU = (t) => up.m * t + up.b, yL = (t) => lo.m * t + lo.b;
  const height = yU(base) - yL(base);
  if (height <= 0) return null;
  const lastI = c.length - 1;
  const flatt = (mm, ref) => Math.abs(mm) < 0.0006 * Math.abs(ref || 1);
  const refP = c[lastI].c;
  if (flatt(up.m, refP) && lo.m > 0) return { key: "asc-triangle", name: "Ascending Triangle", dir: "bull", breakLevel: yU(lastI), target: yU(lastI) + height, at: lastI };
  if (flatt(lo.m, refP) && up.m < 0) return { key: "desc-triangle", name: "Descending Triangle", dir: "bear", breakLevel: yL(lastI), target: yL(lastI) - height, at: lastI };
  if (up.m < 0 && lo.m > 0 && near(Math.abs(up.m), Math.abs(lo.m), 0.6)) return { key: "sym-triangle", name: "Symmetrical Triangle", dir: "neutral", breakLevel: yU(lastI), target: yU(lastI) + height, at: lastI };
  return null;
}
function flag(c) {
  const n = c.length; if (n < 16) return null;
  const poleStart = n - 15, poleEnd = n - 6;
  const pole = c[poleEnd].c - c[poleStart].c;
  const seg = c.slice(n - 6);
  const hi = Math.max(...seg.map((x) => x.h)), loo = Math.min(...seg.map((x) => x.l));
  if (Math.abs(pole) < 0.03 * c[poleStart].c) return null;
  if ((hi - loo) > 0.382 * Math.abs(pole)) return null;
  if (pole > 0) return { key: "bull-flag", name: "Bull Flag", dir: "bull", breakLevel: hi, target: hi + pole, at: n - 1 };
  return { key: "bear-flag", name: "Bear Flag", dir: "bear", breakLevel: loo, target: loo + pole, at: n - 1 };
}
function wedge(c, pv) {
  const highs = pv.filter((x) => x.t === "H").slice(-3);
  const lows = pv.filter((x) => x.t === "L").slice(-3);
  if (highs.length < 2 || lows.length < 2) return null;
  const up = fit(highs), lo = fit(lows);
  const base = Math.min(highs[0].i, lows[0].i), lastI = c.length - 1;
  const height = (up.m * base + up.b) - (lo.m * base + lo.b);
  if (height <= 0) return null;
  const yU = (t) => up.m * t + up.b, yL = (t) => lo.m * t + lo.b;
  if (up.m > 0 && lo.m > up.m) return { key: "rising-wedge", name: "Rising Wedge", dir: "bear", breakLevel: yL(lastI), target: yL(lastI) - height, at: lastI };
  if (up.m < 0 && lo.m < up.m) return { key: "falling-wedge", name: "Falling Wedge", dir: "bull", breakLevel: yU(lastI), target: yU(lastI) + height, at: lastI };
  return null;
}
function rectangle(c, pv) {
  const highs = pv.filter((x) => x.t === "H").slice(-3).map((x) => x.p);
  const lows = pv.filter((x) => x.t === "L").slice(-3).map((x) => x.p);
  if (highs.length < 2 || lows.length < 2) return null;
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length); };
  const res = mean(highs), sup = mean(lows), height = res - sup;
  if (height <= 0) return null;
  if (sd(highs) > EPS * res || sd(lows) > EPS * sup) return null;
  return { key: "rectangle", name: "Rectangle Range", dir: "neutral", breakLevel: res, target: res + height, at: c.length - 1 };
}
function cupHandle(c, pv) {
  const highs = pv.filter((x) => x.t === "H");
  const lows = pv.filter((x) => x.t === "L");
  if (highs.length < 2 || !lows.length) return null;
  const rim2 = highs[highs.length - 1], rim1 = highs[highs.length - 2];
  if (!near(rim1.p, rim2.p)) return null;
  const bottom = lows.filter((l) => l.i > rim1.i && l.i < rim2.i).sort((a, b) => a.p - b.p)[0];
  if (!bottom) return null;
  const depth = Math.min(rim1.p, rim2.p) - bottom.p;
  if (depth <= 0) return null;
  const px = lastClose(c);
  if (px < bottom.p + depth * 0.5) return null;
  const handle = lows.filter((l) => l.i > rim2.i).sort((a, b) => a.p - b.p)[0];
  if (handle) { const r = (rim2.p - handle.p) / depth; if (r < 0.10 || r > 0.50) return null; }
  return { key: "cup-handle", name: "Cup & Handle", dir: "bull", breakLevel: rim2.p, target: rim2.p + depth, at: rim2.i };
}

function detectPatterns(candles) {
  const c = (candles || []).filter((x) => x && x.h != null && x.l != null && x.c != null);
  if (c.length < 20) return [];
  const pv = pivots(c, 3);
  return [cupHandle(c, pv), headShoulders(c, pv, false), headShoulders(c, pv, true),
    doubleBottom(c, pv), doubleTop(c, pv), triangle(c, pv), wedge(c, pv), flag(c), rectangle(c, pv)]
    .filter(Boolean).sort((a, b) => b.at - a.at);
}
function detectPattern(candles) { return detectPatterns(candles)[0] || null; }

module.exports = { pivots, detectPatterns, detectPattern };
