/* C03 harness — fault injection registry.
 *
 * Every persistence and broker-call boundary in the C03 subsystem calls `faults.gate(name)` (throws) or
 * `faults.tripped(name)` (boolean) before doing its work. A test ARMS a named boundary to fail a set number of
 * times, exercising: DB failure before submit, DB failure after broker acceptance, pending-protection write
 * failure, broker timeout / malformed response, etc. Boundaries are STABLE STRINGS so tests and code agree.
 *
 * Canonical boundary names (the C03 change will call these):
 *   db.attempt.prepare        — commit the PREPARED order_attempt (write-before-send)
 *   db.attempt.transition     — transition PREPARED→SUBMITTING/UNKNOWN
 *   db.attempt.finalize       — transactional ACCEPTED/PARTIAL/FILLED/REJECTED/UNKNOWN + fills/trade/lock
 *   db.pendingProtection.save — persist pending protection for an accepted order
 *   db.riskLock.set           — durable risk-lock write
 *   fyers.place               — submit order to FYERS
 *   fyers.orders              — read FYERS order book (by orderTag/id)
 *   fyers.tradebook           — read FYERS trade/execution book
 *   fyers.positions           — read FYERS positions
 */
function makeFaults() {
  const armed = new Map();   // name -> { times, error }
  return {
    /* Arm `name` to fail the next `times` calls (default 1) with `error`. */
    arm(name, { times = 1, error } = {}) {
      armed.set(name, { times: Number(times) || 1, error: error || Object.assign(new Error(`injected fault: ${name}`), { injected: true, boundary: name }) });
      return this;
    },
    disarm(name) { armed.delete(name); return this; },
    clear() { armed.clear(); return this; },
    isArmed(name) { const f = armed.get(name); return !!(f && f.times > 0); },
    /* Consume one armed failure for `name`; returns true if this call should fail. */
    tripped(name) {
      const f = armed.get(name);
      if (!f || f.times <= 0) return false;
      f.times -= 1; if (f.times <= 0) armed.delete(name);
      return true;
    },
    /* Throwing gate — the common form at a boundary: `faults.gate("db.attempt.prepare")`. */
    gate(name) {
      const f = armed.get(name);
      if (!f || f.times <= 0) return;
      f.times -= 1; const err = f.error; if (f.times <= 0) armed.delete(name);
      throw err;
    },
  };
}
/* A process-global registry so a boundary deep in production code can consult it in tests without threading a
   handle everywhere. Production leaves it empty (no boundary ever trips); only tests arm it. */
const globalFaults = makeFaults();
module.exports = { makeFaults, globalFaults };
