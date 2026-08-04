/* R38-P2-03 — MatrixOne-PATH real-broker integration certification (scaffold).
 *
 * The raw *.sandbox.cjs suites prove broker CREDENTIALS + broker SEMANTICS (a real fill and a reduce-only close). They
 * do NOT prove MatrixOne's own unattended execution pipeline. This suite is the certification that DOES: it drives an
 * order through MatrixOne's authenticated execution boundary against a REAL broker sandbox + a REAL PostgreSQL, and
 * proves the safety invariants end to end:
 *   1. ENTRY through MatrixOne's order path with an idempotency key + a durable order-attempt ledger row;
 *   2. AUTHORITATIVE FILL JOURNAL — the fill is recorded once in the append-only ledger from broker truth;
 *   3. MANAGED PROTECTION — SL/TP or a managed exit is registered and verified;
 *   4. REDUCE-ONLY CLOSE — the exit flattens the position; broker state is FLAT and the local trade projects closed;
 *   5. LEDGER/P&L MATCH — local ledger + risk match the broker's realized outcome;
 *   6. RETRY IDEMPOTENCY — replaying the same order key does NOT double-submit;
 *   7. LOST-RESPONSE RECOVERY — an ambiguous submit is reconciled from broker truth on restart, not re-sent;
 *   8. SINGLE-OWNER — two app instances contend; exactly one owns the entry/close (lease/fencing).
 *
 * GATE (fail-closed, never a false green):
 *   • Runs ONLY when BROKER_E2E=1 AND DATABASE_URL is set AND a complete broker sandbox credential set is present.
 *   • BROKER_E2E=1 with any of those missing ⇒ THROWS in setup (a certification run can never silently skip/pass).
 *   • Without BROKER_E2E it self-skips (ordinary PR/dev). It is NOT part of the default `npm test` safety gate; it is a
 *     separate, explicitly-invoked certification job so it can never masquerade as covered when it isn't.
 *
 * STATUS: the journey wiring against the live sandbox is NOT YET IMPLEMENTED. Until it is, an ENABLED run FAILS LOUD
 * (below) rather than passing — so this file can never be mistaken for certification evidence it hasn't produced. This
 * is deliberate per R38-P2-03: raw endpoint tests alone are not unattended-automation certification.
 */
const test = require("node:test");
const assert = require("node:assert");

const E2E = /^(1|true|yes)$/i.test(String(process.env.BROKER_E2E || ""));
const HAS_DB = !!process.env.DATABASE_URL;
const FYERS_OK = !!(process.env.FYERS_SANDBOX_APP_ID && process.env.FYERS_SANDBOX_TOKEN);
const DELTA_OK = !!(process.env.DELTA_SANDBOX_KEY && process.env.DELTA_SANDBOX_SECRET);
const READY = HAS_DB && (FYERS_OK || DELTA_OK);

test.before(() => {
  if (!E2E) return;                       // not a certification run; the test self-skips below
  if (!HAS_DB) throw new Error("BROKER_E2E=1 requires DATABASE_URL (a real PostgreSQL for the MatrixOne pipeline)");
  if (!FYERS_OK && !DELTA_OK) throw new Error("BROKER_E2E=1 requires a complete FYERS or Delta sandbox credential set");
});

test("matrixone-pipeline-e2e: entry → journal → managed exit → reduce-only close → flat → ledger match (single-owner)", (t) => {
  if (!E2E || !READY) { t.skip("BROKER_E2E not enabled / DATABASE_URL or broker creds missing"); return; }
  // R38-P2-03: fail-closed until the live pipeline journey is wired. Never emit a green pass without proving the journey.
  assert.fail("MatrixOne-path real-broker E2E journey is not yet implemented — do NOT treat this suite as certification. See docs/RELEASE_GATE.md for the required journey and wiring.");
});
