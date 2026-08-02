/**
 * test/parity.test.cjs — FE↔BE strategy-engine DRIFT GUARD.
 *
 * The strategy language (indicators + operand resolution + condition evaluation) is intentionally
 * duplicated: strategyEngine.js here, src/domain/strategyLang.js in the frontend. Duplication risks
 * DRIFT — one side changes, the other doesn't, and a strategy backtests differently from how it trades
 * live. This test pins a canonical rule + candle series to a GOLDEN signal sequence. The IDENTICAL
 * fixture + expected result lives in the frontend's test/parity.test.mjs — if either engine's math
 * drifts, its parity test fails, flagging the divergence before it reaches real orders.
 *
 * GOLDEN (keep byte-for-byte in sync with the frontend copy):
 *   rule    : close crosses above SMA(3)
 *   prices  : [100,99,98,99,101,103,102,104,106,105,107,109]
 *   signals : entry fires on bar indices [3, 7, 10]
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const BE = require("../strategyEngine.js");

const CFG = { entry: [{ la: "CC.close", op: "crosses_above", b: "SMA3", bType: "ind" }], exit: [], defs: [{ type: "CurrentCandle", len: "", name: "CC" }, { type: "SMA", len: "3", name: "SMA3" }], sl: 2, tp: 3 };
const PX = [100, 99, 98, 99, 101, 103, 102, 104, 106, 105, 107, 109];
const GOLDEN_SIGNALS = [3, 7, 10];

function signals(cfg, px) {
  const c = px.map((v, i) => ({ o: v - 0.2, h: v + 0.5, l: v - 0.5, c: v, v: 1000, t: i * 300000 }));
  const closes = c.map((x) => x.c), vols = c.map((x) => x.v), cache = {};
  const get = (op) => BE.resolveOperand(op, cfg.defs, c, closes, vols, cache, "5m");
  const out = [];
  for (let i = 1; i < c.length; i++) if (BE.chainEval(cfg.entry, i, get)) out.push(i);
  return out;
}

test("backend engine matches the shared golden signal sequence (FE↔BE parity)", () => {
  assert.deepEqual(signals(CFG, PX), GOLDEN_SIGNALS);
});
