/* faultHook — production-safe fault-injection seam.
 *
 * The C03 durable order-attempt state machine must be provable with faults injected at each persistence
 * boundary (DB failure before send, after acceptance, etc.). Production code calls `gate(name)` at those
 * boundaries; it is a NO-OP in production because nothing is ever armed there. ONLY tests arm boundaries.
 *
 * This lives in the app (not test/) so db.js can consult it without importing test-only modules. It carries
 * no state unless a test arms it, so shipping it changes no production behaviour.
 *
 * Canonical boundary names (kept in sync with test/harness/README.md):
 *   db.attempt.prepare | db.attempt.transition | db.attempt.finalize
 *   db.pendingProtection.save | db.riskLock.set
 */
const armed = new Map();   // name -> remaining trip count

function arm(name, times = 1) { armed.set(String(name), Math.max(1, Number(times) || 1)); }
function disarm(name) { armed.delete(String(name)); }
function clear() { armed.clear(); }
function isArmed(name) { return (armed.get(String(name)) || 0) > 0; }

/* Throwing gate — the common form at a boundary. Consumes one armed trip and throws an injected error. */
function gate(name) {
  const n = armed.get(String(name)) || 0;
  if (n <= 0) return;
  if (n <= 1) armed.delete(String(name)); else armed.set(String(name), n - 1);
  throw Object.assign(new Error(`injected fault: ${name}`), { injected: true, boundary: String(name) });
}

module.exports = { arm, disarm, clear, isArmed, gate };
