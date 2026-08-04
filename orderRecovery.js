/* C03 slice 2 — startup broker-backed reconciliation of durable order attempts.
 *
 * At backend startup (before money-moving routes/automation open) we must resolve every unresolved
 * order_attempt against BROKER TRUTH: an attempt left PREPARED/SUBMITTING/UNKNOWN after a crash or lost
 * response is looked up by its deterministic orderTag; a confirmed fill is adopted exactly once, a confirmed
 * rejection/absence is closed, and anything the broker can't conclusively confirm (unreachable, partial,
 * still-pending) KEEPS THE ACCOUNT LOCKED. Fail closed everywhere.
 *
 * Pure/injected so it is provable without a live server: the caller passes `db`, a per-attempt broker probe,
 * a fill-adopter, a lock setter, an advisory-lock (single-owner) acquirer, a fault seam and a logger. The
 * production wiring (slice 2b) supplies the real db, FYERS order/trade/position reads, recordAuthoritativeFill,
 * db.setRiskLock/setEntryHalt and a pg advisory lock — behind the C03_ORDER_ATTEMPTS flag.
 *
 * `probeByTag(attempt)` must return a NORMALIZED outcome or throw (throw ⇒ unreachable ⇒ stay locked):
 *   { status: "filled"|"partial"|"rejected"|"absent"|"pending"|"unknown", orderId?, filledQty?, avgPrice? }
 *   or null for inconclusive.
 */
async function reconcileUnresolvedAttempts(deps) {
  const {
    db, probeByTag, adoptFill, setLock, setHalt,
    acquireOwner = async () => true,   // advisory lock: returns true if THIS worker is the single owner
    releaseOwner = async () => {},     // MUST release the single-owner lock when the sweep finishes (see below)
    faults = null, logger = () => {}, limit = 1000,
  } = deps || {};

  if (faults) faults.gate("c03.recover.owner");
  const owner = await acquireOwner();
  if (!owner) { logger("c03.recover.not_owner", {}); return { owner: false, skipped: true }; }
  /* OWNERSHIP LIFECYCLE: acquireOwner takes a single-owner lock (a pg advisory lock in prod). It MUST be released
     when this sweep ends — otherwise the lock lingers on whatever pooled connection took it, and the NEXT sweep
     (often a different pooled connection) gets owner=false and SILENTLY no-ops. That would quietly wedge the
     reconciler: unresolved UNKNOWN orders would stop being reconciled and accounts would never re-lock/settle.
     So everything after acquisition runs in a try/finally that always releases. */
  try {
  const attempts = await db.listUnresolvedOrderAttempts(limit);
  let resolved = 0, adopted = 0, keptLocked = 0;
  const lockUsers = new Set();   // users with an attempt we could NOT resolve → re-lock them per-user

  for (const a of attempts) {
    let ob;
    try { ob = await probeByTag(a); }
    catch { keptLocked++; if (a.userId) lockUsers.add(a.userId); logger("c03.recover.unreachable", { id: a.id, tag: a.orderTag }); continue; }   // broker down ⇒ lock stays
    if (ob == null) { keptLocked++; if (a.userId) lockUsers.add(a.userId); logger("c03.recover.inconclusive", { id: a.id, tag: a.orderTag }); continue; }

    if (ob.status === "filled") {
      // Adopt the fill EXACTLY ONCE (the fills ledger dedupes on the broker key), then resolve terminally.
      await adoptFill(a, ob);
      await db.finalizeOrderAttempt(a.id, "FILLED", { brokerOrderId: ob.orderId || null, filledQty: ob.filledQty, avgPrice: ob.avgPrice, resolved: true });
      resolved++; adopted++;
      logger("c03.recover.filled", { id: a.id, tag: a.orderTag, filledQty: ob.filledQty });
    } else if (ob.status === "rejected" || ob.status === "absent") {
      // Broker conclusively says nothing is (or stays) open → close it; NO fill adopted.
      await db.finalizeOrderAttempt(a.id, ob.status === "absent" ? "CANCELLED" : "REJECTED", { resolved: true });
      resolved++;
      logger("c03.recover.closed", { id: a.id, tag: a.orderTag, outcome: ob.status });
    } else if (ob.status === "partial") {
      // Adopt the partial fill (idempotent in the ledger) but DO NOT resolve — the residual is still open,
      // so the account stays locked until it settles fully.
      await adoptFill(a, ob);
      await db.finalizeOrderAttempt(a.id, "PARTIAL", { brokerOrderId: ob.orderId || null, filledQty: ob.filledQty, avgPrice: ob.avgPrice });
      keptLocked++; if (a.userId) lockUsers.add(a.userId);
      logger("c03.recover.partial", { id: a.id, tag: a.orderTag, filledQty: ob.filledQty });
    } else if (ob.status === "manual") {
      /* R33-P3-01: the broker was fully readable but CANNOT prove this (previous-session) order's outcome — no
         endpoint covers it. This is NOT transient, so we do not leave it silently pending forever. Stamp a durable,
         AUDITABLE MANUAL_RECONCILIATION_REQUIRED state (kept UNRESOLVED so the account stays locked) with the exact
         evidence, and emit an operator alert. A human / EOD statement resolves it; automation never fabricates an
         outcome. Idempotent: re-stamping the same state on a later sweep is a no-op that keeps the lock. */
      await db.finalizeOrderAttempt(a.id, "MANUAL_RECONCILIATION_REQUIRED", { manual: true, evidence: ob.evidence || null });
      keptLocked++; if (a.userId) lockUsers.add(a.userId);
      logger("c03.recover.manual_required", { id: a.id, tag: a.orderTag, reason: ob.reason || null, evidence: ob.evidence || null });
    } else {
      // pending / unknown → not conclusive → stay locked, retry a later sweep.
      keptLocked++; if (a.userId) lockUsers.add(a.userId);
      logger("c03.recover.pending", { id: a.id, tag: a.orderTag, status: ob.status });
    }
  }

  // Re-arm the durable safety state PER-USER for every account with an unresolved attempt (same signature as
  // rearmFromUnresolvedAttempts). Fail closed: on a read error we keep every touched user locked.
  try {
    const remaining = await db.listUnresolvedOrderAttempts(limit);
    for (const a of remaining) if (a && a.userId) lockUsers.add(a.userId);
  } catch { /* keep whatever we already gathered locked */ }
  for (const uid of lockUsers) {
    if (setLock) await setLock(uid, true);
    if (setHalt) await setHalt(uid, true);
  }
  const stillUnresolved = lockUsers.size > 0;
  logger("c03.recover.done", { attempts: attempts.length, resolved, adopted, keptLocked, stillUnresolved, lockedUsers: lockUsers.size });
  return { owner: true, attempts: attempts.length, resolved, adopted, keptLocked, stillUnresolved, lockedUsers: [...lockUsers] };
  } finally {
    try { await releaseOwner(); } catch { /* best-effort — a leaked lock would wedge the next sweep */ }
  }
}

/* C03 slice 2b — the WRITE-BEFORE-SEND submit orchestrator. This is the seam wired into the live FYERS branch
   (behind the C03_ORDER_ATTEMPTS flag). It GUARANTEES the broker is never reached without a durable, pre-existing
   attempt identifying the order:
     1. commit a PREPARED attempt — if that throws (DB down / fault), we return WITHOUT calling the broker.
     2. transition PREPARED→SUBMITTING, then call `submit()` (the actual broker placement).
     3. an ambiguous submit failure (timeout / lost response) finalizes UNKNOWN — recoverable at startup by tag,
        never a silent duplicate. A thrown-but-conclusive rejection can be finalized REJECTED by the caller.
     4. a returned result is classified via `classify(res)` → { status, patch } and finalized transactionally.
   When the flag is OFF this module isn't used at all; the legacy path runs byte-for-byte unchanged. */
async function submitWithAttempt({ db, attempt, submit, classify, classifyError, fenceGuard = null }) {
  /* R31-P2-04 — LEASE FENCE BOUND TO THE SEND. A single-owner job (auto-buy / screener / exit sweep) acquires a
     durable fenced lease before it runs, but the SUBMITTING claim below is per-attempt and, on its own, does NOT
     know whether THIS worker still holds the lease. A worker paused past its lease expiry (GC pause / partition)
     could resume, win the PREPARED→SUBMITTING CAS and place a DUPLICATE order after a takeover. `fenceGuard` closes
     that hole: it returns false iff this worker's fence is no longer the live one. We check it (a) before the CAS,
     and (b) AGAIN immediately before the broker send — so even a pause that happens BETWEEN the claim and the send
     is caught. A stale-fence worker is refused here and never reaches the broker. */
  const fenceOk = async () => { if (typeof fenceGuard !== "function") return true; try { return !!(await fenceGuard()); } catch { return false; } };
  if (!(await fenceOk())) return { fenced: true, submitted: false, status: "FENCED" };
  // 1 — durable PREPARED. Throws on an id collision from a DIFFERENT request; returns the existing row on a
  //     legit same-request retry. If this throws, the broker is NEVER called.
  const row = await db.prepareOrderAttempt(attempt);
  // 1a — IDEMPOTENCY GUARD: if the attempt already advanced past PREPARED, a prior call already submitted (or is
  //      submitting/terminal). Re-submitting here is exactly the double-order bug — do NOT call the broker again.
  if (row && row.status && row.status !== "PREPARED") {
    return { replay: true, submitted: false, status: row.status, attempt: row };
  }
  // 2 — claim the send via CAS PREPARED→SUBMITTING. ONLY the caller that wins this transition may submit; a null
  //     result means another worker/request already advanced it, so we must NOT submit (prevents concurrent dupes).
  const advanced = await db.transitionOrderAttempt(attempt.id, "PREPARED", "SUBMITTING");
  if (!advanced) {
    const cur = await db.getOrderAttempt(attempt.id).catch(() => null);
    return { replay: true, submitted: false, status: cur ? cur.status : "UNKNOWN", attempt: cur || row };
  }
  /* 2a — RE-CHECK the fence at the last possible instant before the send. The CAS above may have been won while the
     lease was still live, then this worker paused and lost it to a takeover. If the fence is now stale we must NOT
     submit; leave the attempt SUBMITTING so startup/periodic recovery reconciles it by tag (never a phantom send). */
  if (!(await fenceOk())) return { fenced: true, submitted: false, status: "FENCED", attempt: row };
  let res;
  try {
    res = await submit();   // reached ONLY after a durable PREPARED + a won SUBMITTING claim + a LIVE fence
  } catch (e) {
    /* 3 — the submit threw. Two distinct cases:
       (a) CONCLUSIVE broker rejection — the broker definitively rejected the order and nothing landed (e.g. an
           RMS "insufficient margin" error on a synchronous endpoint). classifyError(e) returns a TERMINAL status
           (e.g. "REJECTED") so we finalize it RESOLVED — no phantom position, and crucially NOT left UNKNOWN,
           which would needlessly lock the account waiting to reconcile an order that never existed.
       (b) AMBIGUOUS transport failure (timeout / lost response) — the broker MAY have received it. Mark UNKNOWN
           (unresolved → startup reconciles by tag; the account is kept locked). Rethrow either way so the caller
           surfaces the failure honestly. */
    let terminal = null;
    try { terminal = typeof classifyError === "function" ? classifyError(e) : null; } catch { terminal = null; }
    if (terminal && terminal.status) {
      try { await db.finalizeOrderAttempt(attempt.id, terminal.status, { resolved: true, ...(terminal.patch || {}) }); } catch { /* recovery resolves it */ }
    } else {
      try { await db.finalizeOrderAttempt(attempt.id, "UNKNOWN", {}); } catch { /* recovery still finds it SUBMITTING */ }
    }
    throw e;
  }
  // 4 — conclusive result → finalize the mapped terminal/near-terminal state atomically.
  const c = classify(res) || { status: "UNKNOWN", patch: {} };
  await db.finalizeOrderAttempt(attempt.id, c.status, c.patch || {});
  return res;
}

/* C03 slice 2b — STARTUP SAFETY RE-ARM. Before money-moving routes open, every account with an unresolved
   order_attempt must be re-locked so a crash/restart can never leave real exposure un-gated. This is PURELY
   fail-closed: it re-arms the durable risk-lock + entry-halt per affected user and never resolves anything or
   contacts the broker (resolution is the periodic reconciler + the C02 broker-backed unlock gate). Returns the
   set of re-armed users. Safe to run on every boot. */
async function rearmFromUnresolvedAttempts({ db, setLock, setHalt, logger = () => {}, limit = 1000 }) {
  const attempts = await db.listUnresolvedOrderAttempts(limit);
  const users = [...new Set(attempts.map((a) => a && a.userId).filter(Boolean))];
  for (const uid of users) {
    if (setLock) await setLock(uid, true);
    if (setHalt) await setHalt(uid, true);
  }
  logger("c03.startup_rearm", { unresolved: attempts.length, users: users.length });
  return { unresolved: attempts.length, users };
}

module.exports = { reconcileUnresolvedAttempts, submitWithAttempt, rearmFromUnresolvedAttempts };
