/* R40 (Delta automation) — DELTA durable write-before-send + startup RECOVERY, at the literal /api/broker/order route
   against real PostgreSQL + a fake Delta HTTP server (via DELTA_API_BASE). Proves the crash/lost-order safety Delta was
   missing (FYERS already had it):
     J1  a normal market BUY finalizes the durable order_attempt as FILLED/resolved (no lingering unresolved attempt);
     J2  replaying the SAME idempotency key does NOT place a second Delta order (idempotent replay → reconcile-required);
     J3  a LOST RESPONSE (broker filled, app never heard back) leaves the attempt UNKNOWN; the reconciler then finds the
         fill from BROKER TRUTH (by client_order_id) and ADOPTS it EXACTLY ONCE — no resend, and a re-run is idempotent.
   Real DB required (CI / embedded-postgres). Skips without a DB locally (a skip is a CI failure via the zero-skip gate). */
const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const path = require("path");
const os = require("os");
const fs = require("fs");

const IN_CI = /^(1|true|yes)$/i.test(String(process.env.CI || ""));
function loadEmbeddedPg() {
  const tries = ["embedded-postgres", process.env.EMBEDDED_PG_PATH].filter(Boolean);
  for (const t of tries) { try { const M = require(t); return M.default || M; } catch { /* next */ } }
  return null;
}
let pgHandle = null, DATABASE_URL = null, srv = null, base = null, fake = null;
let server, auth, db, bcrypt;

async function bootPostgres() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const EmbeddedPostgres = loadEmbeddedPg();
  if (!EmbeddedPostgres) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-deltarec-"));
  const port = 55000 + Math.floor(Math.random() * 1500);
  pgHandle = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "postgres", port, persistent: false });
  await pgHandle.initialise(); await pgHandle.start(); await pgHandle.createDatabase("matrix_test");
  return `postgres://postgres:postgres@127.0.0.1:${port}/matrix_test`;
}
function req(method, p, { token, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const h = { "Content-Type": "application/json", ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    if (data) h["Content-Length"] = Buffer.byteLength(data);
    const u = new URL(base + p);
    const r = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: h }, (res) => {
      let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => { let j; try { j = b ? JSON.parse(b) : {}; } catch { j = { raw: b }; } resolve({ status: res.statusCode, body: j }); });
    });
    r.on("error", reject); if (data) r.write(data); r.end();
  });
}

const PHONE = "9198761234";
let TOKEN = null, SESSION = null, SKEY = null;

test.before(async () => {
  DATABASE_URL = await bootPostgres();
  if (!DATABASE_URL) { if (IN_CI) throw new Error("DATABASE_URL required for the Delta recovery journey in CI."); return; }
  fake = require("./route/fakeDelta.cjs").makeFakeDelta();
  const dBase = await fake.listen();
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.DELTA_API_BASE = dBase;
  process.env.DELTA_API_KEY = "test-delta-key";
  process.env.DELTA_API_SECRET = "test-delta-secret";
  process.env.ADMIN_USER_IDS = PHONE;
  process.env.JWT_SECRET = "delta-recovery-secret-000";
  process.env.CRED_KEY = "route-test-cred-key-32bytes-min!!";
  process.env.BROKER_TRADING_ENABLED = "true";
  process.env.C03_ORDER_ATTEMPTS = "1";
  process.env.MATRIX_NO_LISTEN = "1";
  process.env.DELTA_ABSENCE_MIN_AGE_MS = "0";
  server = require("../server.js"); auth = require("../auth.js"); db = require("../db.js"); bcrypt = require("bcryptjs");
  const deadline = Date.now() + 30000;
  while (!server.isSchemaReady() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  assert.ok(server.isSchemaReady(), "schema ready");
  srv = http.createServer(server.app);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${srv.address().port}`;
  await db.createUser(PHONE, bcrypt.hashSync("1234", 8), "Delta Rec", null, null, null, null, true);
  TOKEN = auth.signToken(PHONE, process.env.JWT_SECRET, 24 * 3600 * 1000, 0);
  SKEY = "ph_" + PHONE;
  SESSION = server.putBrokerSession(SKEY, "delta", "server-signed");
});
test.after(async () => {
  if (srv) await new Promise((r) => srv.close(r));
  if (fake) await fake.close();
  if (pgHandle) { try { await pgHandle.stop(); } catch { /* ignore */ } }
});

const guard = (fn) => async (t) => { if (!DATABASE_URL) { if (IN_CI) throw new Error("no DB"); t.skip("no PostgreSQL"); return; } return fn(t); };
const oh = (idem, extra = {}) => ({ "X-Broker-Session": SESSION, "X-Confirm-Live": "yes", "X-Idempotency-Key": idem, ...extra });
const newKey = () => "idem_" + Math.random().toString(36).slice(2, 12);
const openDelta = async () => (await db.getTrades(SKEY, 0, Date.now())).filter((tr) => tr && tr.real === true && tr.broker === "delta" && tr.entryAt != null && tr.exitAt == null);

test("Delta-Rec J1: a normal BUY finalizes the durable attempt (no unresolved attempt lingers)", guard(async () => {
  fake.reset(); fake.setMode("fill", { fillPrice: 100 });
  const key = newKey();
  const r = await req("POST", "/api/broker/order", { token: TOKEN, headers: oh(key), body: { broker: "delta", symbol: "BTCUSD", side: "buy", qty: 3, price: 100, entryPrice: 100 } });
  assert.ok(r.status === 200 || r.status === 201, "order accepted: " + JSON.stringify(r.body));
  const unresolved = await db.listUnresolvedOrderAttempts(1000);
  assert.ok(!unresolved.some((a) => a.id === `oa_${SKEY}_${key}`), "the durable attempt is finalized/resolved (not left unresolved)");
}));

test("Delta-Rec J2: replaying the SAME idempotency key does NOT place a second Delta order", guard(async () => {
  fake.reset(); fake.setMode("fill", { fillPrice: 100 });
  const key = newKey();
  const body = { broker: "delta", symbol: "BTCUSD", side: "buy", qty: 3, price: 100, entryPrice: 100 };
  const r1 = await req("POST", "/api/broker/order", { token: TOKEN, headers: oh(key), body });
  assert.ok(r1.status === 200 || r1.status === 201, "first submit accepted: " + JSON.stringify(r1.body));
  const after1 = fake.placeCount();
  const r2 = await req("POST", "/api/broker/order", { token: TOKEN, headers: oh(key), body });   // SAME key
  // THE SAFETY INVARIANT: no second Delta order ever reaches the broker on a replay.
  assert.equal(fake.placeCount(), after1, "the replay placed NO second Delta order");
  // The durable idempotency ledger replays the ORIGINAL outcome (idempotentReplay) rather than acting again; a
  // still-in-flight attempt would instead be reconcile-required. Either is a safe, non-duplicating response.
  assert.ok(r2.body.idempotentReplay === true || r2.status === 409 || r2.body.reconcileRequired === true,
    "replay returns the original idempotent outcome (or reconcile-required), never a fresh second order: " + JSON.stringify(r2.body));
}));

test("Delta-Rec J3: a LOST RESPONSE is recovered from broker truth — adopt the fill EXACTLY ONCE, no resend", guard(async () => {
  fake.reset(); fake.setMode("fill", { fillPrice: 100 });
  fake.setLostResponse(true);   // broker fills, but the app's POST never gets the reply
  const key = newKey();
  const beforeOpen = (await openDelta()).length;
  const r = await req("POST", "/api/broker/order", { token: TOKEN, headers: oh(key), body: { broker: "delta", symbol: "BTCUSD", side: "buy", qty: 3, price: 100, entryPrice: 100 } });
  assert.ok(r.status >= 400, "the lost-response submit is an honest failure to the client (not a fake success): " + JSON.stringify(r.body));
  assert.equal(fake.placeCount(), 1, "exactly ONE order reached the broker (it filled; only the response was lost)");
  // The attempt is UNKNOWN/unresolved now — recovery must resolve it from broker truth.
  const unresolvedBefore = await db.listUnresolvedOrderAttempts(1000);
  assert.ok(unresolvedBefore.some((a) => a.id === `oa_${SKEY}_${key}`), "the lost order left a durable UNKNOWN attempt to reconcile");
  // Allow the broker read; stop the lost-response so the PROBE reads succeed.
  fake.setLostResponse(false);
  await server.runC03Reconcile("test");
  const openAfter = await openDelta();
  assert.equal(openAfter.length, beforeOpen + 1, "the recovered fill was ADOPTED exactly once (one new authoritative Delta position)");
  assert.ok(Math.abs(Number(openAfter[openAfter.length - 1].entry) - 100) < 1e-6, "adopted at the real fill price (100)");
  assert.equal(fake.placeCount(), 1, "recovery did NOT resend the order (still exactly one broker placement)");
  const unresolvedAfter = await db.listUnresolvedOrderAttempts(1000);
  assert.ok(!unresolvedAfter.some((a) => a.id === `oa_${SKEY}_${key}`), "the attempt is now resolved");
  // Idempotent: a second reconcile sweep must NOT create a duplicate position.
  await server.runC03Reconcile("test-again");
  assert.equal((await openDelta()).length, beforeOpen + 1, "a re-run of recovery is idempotent — no duplicate adoption");
}));
