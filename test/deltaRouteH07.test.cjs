/* R31-H07 — first per-broker Auto-Buy CERTIFICATION journey for DELTA (crypto), at the literal /api/broker/order
   route, against real PostgreSQL + a fake Delta HTTP server (via DELTA_API_BASE). Proves the money-critical entry
   path for Delta: a market BUY places ONE order, its fill is VERIFIED (not assumed on a 200), and the verified fill
   is journaled to the immutable ledger + trade projection; a broker rejection creates NO position (no phantom).
   These are the entry-stage proofs; protection/exit/restart stages extend this harness next. Real DB required (CI). */
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-deltapg-"));
  const port = 56000 + Math.floor(Math.random() * 1500);
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

const PHONE = "9198765432";
let TOKEN = null, SESSION = null, SKEY = null;

test.before(async () => {
  DATABASE_URL = await bootPostgres();
  if (!DATABASE_URL) { if (IN_CI) throw new Error("DATABASE_URL required for the Delta H07 journey in CI."); return; }
  fake = require("./route/fakeDelta.cjs").makeFakeDelta();
  const dBase = await fake.listen();
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.DELTA_API_BASE = dBase;
  process.env.DELTA_API_KEY = "test-delta-key";
  process.env.DELTA_API_SECRET = "test-delta-secret";
  process.env.ADMIN_USER_IDS = PHONE;               // makes the user Delta-tradable (server-signed env keys)
  process.env.JWT_SECRET = "delta-route-secret-000";
  process.env.CRED_KEY = "route-test-cred-key-32bytes-min!!";
  process.env.BROKER_TRADING_ENABLED = "true";
  process.env.MATRIX_NO_LISTEN = "1";
  server = require("../server.js"); auth = require("../auth.js"); db = require("../db.js"); bcrypt = require("bcryptjs");
  const deadline = Date.now() + 30000;
  while (!server.isSchemaReady() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  assert.ok(server.isSchemaReady(), "schema ready");
  srv = http.createServer(server.app);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${srv.address().port}`;
  await db.createUser(PHONE, bcrypt.hashSync("1234", 8), "Delta Trader", null, null, null, null, true);
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

test("Delta J1: a market BUY places ONE order, verifies the fill, and journals it (no assumed fill)", guard(async () => {
  fake.reset(); fake.setMode("fill", { fillPrice: 100 });
  const before = fake.placeCount();
  const r = await req("POST", "/api/broker/order", { token: TOKEN, headers: oh(newKey()), body: { broker: "delta", symbol: "BTCUSD", side: "buy", qty: 3, price: 100, entryPrice: 100 } });
  assert.equal(fake.placeCount(), before + 1, "exactly one Delta order was placed");
  assert.ok(r.status === 200 || r.status === 201, "order accepted after verified fill: " + JSON.stringify(r.body));
  const trades = await db.getTrades(SKEY, 0, Date.now());
  const open = trades.filter((tr) => tr && tr.real === true && tr.broker === "delta" && tr.entryAt != null && tr.exitAt == null);
  assert.equal(open.length, 1, "one authoritative real Delta position journaled");
  assert.ok(Math.abs(Number(open[0].entry) - 100) < 1e-6, "entry price recorded from the verified fill");
}));

test("Delta J3: a broker REJECTION creates NO position (no phantom) and reports honestly", guard(async () => {
  fake.reset(); fake.setMode("reject");
  const before = (await db.getTrades(SKEY, 0, Date.now())).filter((t) => t && t.real && t.broker === "delta" && t.exitAt == null).length;
  const r = await req("POST", "/api/broker/order", { token: TOKEN, headers: oh(newKey()), body: { broker: "delta", symbol: "BTCUSD", side: "buy", qty: 3, price: 100 } });
  assert.equal(r.status, 400, "a rejected order is an honest 4xx, not a success: " + JSON.stringify(r.body));
  assert.ok(/reject|not filled|insufficient|margin/i.test(JSON.stringify(r.body)), "rejection reason surfaced");
  const after = (await db.getTrades(SKEY, 0, Date.now())).filter((t) => t && t.real && t.broker === "delta" && t.exitAt == null).length;
  assert.equal(after, before, "NO new position from a rejected order (no phantom)");
}));

// A fresh Delta trader isolates the exit/partial journeys from J1/J3 state.
async function freshDelta() {
  const phone = "9" + String(Math.floor(1e8 + Math.random() * 8e8));
  const skey = "ph_" + phone;
  process.env.ADMIN_USER_IDS = process.env.ADMIN_USER_IDS + "," + phone;   // make this trader Delta-tradable too
  await db.createUser(phone, bcrypt.hashSync("1234", 8), "Delta X", null, null, null, null, true);
  const token = auth.signToken(phone, process.env.JWT_SECRET, 24 * 3600 * 1000, 0);
  const session = server.putBrokerSession(skey, "delta", "server-signed");
  const oh2 = (idem, extra = {}) => ({ "X-Broker-Session": session, "X-Confirm-Live": "yes", "X-Idempotency-Key": idem, ...extra });
  const order = (body, extra = {}) => req("POST", "/api/broker/order", { token, headers: oh2(newKey(), extra), body });
  const open = async () => (await db.getTrades(skey, 0, Date.now())).filter((t) => t && t.real && t.broker === "delta" && t.entryAt != null && t.exitAt == null && t.exit == null && t.status !== "rejected");
  return { skey, order, open };
}

test("Delta J-exit: a reduce-only close books an EXIT (realized P&L), NOT a phantom sell row", guard(async () => {
  fake.reset(); fake.setMode("fill", { fillPrice: 100 });
  const t = await freshDelta();
  await t.order({ broker: "delta", symbol: "BTCUSD", side: "buy", qty: 4, price: 100 });            // open long 4 @100
  let open = await t.open();
  assert.equal(open.length, 1, "one open Delta long after the entry");
  fake.setMode("fill", { fillPrice: 130 });
  const r = await t.order({ broker: "delta", symbol: "BTCUSD", side: "sell", qty: 4, price: 130, reduceOnly: true }, { "X-Reduce-Only": "yes" });
  assert.ok(r.status === 200 || r.status === 201, "close accepted: " + JSON.stringify(r.body));
  open = await t.open();
  assert.equal(open.length, 0, "position is CLOSED after the reduce-only sell (no leftover open long)");
  const all = await db.getTrades(t.skey, 0, Date.now());
  const closed = all.filter((x) => x.broker === "delta" && x.status === "closed");
  assert.equal(closed.length, 1, "exactly one closed row (the exit), not a phantom new sell entry");
  assert.ok(Math.abs(Number(closed[0].pnl) - 120) < 1e-6, "realized P&L = (130-100)*4 = 120: " + closed[0].pnl);
}));

test("Delta J-partial: a PARTIAL fill journals the FILLED qty only (never the requested size)", guard(async () => {
  fake.reset(); fake.setMode("partial", { fillPrice: 100 });   // fills floor(qty/2)
  const t = await freshDelta();
  await t.order({ broker: "delta", symbol: "BTCUSD", side: "buy", qty: 4, price: 100 });
  const open = await t.open();
  assert.equal(open.length, 1, "one open Delta position from the partial fill");
  assert.equal(Number(open[0].qty), 2, "journaled the FILLED qty (2), not the requested 4: " + open[0].qty);
}));

test("Delta J-bracket: SL/TP request attaches an exchange-side bracket on Delta", guard(async () => {
  fake.reset(); fake.setMode("fill", { fillPrice: 100 });
  const t = await freshDelta();
  const before = fake.bracketCount();
  await t.order({ broker: "delta", symbol: "BTCUSD", side: "buy", qty: 3, price: 100, slPct: 2, tpPct: 4 });
  assert.equal(fake.bracketCount(), before + 1, "one exchange-side bracket placed on Delta for the SL/TP");
}));
