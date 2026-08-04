/* §5 — CANONICAL REAL EXIT LIFECYCLE. Route-level proofs for the dedicated position-addressable close
   POST /api/real-positions/:positionId/close, against real PostgreSQL + the fake Delta HTTP server (Delta is a
   fill-truth broker, so a close's filled/remaining is unambiguous). Proves the money-critical close contract:
   full close, partial (requested < open), clamp to fresh broker exposure, entryOrderId mismatch refusal, a
   mandatory stable idempotency id, and broker-already-flat reconciliation (no phantom order). Real DB required. */
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-s5pg-"));
  const port = 57500 + Math.floor(Math.random() * 1500);
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

const PHONE = "9111222333";
let TOKEN = null, SESSION = null, SKEY = null;

test.before(async () => {
  DATABASE_URL = await bootPostgres();
  if (!DATABASE_URL) { if (IN_CI) throw new Error("DATABASE_URL required for the §5 close journey in CI."); return; }
  fake = require("./route/fakeDelta.cjs").makeFakeDelta();
  const dBase = await fake.listen();
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.DELTA_API_BASE = dBase;
  process.env.DELTA_API_KEY = "test-delta-key";
  process.env.DELTA_API_SECRET = "test-delta-secret";
  process.env.ADMIN_USER_IDS = PHONE;            // makes the user Delta-tradable (server-signed env keys)
  process.env.JWT_SECRET = "s5-close-secret-000";
  process.env.CRED_KEY = "s5-close-cred-key-32bytes-min!!!";
  process.env.BROKER_TRADING_ENABLED = "true";
  process.env.AUTO_EXIT_LIVE = "true";           // exercise the LIVE close path (not dry-run)
  process.env.MATRIX_NO_LISTEN = "1";
  server = require("../server.js"); auth = require("../auth.js"); db = require("../db.js"); bcrypt = require("bcryptjs");
  const deadline = Date.now() + 30000;
  while (!server.isSchemaReady() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  assert.ok(server.isSchemaReady(), "schema ready");
  srv = http.createServer(server.app);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${srv.address().port}`;
  await db.createUser(PHONE, bcrypt.hashSync("1234", 8), "S5 Closer", null, null, null, null, true);
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
const oh = (extra = {}) => ({ "X-Broker-Session": SESSION, "X-Confirm-Live": "yes", ...extra });
let _pid = 0;
// Seed an OPEN managed Delta position owned by our user, and reflect matching broker exposure in the fake.
async function seedPosition(qty, { brokerExposure = qty, entryOrderId = null } = {}) {
  const seq = ++_pid;
  const id = `mp_${PHONE}_${Date.now()}_${seq}`;
  const eoid = entryOrderId || `ent_${seq}`;   // unique per seed — composite (broker,user,entryOrderId) is UNIQUE
  await db.saveManagedPosition({
    // managed positions are keyed by the STORAGE key (storageKeyFor), which is what routeUserId resolves the
    // verified token to — seed under SKEY so the endpoint's getManagedPositionsForUser(SKEY) finds it.
    id, userId: SKEY, broker: "delta", status: "open", market: "Crypto", product: "Manual",
    symbol: "BTC", brokerSym: "BTCUSD", qty, entry: 100, short: false, entryOrderId: eoid, tradeType: "Manual",
  });
  fake.state.positions = brokerExposure > 0 ? [{ size: brokerExposure, product_symbol: "BTCUSD", entry_price: "100", mark_price: "130" }] : [];
  return id;
}
const closeReq = (positionId, body) => req("POST", `/api/real-positions/${positionId}/close`, { token: TOKEN, headers: oh(), body });

test("§5 J1: a full close flattens the position and books a kind=exit fill (authoritative filled/remaining)", guard(async () => {
  fake.reset(); fake.setMode("fill", { fillPrice: 130 });
  const pid = await seedPosition(4);
  const r = await closeReq(pid, { exitIntentId: "ex_" + pid, reason: "manual-close" });
  assert.ok(r.status === 200, "close ok: " + JSON.stringify(r.body));
  assert.equal(r.body.closed, true, "fully closed");
  assert.equal(r.body.filledQty, 4, "authoritative filled qty");
  assert.equal(r.body.remainingQty, 0, "nothing remaining");
  const pos = (await db.getManagedPositionsForUser(SKEY)).find((p) => p.id === pid);
  assert.equal(pos.status, "closed", "managed position is CLOSED");
  const fills = await db.getFills(SKEY, 0, Date.now());
  assert.ok(fills.some((f) => f.kind === "exit" && f.managedId === pid), "an immutable kind=exit fill was booked, linked to the position");
}));

test("§5 J2: a PARTIAL requested close reduces the tracked qty and keeps the residual OPEN", guard(async () => {
  fake.reset(); fake.setMode("fill", { fillPrice: 130 });
  const pid = await seedPosition(4);
  const r = await closeReq(pid, { exitIntentId: "ex_" + pid, quantity: 2 });
  assert.ok(r.status === 200, "partial close ok: " + JSON.stringify(r.body));
  assert.equal(r.body.closed, false, "not fully closed");
  assert.equal(r.body.filledQty, 2);
  assert.equal(r.body.remainingQty, 2, "2 remain open");
  const pos = (await db.getManagedPositionsForUser(SKEY)).find((p) => p.id === pid);
  assert.equal(pos.status, "open", "position stays OPEN");
  assert.equal(Number(pos.qty), 2, "tracked qty reduced to the residual");
}));

test("§5 J3: the requested qty is CLAMPED to fresh broker exposure (never over-close)", guard(async () => {
  fake.reset(); fake.setMode("fill", { fillPrice: 130 });
  const pid = await seedPosition(4, { brokerExposure: 3 });   // broker only holds 3
  const r = await closeReq(pid, { exitIntentId: "ex_" + pid });   // request full (4)
  assert.ok(r.status === 200, "clamped close ok: " + JSON.stringify(r.body));
  assert.equal(r.body.filledQty, 3, "closed only what the broker actually held");
  assert.equal(r.body.remainingQty, 1, "the untradeable 1 stays tracked");
  const pos = (await db.getManagedPositionsForUser(SKEY)).find((p) => p.id === pid);
  assert.equal(Number(pos.qty), 1, "tracked qty reduced by the broker-confirmed close only");
}));

test("§5 J4: a mismatched entryOrderId is REFUSED (won't close the wrong position)", guard(async () => {
  fake.reset(); fake.setMode("fill");
  const before = fake.placeCount();
  const pid = await seedPosition(4, { entryOrderId: "entA" });
  const r = await closeReq(pid, { exitIntentId: "ex_" + pid, entryOrderId: "entB" });
  assert.equal(r.status, 409, "mismatch is a conflict: " + JSON.stringify(r.body));
  assert.equal(fake.placeCount(), before, "NO broker order was placed for a mismatched entryOrderId");
}));

test("§5 J5: a close WITHOUT a stable exit intent id is rejected (idempotency is mandatory)", guard(async () => {
  fake.reset(); fake.setMode("fill");
  const before = fake.placeCount();
  const pid = await seedPosition(4);
  const r = await closeReq(pid, { reason: "manual-close" });   // no exitIntentId / X-Idempotency-Key
  assert.equal(r.status, 400, "missing idempotency id is a 400: " + JSON.stringify(r.body));
  assert.equal(fake.placeCount(), before, "NO broker order placed without a durable close identity");
}));

test("§5 J6: broker already flat → position reconciled CLOSED with NO new order", guard(async () => {
  fake.reset(); fake.setMode("fill");
  const before = fake.placeCount();
  const pid = await seedPosition(4, { brokerExposure: 0 });   // broker holds nothing
  const r = await closeReq(pid, { exitIntentId: "ex_" + pid });
  assert.ok(r.status === 200, "flat reconcile ok: " + JSON.stringify(r.body));
  assert.equal(r.body.closed, true);
  assert.equal(fake.placeCount(), before, "NO redundant broker order was placed when already flat");
  const pos = (await db.getManagedPositionsForUser(SKEY)).find((p) => p.id === pid);
  assert.equal(pos.status, "closed", "position reconciled closed");
}));
