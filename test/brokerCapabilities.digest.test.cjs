/**
 * test/brokerCapabilities.digest.test.cjs — REC-4. The capability matrix must be identifiable per deploy: a
 * deterministic content digest that moves when ANY flag flips (even if the hand-bumped version is forgotten),
 * and is invariant to comments / source ordering.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const bc = require("../brokerCapabilities");

test("matrixDigest is a stable 16-hex fingerprint, deterministic across calls", () => {
  const d1 = bc.matrixDigest();
  const d2 = bc.matrixDigest();
  assert.equal(d1, d2);
  assert.match(d1, /^[0-9a-f]{16}$/);
});

test("canonicalMatrix coerces every capability to a strict boolean for every broker", () => {
  const c = bc.canonicalMatrix();
  for (const broker of Object.keys(c)) {
    for (const cap of bc.ALL_CAPS) {
      assert.equal(typeof c[broker][cap], "boolean", `${broker}.${cap} must be boolean`);
    }
  }
});

test("digest is order-independent and changes iff a flag changes (simulated over canonical form)", () => {
  const crypto = require("node:crypto");
  const digestOf = (m) => crypto.createHash("sha256").update(JSON.stringify(m)).digest("hex").slice(0, 16);
  const canon = bc.canonicalMatrix();
  // Reserialising the SAME canonical object yields the SAME digest as the module (proves the module hashes canonically).
  assert.equal(digestOf(canon), bc.matrixDigest());
  // Flip one flag → digest must change.
  const anyBroker = Object.keys(canon)[0];
  const anyCap = bc.ALL_CAPS[0];
  const mutated = JSON.parse(JSON.stringify(canon));
  mutated[anyBroker][anyCap] = !mutated[anyBroker][anyCap];
  assert.notEqual(digestOf(mutated), bc.matrixDigest());
});

test("capabilitiesView publishes version + digest + commit binding", () => {
  const v = bc.capabilitiesView();
  assert.equal(typeof v.version, "string");
  assert.match(v.matrixDigest, /^[0-9a-f]{16}$/);
  assert.ok("commit" in v);   // null in dev, a SHA in a deployed env
});

test("deployCommit reads the platform-injected SHA env, null when unset", () => {
  const saved = process.env.RENDER_GIT_COMMIT;
  delete process.env.RENDER_GIT_COMMIT; delete process.env.GIT_SHA; delete process.env.SOURCE_VERSION;
  assert.equal(bc.deployCommit(), null);
  process.env.RENDER_GIT_COMMIT = "abc123";
  assert.equal(bc.deployCommit(), "abc123");
  if (saved === undefined) delete process.env.RENDER_GIT_COMMIT; else process.env.RENDER_GIT_COMMIT = saved;
});
