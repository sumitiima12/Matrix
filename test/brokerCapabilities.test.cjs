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
  assert.equal(caps.brokerCap("zerodha", "connect"), true);
  assert.equal(caps.brokerCap("zerodha", "portfolio"), true);
  assert.equal(caps.brokerCap("zerodha", "verifiedFill"), false, "acceptance-only broker: fill truth not certified");
  // R31-P2-06: Zerodha manualEntry/manualExit must NOT be advertised while fill-truth is uncertified (was overstated).
  assert.equal(caps.brokerCap("zerodha", "manualEntry"), false, "uncertified fill-truth ⇒ no real manual entry");
  assert.equal(caps.brokerCap("zerodha", "manualExit"), false, "uncertified fill-truth ⇒ no real manual exit");
  assert.equal(caps.brokerCap("coindcx", "manualEntry"), false);
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
