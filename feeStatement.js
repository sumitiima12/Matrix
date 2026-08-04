/* R37-P3-02 / R37-P2-02 — PURE FYERS-style contract-note statement adapter, extracted from server.js so the most
 * important fee-provenance logic is directly unit-testable (no HTTP/auth wiring). It contains ONLY pure functions:
 *   • strictCharge  — the strict numeric/decimal parser (rejects booleans/arrays/objects/whitespace).
 *   • nzId          — absent-id normalization ("" / "  " ⇒ null).
 *   • parseIsoDate  — strict YYYY-MM-DD parse to a canonical ISO day string, or null.
 *   • normStatementLine — normalize one charge line to { execId?, orderId?, charges } or null (REJECTED).
 *   • validateStatement — validate the MANDATORY provenance envelope AND the trading date, returning either
 *       { ok:false, reasons } or { ok:true, tradingDate, account, lines, rejected }.
 * The server keeps the HTTP fetch/auth and audit-logging; it calls validateStatement with the expected account and the
 * allowed reconciliation-day set. Keeping this pure means wrong-day / wrong-account / unsettled / schema-drift / mixed-
 * line payloads are provable in a test without a live broker.
 */
"use strict";

// R36-P2-01 — accept ONLY a finite non-negative number, or a strict decimal STRING (optional surrounding whitespace).
// Reject booleans (true→1/false→0), arrays ([]→0), objects, empty/whitespace, NaN, negatives.
function strictCharge(raw) {
  if (typeof raw === "number") return Number.isFinite(raw) && raw >= 0 ? raw : null;
  if (typeof raw === "string" && /^\s*\d+(\.\d+)?\s*$/.test(raw)) {
    const n = Number(raw.trim());
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  return null;
}

function nzId(v) {
  const s = v == null ? "" : String(v).trim();
  return s === "" ? null : s;
}

// R37-P2-02 — STRICT ISO calendar-day parse. Accepts only "YYYY-MM-DD" (optional surrounding whitespace), validates the
// components form a real date, and returns the canonical "YYYY-MM-DD" string. Anything else (timestamps, DD/MM/YYYY,
// garbage, non-strings) ⇒ null, so a malformed/ambiguous date can never pass the day-match check.
function parseIsoDate(s) {
  const str = s == null ? "" : String(s).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function normStatementLine(t) {
  if (!t || typeof t !== "object" || Array.isArray(t)) return null;
  const execId = nzId(t.execId ?? t.tradeNumber ?? t.id ?? t.fillId);
  const orderId = nzId(t.orderId ?? t.orderNumber);
  const charges = strictCharge(t.charges ?? t.fees);
  if (charges == null) return null;                                                 // strict type check
  if (execId) return { execId, orderId: orderId || null, charges, source: "contract-note" };  // execution-level
  if (orderId) return { orderId, charges, source: "contract-note" };               // order-level
  return null;                                                                     // no usable identity
}

/* R36-P2-01 + R37-P2-02 — validate the MANDATORY provenance envelope AND trading date.
 *   opts = { account, allowedDates?, nowMs? }
 *     account      — the requested broker account id; the statement's account MUST equal it.
 *     allowedDates — the set/array of allowed reconciliation-day ISO strings (the EOD window). When provided, the
 *                    statement's tradingDate MUST be one of them (R37-P2-02: reject wrong-day / stale / future / mixed).
 *     nowMs        — current time; the tradingDate must not be in the FUTURE relative to it.
 * Returns { ok:false, reasons, account?, tradingDate? } or { ok:true, tradingDate, account, lines, rejected }.
 */
function validateStatement(sd, opts = {}) {
  const { account, allowedDates, nowMs } = opts;
  if (!sd || typeof sd !== "object" || Array.isArray(sd)) return { ok: false, reasons: ["no-envelope"] };
  const lines = Array.isArray(sd.lines) ? sd.lines : (Array.isArray(sd.charges) ? sd.charges : null);
  if (!Array.isArray(lines)) return { ok: false, reasons: ["no-lines"] };

  const cur = nzId(sd.currency);
  const acct = nzId(sd.account ?? sd.accountId ?? sd.fyId);
  const tdateRaw = nzId(sd.tradingDate ?? sd.date);
  const tdate = parseIsoDate(tdateRaw);
  const settled = sd.settled === true || sd.settlement === "settled" || sd.final === true;
  const schemaOk = nzId(sd.schemaVersion ?? sd.version) != null;

  const reasons = [];
  if (!schemaOk) reasons.push("schemaVersion");
  if (!acct) reasons.push("account-missing");
  else if (account != null && String(acct) !== String(account)) reasons.push("account-mismatch");
  // R37-P2-02 — trading date: present, strict-ISO, not future, and within the allowed reconciliation window.
  if (!tdateRaw) reasons.push("tradingDate-missing");
  else if (!tdate) reasons.push("tradingDate-format");
  else {
    if (nowMs != null && Date.parse(`${tdate}T00:00:00Z`) > nowMs) reasons.push("tradingDate-future");
    const allow = allowedDates == null ? null : (Array.isArray(allowedDates) ? allowedDates : Array.from(allowedDates));
    if (allow && allow.length && !allow.includes(tdate)) reasons.push("tradingDate-out-of-window");
  }
  if (!settled) reasons.push("not-settled");
  if (!cur) reasons.push("currency-missing");
  else if (cur.toUpperCase() !== "INR") reasons.push("currency-not-INR");

  if (reasons.length) return { ok: false, reasons, account: acct || null, tradingDate: tdate || null };

  const out = [];
  let rejected = 0;
  for (const t of lines) { const n = normStatementLine(t); if (n) out.push(n); else rejected++; }
  return { ok: true, tradingDate: tdate, account: acct, lines: out, rejected };
}

// R37-P2-02 helper — the set of allowed IST reconciliation-day ISO strings spanning [windowStartMs, nowMs].
function istDayWindow(windowStartMs, nowMs, offsetMs = 19800000) {
  const dayOf = (ms) => new Date(ms + offsetMs).toISOString().slice(0, 10);
  const out = new Set();
  const startDay = Math.floor((windowStartMs + offsetMs) / 86400000) * 86400000 - offsetMs;
  for (let ms = startDay; ms <= nowMs; ms += 86400000) out.add(dayOf(ms));
  out.add(dayOf(nowMs));
  return Array.from(out);
}

// R38-P2-02 — the IST trading day (YYYY-MM-DD) for a broker timestamp. Accepts epoch seconds, epoch millis, or an ISO
// string; returns null if it can't be parsed to a real instant (so an undated fill is never mis-attributed to a day).
function brokerTradingDay(v, offsetMs = 19800000) {
  let ms = null;
  if (typeof v === "number" && Number.isFinite(v)) ms = v < 1e12 ? v * 1000 : v;         // seconds vs millis heuristic
  else if (typeof v === "string" && v.trim() !== "") { const p = Date.parse(v.trim()); if (Number.isFinite(p)) ms = p; }
  if (ms == null) return null;
  return new Date(ms + offsetMs).toISOString().slice(0, 10);
}

/* R38-P2-02 — PURE Delta fills → contract-note adapter with per-day partitioning and a completeness watermark.
 *   normalizeDeltaFills(rows, { tradingDate, account?, complete })
 *     rows        — the FULLY-PAGINATED (to exhaustion) /v2/fills result rows for the account.
 *     tradingDate — the IST day being reconciled; ONLY fills whose broker timestamp resolves to this day are kept, so a
 *                   default-limited or cross-day response can never finalize another day's executions.
 *     account     — optional expected account id; a fill carrying a different account is rejected.
 *     complete    — the caller's proof that pagination reached exhaustion. If FALSE we refuse to finalize (return
 *                   ok:false) — an incomplete page set must leave fills provisional, never partially finalize (watermark).
 *   Returns { ok:false, reason } or { ok:true, tradingDate, lines:[{execId,orderId,charges,tradingDate}], kept, rejected }.
 */
function normalizeDeltaFills(rows, opts = {}) {
  const { tradingDate, account, complete } = opts;
  if (complete === false) return { ok: false, reason: "incomplete-pagination" };            // completeness watermark
  if (!Array.isArray(rows)) return { ok: false, reason: "no-rows" };
  const wantDay = parseIsoDate(tradingDate);
  if (tradingDate != null && !wantDay) return { ok: false, reason: "bad-trading-date" };
  const lines = [];
  let rejected = 0, offday = 0;
  const seen = new Set();                                                                    // de-dupe by fill id
  for (const f of rows) {
    if (!f || typeof f !== "object") { rejected++; continue; }
    if (account != null) { const a = nzId(f.account_id ?? f.account ?? f.user_id); if (a != null && String(a) !== String(account)) { rejected++; continue; } }
    const day = brokerTradingDay(f.created_at ?? f.timestamp ?? f.fill_time ?? f.time);
    if (wantDay && day !== wantDay) { offday++; continue; }                                   // per-day partition
    const charges = strictCharge(f.commission ?? f.fee ?? f.charges);
    if (charges == null) { rejected++; continue; }                                            // strict, never coerce
    const execId = nzId(f.id ?? f.fill_id);
    const orderId = nzId(f.order_id ?? f.orderId);
    if (execId == null && orderId == null) { rejected++; continue; }
    const dedupeKey = execId != null ? `e:${execId}` : `o:${orderId}:${lines.length}`;
    if (execId != null) { if (seen.has(dedupeKey)) continue; seen.add(dedupeKey); }           // duplicate exec line ⇒ once
    const line = { charges, source: "delta-fills", tradingDate: day || wantDay || null };
    if (execId != null) { line.execId = execId; line.orderId = orderId || null; } else { line.orderId = orderId; }
    lines.push(line);
  }
  return { ok: true, tradingDate: wantDay || null, lines, kept: lines.length, rejected, offday };
}

module.exports = { strictCharge, nzId, parseIsoDate, normStatementLine, validateStatement, istDayWindow, brokerTradingDay, normalizeDeltaFills };
