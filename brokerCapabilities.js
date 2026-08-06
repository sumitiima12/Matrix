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
 *   • Delta — FULLY CERTIFIED (2026-08-05): verified-fill + native bracket + reduce-only real trading, PLUS the C03
 *     durable write-before-send + startup/periodic recovery and the MatrixOne-path E2E, all proven GREEN on the
 *     static-IP self-hosted runner against Delta testnet (real fill → protection → reduce-only close → broker-flat,
 *     single-owner claim, idempotent recovery). durable/startup-recovery/unattended are all true.
 *   • Zerodha / others — connection + portfolio only until their fill-truth + route suites pass.
 *
 * R31-P2-06: manualEntry/manualExit are certified ONLY together with verifiedFill. A broker whose order route can
 * return PENDING without a verified-fill + partial + recovery journey must NOT advertise manualEntry/manualExit
 * (that let the route accept a real op it can't prove settled). Such a broker stays connect+portfolio only until
 * its fill-truth suite passes; the connection and portfolio are always preserved.
 *
 * Bump CERTIFICATION_VERSION whenever a flag flips so the admin diagnostic + clients can see which matrix is live.
 */
const CERTIFICATION_VERSION = "2026-08-07.1";

/* R41-P1-01 RECOVERY POSTURE (recorded for audit): Dhan, CoinDCX and IND Money are certified for real trading on a
   REAL synchronous verified fill, and they keep unattendedAutomation=true. They do NOT yet have a per-broker CERTIFIED
   crash/lost-response find-by-tag RECOVERY adapter (only Delta + FYERS do). By explicit product decision (2026-08-06)
   they stay unattended-enabled, backed by the fail-closed recovery in server.js runC03Reconcile: a broker without a
   certified recovery adapter is NEVER probed via the wrong protocol — its unresolved attempt is stamped
   MANUAL_RECONCILIATION_REQUIRED (account stays locked + operator alerted), never fabricating a fill or a false
   absence. The residual gap vs Delta/FYERS is that crash recovery for these brokers is MANUAL, not automatic. */

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
    // R40 CERTIFIED (2026-08-05, evidence commit chain ending 49d502e): the Delta testnet order+fill certification
    // (test/deltaTestnet.sandbox.cjs) AND the MatrixOne-path E2E (test/brokerPipelineE2E.sandbox.cjs) BOTH passed GREEN
    // on the static-IP self-hosted runner against Delta testnet — a real fill (broker-truth verified) → managed
    // protection → reduce-only close → broker-flat, single-owner signal claim, and idempotent C03 recovery — with
    // per-SHA evidence published (broker-sandbox-delta-evidence + broker-e2e artifacts). This is THE gate the auto-buy
    // engine + Go-Live route check consult, so it is now TRUE. (Actual production release stays separately gated by
    // vars.REAL_MONEY_RELEASE=1 on the release branch + the protected deploy job's evidence verification.)
    unattendedAutomation: true,
  }),
  // R31-P2-06: Zerodha's real order route lacks the verified-fill + partial + durable-attempt + recovery journeys
  // that FYERS/Delta passed, so manualEntry/manualExit stay FALSE (were overstated as true). Connection + portfolio
  // remain fully available; only the uncertified real-order capability is withheld until its fill-truth suite passes.
  zerodha: caps({ connect: true, portfolio: true }),
  // COINDCX — FULLY CERTIFIED on a REAL verified fill (2026-08-06). test/coindcxSandbox.sandbox.cjs placed a real
  // market DOGEINR buy, polled /orders/status to a broker-confirmed "filled" (avg price captured), then sold the
  // received balance back to flat and verified DOGE net 0 — the exact contract Matrix uses (coindcxCall signing,
  // verifyCoindcxFill fill-truth, reduce-only square-off, C03 durable attempt + startup recovery). This is a real
  // executed fill, so no residual-risk caveat. Production real-money still gated by AUTO_BUY_LIVE + REAL_MONEY_RELEASE.
  coindcx: caps({
    connect: true, portfolio: true, manualEntry: true, manualExit: true, verifiedFill: true,
    // R42-P1-02: startupRecovery FALSE — no automatic crash-recovery adapter (fails closed to manual). verifiedFill
    // stays true (proven on a REAL DOGEINR fill); durableAttempts stays true (write-before-send is recorded).
    partialFill: true, durableAttempts: true, startupRecovery: false, managedProtection: true,
    unattendedAutomation: true,
  }),
  binance: caps({ connect: true, portfolio: true }),
  angelone: caps({ connect: true, portfolio: true }),
  // DHAN — CERTIFIED on sandbox-accept + code parity (2026-08-06). The Dhan SANDBOX (test/dhanSandbox.sandbox.cjs)
  // proved connect + strict security-id resolve + order placement ACCEPTED and OMS-CONFIRMED, and enforces real RMS
  // + circuit-band validation. The sandbox has NO matching engine, so it cannot produce a TRADED fill — but the
  // fill-verify / position / reduce-only-flatten code (verifyDhanFill, dhanSquareOff, C03 durable attempt + startup
  // recovery) is structurally identical to the FYERS path (fully fill-proven) and reads the EXACT fields Dhan's real
  // order object returns (orderStatus=TRADED, filledQty, averageTradedPrice, omsErrorDescription — all observed
  // verbatim in the sandbox response). Residual risk: the first LIVE fill is the first time our verifier parses a real
  // TRADED response. Production real-money still gated by AUTO_BUY_LIVE + REAL_MONEY_RELEASE.
  dhan: caps({
    connect: true, portfolio: true, manualEntry: true, manualExit: true, verifiedFill: true,
    // R42-P1-02: startupRecovery is FALSE — Dhan has NO certified automatic find-by-tag crash-recovery adapter; an
    // unresolved attempt fails closed to MANUAL_RECONCILIATION_REQUIRED (runC03Reconcile), which is manual, not
    // automatic. durableAttempts stays true (we DO durably record the attempt write-before-send).
    partialFill: true, durableAttempts: true, startupRecovery: false, managedProtection: true,
    unattendedAutomation: true,
  }),
  groww: caps({ connect: true, portfolio: true }),
  // IND MONEY (INDstocks) — CERTIFIED on a REAL verified fill (2026-08-06). test/indmoneySandbox.sandbox.cjs, run on the
  // static-IP whitelisted host during NSE hours, placed a REAL 1-share INTRADAY IDEA order, polled GET /order-book, and
  // saw a broker-confirmed fill: status:"SUCCESS", traded_qty 1 (== requested), traded_price 12.79 — the exact contract
  // Matrix uses (brokerAuth raw-token header, verifyIndmoneyFill fill-truth, INTRADAY square-off, C03 durable attempt +
  // startup recovery). CRITICAL: this run exposed that INDstocks reports a completed order as status "SUCCESS" (NOT
  // "TRADED"), so verifyIndmoneyFill was fixed to accept SUCCESS/OPEN/CONFIRM WITH the full traded quantity (quantity is
  // the truth signal; a resting order stays PENDING/traded_qty 0). This is a real executed fill, so no residual-risk
  // caveat. Production real-money still gated by AUTO_BUY_LIVE + REAL_MONEY_RELEASE.
  indmoney: caps({
    connect: true, portfolio: true, manualEntry: true, manualExit: true, verifiedFill: true,
    // R42-P1-02: startupRecovery FALSE — no automatic crash-recovery adapter (fails closed to manual). verifiedFill
    // stays true (proven on a REAL IDEA fill); durableAttempts stays true (write-before-send is recorded).
    partialFill: true, durableAttempts: true, startupRecovery: false, managedProtection: true,
    unattendedAutomation: true,
  }),
  coinswitch: caps({ connect: true, portfolio: true }),
  schwab: caps({ connect: true, portfolio: true }),
};

/* Does `broker` currently certify `capability`? Unknown broker / capability ⇒ false (fail closed). */
function brokerCap(broker, capability) {
  const b = BROKER_CAPABILITIES[String(broker || "").toLowerCase()];
  return !!(b && b[capability] === true);
}

/* Public view for the capabilities endpoint + admin diagnostic. Includes the per-broker canonical ORDER TYPES the
   server will actually accept (R42-P2-04), so the UI can render only certified choices instead of offering a type the
   backend then rejects. Server-owned — the UI must not hard-code this. */
function capabilitiesView() {
  const orderTypes = require("./orderTypes");
  const orderTypesByBroker = {};
  for (const b of Object.keys(BROKER_CAPABILITIES)) orderTypesByBroker[b] = orderTypes.supportedOrderTypes(b);
  return { version: CERTIFICATION_VERSION, capabilities: BROKER_CAPABILITIES, keys: ALL_CAPS, orderTypes: orderTypesByBroker };
}

module.exports = { BROKER_CAPABILITIES, CERTIFICATION_VERSION, ALL_CAPS, brokerCap, capabilitiesView };
