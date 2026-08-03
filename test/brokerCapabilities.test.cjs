/* S1 — broker capability registry: server-owned, fail-closed, honest certification. */
const test = require("node:test");
const assert = require("node:assert");
const caps = require("../brokerCapabilities.js");

test("S1: FYERS is fully certified (passed the route/recovery/exit/protection suite)", () => {
  for (const c of caps.ALL_CAPS) assert.equal(caps.brokerCap("fyers", c), true, `fyers.${c} should be certified`);
});

test("S1: Delta keeps manual real trading but durable/recovery/unattended are NOT yet certified", () => {
  assert.equal(caps.brokerCap("delta", "manualEntry"), true, "manual real trading stays available");
  assert.equal(caps.brokerCap("delta", "verifiedFill"), true);
  assert.equal(caps.brokerCap("delta", "durableAttempts"), false, "C03 not certified for Delta yet");
  assert.equal(caps.brokerCap("delta", "startupRecovery"), false);
  assert.equal(caps.brokerCap("delta", "unattendedAutomation"), false, "unattended real automation uncertified");
  assert.equal(caps.brokerCap("delta", "connect"), true, "connection always available");
});

test("S1: uncertified/other brokers keep connect+portfolio, block real ops (block the OP, not the broker)", () => {
  assert.equal(caps.brokerCap("zerodha", "connect"), true);
  assert.equal(caps.brokerCap("zerodha", "portfolio"), true);
  assert.equal(caps.brokerCap("zerodha", "verifiedFill"), false, "acceptance-only broker: fill truth not certified");
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
