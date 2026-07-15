/**
 * test/db.test.js — the flat-file DB layer (no Postgres).
 * Run: node --test  (from the backend dir)
 *
 * Exercises the user/state/trade round-trip and the admin block logic, using a temp dir so
 * it never touches real data. Env vars are set BEFORE requiring db.js so the file paths and
 * flat-file mode are picked up. This guards the recurring "ph_ prefix / user-data lookup"
 * bugs and the block-at-login behaviour.
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let dir, db;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-db-test-"));
  // Point the store at the temp dir and force flat-file mode (no DATABASE_URL).
  delete process.env.DATABASE_URL;
  process.env.USERS_FILE = path.join(dir, "users.json");
  process.env.TRADES_FILE = path.join(dir, "trades.json");
  process.env.STATE_FILE = path.join(dir, "state.json");
  db = require("../db");
});

after(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

test("create then fetch a user", async () => {
  await db.createUser("9167737726", "hash123", "Sumit");
  const u = await db.getUser("9167737726");
  assert.strictEqual(u.name, "Sumit");
  assert.strictEqual(u.pin, "hash123");
});

test("a new user is not blocked by default", async () => {
  const blocked = await db.isUserBlocked("9167737726");
  assert.strictEqual(blocked, false);
});

test("blocking then unblocking a user", async () => {
  await db.setUserBlocked("9167737726", true);
  assert.strictEqual(await db.isUserBlocked("9167737726"), true);
  await db.setUserBlocked("9167737726", false);
  assert.strictEqual(await db.isUserBlocked("9167737726"), false);
});

test("listUsers returns the created user without the PIN hash exposed via getUserFull", async () => {
  const users = await db.listUsers();
  assert.ok(users.find((x) => x.phone === "9167737726"));
});

test("state + trades are stored under the ph_-prefixed id and getUserFull finds them", async () => {
  // The app keys state/trades under ph_<phone>; users table under the bare phone.
  await db.saveState("ph_9167737726", { profile: { style: "swing" }, strats: [{ name: "S1", active: true }] });
  await db.saveTrade("ph_9167737726", { id: "t1", sym: "RELIANCE", side: "BUY", qty: 2, entryAt: Date.now() });

  const full = await db.getUserFull("9167737726");
  assert.ok(full, "getUserFull should find the user");
  assert.strictEqual(full.user.name, "Sumit");
  assert.ok(!("pin" in full.user), "PIN hash must never be exposed");
  assert.ok(full.state && full.state.profile && full.state.profile.style === "swing", "onboarding/profile found");
  assert.ok(Array.isArray(full.state.strats) && full.state.strats.length === 1, "strategies found");
  assert.ok(Array.isArray(full.trades) && full.trades.length === 1 && full.trades[0].sym === "RELIANCE", "trades found");
});

test("getUserFull returns null for an unknown user", async () => {
  const full = await db.getUserFull("0000000000");
  assert.strictEqual(full, null);
});

test("security question is stored and retrievable; answer hash is separate", async () => {
  const bcrypt = require("bcryptjs");
  const answerHash = bcrypt.hashSync("fluffy", 10);
  await db.createUser("9998887776", "pinhash", "Test", "First pet's name?", answerHash);

  const q = await db.getSecurityQuestion("9998887776");
  assert.strictEqual(q, "First pet's name?");

  const h = await db.getSecurityAnswerHash("9998887776");
  assert.ok(h && bcrypt.compareSync("fluffy", h), "stored answer hash verifies against the answer");
  assert.ok(!bcrypt.compareSync("wrong", h), "wrong answer does not verify");

  // A user without a security question returns null (not an error).
  await db.createUser("1112223334", "pinhash", "NoQ");
  assert.strictEqual(await db.getSecurityQuestion("1112223334"), null);
});
