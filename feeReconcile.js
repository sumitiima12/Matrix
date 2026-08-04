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
//
// R33-P2-02 — BROKER-SCOPED MATCHING. Broker order/execution IDs are NOT globally unique: FYERS and Delta can both
// emit orderId "123". Every map/bucket is keyed by (broker, id), and a fill is matched only against its OWN broker's
// lines, so one broker's charge can never be allocated to another broker's fill. Contract-note lines carry `broker`
// (the job tags each line with the broker it was fetched from). For backward compatibility, a line with NO broker is
// a WILDCARD that matches any broker's fill for that id — used only by the pure unit fixtures; production always tags.
// Returns one finalization per matched, not-yet-final real fill.
const SEP = "\u001F";  // R34-P4-01: escaped unit-separator (0x1F), not a raw NUL, keeps the file text for git/diff/scanners
const bkey = (broker, id) => String(broker == null ? "" : broker).toLowerCase() + SEP + String(id);
// R35-P2-01: an id present only as "" / whitespace is ABSENT. Used for BOTH contract-note lines and fills so a blank
// execution id never routes an order-level charge into the execution map (where it would never match).
const nzId = (v) => { const s = v == null ? "" : String(v).trim(); return s === "" ? null : s; };
function reconcileEodFees({ fills = [], contractNote = [], now = Date.now() } = {}) {
  /* R35-P2-04 — CONVERGENT order-level allocation. The input `fills` is the COMPLETE execution set for the window (a
     fill already carrying a fee_final overlay is included and flagged `feeFinalized:true`). Order-level charges are
     allocated deterministically across the FULL set of an order's executions (stable sort by fill id, so the split is
     identical on every run regardless of how many are already finalized), and a finalization is EMITTED ONLY for the
     executions that don't yet have an overlay. This prevents over-allocation AND converges: once every execution has
     its overlay, subsequent passes emit nothing. (Replaces the R34 "refuse when incomplete" gate, which could never
     finalize the remainder after a partial prior write.) */
  const byExec = new Map();       // (broker,execId) -> exact charge   [broker "" = wildcard]
  const byOrderTotal = new Map(); // (broker,orderId) -> total charge from ORDER-LEVEL lines only
  for (const c of (contractNote || [])) {
    const charges = Number(c && (c.charges ?? c.fees));
    if (!Number.isFinite(charges) || charges < 0) continue;   // R35-P2-02: never accept a non-finite/negative charge
    const brk = c.broker;
    const eId = nzId(c.execId), oId = nzId(c.orderId);
    if (eId != null) byExec.set(bkey(brk, eId), charges);
    else if (oId != null) { const k = bkey(brk, oId); byOrderTotal.set(k, (byOrderTotal.get(k) || 0) + charges); }
  }
  // Look up a fill's charge in a broker-scoped map: prefer the fill's OWN broker line, fall back to a wildcard
  // (untagged) line for the same id. Returns { key, charge } of the matched entry, or null.
  const scopedLookup = (map, broker, id) => {
    if (id == null) return null;
    const own = bkey(broker, id);
    if (map.has(own)) return { key: own, charge: map.get(own) };
    const wild = bkey("", id);
    if (String(broker == null ? "" : broker) !== "" && map.has(wild)) return { key: wild, charge: map.get(wild) };
    return null;
  };

  // Candidate = every real execution (kind fee_final rows are excluded by the caller). We use `feeFinalized` (overlay
  // already present) — NOT the source row's own feeFinal (append-only, always false) — to decide EMISSION.
  const candidateFills = (fills || []).filter((f) => f && f.real === true && f.kind !== "fee_final");
  const out = [];
  const mk = (f, finalFees) => {
    if (f.feeFinalized === true || f.feeFinal === true) return;   // already finalized (overlay present, or legacy flag) → don't re-emit
    const provisional = Number(f.fees) || 0;
    out.push({
      fillId: f.fillId ?? f.id ?? null, execId: nzId(f.execId), orderId: nzId(f.orderId), broker: f.broker ?? null,
      leg: f.kind === "exit" ? "exit" : "entry",   // R32-P2-02: which leg's fee this corrects (for the projection overlay)
      provisionalFees: provisional, finalFees: round2(finalFees), feeDelta: +(round2(finalFees) - provisional).toFixed(6),
      feeStatus: "contract-note", feeFinal: true, at: now,
    });
  };

  // Pass 1 — exact per-execution matches; collect the rest (order-level fallback) grouped by (broker, orderId). Blank
  // execution/order ids are treated as ABSENT (nzId), so an order-level line never mis-routes into the execution map.
  const orderBuckets = new Map();   // matched-order-key -> [fills awaiting allocation]
  for (const f of candidateFills) {
    const exec = scopedLookup(byExec, f.broker, nzId(f.execId));
    if (exec) { mk(f, exec.charge); continue; }
    const ord = scopedLookup(byOrderTotal, f.broker, nzId(f.orderId));
    if (ord) {
      if (!orderBuckets.has(ord.key)) orderBuckets.set(ord.key, []);
      orderBuckets.get(ord.key).push(f);
    }
    // else: no contract-note line for this fill yet → leave provisional (retried next run).
  }

  // Pass 2 — allocate each order's total across its COMPLETE bucket, DETERMINISTICALLY (stable sort by fill id), by
  // |qty| weight (equal split if no qty), remainder on the last. mk() emits ONLY for not-yet-finalized fills, so the
  // per-fill share is identical whether the pass runs before or after some executions were already finalized ⇒ it
  // CONVERGES: the remaining executions finalize with the correct share and re-runs become no-ops (R35-P2-04).
  for (const [okey, bucketRaw] of orderBuckets) {
    const bucket = bucketRaw.slice().sort((a, b) => String(a.fillId ?? a.id ?? "").localeCompare(String(b.fillId ?? b.id ?? "")));
    const total = round2(byOrderTotal.get(okey));
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
async function runEodFeeReconcile({ userKeys = [], listReconcilableFills, listProvisionalFills, fetchContractNote, recordFeeFinal, now = Date.now(), log = () => {} } = {}) {
  // R35-P2-04: the matcher now needs the COMPLETE execution set (finalized + not) with a `feeFinalized` flag so it can
  // allocate order-level charges deterministically and converge. `listReconcilableFills` supplies that. For backward
  // compatibility, fall back to the older `listProvisionalFills` (which returns only unfinalized fills).
  const listFills = listReconcilableFills || listProvisionalFills;
  if (typeof listFills !== "function" || typeof fetchContractNote !== "function" || typeof recordFeeFinal !== "function") {
    throw new Error("runEodFeeReconcile requires listReconcilableFills (or listProvisionalFills), fetchContractNote and recordFeeFinal functions");
  }
  let usersTouched = 0, finalized = 0, alreadyFinal = 0, conflicts = 0, netFeeCorrection = 0, stillProvisional = 0, errors = 0;
  for (const uk of userKeys) {
    let fills = [];
    try { fills = await listFills(uk); } catch (e) { errors++; log("eodfee.list_failed", { userKey: uk, err: String((e && e.message) || e) }); continue; }
    const real = (fills || []).filter((f) => f && f.real === true && f.kind !== "fee_final");
    const unfinalized = real.filter((f) => f.feeFinalized !== true);
    if (!unfinalized.length) continue;   // nothing left to finalize for this user
    usersTouched++;
    // Fetch each involved broker's contract note ONCE, then reconcile against the union of lines. R33-P2-02: TAG each
    // line with the broker it came from so the matcher scopes charges per broker (broker IDs aren't globally unique).
    const brokers = [...new Set(real.map((f) => String(f.broker || "")))];
    let note = [];
    for (const broker of brokers) {
      try { const n = await fetchContractNote(uk, broker); if (Array.isArray(n)) note = note.concat(n.map((ln) => ({ ...ln, broker: (ln && ln.broker != null) ? ln.broker : broker }))); }
      catch (e) { errors++; log("eodfee.note_failed", { userKey: uk, broker, err: String((e && e.message) || e) }); }
    }
    // Pass the COMPLETE real set so order-level allocation is deterministic + convergent; mk() emits only the missing overlays.
    const finals = reconcileEodFees({ fills: real, contractNote: note, now });
    for (const fin of finals) {
      try {
        // R33-P2-01: recordFeeFinal returns { inserted, conflict }. A finalization only counts (and its delta only
        // moves net P&L) when a NEW immutable row is actually written. inserted:false with identical content is an
        // idempotent replay (alreadyFinal); inserted:false with DIFFERENT content is a collision alert (conflict).
        const r = await recordFeeFinal(uk, fin);
        if (r && r.inserted === false) {
          if (r.conflict) { conflicts++; log("eodfee.conflict", { userKey: uk, fillId: fin.fillId, broker: fin.broker }); }
          else alreadyFinal++;
        } else { finalized++; netFeeCorrection += Number(fin.feeDelta) || 0; }
      } catch (e) { errors++; log("eodfee.persist_failed", { userKey: uk, fillId: fin.fillId, err: String((e && e.message) || e) }); }
    }
    stillProvisional += summarizeFinalizations(finals, unfinalized.length).stillProvisional;
  }
  const summary = { usersTouched, finalized, alreadyFinal, conflicts, netFeeCorrection: +netFeeCorrection.toFixed(6), stillProvisional, errors };
  log("eodfee.done", summary);
  return summary;
}

module.exports = { reconcileEodFees, summarizeFinalizations, runEodFeeReconcile };
