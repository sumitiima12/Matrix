"use strict";
/* Correctness tests for strategyEngine.js — the shared rule engine behind Backtesting, the
   Screener, Automate/Smart Auto-Buy entry signals, the Strategy Builder and all Technical-analysis
   indicators. These pin the indicator maths and the entry/exit/price-exit signal logic so a
   strategy fires on live data exactly as it did in the in-app backtest. Pure functions, no I/O. */
const test = require("node:test");
const assert = require("node:assert");
const E = require("../strategyEngine");

// candle helpers
const mk = (o, h, l, c, v = 1000, t = 0) => ({ o, h, l, c, v, t });
// build N ascending, closed candles (t spaced 5 min, far in the past so none are "still forming")
function candles(closes, startT = 1_600_000_000_000) {
  const step = 5 * 60 * 1000;
  return closes.map((c, i) => mk(c, c + 1, c - 1, c, 1000, startT + i * step));
}
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

/* ───────────────── indicators (Technical analysis) ───────────────── */

test("SMAarr: correct window averages, NaN during warm-up", () => {
  const s = E.SMAarr([1, 2, 3, 4, 5], 2);
  assert.ok(Number.isNaN(s[0]));            // no full window yet
  assert.equal(s[1], 1.5);
  assert.equal(s[4], 4.5);
});

test("EMAarr: seeds on first value and holds a constant series", () => {
  const s = E.EMAarr([5, 5, 5, 5, 5], 3);
  assert.equal(s[0], 5);
  assert.ok(approx(s[4], 5));
});

test("RSIarr: an unbroken up-trend pins to the top of the range (~99+)", () => {
  const s = E.RSIarr(Array.from({ length: 20 }, (_, i) => i + 1), 14);
  assert.ok(s[s.length - 1] > 99);   // no-loss RS is capped, so it reads ~99.01, not exactly 100
});

test("RSIarr: an unbroken down-trend reads 0", () => {
  const s = E.RSIarr(Array.from({ length: 20 }, (_, i) => 20 - i), 14);
  assert.equal(s[s.length - 1], 0);
});

test("MACDarr: on a flat series the line and histogram are ~0", () => {
  const { line, signal, hist } = E.MACDarr(Array(40).fill(10));
  const i = 39;
  assert.ok(approx(line[i], 0, 1e-9));
  assert.ok(approx(hist[i], 0, 1e-9));
  assert.ok(approx(signal[i], 0, 1e-9));
});

test("BBarr: bands collapse onto the mean when volatility is zero", () => {
  const { upper, middle, lower } = E.BBarr(Array(30).fill(50), 20, 2);
  const i = 29;
  assert.ok(approx(upper[i], middle[i]));
  assert.ok(approx(lower[i], middle[i]));
  assert.ok(approx(middle[i], 50));
});

test("BBarr: upper and lower bands are symmetric about the middle", () => {
  const data = Array.from({ length: 30 }, (_, i) => 50 + Math.sin(i));
  const { upper, middle, lower } = E.BBarr(data, 20, 2);
  const i = 29;
  assert.ok(approx(upper[i] - middle[i], middle[i] - lower[i], 1e-9));
});

test("ATRarr: converges to a constant true-range", () => {
  const c = candles(Array(40).fill(100)); // each bar h-l = 2
  const atr = E.ATRarr(c, 14);
  assert.ok(approx(atr[atr.length - 1], 2, 1e-6));
});

test("VWAParr: first value is candle-0 typical price; stays a weighted average", () => {
  const c = candles([100, 102, 104, 106]);
  const vw = E.VWAParr(c);
  assert.ok(approx(vw[0], (c[0].h + c[0].l + c[0].c) / 3));
  assert.ok(vw[3] > 100 && vw[3] < 106);
});

test("CCIarr: produces finite readings after warm-up", () => {
  const c = candles(Array.from({ length: 40 }, (_, i) => 100 + i));
  const cci = E.CCIarr(c, 20);
  assert.ok(Number.isFinite(cci[cci.length - 1]));
});

test("ADXarr: bounded within 0..100 after warm-up", () => {
  const c = candles(Array.from({ length: 60 }, (_, i) => 100 + i));
  const adx = E.ADXarr(c, 14);
  const v = adx[adx.length - 1];
  assert.ok(Number.isFinite(v) && v >= 0 && v <= 100);
});

test("STarr: returns a line plus a direction that is always +1 or -1", () => {
  const c = candles(Array.from({ length: 50 }, (_, i) => 100 + Math.sin(i / 3) * 5));
  const { line, dir } = E.STarr(c, 10, 3);
  assert.equal(line.length, c.length);
  assert.ok(dir.every((d) => d === 1 || d === -1));
});

/* ───────────────── candle-close hygiene ───────────────── */

test("closedCandles: drops the still-forming last bar", () => {
  const step = 5 * 60 * 1000;
  const now = 1_600_000_100_000;
  const c = [mk(1, 1, 1, 1, 1, now - 2 * step), mk(1, 1, 1, 1, 1, now - step), mk(1, 1, 1, 1, 1, now - 1)];
  // last bar opened <1 interval ago → not yet closed → dropped
  assert.equal(E.closedCandles(c, now).length, 2);
});

test("closedCandles: keeps the last bar once its interval has elapsed", () => {
  const step = 5 * 60 * 1000;
  const now = 1_600_000_100_000;
  const c = [mk(1, 1, 1, 1, 1, now - 3 * step), mk(1, 1, 1, 1, 1, now - 2 * step), mk(1, 1, 1, 1, 1, now - 2 * step + step)];
  assert.equal(E.closedCandles(c, now).length, 3);
});

/* ───────────────── operands + conditions (Strategy Builder / Screener) ───────────────── */

test("resolveOperand: Price, Volume and numeric literals map to the right series", () => {
  const c = candles([10, 20, 30]);
  const closes = c.map((x) => x.c), vols = c.map((x) => x.v);
  const cache = {};
  assert.deepEqual(E.resolveOperand("Price", [], c, closes, vols, cache), closes);
  assert.deepEqual(E.resolveOperand("Volume", [], c, closes, vols, cache), vols);
  assert.deepEqual(E.resolveOperand("30", [], c, closes, vols, cache), [30, 30, 30]);
});

test("resolveOperand: an indicator def resolves to its computed series", () => {
  const c = candles(Array.from({ length: 20 }, (_, i) => 100 + i));
  const closes = c.map((x) => x.c), vols = c.map((x) => x.v);
  const defs = [{ type: "EMA", len: 5, name: "E1" }];
  const got = E.resolveOperand("E1.close", defs, c, closes, vols, {});
  const want = E.EMAarr(closes, 5);
  assert.ok(approx(got[got.length - 1], want[want.length - 1], 1e-9));
});

test("evalCond: greater-than compares the current bar", () => {
  const get = (op) => (op === "L" ? [1, 2, 3] : [0, 0, 0]);
  assert.equal(E.evalCond({ la: "L", op: ">", b: "R", bType: "ind" }, 2, get), true);
  assert.equal(E.evalCond({ la: "L", op: ">", b: "R", bType: "ind" }, 2, (o) => (o === "L" ? [-1, -1, -1] : [0, 0, 0])), false);
});

test("evalCond: crosses_above fires only on the crossing bar", () => {
  const get = (op) => (op === "L" ? [98, 99, 101] : [100, 100, 100]);
  assert.equal(E.evalCond({ la: "L", op: "crosses_above", b: "R", bType: "ind" }, 2, get), true);   // 99→101 over 100
  assert.equal(E.evalCond({ la: "L", op: "crosses_above", b: "R", bType: "ind" }, 1, get), false);  // 98→99, still under
});

test("chainEval: AND requires all, OR requires any", () => {
  const get = (op) => ({ A: [1, 1, 5], B: [1, 1, 0], K10: [1, 1, 10] }[op]);
  const T = { la: "A", op: ">", b: "B", bType: "ind" };            // 5 > 0  → true
  const F = { la: "A", op: ">", b: "K10", bType: "ind", gate: "AND" }; // 5 > 10 → false
  assert.equal(E.chainEval([T, F], 2, get), false);                // true AND false
  assert.equal(E.chainEval([T, { ...F, gate: "OR" }], 2, get), true); // true OR false
});

/* ───────────────── entry / exit / price-exit signals (Automate + Backtest) ───────────────── */

test("entrySignalFired: fires when the entry rule is met on the last closed bar", () => {
  const cfg = { entry: [{ la: "Price", op: ">", b: "100", bType: "num" }], defs: [] };
  const c = candles(Array.from({ length: 35 }, (_, i) => 90 + i)); // last close 124 > 100
  const r = E.entrySignalFired(cfg, c);
  assert.equal(r.fired, true);
  assert.ok(r.price > 100);
});

test("entrySignalFired: does not fire without enough history", () => {
  const cfg = { entry: [{ la: "Price", op: ">", b: "0", bType: "num" }], defs: [] };
  const r = E.entrySignalFired(cfg, candles([1, 2, 3, 4, 5]));
  assert.equal(r.fired, false);
});

test("entrySignalFired: crosses_above a level triggers on the crossing bar", () => {
  const rising = Array.from({ length: 33 }, (_, i) => 90 + i * 0.2).concat([99, 101]); // last two 99→101
  const cfg = { entry: [{ la: "Price", op: "crosses_above", b: "100", bType: "num" }], defs: [] };
  assert.equal(E.entrySignalFired(cfg, candles(rising)).fired, true);
});

test("exitSignalFired: fires when the exit rule is met", () => {
  const cfg = { exit: [{ la: "Price", op: "<", b: "100", bType: "num" }], defs: [] };
  const c = candles(Array.from({ length: 35 }, (_, i) => 130 - i)); // last close 96 < 100
  assert.equal(E.exitSignalFired(cfg, c).fired, true);
});

test("priceExitFired: take-profit books at the target", () => {
  const pos = { entry: 100, tp: 2, sl: 1, entryAt: 0 };
  const after = [mk(100, 101, 100, 100.5, 1, 1), mk(100.5, 103, 100, 102.5, 1, 2)]; // 2nd bar high 103 ≥ 102
  const r = E.priceExitFired(pos, after);
  assert.equal(r.fired, true);
  assert.equal(r.reason, "Take profit");
  assert.ok(approx(r.price, 102));
});

test("priceExitFired: stop-loss books at the stop", () => {
  const pos = { entry: 100, tp: 5, sl: 1, entryAt: 0 };
  const after = [mk(100, 100.5, 98, 98.5, 1, 1)]; // low 98 ≤ stop 99
  const r = E.priceExitFired(pos, after);
  assert.equal(r.fired, true);
  assert.equal(r.reason, "Stop loss");
  assert.ok(approx(r.price, 99));
});

test("priceExitFired: trailing stop follows the peak down", () => {
  const pos = { entry: 100, tsl: 5, entryAt: 0 };
  const after = [mk(100, 110, 100, 109, 1, 1), mk(109, 109, 104, 104, 1, 2)]; // peak 110 → trail 104.5, low 104 hits
  const r = E.priceExitFired(pos, after);
  assert.equal(r.fired, true);
  assert.equal(r.reason, "Trailing stop");
});

test("priceExitFired: nothing fires when no level is touched", () => {
  const pos = { entry: 100, tp: 10, sl: 10, entryAt: 0 };
  const after = [mk(100, 101, 99, 100.5, 1, 1)];
  assert.equal(E.priceExitFired(pos, after).fired, false);
});

test("priceExitFired SHORT: stop-loss fires when price RISES into the stop", () => {
  // Short at 100, sl 1% → stop is ABOVE at 101. A rising bar (high 101.2) hits the stop = a loss.
  const pos = { entry: 100, sl: 1, tp: 3, entryAt: 0, short: true };
  const after = [mk(100, 101.2, 100.5, 100.8, 1, 1)];
  const r = E.priceExitFired(pos, after);
  assert.equal(r.fired, true);
  assert.equal(r.reason, "Stop loss");
  assert.ok(approx(r.price, 101));
});

test("priceExitFired SHORT: take-profit fires when price FALLS to the target", () => {
  // Short at 100, tp 3% → target is BELOW at 97. A falling bar (low 96.5) books the profit.
  const pos = { entry: 100, sl: 1, tp: 3, entryAt: 0, short: true };
  const after = [mk(100, 100.2, 96.5, 97, 1, 1)];
  const r = E.priceExitFired(pos, after);
  assert.equal(r.fired, true);
  assert.equal(r.reason, "Take profit");
  assert.ok(approx(r.price, 97));
});

test("priceExitFired SHORT via side:SELL: same as short flag", () => {
  const pos = { entry: 100, sl: 1, tp: 3, entryAt: 0, side: "SELL" };
  const r = E.priceExitFired(pos, [mk(100, 101.5, 100.5, 101, 1, 1)]);
  assert.equal(r.fired, true);
  assert.equal(r.reason, "Stop loss");
});

test("priceExitFired SHORT: a price DROP does not trigger the stop (would for a long)", () => {
  // A long at 100 sl 1% would stop at 99 on this drop; a short must NOT stop out on a favorable drop.
  const pos = { entry: 100, sl: 1, tp: 10, entryAt: 0, short: true };
  const after = [mk(100, 100.1, 98.5, 98.7, 1, 1)];
  assert.equal(E.priceExitFired(pos, after).fired, false);
});
