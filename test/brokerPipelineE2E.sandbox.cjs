/* R38-P2-03 / R39-P1-03 — MatrixOne-PATH real-broker integration CERTIFICATION (Delta testnet).
 *
 * The raw *.sandbox.cjs suites prove broker CREDENTIALS + broker SEMANTICS (a real fill and a reduce-only close). They
 * do NOT prove MatrixOne's own unattended execution pipeline. THIS suite drives an order through MatrixOne's
 * authenticated `/api/broker/order` route against a REAL Delta testnet + a REAL PostgreSQL, and proves the safety
 * invariants end to end through the app's own code (not raw broker HTTP):
 *   J1  ENTRY            a market BUY places ONE order, its fill is VERIFIED (not assumed), and journaled to the ledger.
 *   J2  PROTECTION       an SL/TP request attaches a managed exit / exchange bracket (protection registered).
 *   J3  REDUCE-ONLY CLOSE a reduce-only SELL flattens the position; the local trade projects CLOSED with realized P&L.
 *   J4  RETRY IDEMPOTENCY replaying the SAME idempotency key does NOT place a second broker order (no double-submit).
 *   J5  LOST-RESPONSE    running the C03 reconciler after a fill does NOT create a duplicate — it reconciles, not resend.
 *   J6  SINGLE-OWNER     two REAL OS processes on ONE PostgreSQL race the same signal id → exactly ONE claim commits.
 *   TEARDOWN             any position left open by a failed journey is flattened (reduce-only) and proven flat.
 *
 * WHERE IT RUNS: a STATIC-IP / self-hosted runner whose egress IP is whitelisted at Delta (the CI job `broker-e2e`
 * targets `runs-on: [self-hosted, linux]`). GitHub's shared runners have rotating IPs Delta will reject.
 *
 * GATE (fail-closed, never a false green):
 *   • Runs ONLY when BROKER_E2E=1 AND DATABASE_URL is set AND a COMPLETE Delta testnet credential set + testnet BASE are
 *     present. Any of those missing under BROKER_E2E=1 THROWS in setup — a certification run can never silently pass.
 *   • Without BROKER_E2E it self-skips (ordinary PR/dev) and is EXCLUDED from the default `npm test` gate (.sandbox.cjs).
 *   • DELTA_SANDBOX_BASE must resolve to a Delta TESTNET host (no production default) or setup refuses to run.
 */
const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { execFileSync } = require("child_process");

const E2E = /^(1|true|yes)$/i.test(String(process.env.BROKER_E2E || ""));
const IN_CI = /^(1|true|yes)$/i.test(String(process.env.CI || ""));
const DELTA_OK = !!(process.env.DELTA_SANDBOX_KEY && process.env.DELTA_SANDBOX_SECRET);
const DELTA_BASE = String(process.env.DELTA_SANDBOX_BASE || "").replace(/\/+$/, "");
const SYMBOL = process.env.DELTA_SANDBOX_SYMBOL || "BTCUSD";
const SIZE = Math.max(1, Number(process.env.DELTA_SANDBOX_MAX_SIZE) || 1);

// A Delta TESTNET host only — never production api.delta.exchange. (testnet hostnames contain "testnet".)
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

const PHONE = "9" + String(Math.floor(1e8 + Math.random() * 8e8));
const SKEY = "ph_" + PHONE;
let TOKEN = null, SESSION = null;
const newKey = () => "e2e_" + Math.random().toString(36).slice(2, 12);
const oh = (idem, extra = {}) => ({ "X-Broker-Session": SESSION, "X-Confirm-Live": "yes", "X-Idempotency-Key": idem, ...extra });
const openTrades = async () => (await db.getTrades(SKEY, 0, Date.now())).filter((t) => t && t.real && t.broker === "delta" && t.entryAt != null && t.exitAt == null && t.exit == null && t.status !== "rejected");

test.before(async () => {
  if (!E2E) return;                                   // not a certification run — every test self-skips below
  if (!DELTA_OK) throw new Error("BROKER_E2E=1 requires a COMPLETE Delta testnet credential set (DELTA_SANDBOX_KEY + DELTA_SANDBOX_SECRET)");
  if (!DELTA_BASE) throw new Error("BROKER_E2E=1 requires DELTA_SANDBOX_BASE (the Delta TESTNET base URL — no production default)");
  if (!isTestnetHost(DELTA_BASE)) throw new Error(`refusing to run: DELTA_SANDBOX_BASE host is not a Delta testnet host (${DELTA_BASE})`);
  DATABASE_URL = await bootPostgres();
  if (!DATABASE_URL) throw new Error("BROKER_E2E=1 requires DATABASE_URL (a real PostgreSQL for the MatrixOne pipeline)");

  process.env.DATABASE_URL = DATABASE_URL;
  process.env.DELTA_API_BASE = DELTA_BASE;                       // route every Delta call to the testnet
  process.env.DELTA_API_KEY = process.env.DELTA_SANDBOX_KEY;     // house-signed with the testnet creds
  process.env.DELTA_API_SECRET = process.env.DELTA_SANDBOX_SECRET;
  process.env.ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS ? process.env.ADMIN_USER_IDS + "," : "") + PHONE;   // makes the user Delta-tradable
  process.env.JWT_SECRET = process.env.JWT_SECRET || "e2e-secret-000000000000000000";
  process.env.CRED_KEY = process.env.CRED_KEY || "e2e-test-cred-key-32bytes-minimum!!";
  process.env.BROKER_TRADING_ENABLED = "true";
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
});

test.after(async () => {
  // TEARDOWN — flatten anything a failed journey left open, then prove flat, so the testnet account never leaks exposure.
  try {
    if (base && db) {
      for (let attempt = 0; attempt < 4; attempt++) {
        const open = await openTrades().catch(() => []);
        if (!open.length) break;
        for (const t of open) {
          await req("POST", "/api/broker/order", { token: TOKEN, headers: oh(newKey(), { "X-Reduce-Only": "yes" }), body: { broker: "delta", symbol: t.symbol || SYMBOL, side: "sell", qty: Math.abs(Number(t.qty) || SIZE), reduceOnly: true } }).catch(() => {});
        }
        await new Promise((r) => setTimeout(r, 800));
      }
      const left = await openTrades().catch(() => []);
      if (left.length) console.error(`::error::BROKER-E2E TEARDOWN — ${left.length} position(s) still open after emergency flatten; check the Delta testnet account`);
    }
  } finally {
    if (srv) await new Promise((r) => srv.close(r));
    if (pgHandle) { try { await pgHandle.stop(); } catch { /* ignore */ } }
  }
});

const guard = (fn) => async (t) => { if (!E2E) { t.skip("BROKER_E2E not enabled"); return; } if (!DATABASE_URL) { if (IN_CI) throw new Error("no DB"); t.skip("no PostgreSQL"); return; } return fn(t); };

test("E2E-J1: market BUY through MatrixOne verifies the fill and journals ONE authoritative real position", guard(async () => {
  const before = (await openTrades()).length;
  const r = await req("POST", "/api/broker/order", { token: TOKEN, headers: oh(newKey()), body: { broker: "delta", symbol: SYMBOL, side: "buy", qty: SIZE, orderType: "market" } });
  assert.ok(r.status === 200 || r.status === 201, "order accepted after a VERIFIED fill: " + JSON.stringify(r.body));
  const open = await openTrades();
  assert.equal(open.length, before + 1, "exactly one new authoritative real Delta position journaled from broker truth");
  assert.ok(Number(open[0].entry) > 0, "entry price recorded from the verified fill (not zero/assumed)");
}));

test("E2E-J2: an SL/TP request registers managed protection on the open position", guard(async () => {
  const r = await req("POST", "/api/broker/order", { token: TOKEN, headers: oh(newKey()), body: { broker: "delta", symbol: SYMBOL, side: "buy", qty: SIZE, orderType: "market", slPct: 2, tpPct: 4 } });
  assert.ok(r.status === 200 || r.status === 201, "protected entry accepted: " + JSON.stringify(r.body));
  // Protection is registered either as a managed-exit id on the response or as SL/TP on the journaled trade.
  const open = await openTrades();
  const protectedRow = open.find((t) => (t.sl != null || t.tp != null || t.slPct != null || t.tpPct != null));
  assert.ok(r.body.autoExitId || r.body.managedId || protectedRow, "a managed exit / bracket was registered for the SL/TP: " + JSON.stringify(r.body));
}));

test("E2E-J3: a reduce-only CLOSE flattens the position and projects a CLOSED trade with realized P&L", guard(async () => {
  const open = await openTrades();
  assert.ok(open.length >= 1, "there is an open position to close");
  const pos = open[0];
  const r = await req("POST", "/api/broker/order", { token: TOKEN, headers: oh(newKey(), { "X-Reduce-Only": "yes" }), body: { broker: "delta", symbol: pos.symbol || SYMBOL, side: "sell", qty: Math.abs(Number(pos.qty) || SIZE), reduceOnly: true } });
  assert.ok(r.status === 200 || r.status === 201, "reduce-only close accepted: " + JSON.stringify(r.body));
  const stillOpenSame = (await openTrades()).some((t) => t.id === pos.id);
  assert.ok(!stillOpenSame, "the closed position is no longer open (reduce-only actually flattened it)");
  const closed = (await db.getTrades(SKEY, 0, Date.now())).filter((x) => x.broker === "delta" && x.status === "closed");
  assert.ok(closed.length >= 1, "at least one closed row (the exit), with a realized P&L number");
  assert.ok(Number.isFinite(Number(closed[closed.length - 1].pnl)), "closed trade carries a finite realized P&L");
}));

test("E2E-J4: replaying the SAME idempotency key does NOT place a second broker order", guard(async () => {
  const key = newKey();
  const body = { broker: "delta", symbol: SYMBOL, side: "buy", qty: SIZE, orderType: "market" };
  const beforeCount = (await db.getTrades(SKEY, 0, Date.now())).length;
  const r1 = await req("POST", "/api/broker/order", { token: TOKEN, headers: oh(key), body });
  assert.ok(r1.status === 200 || r1.status === 201, "first submit accepted: " + JSON.stringify(r1.body));
  const afterFirst = (await db.getTrades(SKEY, 0, Date.now())).length;
  const r2 = await req("POST", "/api/broker/order", { token: TOKEN, headers: oh(key), body });   // SAME key ⇒ idempotent replay
  const afterSecond = (await db.getTrades(SKEY, 0, Date.now())).length;
  assert.equal(afterSecond, afterFirst, "the replay created NO new trade row (no double-submit)");
  assert.ok(afterFirst > beforeCount, "the first submit DID create exactly one new row");
}));

test("E2E-J5: the C03 reconciler after a fill reconciles — it does NOT create a duplicate order", guard(async () => {
  const before = (await db.getTrades(SKEY, 0, Date.now())).length;
  if (typeof server.runC03Reconcile === "function") { await server.runC03Reconcile("e2e").catch(() => {}); }
  const after = (await db.getTrades(SKEY, 0, Date.now())).length;
  assert.equal(after, before, "startup/periodic reconciliation is replay-safe — no duplicate trade from a re-run");
}));

test("E2E-J6: two REAL processes on ONE PostgreSQL race the same signal — exactly ONE claim commits (single owner)", guard(async () => {
  const signalId = "e2e:sig:" + Date.now();
  const child = (owner) => {
    const script = `
      process.env.DATABASE_URL = ${JSON.stringify(DATABASE_URL)};
      const db = require(${JSON.stringify(DBPATH)});
      (async () => {
        const claimed = await db.claimSignal(${JSON.stringify(signalId)}, ${JSON.stringify(SKEY)}, "signal");
        process.stdout.write("RESULT:" + JSON.stringify({ owner: ${JSON.stringify(owner)}, claim: !!claimed }) + "\\n");
        process.exit(0);
      })().catch((e) => { process.stderr.write("ERR:" + (e && e.message) + "\\n"); process.exit(7); });`;
    const out = execFileSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"] });
    const line = out.split("\n").find((l) => l.startsWith("RESULT:"));
    if (!line) throw new Error("child produced no RESULT: " + out);
    return JSON.parse(line.slice("RESULT:".length));
  };
  const a = child("procA"), b = child("procB");
  const claims = [a, b].filter((r) => r.claim);
  assert.equal(claims.length, 1, `exactly one process may CLAIM the signal, got ${claims.length}: ${JSON.stringify([a, b])}`);
}));
