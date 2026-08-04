/* §8 — canonical automated-strategy state machine. Pure unit tests: the derivation is total and safety-ordered,
   and the transition guard fails closed. No DB. */
const test = require("node:test");
const assert = require("node:assert");
const S = require("../strategyStates");
const ST = S.STRATEGY_STATES;

test("§8 derive: safety states win first (error-locked and reconciliation-required dominate)", () => {
  // An errored strategy is ERROR_LOCKED even if it has an open position.
  assert.equal(S.deriveStrategyState({ status: "active", errorLocked: true }, { status: "open" }), ST.ERROR_LOCKED);
  assert.equal(S.deriveStrategyState({ status: "error" }, null), ST.ERROR_LOCKED);
  // Reconciliation-required dominates an otherwise-open position.
  assert.equal(S.deriveStrategyState({ status: "active" }, { status: "open" }, { reconcileRequired: true }), ST.RECONCILIATION_REQUIRED);
  assert.equal(S.deriveStrategyState({ status: "unknown" }, null), ST.RECONCILIATION_REQUIRED);
});

test("§8 derive: position status drives EXIT_PENDING / POSITION_OPEN over the strategy label", () => {
  assert.equal(S.deriveStrategyState({ status: "active" }, { status: "closing" }), ST.EXIT_PENDING);
  assert.equal(S.deriveStrategyState({ status: "paused" }, { status: "open" }), ST.POSITION_OPEN, "an open position beats a paused label");
});

test("§8 derive: strategy-only labels map to the canonical vocabulary", () => {
  assert.equal(S.deriveStrategyState({ status: "active" }, null), ST.ACTIVE);
  assert.equal(S.deriveStrategyState({ status: "approved" }, null), ST.ACTIVE);
  assert.equal(S.deriveStrategyState({ status: "paused" }, null), ST.PAUSED);
  assert.equal(S.deriveStrategyState({ status: "cancelled" }, null), ST.STOPPED);
  assert.equal(S.deriveStrategyState({ status: "closed" }, null), ST.STOPPED);
  assert.equal(S.deriveStrategyState({ status: "pending" }, null), ST.ENTRY_PENDING);
  assert.equal(S.deriveStrategyState({ status: "", entryPending: true }, null), ST.ENTRY_PENDING);
  assert.equal(S.deriveStrategyState({ status: "draft" }, null), ST.DRAFT);
  assert.equal(S.deriveStrategyState({}, null), ST.DRAFT, "an unlabelled row is DRAFT");
});

test("§8 transitions: forward progress allowed, illegal jumps rejected, terminal is terminal", () => {
  assert.equal(S.canTransition(ST.ACTIVE, ST.ENTRY_PENDING), true);
  assert.equal(S.canTransition(ST.ENTRY_PENDING, ST.POSITION_OPEN), true);
  assert.equal(S.canTransition(ST.POSITION_OPEN, ST.EXIT_PENDING), true);
  assert.equal(S.canTransition(ST.EXIT_PENDING, ST.STOPPED), true);
  // Any live state can fall into reconciliation / error.
  assert.equal(S.canTransition(ST.POSITION_OPEN, ST.RECONCILIATION_REQUIRED), true);
  assert.equal(S.canTransition(ST.ACTIVE, ST.ERROR_LOCKED), true);
  // Illegal: can't jump straight from ACTIVE to POSITION_OPEN (must pass ENTRY_PENDING).
  assert.equal(S.canTransition(ST.ACTIVE, ST.POSITION_OPEN), false);
  // Terminal STOPPED has no outgoing transitions.
  assert.equal(S.canTransition(ST.STOPPED, ST.ACTIVE), false);
  // A self-transition is idempotent-legal; unknown states fail closed.
  assert.equal(S.canTransition(ST.PAUSED, ST.PAUSED), true);
  assert.equal(S.canTransition("BOGUS", ST.ACTIVE), false);
  assert.equal(S.canTransition(ST.ACTIVE, "BOGUS"), false);
});

test("§9 signalIdentity: deterministic, version-aware, direction-normalised", () => {
  const base = { userId: "u1", strategyId: "st1", version: 1, symbol: "sbin", timeframe: "15m", candleTime: 1700000000000, direction: "long" };
  // Deterministic and case-normalised on symbol.
  assert.equal(S.signalIdentity(base), S.signalIdentity({ ...base, symbol: "SBIN" }), "symbol case doesn't change identity");
  assert.equal(S.signalIdentity(base), "u1|st1|v1|SBIN|15m|1700000000000|L");
  // Version is part of the identity — an edit (v2) is a DIFFERENT signal on the same candle (re-evaluates fresh).
  assert.notEqual(S.signalIdentity(base), S.signalIdentity({ ...base, version: 2 }));
  // Direction changes the identity; short/SELL/true all normalise to S.
  assert.notEqual(S.signalIdentity(base), S.signalIdentity({ ...base, direction: "short" }));
  assert.equal(S.signalIdentity({ ...base, direction: "short" }), S.signalIdentity({ ...base, direction: "SELL" }));
  assert.equal(S.signalIdentity({ ...base, direction: true }), S.signalIdentity({ ...base, direction: "short" }));
  // Each of user / strategy / symbol / timeframe / candle changes the identity.
  for (const k of ["userId", "strategyId", "symbol", "timeframe", "candleTime"]) {
    assert.notEqual(S.signalIdentity(base), S.signalIdentity({ ...base, [k]: base[k] + "_x" }), `${k} must be part of the identity`);
  }
});

test("§8 helpers: blocksNewEntries + isTerminal reflect the safety contract", () => {
  assert.equal(S.isTerminal(ST.STOPPED), true);
  assert.equal(S.isTerminal(ST.ACTIVE), false);
  // New entries must not start while paused/reconciling/errored/stopped or while an order/position is in flight.
  for (const st of [ST.PAUSED, ST.RECONCILIATION_REQUIRED, ST.ERROR_LOCKED, ST.STOPPED, ST.ENTRY_PENDING, ST.EXIT_PENDING, ST.POSITION_OPEN]) {
    assert.equal(S.blocksNewEntries(st), true, `${st} should block new entries`);
  }
  assert.equal(S.blocksNewEntries(ST.ACTIVE), false, "ACTIVE is the only state that admits a new entry");
  assert.equal(S.blocksNewEntries(ST.DRAFT), false);
});
