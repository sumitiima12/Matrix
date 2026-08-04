/* R31-P2-04 — LEASE FENCE BOUND TO THE BROKER SEND.
   Proves that submitWithAttempt (the C03 write-before-send orchestrator) will NOT place a broker order when the
   calling worker has lost its single-owner lease to a takeover — even if it already won the PREPARED→SUBMITTING CAS
   and only lost the lease during the pause between the claim and the send. The lease/fence semantics are the REAL
   ones from db.js against a REAL PostgreSQL (the "two instances" are two owner strings against one leases table —
   the fence, not the process count, is what makes a worker stale). The attempt store is a faithful in-memory model
   of prepare/transition/finalize so the CAS + idempotency behaviour is exercised exactly as in production.

   Real DB required (DATABASE_URL, or embedded-postgres via EMBEDDED_PG_PATH). In CI a missing DB is a FAILURE. */
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { submitWithAttempt } = require("../orderRecovery.js");

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-fencepg-"));
  const port = 58000 + Math.floor(Math.random() * 1500);
  pgHandle = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "postgres", port, persistent: false });
  await pgHandle.initialise(); await pgHandle.start(); await pgHandle.createDatabase("matrix_test");
  return `postgres://postgres:postgres@127.0.0.1:${port}/matrix_test`;
}

test.before(async () => {
  DATABASE_URL = await bootPostgres();
  if (!DATABASE_URL) { if (IN_CI) throw new Error("DATABASE_URL required for the R31-P2-04 fence-to-send proof in CI."); return; }
  process.env.DATABASE_URL = DATABASE_URL;
  db = require(DBPATH);
  await db.initDb();
});
test.after(async () => { try { if (pgHandle) await pgHandle.stop(); } catch { /* ignore */ } });
const guard = (fn) => async (t) => { if (!DATABASE_URL) { if (IN_CI) throw new Error("no DB"); t.skip("no PostgreSQL"); return; } return fn(t); };

/* Faithful in-memory attempt store mirroring the production CAS contract:
   - prepareOrderAttempt: insert-once (idempotent on id), returns the existing row on a same-id retry;
   - transitionOrderAttempt(id, from, to): atomic compare-and-set — succeeds ONLY if current status === from;
   - finalizeOrderAttempt / getOrderAttempt as expected. */
function makeAttemptStore() {
  const rows = new Map();
  return {
    rows,
    async prepareOrderAttempt(a) {
      const id = String(a.id);
      if (!rows.has(id)) rows.set(id, { ...a, id, status: "PREPARED" });
      return { ...rows.get(id) };
    },
    async transitionOrderAttempt(id, from, to) {
      const r = rows.get(String(id));
      if (!r || r.status !== from) return null;   // CAS: only from the expected state
      r.status = to; return { ...r };
    },
    async getOrderAttempt(id) { const r = rows.get(String(id)); return r ? { ...r } : null; },
    async finalizeOrderAttempt(id, status, patch = {}) { const r = rows.get(String(id)); if (r) Object.assign(r, { status, resolved: patch.resolved ?? r.resolved }, patch); return r ? { ...r } : null; },
  };
}

test("R31-P2-04: a STALE-FENCE worker is fenced out — the broker send never happens", guard(async () => {
  const name = "engine:send:" + Date.now();
  await db.releaseLease(name, "A").catch(() => {});
  // Worker A owns the lease (fence 1) but with a tiny TTL; it then lets the lease expire and B takes over (fence 2).
  const a = await db.acquireLease(name, "A", 1);
  assert.equal(a.fence, 1);
  await new Promise((r) => setTimeout(r, 25));
  const b = await db.acquireLease(name, "B", 30000);
  assert.equal(b.fence, 2, "takeover bumped the fence");

  const store = makeAttemptStore();
  let sends = 0;
  const res = await submitWithAttempt({
    db: store,
    attempt: { id: "att_stale_" + Date.now(), userId: "u1", orderTag: "tagA" },
    submit: async () => { sends++; return { filled: true }; },
    classify: () => ({ status: "FILLED", patch: { resolved: true } }),
    // A still THINKS it holds fence 1 — but that fence is no longer live.
    fenceGuard: async () => db.fenceValid(name, 1),
  });
  assert.equal(res.fenced, true, "the stale worker is fenced");
  assert.equal(res.submitted, false, "no submission reported");
  assert.equal(sends, 0, "the broker submit() was NEVER called by the fenced worker");
  await db.releaseLease(name, "B").catch(() => {});
}));

test("R31-P2-04: the CURRENT-fence owner submits exactly once", guard(async () => {
  const name = "engine:send:live:" + Date.now();
  await db.releaseLease(name, "B").catch(() => {});
  const b = await db.acquireLease(name, "B", 30000);
  assert.equal(b.acquired, true);

  const store = makeAttemptStore();
  let sends = 0;
  const res = await submitWithAttempt({
    db: store,
    attempt: { id: "att_live_" + Date.now(), userId: "u1", orderTag: "tagB" },
    submit: async () => { sends++; return { filled: true }; },
    classify: () => ({ status: "FILLED", patch: { resolved: true } }),
    fenceGuard: async () => db.fenceValid(name, b.fence),
  });
  assert.equal(res && res.filled, true, "the live-fence worker's order went through");
  assert.equal(sends, 1, "submitted exactly once");
  await db.releaseLease(name, "B").catch(() => {});
}));

test("R31-P2-04: a fence lost in the PAUSE WINDOW (after the SUBMITTING claim) still blocks the send", guard(async () => {
  const name = "engine:send:pause:" + Date.now();
  await db.releaseLease(name, "A").catch(() => {});
  const a = await db.acquireLease(name, "A", 30000);
  assert.equal(a.fence >= 1, true);

  const store = makeAttemptStore();
  let sends = 0, checks = 0;
  // The fence is LIVE for the first guard call (pre-CAS) but a takeover happens BEFORE the send, so the second
  // guard call (immediately pre-send) sees it as stale. Proves the re-check at the last instant catches the pause.
  const res = await submitWithAttempt({
    db: store,
    attempt: { id: "att_pause_" + Date.now(), userId: "u1", orderTag: "tagP" },
    submit: async () => { sends++; return { filled: true }; },
    classify: () => ({ status: "FILLED", patch: { resolved: true } }),
    fenceGuard: async () => {
      checks++;
      if (checks === 1) return true;                       // pre-CAS: still the owner
      // Simulate the pause + takeover happening between the CAS win and the send: B evicts A.
      await db.acquireLease(name, "A", 1);                 // shorten A's own lease so it can be taken over
      await new Promise((r) => setTimeout(r, 20));
      await db.acquireLease(name, "B", 30000);             // B takes over → A's fence is now stale
      return db.fenceValid(name, a.fence);                 // false — A lost the lease during the pause
    },
  });
  assert.equal(res.fenced, true, "the pause-window takeover is caught by the pre-send re-check");
  assert.equal(sends, 0, "no broker order was placed after losing the lease mid-flight");
  assert.ok(checks >= 2, "the fence was re-checked immediately before the send");
  // The attempt is left SUBMITTING (not resolved) so recovery reconciles it by tag — never a phantom send.
  const at = await store.getOrderAttempt(res.attempt.id);
  assert.equal(at.status, "SUBMITTING", "attempt parked SUBMITTING for tag-based recovery, not falsely finalized");
  await db.releaseLease(name, "B").catch(() => {});
}));
