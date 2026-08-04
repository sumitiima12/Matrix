/* R31-P2-07 — ATTEMPT-TIMESTAMP GATE before declaring a FYERS order ABSENT.
   FYERS' order book / tradebook are day/window-scoped and lag right after placement, so "not found in any live read"
   is only trustworthy once the attempt is old enough that broker-side propagation can't still be hiding it. These
   unit tests pin that decision (reconcile.safeToDeclareAbsent) — the pure predicate the live probe now consults
   before returning { status: "absent" }. A future/unknown timestamp or a too-recent attempt must NEVER be declared
   absent (stay locked, retry a later sweep); only a sufficiently old attempt may be. Pure — no DB/broker needed. */
const test = require("node:test");
const assert = require("node:assert");
const reconcile = require("../reconcile.js");

const MIN = 120000;      // 2 minutes, the production default
const NOW = 1_700_000_000_000;

test("R31-P2-07: an attempt with NO timestamp is never declarable absent (unknown age ⇒ stay locked)", () => {
  assert.equal(reconcile.safeToDeclareAbsent({}, { now: NOW, minAgeMs: MIN }), false);
  assert.equal(reconcile.safeToDeclareAbsent({ createdAt: null }, { now: NOW, minAgeMs: MIN }), false);
  assert.equal(reconcile.safeToDeclareAbsent({ createdAt: "not-a-number" }, { now: NOW, minAgeMs: MIN }), false);
  assert.equal(reconcile.safeToDeclareAbsent(null, { now: NOW, minAgeMs: MIN }), false);
});

test("R31-P2-07: a TOO-RECENT attempt (inside the lag window) is not declarable absent", () => {
  assert.equal(reconcile.safeToDeclareAbsent({ createdAt: NOW - 1 }, { now: NOW, minAgeMs: MIN }), false, "1ms old");
  assert.equal(reconcile.safeToDeclareAbsent({ createdAt: NOW - (MIN - 1) }, { now: NOW, minAgeMs: MIN }), false, "just under the window");
  assert.equal(reconcile.safeToDeclareAbsent({ createdAt: NOW }, { now: NOW, minAgeMs: MIN }), false, "same instant");
});

test("R31-P2-07: a FUTURE timestamp (clock skew) is treated as too-recent, never absent", () => {
  assert.equal(reconcile.safeToDeclareAbsent({ createdAt: NOW + 5000 }, { now: NOW, minAgeMs: MIN }), false);
});

test("R31-P2-07: an OLD-ENOUGH attempt is declarable absent (exactly at and beyond the window)", () => {
  assert.equal(reconcile.safeToDeclareAbsent({ createdAt: NOW - MIN }, { now: NOW, minAgeMs: MIN }), true, "exactly the window");
  assert.equal(reconcile.safeToDeclareAbsent({ createdAt: NOW - (MIN + 60000) }, { now: NOW, minAgeMs: MIN }), true, "well beyond");
  // The next-day recovery case: an attempt from yesterday that all live reads no longer show is safely absent.
  assert.equal(reconcile.safeToDeclareAbsent({ createdAt: NOW - 24 * 3600 * 1000 }, { now: NOW, minAgeMs: MIN }), true, "a day old");
});

test("R31-P2-07: accepts the snake_case created_at column too (DB row shape)", () => {
  assert.equal(reconcile.safeToDeclareAbsent({ created_at: NOW - MIN }, { now: NOW, minAgeMs: MIN }), true);
  assert.equal(reconcile.safeToDeclareAbsent({ created_at: NOW - 1 }, { now: NOW, minAgeMs: MIN }), false);
});

test("R31-P2-07: monotone in age — once old enough to be absent, staying older stays absent", () => {
  for (let extra = 0; extra <= 10; extra++) {
    const created = NOW - MIN - extra * 1000;
    assert.equal(reconcile.safeToDeclareAbsent({ createdAt: created }, { now: NOW, minAgeMs: MIN }), true);
  }
});

// R32-P2-06 — coverage window: a PREVIOUS-session attempt is not covered by today's day-scoped books, so it must
// NOT be declared absent even though it's "old enough". Only an attempt within the coverage window can be absent.
const SESSION_START = NOW - 3 * 3600 * 1000;   // session began 3h ago
test("R32-P2-06: a within-session, old-enough attempt CAN be declared absent", () => {
  const created = SESSION_START + 60 * 1000;   // 1 min into the session, and > minAge old vs NOW
  assert.equal(reconcile.safeToDeclareAbsent({ createdAt: created }, { now: NOW, minAgeMs: MIN, coverageStartMs: SESSION_START }), true);
});
test("R32-P2-06: a PREVIOUS-session attempt is NEVER absent (books don't cover it → stay UNKNOWN)", () => {
  const yesterday = SESSION_START - 24 * 3600 * 1000;   // clearly before this session's coverage window
  assert.equal(reconcile.safeToDeclareAbsent({ createdAt: yesterday }, { now: NOW, minAgeMs: MIN, coverageStartMs: SESSION_START }), false);
});
test("R32-P2-06: exactly at the coverage boundary is covered; one ms before is not", () => {
  assert.equal(reconcile.safeToDeclareAbsent({ createdAt: SESSION_START }, { now: NOW, minAgeMs: MIN, coverageStartMs: SESSION_START }), true, "at the boundary is covered");
  assert.equal(reconcile.safeToDeclareAbsent({ createdAt: SESSION_START - 1 }, { now: NOW, minAgeMs: MIN, coverageStartMs: SESSION_START }), false, "just before the window is not");
});
