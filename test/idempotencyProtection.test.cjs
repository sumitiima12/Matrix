/**
 * test/idempotencyProtection.test.cjs — R17-P1-02 idempotency state machine + R17-P1-03 protection lease
 * (flat-file path). Proves an ambiguous outcome keeps the key blocked, a conclusive rejection frees it, a
 * payload hash is recorded, and a leased protection row isn't handed to a second worker.
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let dir, db;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-idem-test-"));
  delete process.env.DATABASE_URL;
  process.env.IDEM_FILE = path.join(dir, "idem.json");
  process.env.PENDING_PROT_FILE = path.join(dir, "pp.json");
  db = require("../db");
});
after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

test("idempotency: first claim wins, duplicate is blocked, hash is recorded", async () => {
  assert.equal(await db.claimIdempotencyKey("ph_1", "key-A", "hash-1"), true);
  assert.equal(await db.claimIdempotencyKey("ph_1", "key-A", "hash-1"), false);
  const rec = await db.getIdempotencyRecord("ph_1", "key-A");
  assert.equal(rec.status, "in_flight");
  assert.equal(rec.reqHash, "hash-1");
});

test("UNKNOWN outcome keeps the key blocked (no silent duplicate)", async () => {
  await db.claimIdempotencyKey("ph_1", "key-unknown", "h");
  await db.finalizeIdempotency("ph_1", "key-unknown", "unknown", { error: "timeout" });
  // a retry with the same key cannot re-claim
  assert.equal(await db.claimIdempotencyKey("ph_1", "key-unknown", "h"), false);
  const rec = await db.getIdempotencyRecord("ph_1", "key-unknown");
  assert.equal(rec.status, "unknown");
});

test("CONCLUSIVE rejection frees the key so a genuine retry can proceed", async () => {
  await db.claimIdempotencyKey("ph_1", "key-rej", "h");
  await db.finalizeIdempotency("ph_1", "key-rej", "rejected", { error: "insufficient funds" });
  // key released → re-claimable
  assert.equal(await db.claimIdempotencyKey("ph_1", "key-rej", "h"), true);
});

test("SUCCESS persists the response for replay", async () => {
  await db.claimIdempotencyKey("ph_1", "key-ok", "h");
  await db.finalizeIdempotency("ph_1", "key-ok", "succeeded", { orderId: "X1", ok: true });
  const rec = await db.getIdempotencyRecord("ph_1", "key-ok");
  assert.equal(rec.status, "succeeded");
  assert.equal(rec.response.orderId, "X1");
});

test("R26-P1-01: a record is UNTAGGED until the order is stamped, then TAGGED", async () => {
  await db.claimIdempotencyKey("ph_1", "key-tag", "h");
  await db.finalizeIdempotency("ph_1", "key-tag", "unknown", { error: "timeout" });
  let rec = await db.getIdempotencyRecord("ph_1", "key-tag");
  assert.equal(rec.tagged, false, "a fresh/legacy record is untagged — its broker-book absence is NOT proof");
  await db.markIdempotencyTagged("ph_1", "key-tag");
  rec = await db.getIdempotencyRecord("ph_1", "key-tag");
  assert.equal(rec.tagged, true, "after stamping the order tag, the record is tagged and may be resolved by the probe");
});

test("protection lease: a leased row is not handed to a second worker", async () => {
  await db.savePendingProtection({ id: "pp1", userId: "ph_1", broker: "fyers", orderId: "O1", symbol: "SBIN", qty: 1 });
  const first = await db.claimPendingProtection(60000, 10);
  assert.equal(first.filter((p) => p.orderId === "O1").length, 1, "first worker leases it");
  const second = await db.claimPendingProtection(60000, 10);
  assert.equal(second.filter((p) => p.orderId === "O1").length, 0, "second worker must NOT get the leased row");
});
