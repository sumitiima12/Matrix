"use strict";
/* driftMetrics.js — FIN-2. Cost & drift metrics derived from the IMMUTABLE fills ledger, so the numbers are
   reproducible from durable data (not the mutable projection). All PURE; reuses db.deriveRiskFromFills /
   db.projectFills so it can never diverge from the authoritative risk maths.

   Reports, over a window:
     - realized NET vs GROSS P&L and the fee drag between them (what costs actually took out of the edge);
     - per-broker breakdown (net, gross, fees, matched round-trips);
     - SLIPPAGE where a reference/intended price was captured on the fill (expected vs actual fill). Slippage is
       "available:false" until reference prices are recorded on fills — the computation is forward-ready, and we
       state honestly when we can't measure it rather than inventing a number.
     - model-vs-ledger P&L drift when the projection's realized P&L is supplied (|projection − ledger|). */

const { deriveRiskFromFills, projectFills } = require("./db");

const round2 = (n) => +(Number(n) || 0).toFixed(2);

/* Reference/intended price a fill may carry (limit price, signal price, expected). null if none recorded. */
function refPriceOf(f) {
  const v = f && (f.refPrice != null ? f.refPrice : f.expected != null ? f.expected : f.signalPrice != null ? f.signalPrice : f.limitPrice);
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/* Signed slippage in basis points for one entry fill: for a BUY, paying ABOVE the reference is adverse
   (negative); for a SELL/short, filling BELOW the reference is adverse. Returns null if not measurable. */
function slippageBps(fill) {
  const ref = refPriceOf(fill);
  const px = Number(fill && (fill.entry != null ? fill.entry : fill.price));
  if (!(ref > 0) || !(px > 0)) return null;
  const dir = String(fill && fill.side || "").toUpperCase() === "SELL" ? -1 : 1;
  // adverse fill → negative bps. (px-ref)/ref for a buy; inverted for a sell.
  return -dir * ((px - ref) / ref) * 10000;
}

function costMetrics(fills, { from = 0, to = Date.now(), projectionRealizedPnl = null } = {}) {
  const all = Array.isArray(fills) ? fills : [];
  const overall = deriveRiskFromFills(all, { from, to });

  // Per-broker: run the same authoritative derivation on each broker's own fills.
  const brokers = [...new Set(all.map((f) => String((f && f.broker) || "").toLowerCase()).filter(Boolean))];
  const byBroker = {};
  for (const b of brokers) {
    const r = deriveRiskFromFills(all.filter((f) => String((f && f.broker) || "").toLowerCase() === b), { from, to });
    byBroker[b] = { net: r.realizedPnl, gross: r.realizedPnlGross, fees: r.fees, matched: r.matched };
  }

  // Slippage over entry legs that carry a reference price.
  const entryLegs = projectFills(all).filter((p) => p.leg === "entry" && p.ts >= from && p.ts <= to);
  // projectFills drops the raw reference field, so measure slippage on the RAW entry fills instead.
  const rawEntries = all.filter((f) => f && (f.kind !== "exit") && f.ts >= from && f.ts <= to);
  const slips = rawEntries.map(slippageBps).filter((x) => x != null);
  const slippage = slips.length
    ? {
        available: true,
        samples: slips.length,
        avgBps: round2(slips.reduce((a, x) => a + x, 0) / slips.length),
        worstBps: round2(Math.min(...slips)),
      }
    : { available: false, reason: "no reference/intended price recorded on fills yet", samples: 0 };

  const feeDragPct = overall.realizedPnlGross ? round2((overall.fees / Math.abs(overall.realizedPnlGross)) * 100) : null;
  const modelVsLedgerDrift = projectionRealizedPnl == null ? null : round2(Math.abs(Number(projectionRealizedPnl) - overall.realizedPnl));

  return {
    window: { from, to },
    realizedNet: overall.realizedPnl,
    realizedGross: overall.realizedPnlGross,
    totalFees: overall.fees,
    feeDragPct,                 // % of gross edge eaten by costs
    roundTrips: overall.matched,
    unmatchedExits: overall.unmatchedExits,
    byBroker,
    slippage,
    modelVsLedgerDrift,         // |projection P&L − ledger P&L| when a projection value is supplied
    entryLegs: entryLegs.length,
  };
}

module.exports = { costMetrics, slippageBps, refPriceOf };
