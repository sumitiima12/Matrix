"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { alertSeverity, alertCategory } = require("../alertSeverity");

test("urgent classifications", () => {
  for (const k of ["order_rejected", "position_unprotected", "daily_loss_limit", "risk_lock", "manual_reconciliation_required", "exit_failed", "ledger_drift"]) {
    assert.strictEqual(alertSeverity(k), "urgent", k);
  }
});

test("action classifications", () => {
  for (const k of ["broker_disconnected", "token_expired", "partial_fill", "order_unknown", "strategy_paused"]) {
    assert.strictEqual(alertSeverity(k), "action", k);
  }
});

test("info classifications", () => {
  for (const k of ["order_filled", "entry_complete", "exit_complete", "automation_activated", "target_hit"]) {
    assert.strictEqual(alertSeverity(k), "info", k);
  }
});

test("explicit override wins; unknown override ignored", () => {
  assert.strictEqual(alertSeverity("order_filled", "urgent"), "urgent");
  assert.strictEqual(alertSeverity("order_rejected", "nonsense"), "urgent");   // bad override → fall back to rules
  assert.strictEqual(alertSeverity("something_new"), "info");                  // unknown kind → info
});

test("category mapping", () => {
  assert.strictEqual(alertCategory("order_filled"), "trades");
  assert.strictEqual(alertCategory("broker_disconnected"), "broker");
  assert.strictEqual(alertCategory("price_alert"), "alerts");
  assert.strictEqual(alertCategory("anything", "trades"), "trades");
});
