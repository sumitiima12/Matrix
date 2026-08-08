"use strict";
/* drReconstruct.js — DISASTER-RECOVERY reconstruction.
 *
 * The essential DR question (OPS-2): after losing the mutable projection tables (trades, managed_positions,
 * risk_lock), can Matrix rebuild every OPEN position and the correct risk-lock state from the IMMUTABLE
 * append-only fills ledger alone?
 *
 * This module answers "yes" with PURE functions that take only the fills ledger and reproduce:
 *   - reconstructOpenPositions(fills)  → net-open positions (entry qty minus matched exit qty), by (broker, entry order)
 *   - reconstructRiskState(fills, opts)→ realized daily loss + whether the account SHOULD be risk-locked
 *
 * It reuses db.projectFills / db.deriveRiskFromFills (the same authoritative primitives the live system uses),
 * so the reconstruction can never silently diverge from production maths.
 */

const { projectFills, deriveRiskFromFills } = require("./db");

/* Net-open positions from the immutable ledger. An entry leg is open for the quantity not yet consumed by a
   matched exit leg (exits match their entry by broker-scoped entryOrderId, else managedId — same rule the live
   risk engine uses). Returns one row per still-open entry order. */
function reconstructOpenPositions(fills) {
  const proj = projectFills(fills || []);
  const entries = proj.filter((p) => p.leg === "entry");
  const exits = proj.filter((p) => p.leg === "exit");

  // Sum matched exit quantity per entry order.
  const consumed = new Map();   // key `${broker}|${entryOrderId}` -> qty
  const add = (key, q) => consumed.set(key, (consumed.get(key) || 0) + q);
  const entryByManaged = new Map();
  for (const e of entries) if (e.managedId != null) entryByManaged.set(String(e.managedId), e);
  for (const x of exits) {
    let key = null;
    if (x.entryOrderId != null) key = `${x.broker || ""}|${x.entryOrderId}`;
    else if (x.managedId != null && entryByManaged.has(String(x.managedId))) {
      const e = entryByManaged.get(String(x.managedId));
      key = `${e.broker || ""}|${e.orderId}`;
    }
    if (key) add(key, Number(x.qty) || 0);
  }

  const open = [];
  for (const e of entries) {
    const key = `${e.broker || ""}|${e.orderId}`;
    const net = (Number(e.qty) || 0) - (consumed.get(key) || 0);
    if (net > 1e-9) {
      open.push({
        broker: e.broker || null,
        entryOrderId: e.orderId,
        market: e.market || null,
        side: e.side || "BUY",
        qty: +net.toFixed(8),
        entryPrice: e.price,
        managedId: e.managedId || null,
        incompleteExec: !!e.incompleteExec,
      });
    }
  }
  return open;
}

/* Reconstruct the risk state that SHOULD exist for a user from the ledger: realized loss over the session
   window and, given the daily-loss ceiling, whether the account should be risk-locked. Pure — no DB reads
   beyond the fills passed in. `maxDailyLoss` is an absolute currency amount (the ceiling for the window). */
function reconstructRiskState(fills, { from = 0, to = Date.now(), maxDailyLoss = null } = {}) {
  const risk = deriveRiskFromFills(fills || [], { from, to });
  const shouldRiskLock = maxDailyLoss != null && Number.isFinite(maxDailyLoss) && risk.realizedLoss >= maxDailyLoss;
  return {
    realizedPnl: risk.realizedPnl,
    realizedLoss: risk.realizedLoss,
    fees: risk.fees,
    entryCount: risk.entryCount,
    matched: risk.matched,
    unmatchedExits: risk.unmatchedExits,
    shouldRiskLock,
    maxDailyLoss: maxDailyLoss != null ? Number(maxDailyLoss) : null,
  };
}

/* Full DR snapshot for a user — everything needed to rebuild their live state after a projection loss. */
function reconstructUserState(fills, opts = {}) {
  const openPositions = reconstructOpenPositions(fills);
  const risk = reconstructRiskState(fills, opts);
  return {
    openPositions,
    openCount: openPositions.length,
    totalOpenQty: +openPositions.reduce((a, p) => a + (p.qty || 0), 0).toFixed(8),
    risk,
    anyIncompleteExec: openPositions.some((p) => p.incompleteExec),
  };
}

module.exports = { reconstructOpenPositions, reconstructRiskState, reconstructUserState };
