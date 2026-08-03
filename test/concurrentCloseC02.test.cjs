/* R31-C02 / H03 — two DISTINCT close order IDs race the SAME open position against ONE PostgreSQL. The stale-plan
   guard in recordExitAtomic (re-read under SELECT FOR UPDATE) must let exactly ONE close commit; the other, whose plan
   was computed against the pre-close state, must be rejected with STALE_PLAN rather than writing a second exit leg that
   double-consumes the same units. Proves the DECISION is serialized, not just the write.

   Real DB required: process.env.DATABASE_URL (CI) or local embedded-postgres via EMBEDDED_PG_PATH. In CI a missing DB
   is a FAILURE (this is a safety proof), not a silent skip. */
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const os = require("os");
const fs = require("fs");

const IN_CI = /^(1|true|yes)$/i.test(String(process.env.CI || ""));
const DBPATH = path.join(__dirname, "..", "db.js");

function loadEmbeddedPg() {
  const tries = ["embedded-postgres", process.env.EMBEDDED_PG_PATH].filter(Boolean);
  for (const t of tries) { try { const M = require(t); return M.default || M; } catch { /* next */ } }
  return null;
}

let pgHandle = null, DATABASE_URL = null, db = null;

async function bootPostgres() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const EmbeddedPostgres = loadEmbeddedPg();
  if (!EmbeddedPostgres) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-c02pg-"));
  const port = 58000 + Math.floor(Math.random() * 1500);
  pgHandle = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "postgres", port, persistent: false });
  await pgHandle.initialise();
  await pgHandle.start();
  await pgHandle.createDatabase("matrix_test");
  return `postgres://postgres:postgres@127.0.0.1:${port}/matrix_test`;
}

test.before(async () => {
  DATABASE_URL = await bootPostgres();
  if (!DATABASE_URL) { if (IN_CI) throw new Error("DATABASE_URL required for the C02 concurrent-close proof in CI."); return; }
  process.env.DATABASE_URL = DATABASE_URL;
  db = require(DBPATH);
  await db.initDb();
});
test.after(async () => { try { if (pgHandle) await pgHandle.stop(); } catch { /* ignore */ } });

const guard = (fn) => async (t) => {
  if (!DATABASE_URL) { if (IN_CI) throw new Error("no DB"); t.skip("no PostgreSQL available"); return; }
  return fn(t);
};

const bare = (s) => String(s || "").replace(/^NSE:/, "").replace(/-EQ$/, "");
// Build a close plan (full close of one open row) + the expect precondition — the shape applyReduceOnlyExit produces.
function planFullClose(row, { orderId, exitPx }) {
  const pnl = +(((exitPx) - (Number(row.entry) || 0)) * (Number(row.qty) || 0)).toFixed(2);
  const rows = [{ ...row, exit: exitPx, exitAt: Date.now(), pnl, status: "closed", exitOrderId: orderId, exitReason: "Manual close (reduce-only)" }];
  const expect = [{ id: row.id, qty: Number(row.qty) || 0 }];
  return { rows, expect };
}

test("R31-C02/H03: two distinct close IDs on one open row — exactly one commits, the other is STALE_PLAN", guard(async () => {
  const userId = "ph_c02user";
  const seed = { id: "c02_" + Date.now(), real: true, sym: "NSE:TATA-EQ", side: "BUY", qty: 10, entry: 200, entryAt: Date.now(), broker: "fyers", market: "IN" };
  await db.saveTrade(userId, seed, { authoritative: true });
  // Plan from what getTrades returns — the STORED (user-namespaced) row, exactly as applyReduceOnlyExit does.
  const openRow = (await db.getTrades(userId, 0, Date.now())).find((t) => t.exitAt == null && bare(t.sym) === "TATA");
  assert.ok(openRow && Number(openRow.qty) === 10, "seeded open row is readable at qty 10");
  const rowId = openRow.id;

  // Both replicas planned their close from the SAME pre-close read of the 10-unit row.
  const A = planFullClose(openRow, { orderId: "CLOSE_A", exitPx: 230 });
  const B = planFullClose(openRow, { orderId: "CLOSE_B", exitPx: 231 });

  const fillA = { orderId: "CLOSE_A", kind: "exit", side: "SELL", qty: 10, entry: 230, price: 230, broker: "fyers", market: "IN", ts: Date.now() };
  const fillB = { orderId: "CLOSE_B", kind: "exit", side: "SELL", qty: 10, entry: 231, price: 231, broker: "fyers", market: "IN", ts: Date.now() };

  // Replica A commits first.
  await db.recordExitAtomic(userId, { fill: fillA, rows: A.rows, expect: A.expect });

  // Replica B's plan is now STALE (the row A closed is no longer open at qty 10). The guard must reject it.
  let bErr = null;
  try { await db.recordExitAtomic(userId, { fill: fillB, rows: B.rows, expect: B.expect }); }
  catch (e) { bErr = e; }
  assert.ok(bErr, "replica B must NOT commit its stale close");
  assert.equal(bErr.code, "STALE_PLAN", "B is rejected with STALE_PLAN, not silently written: " + (bErr && bErr.message));

  // The position was closed EXACTLY once, by A — no double leg, no resurrected qty.
  const trades = await db.getTrades(userId, 0, Date.now());
  const closedByA = trades.filter((t) => String(t.exitOrderId || "") === "CLOSE_A");
  const closedByB = trades.filter((t) => String(t.exitOrderId || "") === "CLOSE_B");
  assert.equal(closedByA.length, 1, "exactly one row closed by A");
  assert.equal(closedByB.length, 0, "no row closed by B (its stale plan never committed)");
  const theRow = trades.find((t) => t.id === rowId);
  assert.equal(theRow.status, "closed", "the original row is closed once");
  assert.equal(Number(theRow.pnl), 300, "realized P&L booked once = (230-200)*10");
}));
