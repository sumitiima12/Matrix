"use strict";
/* Correctness tests for the optimiser scoring math (optimizerCore.js) — the numbers reported by
   "Optimize SL & TP" and "Optimize Indicators" (win rate, SL hit, TP hit, P&L, return) all come from
   evalExitPair, so these hand-computed cases pin those numbers down. */
const test = require("node:test");
const assert = require("node:assert");
const { evalExitPair, optRanker, lenOptions } = require("../optimizerCore");

// A candle. Only o/h/l/c matter to the evaluator.
const bar = (o, h, l, c) => ({ o, h, l, c });
// One entry event: the SIGNAL is on bar 0 (its close). CAUSAL execution fills the entry at bar 1's
// OPEN — never bar 0's close — so every fixture puts the entry bar at index 1.
const ev = (candles) => ({ c: candles, e: 0 });

test("TP hit: entry 100 (next-bar open), TP 2% → +2% return, exit at 102, P&L +2", () => {
  const r = evalExitPair(1, 2, [ev([bar(90, 90, 90, 90), bar(100, 103, 99.5, 101)])]);
  assert.equal(r.trades, 1);
  assert.equal(r.tpHit, 1);
  assert.equal(r.slHit, 0);
  assert.equal(r.wins, 1);
  assert.equal(r.winRate, 100);
  assert.equal(r.retPct, 2);      // +tp%
  assert.equal(r.pnl, 2);         // 102 - 100
});

test("SL hit: entry 100 (next-bar open), SL 1% → -1% return, exit at 99, P&L -1", () => {
  const r = evalExitPair(1, 5, [ev([bar(90, 90, 90, 90), bar(100, 101, 98, 99)])]);
  assert.equal(r.slHit, 1);
  assert.equal(r.tpHit, 0);
  assert.equal(r.wins, 0);
  assert.equal(r.winRate, 0);
  assert.equal(r.retPct, -1);
  assert.equal(r.pnl, -1);        // 99 - 100
});

test("SHORT TP hit: entry 100, TP 2% → target 98 hit on a drop, P&L +2 (price fell)", () => {
  // Short profits when price falls; TP sits BELOW at 98. The entry bar dips to 97 and books the win.
  const r = evalExitPair(1, 2, [ev([bar(110, 110, 110, 110), bar(100, 100, 97, 98)])], 200, true);
  assert.equal(r.tpHit, 1);
  assert.equal(r.slHit, 0);
  assert.equal(r.winRate, 100);
  assert.equal(r.retPct, 2);      // +tp% in the short's favour
  assert.equal(r.pnl, 2);         // entry 100 - exit 98
});

test("SHORT SL hit: entry 100, SL 1% → stop 101 hit on a rise, P&L -1 (price rose)", () => {
  // Short's stop sits ABOVE at 101. The entry bar rises to 102 and stops it out.
  const r = evalExitPair(1, 5, [ev([bar(90, 90, 90, 90), bar(100, 102, 99, 101)])], 200, true);
  assert.equal(r.slHit, 1);
  assert.equal(r.tpHit, 0);
  assert.equal(r.winRate, 0);
  assert.equal(r.retPct, -1);
  assert.equal(r.pnl, -1);        // entry 100 - exit 101
});

test("No level touched → exits at the window's last close", () => {
  const r = evalExitPair(10, 10, [ev([bar(90, 90, 90, 90), bar(100, 101, 99, 100.5)])]);
  assert.equal(r.slHit, 0);
  assert.equal(r.tpHit, 0);
  assert.equal(r.retPct, 0.5);    // (100.5/100 - 1)*100
  assert.equal(r.pnl, 0.5);       // 100.5 - 100
  assert.equal(r.wins, 1);
});

test("Same-bar tie resolves to the STOP (conservative)", () => {
  // Entry bar reaches both stop(98) and target(102); the evaluator must book the stop.
  const r = evalExitPair(2, 2, [ev([bar(90, 90, 90, 90), bar(100, 103, 97, 100)])]);
  assert.equal(r.slHit, 1);
  assert.equal(r.tpHit, 0);
  assert.equal(r.pnl, -2);        // exit at stop 98
});

test("Aggregate of 3 events: win rate, SL/TP hit counts, summed return & P&L", () => {
  const events = [
    ev([bar(90, 90, 90, 90), bar(100, 103, 99.5, 101)]),      // TP hit  +2, pnl +2 (entry 100)
    ev([bar(90, 90, 90, 90), bar(100, 101, 98, 99)]),         // SL hit  -1, pnl -1 (entry 100)
    ev([bar(190, 190, 190, 190), bar(200, 205, 199, 204)]),   // TP hit  +2, pnl +4 (entry 200→204)
  ];
  const r = evalExitPair(1, 2, events);
  assert.equal(r.trades, 3);
  assert.equal(r.wins, 2);
  assert.equal(r.tpHit, 2);
  assert.equal(r.slHit, 1);
  assert.equal(r.winRate, 66.7);          // 2/3
  assert.equal(r.retPct, 3);              // +2 -1 +2
  assert.equal(r.pnl, 5);                 // +2 -1 +4
  assert.equal(r.expectancy, 1);          // 3 / 3
});

test("optRanker(winrate) prefers higher win rate, then return", () => {
  const a = { winRate: 70, retPct: 5 };
  const b = { winRate: 60, retPct: 50 };
  assert.ok(optRanker("winrate")(a, b) < 0);   // a ranks first
});

test("optRanker(pnl) prefers higher return, then win rate", () => {
  const a = { winRate: 70, retPct: 5 };
  const b = { winRate: 60, retPct: 50 };
  assert.ok(optRanker("pnl")(b, a) < 0);        // b ranks first
});

test("lenOptions sweeps sensible candidate lengths, floored at 2", () => {
  assert.deepEqual(lenOptions(13), [7, 9, 13, 18, 26]);   // 0.5,0.7,1,1.4,2 ×13 rounded
  assert.deepEqual(lenOptions(3), [2, 3, 4, 6]);          // floor at 2, de-duped
  assert.equal(lenOptions(""), null);                     // non-numeric (MACD/VWAP) untouched
  assert.equal(lenOptions(0), null);
});

test("No events → null (nothing to report)", () => {
  assert.equal(evalExitPair(1, 2, []), null);
});
