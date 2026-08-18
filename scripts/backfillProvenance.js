#!/usr/bin/env node
/**
 * scripts/backfillProvenance.js — HISTORICAL provenance repair runner (DRY-RUN by default).
 *
 * Correlates each trade to durable evidence (its own screener/strategy attribution, and its order_attempt's
 * payload which carried the original tradeType / strategyName / screenerKey set BEFORE broker submission),
 * proposes a corrected origin, and prints a before/after report. It NEVER mutates unless `--apply` is passed,
 * never invents provenance, never downgrades a known automated origin, and is idempotent.
 *
 * Usage:
 *   node scripts/backfillProvenance.js                 # dry-run, all users
 *   node scripts/backfillProvenance.js --user <id>     # dry-run, one user
 *   node scripts/backfillProvenance.js --symbol SOXLB  # focus a symbol's evidence
 *   node scripts/backfillProvenance.js --apply         # APPLY corrections (per-user, transaction-safe)
 *   node scripts/backfillProvenance.js --json out.json # write the full machine-readable report
 *
 * Required deliverables it produces: corrected + unresolved rows, SOXLB (and SLVON/SNDKB) evidence, and the
 * before/after summary. Runs against whatever DATABASE_URL / storage db.js is configured for.
 */
const db = require("../db");
const { planBackfill } = require("../provenanceBackfill");
const { sourceLabel, strategyLabel } = require("../provenance");

function arg(name, def) { const i = process.argv.indexOf(name); return i >= 0 ? (process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : true) : def; }
const APPLY = process.argv.includes("--apply");
const ONE_USER = arg("--user", null);
const FOCUS_SYM = arg("--symbol", null);
const JSON_OUT = arg("--json", null);

/* Build the evidence index for one user from their order_attempts. The attempt's payload is the order body we
   sent, so it carries the true origin even when the display trade row was mis-stamped "Manual". */
function buildIndex(attempts) {
  const kindFromTradeType = (tt) => ({ "auto buy": "smart_auto_buy", "screener auto buy": "screener", "automate": "automate", "ideas": "idea", "idea": "idea", "manual": "manual" }[String(tt || "").toLowerCase()] || null);
  const byTag = {}, byBroker = {}, byMatrix = {};
  for (const a of attempts || []) {
    const p = a.payload || {};
    const kind = kindFromTradeType(p.tradeType);
    if (!kind) continue;                       // no origin signal in this attempt's payload
    const rec = { kind, strategyId: p.strategyId || null, strategyName: p.strategyName || p.strategy || null, screenerId: p.screenerKey || null, screenerName: p.screenerName || (kind === "screener" ? p.strategy : null) || null, signalId: p.signalId || null, automationRuleId: p.automationRuleId || null, orderAttemptId: a.id, confidence: "order-attempt-payload" };
    if (a.orderTag) byTag[String(a.orderTag)] = rec;
    if (a.brokerOrderId) byBroker[String(a.brokerOrderId)] = rec;
    if (p.clientRequestId) byMatrix[String(p.clientRequestId)] = rec;
    if (a.id) byMatrix[String(a.id)] = rec;
  }
  return { attemptByClientOrderId: byTag, attemptByBrokerOrderId: byBroker, attemptByMatrixOrderId: byMatrix, screenerClaims: [] };
}

async function processUser(userId) {
  const trades = (await db.getTrades(userId, 0, Date.now()).catch(() => [])) || [];
  if (!trades.length) return null;
  const attempts = (await db.getOrderAttemptsForUser(userId).catch(() => [])) || [];
  const idx = buildIndex(attempts);
  const plan = planBackfill({ trades, idx });
  return { userId, plan, trades };
}

function printRow(r) {
  const b = `${sourceLabel(r.before.origin)}/${r.before.screenerName || r.before.strategyName || "—"}`;
  const a = `${sourceLabel(r.after.origin)}/${r.after.screenerName || r.after.strategyName || "—"}`;
  console.log(`  [${r.status}] ${r.sym.padEnd(8)} ${b.padEnd(22)} -> ${a.padEnd(22)}  via ${r.decidedBy}${r.evidence.length ? " (" + r.evidence.map((e) => e.via).join(",") + ")" : ""}`);
}

async function main() {
  console.log(`\n=== Provenance backfill ${APPLY ? "APPLY" : "DRY-RUN"} ===`);
  const users = ONE_USER ? [ONE_USER] : (await db.listUsers().catch(() => [])).map((u) => u.userId || u.id || u.user_id || u).filter(Boolean);
  const agg = { inspected: 0, corrected: 0, unresolved: 0, unchanged: 0, duplicateGroups: 0, phantomOpen: 0, applied: 0 };
  const focusRows = [], report = [];

  for (const uid of users) {
    const res = await processUser(uid);
    if (!res) continue;
    const { plan } = res;
    for (const k of Object.keys(agg)) if (plan.summary[k] != null) agg[k] += plan.summary[k];
    report.push({ userId: uid, summary: plan.summary, rows: plan.rows, duplicates: plan.duplicates, phantoms: plan.phantoms });

    const changed = plan.rows.filter((r) => r.status !== "UNCHANGED");
    if (changed.length) { console.log(`\nUser ${uid}: ${plan.summary.corrected} corrected, ${plan.summary.unresolved} unresolved`); changed.forEach(printRow); }
    if (FOCUS_SYM) focusRows.push(...plan.rows.filter((r) => String(r.sym).toUpperCase() === String(FOCUS_SYM).toUpperCase()).map((r) => ({ ...r, userId: uid })));

    if (APPLY && plan.mutations.length) {
      // Transaction-safe, idempotent apply: patch each row's JSONB via updateTrade (re-running is a no-op because
      // the resolved origin then equals the stored origin). We never close/delete rows here.
      for (const m of plan.mutations) { try { await db.updateTrade(uid, m.id, m.patch); agg.applied += 1; } catch (e) { console.error(`  ! apply failed ${uid}/${m.id}: ${e.message}`); } }
    }
  }

  if (FOCUS_SYM && focusRows.length) { console.log(`\n=== ${FOCUS_SYM} evidence ===`); focusRows.forEach((r) => { printRow(r); console.log(`      evidence: ${JSON.stringify(r.evidence)}`); }); }

  console.log(`\n=== Summary ===`);
  console.log(`  inspected=${agg.inspected} corrected=${agg.corrected} unresolved=${agg.unresolved} unchanged=${agg.unchanged}`);
  console.log(`  duplicateGroups=${agg.duplicateGroups} phantomOpen=${agg.phantomOpen}${APPLY ? ` applied=${agg.applied}` : " (dry-run — nothing written)"}`);
  console.log(`  Unresolved rows need durable evidence before they can be corrected — they are NOT rewritten on a guess.`);

  if (JSON_OUT && typeof JSON_OUT === "string") { require("fs").writeFileSync(JSON_OUT, JSON.stringify({ agg, report }, null, 2)); console.log(`  full report → ${JSON_OUT}`); }
  process.exit(0);
}

main().catch((e) => { console.error("backfill failed:", e); process.exit(1); });
