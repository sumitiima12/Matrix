/**
 * test/parity.test.cjs — FE↔BE strategy-engine DRIFT GUARD.
 *
 * The strategy language (indicators + operand resolution + condition evaluation) is intentionally
 * duplicated: strategyEngine.js here, src/domain/strategyLang.js in the frontend. Duplication risks
 * DRIFT — one side changes, the other doesn't, and a strategy backtests differently from how it trades
 * live. This test replays a SHARED golden fixture (test/parity-fixtures.json — a byte-identical copy
 * lives in the frontend) covering multiple operators (SMA/EMA crosses, RSI thresholds, candle, volume)
 * and asserts this engine reproduces the exact entry-signal sequence both engines were generated to
 * agree on. If either engine's math drifts, its parity test fails.
 *
 * The fixture is GENERATED from both engines (only agreeing scenarios are kept) — do not hand-edit the
 * expected arrays; regenerate with the parity generator.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const BE = require("../strategyEngine.js");

const FIX = JSON.parse(readFileSync(path.join(__dirname, "parity-fixtures.json"), "utf8"));

function signals(cfg) {
  const c = FIX.px.map((v, i) => ({ o: v - 0.2, h: v + 0.6, l: v - 0.6, c: v, v: FIX.vol[i], t: i * 300000 }));
  const closes = c.map((x) => x.c), vols = c.map((x) => x.v), cache = {};
  const get = (op) => BE.resolveOperand(op, cfg.defs, c, closes, vols, cache, "5m");
  const out = [];
  for (let i = 1; i < c.length; i++) if (BE.chainEval(cfg.entry, i, get)) out.push(i);
  return out;
}

test(`backend engine matches ${FIX.scenarios.length} shared golden scenarios (FE↔BE parity)`, () => {
  assert.ok(FIX.scenarios.length >= 5, "fixture should cover several operators");
  for (const s of FIX.scenarios) {
    assert.deepEqual(signals(s.cfg), s.signals, `signal drift on rule: ${s.rule}`);
  }
});
