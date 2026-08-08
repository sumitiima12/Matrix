/**
 * dpdp.js — MU-1: technical scaffolding for India's Digital Personal Data Protection Act (DPDP), 2023.
 *
 * This is NOT legal advice and NOT a full compliance program (that needs counsel — see MU-4). It is the
 * TECHNICAL primitives the Act's data-principal rights map onto, kept pure so they're testable and consistent:
 *
 *   • CONSENT — a versioned, purpose-scoped, withdrawable record. The Act requires free, specific, informed,
 *     unambiguous consent per purpose, and withdrawal to be as easy as giving it.
 *   • DATA INVENTORY — a machine-readable catalog of what personal data we hold, why (purpose), and how long
 *     (retention). This is the backbone of a privacy notice and of retention enforcement.
 *   • PORTABILITY / ACCESS — assemble a data principal's own data into a portable export (right to access).
 *
 * Erasure (right to be forgotten) already exists as account deletion; grievance redressal is the support/
 * incident path (REC-7). This module glues consent + inventory + export together.
 */

const CONSENT_VERSION = "2026-08-07";

/* Purposes we ask consent for. Each is specific (the Act forbids bundled/blanket consent). `essential` purposes
   are required to provide the service the user signed up for; non-essential ones (analytics, marketing) must be
   independently refusable without losing the core service. */
const PURPOSES = {
  account: { essential: true, label: "Operate your account (login, security, profile)." },
  trading: { essential: true, label: "Connect your broker and place/track the trades you initiate." },
  communications: { essential: false, label: "Send you product and trade notifications." },
  analytics: { essential: false, label: "Aggregate, de-identified product analytics to improve MatrixOne." },
};

/* What personal data we hold, why, and the retention target. Drives the privacy notice + retention sweeps.
   (Financial/trade records often carry a STATUTORY retention that overrides a user's erasure request — flagged
   with `statutory:true` so the deletion path keeps them where the law requires.) */
const DATA_INVENTORY = [
  { category: "identity", fields: ["phone", "email", "username"], purpose: "account", retention: "life of account + 30 days" },
  { category: "auth", fields: ["pin_hash", "session_token_version"], purpose: "account", retention: "life of account" },
  { category: "broker_credentials", fields: ["encrypted_broker_tokens"], purpose: "trading", retention: "until you disconnect the broker", sensitive: true },
  { category: "trades", fields: ["orders", "fills", "positions"], purpose: "trading", retention: "8 years", statutory: true },
  { category: "device", fields: ["push_subscription"], purpose: "communications", retention: "until you disable notifications" },
];

/** The consent choices a NEW record must at least address (all essential purposes are implied-required). */
function requiredPurposes() { return Object.keys(PURPOSES).filter((p) => PURPOSES[p].essential); }

/**
 * Validate + normalize a consent submission `{ [purpose]: boolean }` into a stored consent record. Essential
 * purposes are forced true (you can't use the service without them — refusing them means don't sign up, handled
 * in the UI); non-essential default to false (opt-IN, never opt-out). Unknown purposes are dropped.
 */
function buildConsentRecord(choices, meta = {}) {
  const c = choices && typeof choices === "object" ? choices : {};
  const granted = {};
  for (const p of Object.keys(PURPOSES)) {
    granted[p] = PURPOSES[p].essential ? true : c[p] === true;
  }
  return { version: CONSENT_VERSION, granted, at: Number(meta.at) > 0 ? Number(meta.at) : Date.now(), ip: meta.ip || null };
}

/** Withdraw consent for a single non-essential purpose on an existing record. Essential purposes can't be
    withdrawn while the account is active (withdraw = delete the account). Returns a NEW record (immutable). */
function withdrawConsent(record, purpose) {
  const rec = record && record.granted ? record : buildConsentRecord({});
  if (!PURPOSES[purpose] || PURPOSES[purpose].essential) return rec;   // no-op for unknown/essential
  return { ...rec, granted: { ...rec.granted, [purpose]: false }, at: Date.now() };
}

/** Is a stored consent record CURRENT (matches the live consent version)? A revised notice/version re-prompts. */
function consentIsCurrent(record) { return !!(record && record.version === CONSENT_VERSION); }

/**
 * Assemble a data principal's PORTABLE export from the raw records the server already holds. Pure: the caller
 * fetches the pieces, this shapes them into a clean, self-describing bundle and redacts secrets (we export the
 * FACT that broker credentials exist, never the encrypted material itself). `sources` is
 * { profile, consent, trades, pushSubscriptions, brokerConnections }.
 */
function buildDataExport(sources = {}) {
  const s = sources || {};
  return {
    format: "matrixone.dpdp.export/v1",
    generatedAt: Date.now(),
    dataInventory: DATA_INVENTORY,
    profile: s.profile || null,
    consent: s.consent || null,
    trades: Array.isArray(s.trades) ? s.trades : [],
    notifications: Array.isArray(s.pushSubscriptions) ? s.pushSubscriptions.map((p) => ({ endpoint: p.endpoint, createdAt: p.createdAt || null })) : [],
    // NEVER export secret material — only that a connection exists, per broker.
    brokerConnections: Array.isArray(s.brokerConnections)
      ? s.brokerConnections.map((b) => ({ broker: b.broker || b.id || null, connectedAt: b.connectedAt || b.at || null, hasStoredToken: true }))
      : [],
    note: "Broker access tokens and PIN are intentionally omitted (secret material is never exported).",
  };
}

module.exports = { CONSENT_VERSION, PURPOSES, DATA_INVENTORY, requiredPurposes, buildConsentRecord, withdrawConsent, consentIsCurrent, buildDataExport };
