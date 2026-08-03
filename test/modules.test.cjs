/* R23-P3-05: tests for the modules extracted out of server.js — proving the extraction is behaviour-
   preserving (TOTP against the RFC-6238 published vectors) and the pure risk/order helpers hold their
   invariants. These previously lived as un-unit-testable closures inside the 7k-line server. */
const test = require("node:test");
const assert = require("node:assert");

const { totpCode } = require("../otp.js");
const { stableStringify, riskEligibleTrades } = require("../orderIntegrity.js");

test("otp: RFC-6238 published test vectors (SHA-1 seed 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')", () => {
  // The RFC-6238 appendix seed is the ASCII "12345678901234567890" → base32 above. The published 8-digit
  // TOTP at 59s is 94287082; our generator returns the low 6 digits (287082) on a 30s step.
  const seed = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  assert.strictEqual(totpCode(seed, 59 * 1000), "287082");
  assert.strictEqual(totpCode(seed, 1111111109 * 1000), "081804");   // RFC vector 07081804 → low 6
  assert.strictEqual(totpCode(seed, 1234567890 * 1000), "005924");   // RFC vector 89005924 → low 6
});

test("otp: bad/empty secret does not throw and returns 6 digits", () => {
  const c = totpCode("", 0);
  assert.match(c, /^\d{6}$/);
});

test("orderIntegrity: stableStringify is key-order independent", () => {
  assert.strictEqual(stableStringify({ a: 1, b: 2 }), stableStringify({ b: 2, a: 1 }));
  assert.strictEqual(stableStringify({ x: { p: 1, q: 2 } }), stableStringify({ x: { q: 2, p: 1 } }));
  // but a genuinely different value must differ
  assert.notStrictEqual(stableStringify({ a: 1 }), stableStringify({ a: 2 }));
});

test("orderIntegrity: riskEligibleTrades drops client-authored real rows but keeps verified + virtual", () => {
  const rows = [
    { id: "v", real: false },                                             // virtual — counts
    { id: "verified", real: true, serverAuthored: true },                 // server-verified real — counts
    { id: "forged", real: true, clientAuthored: true },                   // fabricated real — EXCLUDED
    { id: "verified2", real: true, clientAuthored: true, serverAuthored: true }, // verified even if client posted — counts
  ];
  const kept = riskEligibleTrades(rows).map((r) => r.id);
  assert.deepStrictEqual(kept.sort(), ["v", "verified", "verified2"].sort());
});
