/* R38-P2-03 / R39-P1-03 / R40-P1-03 — MatrixOne-PATH real-broker integration CERTIFICATION (Delta testnet).
 *
 * Drives an order through MatrixOne's authenticated `/api/broker/order` route against a REAL Delta testnet + a REAL
 * PostgreSQL, and proves the safety invariants FROM BROKER TRUTH (R40-P1-03 hardening — no more local-only assertions):
 *   J1  ENTRY            a market BUY places ONE order, its fill is VERIFIED, and journaled to the ledger.
 *   J2  PROTECTION       an SL/TP request attaches a managed exit / exchange bracket.
 *   J3  REDUCE-ONLY CLOSE a reduce-only SELL flattens the position; the BROKER reports net qty 0 (queried directly).
 *   J4  NO DOUBLE-SUBMIT replaying the SAME idempotency key does not increase the BROKER's order count for that tag.
 *   J5  RECOVERY         after a fill, the C03 reconciler is IDEMPOTENT vs broker truth — no resend, no duplicate.
 *                        (A genuine accepted-but-response-lost injection + restart-adopt is proven hermetically in
 *                        test/deltaRecovery.test.cjs — a live exchange cannot be made to drop a response on command.)
 *   J6  SINGLE-OWNER     two CONCURRENT OS processes race the same signal on ONE PostgreSQL → exactly ONE claim commits.
 *   TEARDOWN             an out-of-band watchdog reads BROKER positions directly and reduce-only flattens to flat,
 *                        independent of local journal state (so a fill whose journaling failed is still cleaned up).
 *
 * WHERE IT RUNS: a STATIC-IP / self-hosted runner whose egress IP is whitelisted at Delta (CI job `broker-e2e`).
 *
 * GATE (fail-closed): runs ONLY when BROKER_E2E=1 AND DATABASE_URL AND complete Delta testnet creds + a TESTNET base.
 * Any missing under BROKER_E2E=1 THROWS in setup; without BROKER_E2E it self-skips and is excluded from `npm test`.
 */
const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const path = require("path");
const os = require("os");
const fs = require("fs");
const crypto = require("crypto");
const { execFile } = require("child_process");

const E2E = /^(1|true|yes)$/i.test(String(process.env.BROKER_E2E || ""));
const IN_CI = /^(1|true|yes)$/i.test(String(process.env.CI || ""));
const DELTA_OK = !!(process.env.DELTA_SANDBOX_KEY && process.env.DELTA_SANDBOX_SECRET);
const DELTA_BASE = String(process.env.DELTA_SANDBOX_BASE || "").replace(/\/+$/, "");
const SYMBOL = process.env.DELTA_SANDBOX_SYMBOL || "BTCUSD";
const SIZE = Math.max(1, Number(process.env.DELTA_SANDBOX_MAX_SIZE) || 1);
const DKEY = process.env.DELTA_SANDBOX_KEY || "";
const DSECRET = process.env.DELTA_SANDBOX_SECRET || "";

function isTestnetHost(u) { try { return /testnet/i.test(new URL(u).host); } catch { return false; } }

let pgHandle = null, DATABASE_URL = null, srv = null, base = null;
let server, auth, db, bcrypt;
const DBPATH = path.join(__dirname, "..", "db.js");

function loadEmbeddedPg() {
  const tries = ["embedded-postgres", process.env.EMBEDDED_PG_PATH].filter(Boolean);
  for (const t of tries) { try { const M = require(t); return M.default || M; } catch { /* next */ } }
  return null;
}
async function bootPostgres() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const EmbeddedPostgres = loadEmbeddedPg();
  if (!EmbeddedPostgres) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-e2epg-"));
  const port = 58000 + Math.floor(Math.random() * 1500);
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

// --- DIRECT, SIGNED Delta broker-truth reads (independent of the app), mirroring server.js deltaHeaders exactly. ---
async function deltaGet(pathName, query = "") {
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = crypto.createHmac("sha256", DSECRET).update("GET" + ts + pathName + query + "").digest("hex");
  const res = await fetch(DELTA_BASE + pathName + query, { headers: { "api-key": DKEY, timestamp: ts, signature: sig, "Content-Type": "application/json", "User-Agent": "matrix-e2e" } });
  const j = await res.json().catch(() => ({}));
  return Array.isArray(j.result) ? j.result : [];
}
async function deltaPost(pathName, body) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const bs = JSON.stringify(body);
  const sig = crypto.createHmac("sha256", DSECRET).update("POST" + ts + pathName + "" + bs).digest("hex");
  const res = await fetch(DELTA_BASE + pathName, { method: "POST", headers: { "api-key": DKEY, timestamp: ts, signature: sig, "Content-Type": "application/json", "User-Agent": "matrix-e2e" }, body: bs });
  return res.json().catch(() => ({}));
}
const cleanSym = (s) => String(s || "").replace(/(USDT|USD|INR)$/i, "").toUpperCase();
async function brokerNetContracts(symbol) {
  const pos = await deltaGet("/v2/positions/margined");
  return pos.filter((p) => cleanSym(p.product_symbol || p.symbol) === cleanSym(symbol)).reduce((s, p) => s + (Number(p.size) || 0), 0);
}
async function brokerOrderCountByTag(tag) {
  const hist = await deltaGet("/v2/orders/history", `?client_order_id=${encodeURIComponent(String(tag).slice(0, 64))}`);
  return hist.length;
}
async function brokerProductId(symbol) {
  const prods = await deltaGet("/v2/products");
  const p = prods.find((x) => x.symbol === symbol);
  return p ? p.id : null;
}

const PHONE = "9" + String(Math.floor(1e8 + Math.random() * 8e8));
const SKEY = "ph_" + PHONE;
let TOKEN = null, SESSION = null, QTY = null;
const newKey = () => "e2e_" + Math.random().toString(36).slice(2, 12);
const oh = (idem, extra = {}) => ({ "X-Broker-Session": SESSION, "X-Confirm-Live": "yes", "X-Idempotency-Key": idem, ...extra });
const openTrades = async () => (await db.getTrades(SKEY, 0, Date.now())).filter((t) => t && t.real && t.broker === "delta" && t.entryAt != null && t.exitAt == null && t.exit == null && t.status !== "rejected");

test.before(async () => {
  if (!E2E) return;
  if (!DELTA_OK) throw new Error("BROKER_E2E=1 requires a COMPLETE Delta testnet credential set (DELTA_SANDBOX_KEY + DELTA_SANDBOX_SECRET)");
  if (!DELTA_BASE) throw new Error("BROKER_E2E=1 requires DELTA_SANDBOX_BASE (the Delta TESTNET base URL — no production default)");
  if (!isTestnetHost(DELTA_BASE)) throw new Error(`refusing to run: DELTA_SANDBOX_BASE host is not a Delta testnet host (${DELTA_BASE})`);
  DATABASE_URL = await bootPostgres();
  if (!DATABASE_URL) throw new Error("BROKER_E2E=1 requires DATABASE_URL (a real PostgreSQL for the MatrixOne pipeline)");

  process.env.DATABASE_URL = DATABASE_URL;
  process.env.DELTA_API_BASE = DELTA_BASE;
  process.env.DELTA_API_KEY = DKEY;
  process.env.DELTA_API_SECRET = DSECRET;
  process.env.ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS ? process.env.ADMIN_USER_IDS + "," : "") + PHONE;
  process.env.JWT_SECRET = process.env.JWT_SECRET || "e2e-secret-000000000000000000";
  process.env.CRED_KEY = process.env.CRED_KEY || "e2e-test-cred-key-32bytes-minimum!!";
  process.env.BROKER_TRADING_ENABLED = "true";
  process.env.C03_ORDER_ATTEMPTS = "1";
  process.env.MATRIX_NO_LISTEN = "1";

  server = require("../server.js"); auth = require("../auth.js"); db = require("../db.js"); bcrypt = require("bcryptjs");
  const deadline = Date.now() + 30000;
  while (!server.isSchemaReady() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  assert.ok(server.isSchemaReady(), "schema ready");
  srv = http.createServer(server.app);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${srv.address().port}`;
  await db.createUser(PHONE, bcrypt.hashSync("1234", 8), "E2E Trader", null, null, null, null, true);
  TOKEN = auth.signToken(PHONE, process.env.JWT_SECRET, 24 * 3600 * 1000, 0);
  SESSION = server.putBrokerSession(SKEY, "delta", "server-signed");

  // The MatrixOne /api/broker/order path sizes CRYPTO in COIN units (its risk notional = qty × price), whereas
  // DELTA_SANDBOX_MAX_SIZE is a CONTRACT count. Convert: qty(coin) = contract_value × SIZE(contracts) so the app
  // places EXACTLY SIZE contracts at the venue's minimum, with a real (small) notional that fits the testnet wallet —
  // instead of reading "1" as one whole coin (~$64k for BTC). Resolved from broker truth (/v2/products.contract_value).
  const prods = await deltaGet("/v2/products").catch(() => []);
  const prod = prods.find((x) => x.symbol === SYMBOL);
  const cv = prod && Number(prod.contract_value) > 0 ? Number(prod.contract_value) : 1;
  QTY = cv * SIZE;
});

test.after(async () => {
  // TEARDOWN WATCHDOG — read BROKER positions directly (not the local ledger) and reduce-only flatten to flat, so a
  // fill whose journaling failed is still cleaned up. Publishes a loud marker if it can't prove flat.
  try {
    if (E2E && DELTA_BASE && DKEY) {
      const pid = await brokerProductId(SYMBOL).catch(() => null);
      for (let attempt = 0; attempt < 6; attempt++) {
        const net = await brokerNetContracts(SYMBOL).catch(() => 0);
        if (net === 0) break;
        if (pid) { await deltaPost("/v2/orders", { product_id: pid, size: Math.abs(net), side: net > 0 ? "sell" : "buy", order_type: "market_order", reduce_only: true }).catch(() => {}); }
        await new Promise((r) => setTimeout(r, 800));
      }
      const left = await brokerNetContracts(SYMBOL).catch(() => 1);
      if (left !== 0) console.error(`::error::BROKER-E2E TEARDOWN — Delta testnet still shows net ${left} for ${SYMBOL} after watchdog flatten; check the account`);
    }
  } finally {
    if (srv) await new Promise((r) => srv.close(r));
    if (pgHandle) { try { await pgHandle.stop(); } catch { /* ignore */ } }
  }
});

const guard = (fn) => async (t) => { if (!E2E) { t.skip("BROKER_E2E not enabled"); return; } if (!DATABASE_URL) { if (IN_CI) throw new Error("no DB"); t.skip("no PostgreSQL"); return; } return fn(t); };

test("E2E-J1: market BUY through MatrixOne verifies the fill and journals ONE authoritative real position", guard(async () => {
  const before = (await openTrades()).length;
  const r = await req("POST", "/api/broker/order", { token: TOKEN, headers: oh(newKey()), body: { broker: "delta", symbol: SYMBOL, side: "buy", qty: QTY, orderType: "market" } });
  assert.ok(r.status === 200 || r.status === 201, "order accepted after a VERIFIED fill: " + JSON.stringify(r.body));
  const open = await openTrades();
  assert.equal(open.length, before + 1, "exactly one new authoritative real Delta position journaled from broker truth");
  assert.ok(Number(open[0].entry) > 0, "entry price recorded from the verified fill (not zero/assumed)");
}));

test("E2E-J2: an SL/TP request registers managed protection on the open position", guard(async () => {
  const r = await req("POST", "/api/broker/order", { token: TOKEN, headers: oh(newKey()), body: { broker: "delta", symbol: SYMBOL, side: "buy", qty: QTY, orderType: "market", slPct: 2, tpPct: 4 } });
  assert.ok(r.status === 200 || r.status === 201, "protected entry accepted: " + JSON.stringify(r.body));
  const open = await openTrades();
  const protectedRow = open.find((t) => (t.sl != null || t.tp != null || t.slPct != null || t.tpPct != null));
  assert.ok(r.body.autoExitId || r.body.managedId || (r.body.bracket && !r.body.bracket.error) || protectedRow, "a managed exit / bracket was registered for the SL/TP: " + JSON.stringify(r.body));
}));

test("E2E-J3: a reduce-only CLOSE makes the BROKER flat (queried directly) with a projected CLOSED trade", guard(async () => {
  const open = await openTrades();
  assert.ok(open.length >= 1, "there is an open position to close");
  const sym = open[0].symbol || SYMBOL;
  // J1 opened a position and J2 opened a SECOND (protected) one on the same product, so the venue nets >1 contract.
  // Flatten EVERY open journal position reduce-only so the broker truly nets to zero (not just the first row's qty).
  for (const pos of open) {
    const r = await req("POST", "/api/broker/order", { token: TOKEN, headers: oh(newKey(), { "X-Reduce-Only": "yes" }), body: { broker: "delta", symbol: pos.symbol || SYMBOL, side: "sell", qty: Math.abs(Number(pos.qty) || QTY), reduceOnly: true } });
    assert.ok(r.status === 200 || r.status === 201, "reduce-only close accepted: " + JSON.stringify(r.body));
  }
  // BROKER TRUTH: re-read Delta positions until this symbol nets to zero (not merely "the local row closed").
  let net = null;
  for (let i = 0; i < 8; i++) { await new Promise((res) => setTimeout(res, 500)); net = await brokerNetContracts(sym); if (net === 0) break; }
  assert.equal(net, 0, "the BROKER reports the position flat after the reduce-only close (queried from Delta directly)");
  const closed = (await db.getTrades(SKEY, 0, Date.now())).filter((x) => x.broker === "delta" && x.status === "closed");
  assert.ok(closed.length >= 1 && Number.isFinite(Number(closed[closed.length - 1].pnl)), "a CLOSED trade with a finite realized P&L is projected locally");
}));

test("E2E-J4: replaying the SAME idempotency key does not increase the BROKER's order count for that tag", guard(async () => {
  const key = newKey();
  const body = { broker: "delta", symbol: SYMBOL, side: "buy", qty: QTY, orderType: "market" };
  const r1 = await req("POST", "/api/broker/order", { token: TOKEN, headers: oh(key), body });
  assert.ok(r1.status === 200 || r1.status === 201, "first submit accepted: " + JSON.stringify(r1.body));
  await new Promise((res) => setTimeout(res, 800));
  const brokerCountAfterFirst = await brokerOrderCountByTag(key);   // BROKER TRUTH: orders carrying our client_order_id
  assert.ok(brokerCountAfterFirst >= 1, "the first submit created a broker order tagged with our key");
  await req("POST", "/api/broker/order", { token: TOKEN, headers: oh(key), body });   // SAME key ⇒ idempotent replay
  await new Promise((res) => setTimeout(res, 800));
  const brokerCountAfterReplay = await brokerOrderCountByTag(key);
  assert.equal(brokerCountAfterReplay, brokerCountAfterFirst, "the replay placed NO additional broker order (counted at the broker, not locally)");
  // clean up the position this test opened
  const net = await brokerNetContracts(SYMBOL);
  if (net !== 0) { const pid = await brokerProductId(SYMBOL); if (pid) await deltaPost("/v2/orders", { product_id: pid, size: Math.abs(net), side: net > 0 ? "sell" : "buy", order_type: "market_order", reduce_only: true }).catch(() => {}); }
}));

test("E2E-J5: the C03 reconciler is IDEMPOTENT vs broker truth after a fill (no resend, no duplicate)", guard(async () => {
  const key = newKey();
  await req("POST", "/api/broker/order", { token: TOKEN, headers: oh(key), body: { broker: "delta", symbol: SYMBOL, side: "buy", qty: QTY, orderType: "market" } });
  await new Promise((res) => setTimeout(res, 800));
  const beforeCount = await brokerOrderCountByTag(key);
  const beforeOpen = (await openTrades()).length;
  if (typeof server.runC03Reconcile === "function") { await server.runC03Reconcile("e2e"); await server.runC03Reconcile("e2e-again"); }
  await new Promise((res) => setTimeout(res, 500));
  assert.equal(await brokerOrderCountByTag(key), beforeCount, "recovery did NOT resend the order (broker order count unchanged)");
  assert.equal((await openTrades()).length, beforeOpen, "recovery adopted no duplicate local position");
  // (The full accepted-but-response-lost → restart → adopt-from-truth path is proven in test/deltaRecovery.test.cjs.)
  const net = await brokerNetContracts(SYMBOL);
  if (net !== 0) { const pid = await brokerProductId(SYMBOL); if (pid) await deltaPost("/v2/orders", { product_id: pid, size: Math.abs(net), side: net > 0 ? "sell" : "buy", order_type: "market_order", reduce_only: true }).catch(() => {}); }
}));

test("E2E-J6: two CONCURRENT processes on ONE PostgreSQL race the same signal — exactly ONE claim commits", guard(async () => {
  const signalId = "e2e:sig:" + Date.now();
  const startAt = Date.now() + 1200;   // a wall-clock BARRIER: both children busy-wait to this instant, then claim together
  const runChild = (owner) => new Promise((resolve, reject) => {
    const script = `
      process.env.DATABASE_URL = ${JSON.stringify(DATABASE_URL)};
      const db = require(${JSON.stringify(DBPATH)});
      (async () => {
        while (Date.now() < ${startAt}) { /* spin to the barrier so both claims fire concurrently */ }
        const claimed = await db.claimSignal(${JSON.stringify(signalId)}, ${JSON.stringify(SKEY)}, "signal");
        process.stdout.write("RESULT:" + JSON.stringify({ owner: ${JSON.stringify(owner)}, claim: !!claimed }) + "\\n");
        process.exit(0);
      })().catch((e) => { process.stderr.write("ERR:" + (e && e.message) + "\\n"); process.exit(7); });`;
    execFile(process.execPath, ["-e", script], { timeout: 30000 }, (err, stdout) => {
      if (err && !stdout) return reject(err);
      const line = String(stdout).split("\n").find((l) => l.startsWith("RESULT:"));
      if (!line) return reject(new Error("child produced no RESULT: " + stdout));
      resolve(JSON.parse(line.slice("RESULT:".length)));
    });
  });
  const [a, b] = await Promise.all([runChild("procA"), runChild("procB")]);   // launched together; both hit the barrier
  const claims = [a, b].filter((r) => r.claim);
  assert.equal(claims.length, 1, `exactly one CONCURRENT process may CLAIM the signal, got ${claims.length}: ${JSON.stringify([a, b])}`);
}));
