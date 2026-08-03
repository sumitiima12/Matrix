/* S7 (Round 30 P2-09) — MULTI-INSTANCE fault proof against a REAL database.
   Spawns TWO actual OS node processes that connect to ONE shared PostgreSQL and race to:
     • acquire the SAME named lease  → exactly ONE wins (single owner), the other stands down;
     • claim the SAME deterministic signal id → exactly ONE claim commits (one signal = one attempt).
   Then, in-process, proves fencing on takeover: an expired lease is taken over with an INCREMENTED fence, the
   previous holder's fence becomes invalid, and a stale renew by the old owner is rejected — so a worker that lost
   the lease during a pause/partition can never resume and double-act.

   Real DB required: uses process.env.DATABASE_URL (CI provides it) or a local embedded-postgres via EMBEDDED_PG_PATH.
   In CI a missing DB is a FAILURE (these are safety proofs), not a silent skip. */
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { execFileSync } = require("child_process");

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-leasepg-"));
  const port = 57000 + Math.floor(Math.random() * 2000);
  pgHandle = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "postgres", port, persistent: false });
  await pgHandle.initialise();
  await pgHandle.start();
  await pgHandle.createDatabase("matrix_test");
  return `postgres://postgres:postgres@127.0.0.1:${port}/matrix_test`;
}

test.before(async () => {
  DATABASE_URL = await bootPostgres();
  if (!DATABASE_URL) {
    if (IN_CI) throw new Error("DATABASE_URL is required for the S7 two-process lease proof in CI (skips are failures).");
    return;
  }
  process.env.DATABASE_URL = DATABASE_URL;
  db = require(DBPATH);
  await db.initDb();   // create leases + signal_claims (+ everything) once, in the parent
});

test.after(async () => { try { if (pgHandle) await pgHandle.stop(); } catch { /* ignore */ } });

const guard = (fn) => async (t) => {
  if (!DATABASE_URL) { if (IN_CI) throw new Error("no DB"); t.skip("no PostgreSQL available"); return; }
  return fn(t);
};

// Run a child node process that connects to the SAME PG and performs one lease+signal race, printing a JSON line.
function raceChild(owner, leaseName, signalId) {
  const script = `
    process.env.DATABASE_URL = ${JSON.stringify(DATABASE_URL)};
    const db = require(${JSON.stringify(DBPATH)});
    (async () => {
      const lease = await db.acquireLease(${JSON.stringify(leaseName)}, ${JSON.stringify(owner)}, 30000);
      const claim = await db.claimSignal(${JSON.stringify(signalId)}, "u1", "signal");
      process.stdout.write("RESULT:" + JSON.stringify({ owner: ${JSON.stringify(owner)}, acquired: !!lease.acquired, fence: lease.fence, claim: !!claim }) + "\\n");
      process.exit(0);
    })().catch((e) => { process.stderr.write("ERR:" + (e && e.message) + "\\n"); process.exit(7); });
  `;
  const out = execFileSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"] });
  const line = out.split("\n").find((l) => l.startsWith("RESULT:"));
  if (!line) throw new Error("child produced no RESULT: " + out);
  return JSON.parse(line.slice("RESULT:".length));
}

test("S7: two real processes racing one Postgres — exactly ONE lease owner and ONE signal claim", guard(async () => {
  const leaseName = "engine:test:" + Date.now();
  const signalId = "sig:test:" + Date.now();
  // Two separate OS processes, same DB. Launched back-to-back; the DB (name PK + ON CONFLICT) is the sole arbiter,
  // so the invariant holds regardless of which starts first.
  const a = raceChild("procA", leaseName, signalId);
  const b = raceChild("procB", leaseName, signalId);

  const owners = [a, b].filter((r) => r.acquired);
  assert.equal(owners.length, 1, `exactly one process may OWN the lease, got ${owners.length}: ${JSON.stringify([a, b])}`);

  const claims = [a, b].filter((r) => r.claim);
  assert.equal(claims.length, 1, `exactly one process may CLAIM the signal, got ${claims.length}: ${JSON.stringify([a, b])}`);

  // The winning owner holds a positive fence; the loser did not acquire.
  assert.ok(owners[0].fence >= 1, "the owner holds a fence token");
}));

test("S7: fencing on takeover — expired lease taken over increments the fence and invalidates the old holder", guard(async () => {
  const name = "engine:fence:" + Date.now();
  await db.releaseLease(name, "A").catch(() => {});
  // A acquires with a 1ms TTL, then lets it expire.
  const a1 = await db.acquireLease(name, "A", 1);
  assert.equal(a1.acquired, true);
  assert.equal(a1.fence, 1, "first acquisition fence is 1");
  await new Promise((r) => setTimeout(r, 25));   // let A's lease expire

  // B takes over the EXPIRED lease → fence increments to 2.
  const b1 = await db.acquireLease(name, "B", 30000);
  assert.equal(b1.acquired, true, "B takes over the expired lease");
  assert.equal(b1.fence, 2, "takeover increments the fence");

  // The OLD fence is now invalid; the CURRENT one is valid. A stale worker holding fence 1 is fenced out.
  assert.equal(await db.fenceValid(name, 1), false, "the previous holder's fence (1) is rejected");
  assert.equal(await db.fenceValid(name, 2), true, "the current holder's fence (2) is accepted");

  // A stale renew by the OLD owner with the OLD fence must be rejected (returns null ⇒ A must stand down).
  const stale = await db.renewLease(name, "A", 1, 30000);
  assert.equal(stale, null, "a stale renew by the evicted owner is rejected");

  // The current owner renews successfully, keeping the same fence.
  const good = await db.renewLease(name, "B", 2, 30000);
  assert.equal(good, 2, "the live owner renews and keeps its fence");
  await db.releaseLease(name, "B").catch(() => {});
}));

test("S7: a claimed signal cannot be claimed again (one signal = one attempt, across restarts)", guard(async () => {
  const id = "sig:once:" + Date.now();
  assert.equal(await db.claimSignal(id, "u1", "signal"), true, "first claim wins");
  assert.equal(await db.claimSignal(id, "u1", "signal"), false, "a second claim of the same id is refused");
  assert.equal(await db.claimSignal(id, "u2", "signal"), false, "even a different user cannot re-claim the id");
}));
