/* C03 harness — deterministic clock.
 *
 * A controllable time source so fault-injection tests can advance/hold time exactly (delayed fills, stale
 * evidence, freshness watermarks) without real sleeps. The C03 subsystem reads `now()` from an injected clock;
 * production passes `Date.now`, tests pass this. Never wall-clock in a test that asserts time-dependent state.
 */
function makeClock(startMs = Date.UTC(2026, 0, 1, 9, 30, 0)) {
  let now = Number(startMs);
  return {
    now: () => now,
    advance: (ms) => { now += Number(ms) || 0; return now; },
    set: (ms) => { now = Number(ms) || 0; return now; },
    iso: () => new Date(now).toISOString(),
  };
}
module.exports = { makeClock };
