"use strict";
/* Correctness tests for patterns.js — chart-pattern recognition (Charts + Technical analysis, and
   the pattern-based operands the Strategy Builder exposes) and the bullishCandle candlestick
   detector used by Top Picks / analysis. Detectors must stay byte-for-byte faithful to the
   frontend, so these lock the pivot maths and the shapes each detector returns. */
const test = require("node:test");
const assert = require("node:assert");
const P = require("../patterns");

// candle with independent OHLC; for pivot tests we set h=l=c=level so extremes are unambiguous
const flat = (level) => ({ o: level, h: level, l: level, c: level, v: 1000 });
const oc = (o, h, l, c) => ({ o, h, l, c, v: 1000 });

/* ───────────────── pivots (swing highs / lows) ───────────────── */

test("pivots: flags a clean swing high and swing low", () => {
  // valley at idx 4, peak at idx 8
  const lv = [120, 116, 112, 108, 104, 108, 112, 116, 120, 116, 112, 108, 104].map(flat);
  const pv = P.pivots(lv, 3);
  assert.ok(pv.some((p) => p.t === "L" && p.i === 4), "should detect the low at index 4");
  assert.ok(pv.some((p) => p.t === "H" && p.i === 8), "should detect the high at index 8");
});

test("pivots: a monotonic ramp has no interior pivots", () => {
  const up = Array.from({ length: 12 }, (_, i) => flat(100 + i));
  assert.equal(P.pivots(up, 3).length, 0);
});

/* ───────────────── chart patterns ───────────────── */

// A clean "W": lead-in down, low1, rally to a peak, low2 (equal), then a break-out rally.
const doubleBottomCandles = [
  130, 126, 122, 118, 108,          // 0-4  (low1 @ idx4 = 108)
  112, 116, 120, 124,               // 5-8  (peak @ idx8 = 124)
  120, 116, 112, 108,               // 9-12 (low2 @ idx12 = 108)
  112, 116, 120,                    // 13-15 rally
  122, 124, 126, 128, 130, 132, 134, 136, // 16-23 break above the peak
].map(flat);

test("detectPatterns: recognises a double bottom and marks it bullish", () => {
  const found = P.detectPatterns(doubleBottomCandles);
  const db = found.find((p) => p.key === "double-bottom");
  assert.ok(db, "double-bottom should be detected");
  assert.equal(db.dir, "bull");
  assert.ok(db.target > db.breakLevel, "target projects above the breakout level");
});

test("detectPatterns: returns [] when there is not enough history", () => {
  assert.deepEqual(P.detectPatterns([flat(100), flat(101), flat(102)]), []);
});

test("detectPatterns: a flat, featureless series yields no patterns", () => {
  const flatSeries = Array.from({ length: 40 }, () => flat(100));
  assert.deepEqual(P.detectPatterns(flatSeries), []);
});

test("detectPattern: returns the single most-recent pattern (or null)", () => {
  const one = P.detectPattern(doubleBottomCandles);
  assert.ok(one && typeof one.key === "string");
  assert.equal(P.detectPattern([flat(1), flat(2)]), null);
});

/* ───────────────── bullish candlestick detector ───────────────── */

test("bullishCandle: three white soldiers", () => {
  const c = [oc(100, 105, 99, 104), oc(102, 107, 101, 106), oc(104, 109, 103, 108)];
  const r = P.bullishCandle(c);
  assert.equal(r.key, "three-soldiers");
  assert.equal(r.dir, "bull");
});

test("bullishCandle: bullish engulfing", () => {
  const c = [oc(100, 101, 99, 100.5), oc(105, 105.5, 99.5, 100), oc(99, 107, 98.5, 106)];
  const r = P.bullishCandle(c);
  assert.equal(r.key, "bull-engulfing");
});

test("bullishCandle: hammer after a down move", () => {
  const c = [oc(102, 102.5, 100.5, 101), oc(101, 101.2, 98, 99), oc(100, 100.7, 98.5, 100.5)];
  const r = P.bullishCandle(c);
  assert.equal(r.key, "hammer");
});

test("bullishCandle: returns null when no bullish pattern is present", () => {
  const c = [oc(100, 101, 99, 100), oc(100, 101, 99, 100), oc(100, 100.2, 99.8, 100)]; // dojis
  assert.equal(P.bullishCandle(c), null);
});

test("bullishCandle: needs at least three candles", () => {
  assert.equal(P.bullishCandle([oc(100, 101, 99, 100.5), oc(100, 101, 99, 100.6)]), null);
});
