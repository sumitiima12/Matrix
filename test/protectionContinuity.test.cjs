/* R31-P3-02 — PROTECTION CONTINUITY: pause / cancel / kill-switch must NEVER stop SL/TP monitoring or recovery for
   an already-open position. Pause/cancel/kill are ENTRY-side controls (they stop NEW orders); the exit/protection
   engine is a SEPARATE loop over open managed positions that runs regardless of the owning strategy's status.

   This is a structural regression guard on server.js: it isolates the two engine functions and asserts the
   invariant at the data-flow level — the EXIT engine monitors open positions and does NOT read the entry
   kill-switch (`haltedEntries`) or gate on a strategy being paused/cancelled, while the ENTRY engine DOES. So if a
   future edit accidentally couples pause/kill to the protection loop (which would strand a live position without a
   stop), this test fails. Deterministic, dependency-free — no DB/broker needed. */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

// Slice a top-level `async function NAME(...) { ... }` body: from its declaration to the next top-level
// `\nasync function ` (functions in server.js are declared at column 0), so we capture exactly one function.
function fnBody(name) {
  const start = SRC.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, `could not find async function ${name} in server.js`);
  const after = SRC.indexOf("\nasync function ", start + 1);
  return SRC.slice(start, after === -1 ? undefined : after);
}

const exitFn = fnBody("runAutoExitEngine");
const entryFn = fnBody("runAutoBuyEngine");

test("R31-P3-02: the EXIT engine monitors OPEN managed positions (protection runs off positions, not strategy state)", () => {
  assert.ok(/getOpenManagedPositions/.test(exitFn), "exit engine must read open managed positions to protect them");
});

test("R31-P3-02: the EXIT engine does NOT consult the entry kill-switch (haltedEntries)", () => {
  assert.ok(!/haltedEntries/.test(exitFn),
    "the protection/exit loop must NOT reference haltedEntries — the kill-switch blocks NEW entries only, never SL/TP monitoring of an open position");
});

test("R31-P3-02: the EXIT engine does NOT gate on a strategy being paused/cancelled", () => {
  // A pause/cancel sets strategy.status away from "active"; the exit loop must never skip an open position for that.
  assert.ok(!/status\s*!==\s*["']active["']/.test(exitFn),
    "the exit loop must not skip an open position because its strategy is paused/cancelled");
  assert.ok(!/status\s*===\s*["'](paused|cancelled)["']/.test(exitFn),
    "the exit loop must not branch on paused/cancelled strategy status");
});

test("R31-P3-02: the ENTRY engine DOES consult the kill-switch + pause/cancel (separation is intentional, not accidental)", () => {
  assert.ok(/haltedEntries/.test(entryFn), "the entry engine must honour the kill-switch so pause/kill blocks NEW entries");
  assert.ok(/status\s*!==\s*["']active["']/.test(entryFn), "the entry engine must skip a non-active (paused/cancelled) strategy");
});

test("R31-P3-02: the EXIT engine recovers a STRANDED 'closing' position instead of abandoning it", () => {
  // Recovery continuity: a position stuck 'closing' (crash between claim and resolution) must be reconciled/resumed,
  // never skipped forever — otherwise a live, unprotected position would be abandoned.
  assert.ok(/closingIsStale/.test(exitFn), "exit engine must detect a stale 'closing' claim");
  assert.ok(/resumed monitoring|status:\s*["']open["']/.test(exitFn), "a stranded 'closing' position must be returned to open monitoring");
});
