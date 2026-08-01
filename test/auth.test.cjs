/**
 * test/auth.test.js — session token signing/verification.
 * Run: node --test  (from the backend dir)
 *
 * These lock down C1: an attacker must not be able to forge a token, claim another user's
 * id, or use an expired one.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const { signToken, verifyToken, storageKeyFor, secretConfigError } = require("../auth");

const SECRET = "test-secret-do-not-use-in-prod";

test("a freshly signed token verifies to the same userId", () => {
  const tok = signToken("9167737726", SECRET);
  const v = verifyToken(tok, SECRET);
  assert.strictEqual(v.userId, "9167737726");
});

test("garbage / empty / null tokens are rejected", () => {
  assert.strictEqual(verifyToken("not.a.token", SECRET), null);
  assert.strictEqual(verifyToken("", SECRET), null);
  assert.strictEqual(verifyToken(null, SECRET), null);
  assert.strictEqual(verifyToken("only-one-part", SECRET), null);
});

test("a token signed with a different secret is rejected", () => {
  const tok = signToken("9167737726", "attacker-secret");
  assert.strictEqual(verifyToken(tok, SECRET), null);
});

test("tampering with the payload invalidates the signature", () => {
  const tok = signToken("9167737726", SECRET);
  const [header, , sig] = tok.split(".");
  // Forge a payload claiming to be a different user, keep the original signature.
  const b64url = (s) => Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const evil = b64url(JSON.stringify({ sub: "9999999999", iat: Date.now(), exp: Date.now() + 1e9 }));
  assert.strictEqual(verifyToken(`${header}.${evil}.${sig}`, SECRET), null);
});

test("an expired token is rejected", () => {
  const expired = signToken("9167737726", SECRET, -1000);   // exp in the past
  assert.strictEqual(verifyToken(expired, SECRET), null);
});

test("a token just inside its TTL still verifies", () => {
  const tok = signToken("9167737726", SECRET, 60_000);   // 1 min
  assert.strictEqual(verifyToken(tok, SECRET).userId, "9167737726");
});

test("storageKeyFor adds the ph_ prefix only when missing", () => {
  assert.strictEqual(storageKeyFor("9167737726"), "ph_9167737726");
  assert.strictEqual(storageKeyFor("ph_9167737726"), "ph_9167737726");
  assert.strictEqual(storageKeyFor(""), "ph_");
});

/* P2-05 — the boot guard. In production a missing/weak JWT_SECRET must block startup (a random
   per-boot secret logs everyone out on deploy; a short/known one is forgeable). In dev it's allowed. */
test("secretConfigError: production blocks a missing or short secret", () => {
  assert.match(secretConfigError("", true), /not set/);
  assert.match(secretConfigError(undefined, true), /not set/);
  assert.match(secretConfigError("short", true), /too short/);
  assert.match(secretConfigError("a".repeat(31), true), /too short/);
  assert.strictEqual(secretConfigError("a".repeat(32), true), null);   // exactly the minimum
  assert.strictEqual(secretConfigError("x".repeat(64), true), null);
});

test("secretConfigError: dev never blocks (random fallback is fine)", () => {
  assert.strictEqual(secretConfigError("", false), null);
  assert.strictEqual(secretConfigError(undefined, false), null);
  assert.strictEqual(secretConfigError("short", false), null);
});
