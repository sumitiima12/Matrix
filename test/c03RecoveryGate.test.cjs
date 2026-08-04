/* R30-C1 — C03 recovery must use the SAME default-on gate as submission. Submission runs unless
   C03_ORDER_ATTEMPTS=0; recovery previously required the var to equal "1", so with the var OMITTED submission
   created durable attempts that recovery then silently skipped — leaving accounts locked with unreconciled orders.
   This spawns the server with the var UNSET and asserts runC03Reconcile() actually SWEEPS (does not return
   {skipped:"flag-off"}). Runs in a child process (server has module-scope side effects) under MATRIX_NO_LISTEN. */
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

test("R30-C1: with C03_ORDER_ATTEMPTS unset, recovery is ACTIVE (default-on), not skipped", () => {
  const SERVER = path.join(__dirname, "..", "server.js");
  const attemptsFile = path.join(os.tmpdir(), "c03gate-" + Date.now() + ".json");
  const script = `
    const assert = require("assert");
    const m = require(${JSON.stringify(SERVER)});
    (async () => {
      const deadline = Date.now() + 20000;
      while (!m.isSchemaReady() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      const out = await m.runC03Reconcile("gate-test");
      // Default-on: the sweep runs. It must NOT be flag-off skipped. With no attempts + flat-file it returns
      // an owner sweep result (attempts: 0), never { skipped: "flag-off" }.
      assert.notStrictEqual(out && out.reason, "flag-off", "recovery must not be flag-off skipped when the var is unset");
      assert.ok(out && (out.owner === true || out.attempts !== undefined), "recovery actually swept: " + JSON.stringify(out));
      console.log("GATE_OK");
      process.exit(0);
    })().catch((e) => { console.error("ERR:" + (e && e.message)); process.exit(4); });
  `;
  // Build a clean env with C03_ORDER_ATTEMPTS explicitly REMOVED.
  const env = { ...process.env, MATRIX_NO_LISTEN: "1", JWT_SECRET: "gate-secret-000", ORDER_ATTEMPTS_FILE: attemptsFile, DATABASE_URL: "" };
  delete env.C03_ORDER_ATTEMPTS;
  let out;
  try { out = execFileSync(process.execPath, ["-e", script], { env, encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { assert.fail("recovery-gate child failed: " + (e.stderr || e.message)); }
  assert.match(out, /GATE_OK/, "recovery ran with the flag omitted (default-on)");
});

function requireServerWith(envOverrides) {
  const SERVER = path.join(__dirname, "..", "server.js");
  const script = `require(${JSON.stringify(SERVER)}); console.log("LOADED"); process.exit(0);`;
  const env = { ...process.env, MATRIX_NO_LISTEN: "1", JWT_SECRET: "gate-secret-000", DATABASE_URL: "", ...envOverrides };
  return execFileSync(process.execPath, ["-e", script], { env, encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe"] });
}

test("S3.1: BROKER_TRADING_ENABLED=true with C03_ORDER_ATTEMPTS=0 FAILS startup (no silent legacy path)", () => {
  assert.throws(
    () => requireServerWith({ BROKER_TRADING_ENABLED: "true", C03_ORDER_ATTEMPTS: "0" }),
    /C03_ORDER_ATTEMPTS=0|durable write-before-send/,
    "live trading with C03 disabled must refuse to start",
  );
});

test("S3.1: an invalid C03_ORDER_ATTEMPTS value refuses to start (ambiguous safety flag)", () => {
  assert.throws(
    () => requireServerWith({ C03_ORDER_ATTEMPTS: "yes" }),
    /must be unset/,
    "a non 0/1 value is a hard config error",
  );
});

test("S3.1: BROKER_TRADING_ENABLED=true with C03 unset (default-on) starts fine", () => {
  // This test isolates the C03 gate. The server ALSO (correctly) refuses real-money startup without PostgreSQL unless
  // ALLOW_FILE_STORE_FOR_REAL=1 (dev-only flat-file path); requireServerWith runs with DATABASE_URL="" so we set that
  // dev flag to satisfy the DB requirement and prove specifically that a DEFAULT-ON C03 does not block startup.
  const out = requireServerWith({ BROKER_TRADING_ENABLED: "true", ALLOW_FILE_STORE_FOR_REAL: "1", CRED_KEY: "route-test-cred-key-32bytes-min!!" });
  assert.match(out, /LOADED/, "default-on C03 satisfies the live-trading requirement");
});
