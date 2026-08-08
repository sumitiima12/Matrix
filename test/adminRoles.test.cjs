"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { resolveAdminRole, roleSatisfies, adminConfigured, parseIds } = require("../adminRoles");

test("parseIds strips ph_ prefix, trims, drops blanks", () => {
  const s = parseIds(" ph_999, 111 ,, 222 ");
  assert.deepStrictEqual([...s].sort(), ["111", "222", "999"]);
});

test("ADMIN_USER_IDS resolves to owner (back-compat)", () => {
  const env = { ADMIN_USER_IDS: "911111" };
  assert.strictEqual(resolveAdminRole("911111", env), "owner");
  assert.strictEqual(resolveAdminRole("ph_911111", env), "owner");
});

test("non-admin resolves to null", () => {
  assert.strictEqual(resolveAdminRole("555", { ADMIN_USER_IDS: "911" }), null);
  assert.strictEqual(resolveAdminRole("", {}), null);
});

test("highest role wins when an id appears in multiple lists", () => {
  const env = { ADMIN_USER_IDS: "1", ADMIN_SUPPORT_IDS: "1" };
  assert.strictEqual(resolveAdminRole("1", env), "owner");
});

test("distinct tiers resolve correctly", () => {
  const env = { ADMIN_USER_IDS: "1", ADMIN_ADMIN_IDS: "2", ADMIN_SUPPORT_IDS: "3", ADMIN_READONLY_IDS: "4" };
  assert.strictEqual(resolveAdminRole("1", env), "owner");
  assert.strictEqual(resolveAdminRole("2", env), "admin");
  assert.strictEqual(resolveAdminRole("3", env), "support");
  assert.strictEqual(resolveAdminRole("4", env), "readonly");
});

test("roleSatisfies enforces the hierarchy", () => {
  assert.ok(roleSatisfies("owner", "admin"));
  assert.ok(roleSatisfies("admin", "admin"));
  assert.ok(roleSatisfies("admin", "support"));
  assert.ok(roleSatisfies("support", "readonly"));
  assert.ok(!roleSatisfies("support", "admin"));
  assert.ok(!roleSatisfies("readonly", "support"));
  assert.ok(!roleSatisfies(null, "readonly"));
  assert.ok(!roleSatisfies("owner", "nonsense"));   // unknown required role → deny
});

test("adminConfigured false when nothing set, true when any tier set", () => {
  assert.ok(!adminConfigured({}));
  assert.ok(adminConfigured({ ADMIN_SUPPORT_IDS: "5" }));
});
