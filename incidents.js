/**
 * incidents.js — REC-7: SUPPORT + INCIDENT handling (pure logic).
 *
 * Two related things a real-money product needs and MatrixOne lacked a formal model for:
 *   1. A user support TICKET — a normalized, categorised report a user files.
 *   2. An INCIDENT lifecycle — severity, status transitions, and an SLA target so nothing silently rots.
 *
 * This module holds ONLY the pure rules: severity levels + their response-time targets, the legal status
 * transitions (so an incident can't jump from resolved back to new without reopening), ticket normalization
 * with a bounded category set, and an auto-severity heuristic for money-touching reports. Storage, paging and
 * notification live in the server; keeping the rules here makes them unit-testable and consistent.
 */

/* Severity ladder. sev1 is "real money at risk / trading halted", sev4 is cosmetic. targetMs is the response
   SLA (how fast someone should ACK), used to flag breaches in the ops view. */
const SEVERITIES = {
  sev1: { rank: 1, label: "Critical — money at risk / trading down", targetMs: 15 * 60_000 },
  sev2: { rank: 2, label: "High — a user is blocked", targetMs: 60 * 60_000 },
  sev3: { rank: 3, label: "Normal", targetMs: 8 * 60 * 60_000 },
  sev4: { rank: 4, label: "Low — cosmetic / question", targetMs: 72 * 60 * 60_000 },
};

/* Ticket categories a user can file under (bounded so ops can route + report). */
const CATEGORIES = ["order-issue", "money-discrepancy", "broker-connection", "account-access", "bug", "feature-request", "other"];

/* Status lifecycle for an incident/ticket. A map of allowed next states from each state (fail-closed: an
   unknown or illegal transition is rejected). "reopened" routes back into the working set. */
const STATUS = ["new", "acknowledged", "in_progress", "resolved", "closed", "reopened"];
const TRANSITIONS = {
  new: ["acknowledged", "in_progress", "resolved", "closed"],
  acknowledged: ["in_progress", "resolved", "closed"],
  in_progress: ["resolved", "closed", "acknowledged"],
  resolved: ["closed", "reopened"],
  closed: ["reopened"],
  reopened: ["acknowledged", "in_progress", "resolved", "closed"],
};

/** Is moving from `from`→`to` a legal status transition? Unknown states / illegal moves ⇒ false. */
function canTransition(from, to) {
  if (!STATUS.includes(from) || !STATUS.includes(to)) return false;
  return (TRANSITIONS[from] || []).includes(to);
}

/** Auto-assign a severity from a ticket's category + text — money/order/halt words escalate. Advisory; ops can
    override. Defaults to sev3. */
function autoSeverity({ category, subject = "", body = "" } = {}) {
  const text = `${subject} ${body}`.toLowerCase();
  const moneyWords = /(money|funds?|withdraw|deposit|charged|debit|lost|wrong\s*amount|double|duplicate|unauthori[sz]ed)/;
  const haltWords = /(can'?t\s*(log|trade|close|exit|sell)|stuck|frozen|not\s*working|down|halted|outage)/;
  if (category === "money-discrepancy" || category === "order-issue") {
    if (moneyWords.test(text) || haltWords.test(text)) return "sev1";
    return "sev2";
  }
  if (category === "account-access" || category === "broker-connection") return haltWords.test(text) ? "sev2" : "sev3";
  if (category === "feature-request") return "sev4";
  if (moneyWords.test(text) || haltWords.test(text)) return "sev2";
  return "sev3";
}

/** Normalize a raw ticket submission into a stored shape (bounded category, trimmed/limited text, valid sev). */
function normalizeTicket(raw = {}) {
  const category = CATEGORIES.includes(raw.category) ? raw.category : "other";
  const subject = String(raw.subject || "").trim().slice(0, 140);
  const body = String(raw.body || "").trim().slice(0, 4000);
  const severity = SEVERITIES[raw.severity] ? raw.severity : autoSeverity({ category, subject, body });
  return { category, subject, body, severity, status: "new" };
}

/** SLA breach check: given an incident's severity + createdAt (and optional ackAt), is the ACK overdue now? */
function slaBreached(sev, createdAtMs, nowMs = Date.now(), ackAtMs = null) {
  const s = SEVERITIES[sev];
  if (!s || !(createdAtMs > 0)) return false;
  if (ackAtMs > 0) return ackAtMs - createdAtMs > s.targetMs;   // acked — did it beat the target?
  return nowMs - createdAtMs > s.targetMs;                       // not acked yet — overdue?
}

module.exports = { SEVERITIES, CATEGORIES, STATUS, TRANSITIONS, canTransition, autoSeverity, normalizeTicket, slaBreached };
