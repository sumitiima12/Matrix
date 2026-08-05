/* S1 — SERVER-OWNED broker capability registry.
 *
 * Safety is NOT inferred from the presence of a broker adapter. A real-money capability is `true` ONLY after that
 * broker's specific route + failure + recovery + exit + protection suite has passed. The frontend must NOT hard-code
 * these — it reads them from GET /api/broker/capabilities. Enforcement blocks ONLY the specific uncertified real
 * operation, never the whole broker (connection + portfolio stay available), and VIRTUAL trading never consults this
 * registry.
 *
 * Certification status (this program):
 *   • FYERS — passed the literal /api/broker/order route suite, C03 write-before-send + startup/periodic recovery,
 *     C01 canonical exit accounting, H04 execution events + fees, and R30 multi-source absence. Fully certified.
 *   • Delta — existing verified-fill + native bracket + reduce-only real trading, but NOT yet run through the C03
 *     durable-attempt route suite or the 2-instance multi-broker matrix ⇒ durable/startup-recovery/unattended
 *     remain UNCERTIFIED (false) pending that suite.
 *   • Zerodha / others — connection + portfolio only until their fill-truth + route suites pass.
 *
 * R31-P2-06: manualEntry/manualExit are certified ONLY together with verifiedFill. A broker whose order route can
 * return PENDING without a verified-fill + partial + recovery journey must NOT advertise manualEntry/manualExit
 * (that let the route accept a real op it can't prove settled). Such a broker stays connect+portfolio only until
 * its fill-truth suite passes; the connection and portfolio are always preserved.
 *
 * Bump CERTIFICATION_VERSION whenever a flag flips so the admin diagnostic + clients can see which matrix is live.
 */
const CERTIFICATION_VERSION = "2026-08-05.1";

const ALL_CAPS = [
  "connect", "portfolio", "manualEntry", "manualExit", "verifiedFill",
  "partialFill", "durableAttempts", "startupRecovery", "managedProtection", "unattendedAutomation",
];

function caps(o) {
  const base = Object.fromEntries(ALL_CAPS.map((c) => [c, false]));
  return { ...base, ...o };
}

const BROKER_CAPABILITIES = {
  fyers: caps({
    connect: true, portfolio: true, manualEntry: true, manualExit: true, verifiedFill: true,
    partialFill: true, durableAttempts: true, startupRecovery: true, managedProtection: true,
    unattendedAutomation: true,
  }),
  delta: caps({
    connect: true, portfolio: true, manualEntry: true, manualExit: true, verifiedFill: true,
    partialFill: true, managedProtection: true,
    // R40 — Delta now has the DURABLE write-before-send order-attempt + STARTUP/periodic broker-truth RECOVERY that
    // FYERS had (server.js Delta branch + _deltaProbeByTag/_adoptDeltaFill), proven in test/deltaRecovery.test.cjs
    // (lost-response → restart → adopt-once, no resend). Those descriptive flags are true. These gate nothing on their
    // own — they're the certification matrix shown in diagnostics.
    durableAttempts: true, startupRecovery: true,
    // unattendedAutomation stays FALSE until the MatrixOne-path E2E (test/brokerPipelineE2E.sandbox.cjs) passes GREEN
    // on the static-IP self-hosted runner against Delta testnet (broker-truth flat/close, concurrent single-owner) and
    // that per-SHA evidence is published. This is THE gate the auto-buy engine + Go-Live route check — never flip it
    // from code alone; flip it only alongside the runner-green certification evidence.
  }),
  // R31-P2-06: Zerodha's real order route lacks the verified-fill + partial + durable-attempt + recovery journeys
  // that FYERS/Delta passed, so manualEntry/manualExit stay FALSE (were overstated as true). Connection + portfolio
  // remain fully available; only the uncertified real-order capability is withheld until its fill-truth suite passes.
  zerodha: caps({ connect: true, portfolio: true }),
  coindcx: caps({ connect: true, portfolio: true }),
  binance: caps({ connect: true, portfolio: true }),
  angelone: caps({ connect: true, portfolio: true }),
  dhan: caps({ connect: true, portfolio: true }),
  groww: caps({ connect: true, portfolio: true }),
  indmoney: caps({ connect: true, portfolio: true }),
  coinswitch: caps({ connect: true, portfolio: true }),
  schwab: caps({ connect: true, portfolio: true }),
};

/* Does `broker` currently certify `capability`? Unknown broker / capability ⇒ false (fail closed). */
function brokerCap(broker, capability) {
  const b = BROKER_CAPABILITIES[String(broker || "").toLowerCase()];
  return !!(b && b[capability] === true);
}

/* Public view for the capabilities endpoint + admin diagnostic. */
function capabilitiesView() {
  return { version: CERTIFICATION_VERSION, capabilities: BROKER_CAPABILITIES, keys: ALL_CAPS };
}

module.exports = { BROKER_CAPABILITIES, CERTIFICATION_VERSION, ALL_CAPS, brokerCap, capabilitiesView };
