"use strict";
/* Per-account PIN/answer brute-force lockout (P1-12/13). A wrong PIN on the Real-mode step-up used to
   be unlimited; these pin down: N failures trip a lock, the lock reports a retry window, a success
   clears the counter, and the lock lifts after the window. Clock is injected so time is deterministic. */
const test = require("node:test");
const assert = require("node:assert");
const { createPinLock } = require("../pinLock");

test("locks after maxFails wrong attempts, not before", () => {
  const lock = createPinLock({ maxFails: 5, lockMs: 60000, now: () => 1000 });
  for (let i = 0; i < 4; i++) { lock.fail("ph_1"); assert.equal(lock.state("ph_1").locked, false); }
  lock.fail("ph_1");                                   // 5th failure trips it
  const s = lock.state("ph_1");
  assert.equal(s.locked, true);
  assert.ok(s.retrySec > 0 && s.retrySec <= 60);
});

test("a correct attempt clears the counter before the lock trips", () => {
  const lock = createPinLock({ maxFails: 3, lockMs: 60000, now: () => 0 });
  lock.fail("ph_2"); lock.fail("ph_2");
  lock.clear("ph_2");                                  // correct PIN
  lock.fail("ph_2"); lock.fail("ph_2");                // two more fails — still under the cap
  assert.equal(lock.state("ph_2").locked, false);
});

test("the lock lifts after lockMs elapses", () => {
  let t = 0;
  const lock = createPinLock({ maxFails: 2, lockMs: 1000, now: () => t });
  lock.fail("ph_3"); lock.fail("ph_3");               // locked at t=0 until t=1000
  assert.equal(lock.state("ph_3").locked, true);
  t = 999;  assert.equal(lock.state("ph_3").locked, true);
  t = 1001; assert.equal(lock.state("ph_3").locked, false);
});

test("keys are independent (PIN vs recovery answer namespaces don't collide)", () => {
  const lock = createPinLock({ maxFails: 2, lockMs: 60000, now: () => 0 });
  lock.fail("ph_9"); lock.fail("ph_9");               // login PIN locked
  assert.equal(lock.state("ph_9").locked, true);
  assert.equal(lock.state("ans:ph_9").locked, false); // recovery-answer key untouched
});
