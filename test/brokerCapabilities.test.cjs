/* S1 — broker capability registry: server-owned, fail-closed, honest certification. */
const test = require("node:test");
const assert = require("node:assert");
const caps = require("../brokerCapabilities.js");

test("S1: FYERS is fully certified (passed the route/recovery/exit/protection suite)", () => {
  for (const c of caps.ALL_CAPS) assert.equal(caps.brokerCap("fyers", c), true, `fyers.${c} should be certified`);
});

test("S1: Delta is FULLY CERTIFIED (R40) — manual real trading + durable/recovery + unattended automation (runner-green)", () => {
  assert.equal(caps.brokerCap("delta", "manualEntry"), true, "manual real trading available");
  assert.equal(caps.brokerCap("delta", "verifiedFill"), true);
  // R40: Delta has the durable write-before-send + startup/periodic broker-truth recovery (proven hermetically in
  // test/deltaRecovery.test.cjs: lost-response → restart → adopt-once, no resend).
  assert.equal(caps.brokerCap("delta", "durableAttempts"), true, "C03 durable attempts implemented + tested for Delta");
  assert.equal(caps.brokerCap("delta", "startupRecovery"), true, "startup/periodic broker-truth recovery implemented for Delta");
  // THE gate the auto-buy engine consults: TRUE now that the Delta testnet order+fill cert (deltaTestnet.sandbox.cjs)
  // AND the MatrixOne-path E2E (brokerPipelineE2E.sandbox.cjs) both passed GREEN on the static-IP self-hosted runner
  // (broker-sandbox-delta + broker-e2e), with per-SHA evidence published.
  assert.equal(caps.brokerCap("delta", "unattendedAutomation"), true, "unattended real automation certified on the runner-green evidence");
  assert.equal(caps.brokerCap("delta", "connect"), true, "connection always available");
});

test("S1: uncertified/other brokers keep connect+portfolio, block real ops (block the OP, not the broker)", () => {
  // Zerodha + Groww: order route exists but fill-truth is NOT certified → no real manual entry/exit (block the OP).
  for (const b of ["zerodha", "groww"]) {
    assert.equal(caps.brokerCap(b, "connect"), true, `${b} connect available`);
    assert.equal(caps.brokerCap(b, "portfolio"), true, `${b} portfolio available`);
    assert.equal(caps.brokerCap(b, "verifiedFill"), false, `${b}: fill truth not certified`);
    assert.equal(caps.brokerCap(b, "manualEntry"), false, `${b}: uncertified fill-truth ⇒ no real manual entry`);
    assert.equal(caps.brokerCap(b, "manualExit"), false, `${b}: uncertified fill-truth ⇒ no real manual exit`);
    assert.equal(caps.brokerCap(b, "unattendedAutomation"), false, `${b}: not unattended-certified`);
  }
  // Genuinely uncertified crypto/other brokers stay connect+portfolio only (fail closed on every real op).
  for (const b of ["binance", "angelone", "coinswitch", "schwab"]) {
    assert.equal(caps.brokerCap(b, "verifiedFill"), false, `${b}: fill truth not certified`);
    assert.equal(caps.brokerCap(b, "manualEntry"), false, `${b}: no real manual entry`);
    assert.equal(caps.brokerCap(b, "unattendedAutomation"), false, `${b}: not unattended`);
  }
});

// R42-P1-01/02: the EXACT approved matrix for the brokers certified on a REAL fill but WITHOUT an automatic
// crash-recovery adapter. verifiedFill + manual entry/exit are TRUE (real fills proven); startupRecovery is FALSE
// (recovery is manual — fail-closed to MANUAL_RECONCILIATION_REQUIRED, never automatic). This makes the registry's
// claims match the implementation exactly, rather than asserting a stale "uncertified" state.
test("S1: CoinDCX + IND Money — real verified fill, manual real trading, but startupRecovery is honestly FALSE", () => {
  for (const b of ["coindcx", "indmoney"]) {
    assert.equal(caps.brokerCap(b, "verifiedFill"), true, `${b}: REAL verified fill proven`);
    assert.equal(caps.brokerCap(b, "manualEntry"), true, `${b}: manual real entry certified on a real fill`);
    assert.equal(caps.brokerCap(b, "manualExit"), true, `${b}: manual real exit certified`);
    assert.equal(caps.brokerCap(b, "durableAttempts"), true, `${b}: write-before-send attempt is durably recorded`);
    assert.equal(caps.brokerCap(b, "startupRecovery"), false, `${b}: NO automatic crash recovery — manual reconciliation`);
  }
});

// R42-P1-03: Dhan is certified on sandbox-accept + FYERS code parity (per explicit product decision), NOT on a real
// TRADED fill, and it too has NO automatic crash-recovery adapter. Its real-money flags are on by that decision; its
// startupRecovery is honestly FALSE.
test("S1: Dhan — parity-certified real flags on (product decision); startupRecovery honestly FALSE", () => {
  assert.equal(caps.brokerCap("dhan", "manualEntry"), true, "dhan real entry enabled by parity decision");
  assert.equal(caps.brokerCap("dhan", "verifiedFill"), true, "dhan verifiedFill on by parity decision");
  assert.equal(caps.brokerCap("dhan", "startupRecovery"), false, "dhan has NO automatic crash recovery — manual");
});

test("S1: unknown broker / capability fails closed (false)", () => {
  assert.equal(caps.brokerCap("nope", "manualEntry"), false);
  assert.equal(caps.brokerCap("fyers", "nonexistentCap"), false);
  assert.equal(caps.brokerCap(null, "connect"), false);
});

test("S1: capabilitiesView exposes a version + every broker over the full key set", () => {
  const v = caps.capabilitiesView();
  assert.ok(v.version && typeof v.version === "string", "certification version present");
  assert.ok(Array.isArray(v.keys) && v.keys.includes("unattendedAutomation"));
  for (const b of Object.keys(v.capabilities)) {
    for (const k of v.keys) assert.equal(typeof v.capabilities[b][k], "boolean", `${b}.${k} must be a boolean`);
  }
});
