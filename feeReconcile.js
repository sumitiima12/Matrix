/* R31-P2-08 — EOD CONTRACT-NOTE FEE RECONCILIATION.
 *
 * Intraday, execution fills carry PROVISIONAL fees (feeFinal:false) derived from the broker's live tradebook, which
 * often omits or under-reports the full charge stack (STT, exchange, SEBI, GST, stamp, clearing). The AUTHORITATIVE
 * cost is the end-of-day CONTRACT NOTE / statement. This module is the PURE decision layer: given today's provisional
 * fills and a normalized contract-note (one line per execution or per order, each with total charges), it decides
 * which fills can be FINALIZED and to what fee — so risk/P&L can move from "estimated cost" to "final cost".
 *
 * Pure + injected (no DB, no broker) so it unit-tests exactly. The server wiring (below, in runEodFeeReconcile)
 * fetches the broker EOD charges, calls this, and appends an immutable `fee_final` ledger event per finalization
 * (the fills ledger is append-only — we never rewrite an execution; a finalization is a new, linked cost record).
 *
 * Contract-note line shape (normalize the broker's EOD payload to this):
 *   { execId?, orderId?, charges }   // charges = TOTAL final cost for that execution (or the order, if per-order)
 */

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;   // paise/cents

// Match provisional fills to contract-note charges.
//   • EXACT execution match (execId line) → that execution's charge, verbatim.
//   • ORDER-LEVEL line (orderId, no execId) → the order's TOTAL is ALLOCATED ACROSS that order's executions by
//     quantity weight (equal split if no qty), with the LAST fill absorbing the rounding remainder so the allocated
//     fees sum EXACTLY to the order total. This is the R32-P2-01 fix: a ₹30 order over three fills is ₹10+₹10+₹10,
//     never ₹30 on each. byOrder is built ONLY from order-level lines so per-execution lines never inflate it.
// Returns one finalization per matched, not-yet-final real fill.
function reconcileEodFees({ fills = [], contractNote = [], now = Date.now() } = {}) {
  const byExec = new Map();       // execId -> exact charge
  const byOrderTotal = new Map(); // orderId -> total charge from ORDER-LEVEL lines only
  for (const c of (contractNote || [])) {
    const charges = Number(c && (c.charges ?? c.fees));
    if (!Number.isFinite(charges)) continue;
    if (c.execId != null) byExec.set(String(c.execId), charges);
    else if (c.orderId != null) byOrderTotal.set(String(c.orderId), (byOrderTotal.get(String(c.orderId)) || 0) + charges);
  }

  const provisionalFills = (fills || []).filter((f) => f && f.real === true && f.feeFinal !== true);
  const out = [];
  const mk = (f, finalFees) => {
    const provisional = Number(f.fees) || 0;
    out.push({
      fillId: f.fillId ?? f.id ?? null, execId: f.execId ?? null, orderId: f.orderId ?? null, broker: f.broker ?? null,
      leg: f.kind === "exit" ? "exit" : "entry",   // R32-P2-02: which leg's fee this corrects (for the projection overlay)
      provisionalFees: provisional, finalFees: round2(finalFees), feeDelta: +(round2(finalFees) - provisional).toFixed(6),
      feeStatus: "contract-note", feeFinal: true, at: now,
    });
  };

  // Pass 1 — exact per-execution matches; collect the rest (order-level fallback) grouped by orderId.
  const orderBuckets = new Map();   // orderId -> [fills awaiting allocation]
  for (const f of provisionalFills) {
    if (f.execId != null && byExec.has(String(f.execId))) { mk(f, byExec.get(String(f.execId))); continue; }
    if (f.orderId != null && byOrderTotal.has(String(f.orderId))) {
      const oid = String(f.orderId);
      if (!orderBuckets.has(oid)) orderBuckets.set(oid, []);
      orderBuckets.get(oid).push(f);
    }
    // else: no contract-note line for this fill yet → leave provisional (retried next run).
  }

  // Pass 2 — allocate each order's total across its bucket by |qty| (equal split if no qty), remainder on the last.
  for (const [oid, bucket] of orderBuckets) {
    const total = round2(byOrderTotal.get(oid));
    const weights = bucket.map((f) => Math.abs(Number(f.qty)) || 0);
    const wsum = weights.reduce((a, b) => a + b, 0);
    let allocated = 0;
    bucket.forEach((f, i) => {
      let share;
      if (i === bucket.length - 1) share = round2(total - allocated);          // last absorbs rounding → exact sum
      else { share = round2(wsum > 0 ? total * (weights[i] / wsum) : total / bucket.length); allocated += share; }
      mk(f, share);
    });
  }
  return out;
}

/* Summarize a batch of finalizations for logging/ops: how many finalized, the net fee correction, and how many
   fills the pass could NOT yet match (still provisional) — the latter should shrink to zero once the full contract
   note is available; a persistent nonzero count is an alert (missing EOD data). */
function summarizeFinalizations(finalizations = [], totalProvisionalFills = 0) {
  const finalized = finalizations.length;
  const netFeeCorrection = +finalizations.reduce((a, x) => a + (Number(x.feeDelta) || 0), 0).toFixed(6);
  const stillProvisional = Math.max(0, Number(totalProvisionalFills) - finalized);
  return { finalized, netFeeCorrection, stillProvisional };
}

/* The scheduled JOB, fully INJECTED so it runs in a test with fakes and in production with real db/broker fns.
   For each user: list today's provisional real fills, fetch each involved broker's EOD contract note, reconcile,
   and persist each finalization (recordFeeFinal). Fail-soft per user/broker/fill — one broker's missing statement
   never blocks another's; unmatched fills simply stay provisional and are retried on the next run. Returns an ops
   summary (finalized count, net fee correction, still-provisional gap = alertable, error count).

   Production wiring: server.js `runEodFeeReconcileJob()` supplies these and schedules the sweep behind the
   EOD_FEE_RECONCILE flag (single-owner via advisory lock). It is exported as server.runEodFeeReconcileJob for ops.
   The injected functions it passes are:
     • userKeys            — storage keys with real trading (e.g. from active real strategies + recent real fills).
     • listProvisionalFills(userKey) → db.getFills(userKey, sessionDayStart, now)
     • fetchContractNote(userKey, broker) → normalized [{ execId?, orderId?, charges }] from the broker's EOD
        statement (FYERS post-settlement tradebook / statements; Delta fills with final commission). [] if not ready.
     • recordFeeFinal(userKey, fin) → append an IMMUTABLE linked ledger event (append-only ledger — never rewrite the
        execution): db.recordFill(userKey, { fillId: `feefinal_${fin.broker}_${fin.execId||fin.orderId}`,
        kind:"fee_final", refFillId: fin.fillId, fees: fin.finalFees, feeDelta: fin.feeDelta, feeStatus:"contract-note",
        feeFinal:true, execEvent:true, real:true, ts: fin.at }). The deterministic id makes re-runs idempotent.
     • schedule: once daily AFTER market close per exchange (and once more late, to catch delayed statements). */
async function runEodFeeReconcile({ userKeys = [], listProvisionalFills, fetchContractNote, recordFeeFinal, now = Date.now(), log = () => {} } = {}) {
  if (typeof listProvisionalFills !== "function" || typeof fetchContractNote !== "function" || typeof recordFeeFinal !== "function") {
    throw new Error("runEodFeeReconcile requires listProvisionalFills, fetchContractNote and recordFeeFinal functions");
  }
  let usersTouched = 0, finalized = 0, netFeeCorrection = 0, stillProvisional = 0, errors = 0;
  for (const uk of userKeys) {
    let fills = [];
    try { fills = await listProvisionalFills(uk); } catch (e) { errors++; log("eodfee.list_failed", { userKey: uk, err: String((e && e.message) || e) }); continue; }
    const provisional = (fills || []).filter((f) => f && f.real === true && f.feeFinal !== true);
    if (!provisional.length) continue;
    usersTouched++;
    // Fetch each involved broker's contract note ONCE, then reconcile against the union of lines.
    const brokers = [...new Set(provisional.map((f) => String(f.broker || "")))];
    let note = [];
    for (const broker of brokers) {
      try { const n = await fetchContractNote(uk, broker); if (Array.isArray(n)) note = note.concat(n); }
      catch (e) { errors++; log("eodfee.note_failed", { userKey: uk, broker, err: String((e && e.message) || e) }); }
    }
    const finals = reconcileEodFees({ fills: provisional, contractNote: note, now });
    for (const fin of finals) {
      try { await recordFeeFinal(uk, fin); finalized++; netFeeCorrection += Number(fin.feeDelta) || 0; }
      catch (e) { errors++; log("eodfee.persist_failed", { userKey: uk, fillId: fin.fillId, err: String((e && e.message) || e) }); }
    }
    stillProvisional += summarizeFinalizations(finals, provisional.length).stillProvisional;
  }
  const summary = { usersTouched, finalized, netFeeCorrection: +netFeeCorrection.toFixed(6), stillProvisional, errors };
  log("eodfee.done", summary);
  return summary;
}

module.exports = { reconcileEodFees, summarizeFinalizations, runEodFeeReconcile };
