/**
 * test/dpdp.test.cjs — MU-1 DPDP scaffolding. Proves consent is opt-in per non-essential purpose, essential
 * purposes can't be silently withdrawn, versioning re-prompts, and the export never leaks secret material.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { PURPOSES, buildConsentRecord, withdrawConsent, consentIsCurrent, buildDataExport, CONSENT_VERSION } = require("../dpdp");

test("essential purposes forced true; non-essential are opt-IN (default false)", () => {
  const rec = buildConsentRecord({});                  // user chose nothing
  assert.equal(rec.granted.account, true);             // essential
  assert.equal(rec.granted.trading, true);             // essential
  assert.equal(rec.granted.communications, false);     // non-essential → not granted unless explicitly chosen
  assert.equal(rec.granted.analytics, false);
  assert.equal(rec.version, CONSENT_VERSION);
});

test("explicit opt-in is honored; unknown purposes dropped", () => {
  const rec = buildConsentRecord({ communications: true, analytics: false, bogus: true });
  assert.equal(rec.granted.communications, true);
  assert.equal(rec.granted.analytics, false);
  assert.equal("bogus" in rec.granted, false);
});

test("withdraw works for non-essential, is a no-op for essential/unknown", () => {
  const rec = buildConsentRecord({ communications: true });
  const w = withdrawConsent(rec, "communications");
  assert.equal(w.granted.communications, false);
  assert.equal(withdrawConsent(rec, "account").granted.account, true);   // essential can't be withdrawn here
  assert.equal(withdrawConsent(rec, "nope").granted.communications, true); // unknown → unchanged
});

test("consentIsCurrent tracks the version (revised notice re-prompts)", () => {
  assert.equal(consentIsCurrent(buildConsentRecord({})), true);
  assert.equal(consentIsCurrent({ version: "2000-01-01", granted: {} }), false);
  assert.equal(consentIsCurrent(null), false);
});

test("data export shapes the bundle and NEVER leaks secret material", () => {
  const exp = buildDataExport({
    profile: { username: "sumit", phone: "9999" },
    consent: buildConsentRecord({ communications: true }),
    trades: [{ sym: "BTC", entry: 100 }],
    pushSubscriptions: [{ endpoint: "https://push/abc", createdAt: 1, keys: { p256dh: "SECRET", auth: "SECRET" } }],
    brokerConnections: [{ broker: "delta", at: 5, encrypted_token: "SECRET-DO-NOT-EXPORT" }],
  });
  assert.equal(exp.format, "matrixone.dpdp.export/v1");
  assert.equal(exp.profile.username, "sumit");
  assert.equal(exp.trades.length, 1);
  // push endpoint kept, but crypto KEYS must not appear
  const blob = JSON.stringify(exp);
  assert.equal(blob.includes("SECRET"), false, "no secret material may appear in the export");
  assert.equal(exp.brokerConnections[0].hasStoredToken, true);
  assert.equal("encrypted_token" in exp.brokerConnections[0], false);
});
