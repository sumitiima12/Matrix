/**
 * strategyStates.js — spec §8 canonical automated-strategy state machine (pure, dependency-free).
 *
 * The durable store (real_strategies) already versions every transition (db.transitionRealStrategy is a CAS on
 * `version`), but it persists ad-hoc status strings ("active", "paused", "cancelled", "closed", "error", ...).
 * The spec requires the FORMAL named vocabulary below. Rather than a risky rename across every money-critical
 * write path, this module (a) defines the canonical states, (b) DERIVES the canonical state deterministically
 * from a strategy row + its managed position (so observability §15 and the UI can present the real state), and
 * (c) validates LEGAL transitions. It is pure and unit-tested; it does not itself write anything.
 */

// The nine spec §8 states.
const STRATEGY_STATES = Object.freeze({
  DRAFT: "DRAFT",                                   // configured, not yet armed for real automation
  ACTIVE: "ACTIVE",                                 // armed, waiting for an entry signal
  PAUSED: "PAUSED",                                 // owner paused new entries (protection/recovery still run)
  ENTRY_PENDING: "ENTRY_PENDING",                   // an entry order is submitted/accepted, fill not yet confirmed
  POSITION_OPEN: "POSITION_OPEN",                   // a confirmed position is open
  EXIT_PENDING: "EXIT_PENDING",                     // a close order is submitted/accepted, fill not yet confirmed
  RECONCILIATION_REQUIRED: "RECONCILIATION_REQUIRED", // an order/exit/journal outcome is unknown → account gated
  STOPPED: "STOPPED",                               // terminal: cancelled/closed by the user, nothing open
  ERROR_LOCKED: "ERROR_LOCKED",                     // a failure locked the strategy; needs operator/repair
});

/* Legal transitions. Recovery/error states are reachable from any live state (a failure or an ambiguous outcome
   can happen at any point); the reverse only via explicit reconciliation. This is intentionally permissive
   toward the SAFE states (RECONCILIATION_REQUIRED / ERROR_LOCKED / STOPPED) and strict about forward progress. */
const LEGAL_TRANSITIONS = Object.freeze({
  DRAFT: ["ACTIVE", "STOPPED", "ERROR_LOCKED"],
  ACTIVE: ["PAUSED", "ENTRY_PENDING", "STOPPED", "RECONCILIATION_REQUIRED", "ERROR_LOCKED"],
  PAUSED: ["ACTIVE", "STOPPED", "RECONCILIATION_REQUIRED", "ERROR_LOCKED"],
  ENTRY_PENDING: ["POSITION_OPEN", "ACTIVE", "RECONCILIATION_REQUIRED", "ERROR_LOCKED", "STOPPED"],
  POSITION_OPEN: ["EXIT_PENDING", "STOPPED", "RECONCILIATION_REQUIRED", "ERROR_LOCKED", "PAUSED"],
  EXIT_PENDING: ["POSITION_OPEN", "STOPPED", "RECONCILIATION_REQUIRED", "ERROR_LOCKED"],
  RECONCILIATION_REQUIRED: ["ACTIVE", "POSITION_OPEN", "STOPPED", "ERROR_LOCKED"],
  STOPPED: [],                                       // terminal
  ERROR_LOCKED: ["RECONCILIATION_REQUIRED", "STOPPED", "ACTIVE"],   // only after explicit repair
});

const _norm = (s) => String(s || "").toLowerCase();

/* DERIVE the canonical §8 state from the persisted (ad-hoc) strategy row + its managed position (if any) + any
   safety flags. Deterministic and total (always returns one of the nine). Order matters: the most-safety-critical
   conditions win first, so an account that needs reconciliation or is error-locked is never shown as merely
   "open" or "active".
     strat: the real_strategies row (has .status, and optionally .reconcileRequired / .errorLocked / .entryPending)
     pos:   the linked managed position (has .status: open|closing|closed) or null
     flags: optional { riskLocked, reconcileRequired } overrides observed elsewhere (e.g. account risk lock) */
function deriveStrategyState(strat, pos = null, flags = {}) {
  const s = _norm(strat && strat.status);
  const ps = _norm(pos && pos.status);
  const reconcile = !!(flags.reconcileRequired || (strat && (strat.reconcileRequired || strat.needsReview)) || (pos && pos.reconcileRequired));
  const errored = !!(strat && (strat.errorLocked)) || s === "error" || s === "error_locked";

  if (errored) return STRATEGY_STATES.ERROR_LOCKED;
  if (reconcile || s === "unknown") return STRATEGY_STATES.RECONCILIATION_REQUIRED;
  // A live close in flight — the broker has the order but the fill isn't confirmed.
  if (ps === "closing") return STRATEGY_STATES.EXIT_PENDING;
  // A confirmed open position dominates the strategy's own ACTIVE/PAUSED label.
  if (ps === "open") return STRATEGY_STATES.POSITION_OPEN;
  // Terminal: user cancelled/closed and nothing is open.
  if (s === "cancelled" || s === "closed" || s === "stopped") return STRATEGY_STATES.STOPPED;
  if (s === "paused") return STRATEGY_STATES.PAUSED;
  // An entry submitted/accepted but not yet a confirmed open position.
  if (s === "entry_pending" || (strat && strat.entryPending === true) || s === "pending" || s === "accepted") return STRATEGY_STATES.ENTRY_PENDING;
  if (s === "active" || s === "approved") return STRATEGY_STATES.ACTIVE;
  if (s === "draft" || s === "new" || s === "") return STRATEGY_STATES.DRAFT;
  return STRATEGY_STATES.ACTIVE;   // default for any live-but-unlabelled row
}

/* Is a transition from → to legal? Unknown states are rejected (fail closed). A self-transition is always legal
   (idempotent re-write of the same state). */
function canTransition(from, to) {
  const f = String(from || "").toUpperCase(), t = String(to || "").toUpperCase();
  if (!(f in LEGAL_TRANSITIONS) || !(t in LEGAL_TRANSITIONS)) return false;
  if (f === t) return true;
  return LEGAL_TRANSITIONS[f].includes(t);
}

const isTerminal = (state) => String(state || "").toUpperCase() === STRATEGY_STATES.STOPPED;
// A state where new entries must NOT be started (but protection/recovery for an open position still run).
const blocksNewEntries = (state) => [STRATEGY_STATES.PAUSED, STRATEGY_STATES.RECONCILIATION_REQUIRED, STRATEGY_STATES.ERROR_LOCKED, STRATEGY_STATES.STOPPED, STRATEGY_STATES.ENTRY_PENDING, STRATEGY_STATES.EXIT_PENDING, STRATEGY_STATES.POSITION_OPEN].includes(String(state || "").toUpperCase());

/* §8/§9 — DETERMINISTIC SIGNAL IDENTITY. A real automated entry may be created at most once per unique signal,
   across restarts and replicas. The spec's identity is: user + strategy id + version + symbol + timeframe +
   closed-candle timestamp + direction. This pure function builds that stable string so the durable unique claim
   (and audit attribution) is computed the same way everywhere. Direction is normalised to L(ong)/S(hort);
   editing a strategy bumps its version, which changes the identity so a NEW version evaluates a candle fresh and
   never collides with (or is blocked by) the OLD version's already-consumed signal. */
function signalIdentity({ userId, strategyId, version = 1, symbol, timeframe, candleTime, direction } = {}) {
  const dir = (String(direction).toUpperCase() === "SELL" || direction === "short" || direction === true) ? "S" : "L";
  return [
    String(userId || ""), String(strategyId || ""), "v" + (Number(version) || 1),
    String(symbol || "").toUpperCase(), String(timeframe || ""), String(candleTime || ""), dir,
  ].join("|");
}

module.exports = { STRATEGY_STATES, LEGAL_TRANSITIONS, deriveStrategyState, canTransition, isTerminal, blocksNewEntries, signalIdentity };
