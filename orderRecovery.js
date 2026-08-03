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
    faults = null, logger = () => {}, limit = 1000,
  } = deps || {};

  if (faults) faults.gate("c03.recover.owner");
  const owner = await acquireOwner();
  if (!owner) { logger("c03.recover.not_owner", {}); return { owner: false, skipped: true }; }

  const attempts = await db.listUnresolvedOrderAttempts(limit);
  let resolved = 0, adopted = 0, keptLocked = 0;

  for (const a of attempts) {
    let ob;
    try { ob = await probeByTag(a); }
    catch { keptLocked++; logger("c03.recover.unreachable", { id: a.id, tag: a.orderTag }); continue; }   // broker down ⇒ lock stays
    if (ob == null) { keptLocked++; logger("c03.recover.inconclusive", { id: a.id, tag: a.orderTag }); continue; }

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
      keptLocked++;
      logger("c03.recover.partial", { id: a.id, tag: a.orderTag, filledQty: ob.filledQty });
    } else {
      // pending / unknown → not conclusive → stay locked, retry a later sweep.
      keptLocked++;
      logger("c03.recover.pending", { id: a.id, tag: a.orderTag, status: ob.status });
    }
  }

  // Re-arm the durable safety state while ANYTHING is still unresolved (recheck the store — a fault could have
  // left a finalize incomplete). Fail closed: if we can't read/lock, we keep the halt engaged.
  let stillUnresolved = keptLocked > 0;
  try { if (!stillUnresolved) stillUnresolved = (await db.listUnresolvedOrderAttempts(1)).length > 0; }
  catch { stillUnresolved = true; }
  if (stillUnresolved) {
    if (setLock) await setLock(true);
    if (setHalt) await setHalt(true);
  }
  logger("c03.recover.done", { attempts: attempts.length, resolved, adopted, keptLocked, stillUnresolved });
  return { owner: true, attempts: attempts.length, resolved, adopted, keptLocked, stillUnresolved };
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
async function submitWithAttempt({ db, attempt, submit, classify }) {
  // 1 — durable PREPARED. If this throws, the broker is NEVER called (no order can exist without an attempt).
  await db.prepareOrderAttempt(attempt);
  // 2 — mark SUBMITTING right before the send, so a crash mid-send leaves a recoverable SUBMITTING row.
  await db.transitionOrderAttempt(attempt.id, "PREPARED", "SUBMITTING");
  let res;
  try {
    res = await submit();
  } catch (e) {
    // 3 — ambiguous outcome: the broker MAY have received it. Mark UNKNOWN (unresolved → startup reconciles by
    //     tag; the account is kept locked). Best-effort finalize; rethrow so the caller surfaces the failure.
    try { await db.finalizeOrderAttempt(attempt.id, "UNKNOWN", {}); } catch { /* recovery will still find it SUBMITTING */ }
    throw e;
  }
  // 4 — conclusive result → finalize the mapped terminal/near-terminal state atomically.
  const c = classify(res) || { status: "UNKNOWN", patch: {} };
  await db.finalizeOrderAttempt(attempt.id, c.status, c.patch || {});
  return res;
}

module.exports = { reconcileUnresolvedAttempts, submitWithAttempt };
