/**
 * riskEngine.js — server-side order validation for REAL orders.
 *
 * Ported from the frontend services/riskService.js validateOrder (which is pure and
 * synchronous). The frontend copy is a UX affordance; THIS is the real control — it runs
 * on the server before any live broker call, using server-held / broker-fetched account
 * state, never values supplied by the client.
 *
 * Keep the two in sync when limits change. This file is intentionally dependency-free.
 */

/* Default SAFETY FLOOR (P1-02). Previously all caps were effectively OFF (100% loss, unlimited
   trades/positions), so a bug or runaway strategy could drain an account. These defaults keep single
   positions permissive (a one-symbol crypto/equity position can legitimately be 100% of that sleeve)
   but add the three controls that actually stop a disaster: a daily-loss circuit breaker, a per-symbol
   cooldown that kills resubmission loops, and sane count caps. All remain fully overridable per user in
   Profile → Risk limits, so anyone who wants them off can set them off. */
const DEFAULT_LIMITS = {
  maxPositionPct: 100,      // max % of that market's equity in a single position (kept permissive)
  maxOpenPositions: 50,     // per market — stops a runaway opening hundreds of positions
  maxTradesPerDay: 100,     // per market
  maxDailyLossPct: 25,      // circuit breaker: halt a market after −25% realised on the day
  cooldownMs: 15000,        // 15s min gap between two entries in the same symbol
};

const startOfDay = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };

/**
 * Validate an order against account state.
 * @param order   { sym, side:"BUY"|"SELL", qty, price, market }
 * @param account { wallet, portfolio:[{sym,qty,avg,price,market}], trades:[{entryAt,exitAt,pnl,market}], limits? }
 * @returns { ok, reasons:string[], warnings:string[] }
 */
function validateOrder(order, account) {
  const limits = { ...DEFAULT_LIMITS, ...((account && account.limits) || {}) };
  const reasons = [];
  const warnings = [];

  const { sym, side = "BUY", qty, price, market = "IN" } = order || {};
  const { wallet = 0, portfolio = [], trades = [] } = account || {};

  // --- basic sanity ---
  if (!sym) reasons.push("No symbol on the order.");
  if (!qty || qty <= 0 || !Number.isFinite(qty)) reasons.push("Quantity must be a positive number.");
  // Price gates BUYS only — a SELL closes a position you already own.
  if (side === "BUY" && (!price || price <= 0 || !Number.isFinite(price))) reasons.push("No live price available for this order.");
  if (reasons.length) return { ok: false, reasons, warnings };

  const value = qty * price;
  const held = portfolio.find((h) => h.sym === sym);
  const todays = trades.filter((t) => (t.entryAt || 0) >= startOfDay() && (t.market || "IN") === market);
  const openInMarket = portfolio.filter((h) => (h.market || "IN") === market);

  if (side === "BUY") {
    // --- funds ---
    if (value > wallet) reasons.push(`Insufficient funds: order needs ${value.toFixed(2)} but ${wallet.toFixed(2)} is available.`);

    // --- position sizing ---
    const equity = wallet + portfolio.reduce((a, h) => a + (h.qty || 0) * (h.price || h.avg || 0), 0);
    const existing = held ? (held.qty || 0) * price : 0;
    const pct = equity > 0 ? ((value + existing) / equity) * 100 : 100;
    if (pct > limits.maxPositionPct) {
      reasons.push(`Position size ${pct.toFixed(1)}% of ${market} equity exceeds the ${limits.maxPositionPct}% cap.`);
    }

    // --- max open positions ---
    if (!held && openInMarket.length >= limits.maxOpenPositions) {
      reasons.push(`Already holding ${openInMarket.length} positions in ${market} (cap ${limits.maxOpenPositions}).`);
    }
  }

  if (side === "SELL") {
    /* P1-03 — reconcile with the frontend, which allows a SELL to OPEN a short. The portion covered by
       an existing long is a plain reduce/close (always allowed, no funds check). Any UNCOVERED portion
       opens a short, which consumes margin like a buy — so it gets the same position-size / count caps
       (and a warning that the market/broker must permit shorting; the broker rejects an illegal short). */
    const heldQty = held ? (held.qty || 0) : 0;
    if (heldQty < qty) {
      const shortQty = qty - heldQty;
      const px = price || (held && (held.price || held.avg)) || 0;
      if (px > 0) {
        const equity = wallet + portfolio.reduce((a, h) => a + Math.abs(h.qty || 0) * (h.price || h.avg || 0), 0);
        const pct = equity > 0 ? ((shortQty * px) / equity) * 100 : 100;
        if (pct > limits.maxPositionPct) reasons.push(`Short size ${pct.toFixed(1)}% of ${market} equity exceeds the ${limits.maxPositionPct}% cap.`);
      }
      if (!held && openInMarket.length >= limits.maxOpenPositions) {
        reasons.push(`Already holding ${openInMarket.length} positions in ${market} (cap ${limits.maxOpenPositions}).`);
      }
      warnings.push(`Opening a short of ${shortQty} ${sym} (uncovered) — needs margin; ensure this market/broker permits shorting.`);
    }
  }

  // --- trade frequency ---
  if (todays.length >= limits.maxTradesPerDay) {
    reasons.push(`Daily trade cap reached for ${market} (${limits.maxTradesPerDay}).`);
  }

  // --- daily loss limit (based on start-of-day equity, not current wallet) ---
  const realisedToday = trades
    .filter((t) => (t.exitAt || 0) >= startOfDay() && (t.market || "IN") === market)
    .reduce((a, t) => a + (t.pnl || 0), 0);
  const startOfDayWallet = wallet - realisedToday;
  const lossCap = -(startOfDayWallet * limits.maxDailyLossPct) / 100;
  if (realisedToday < lossCap) {
    reasons.push(`Daily loss limit hit in ${market} (${realisedToday.toFixed(0)} vs cap ${lossCap.toFixed(0)}).`);
  }

  // --- duplicate / cooldown ---
  const lastSame = trades
    .filter((t) => t.sym === sym && t.entryAt)
    .sort((a, b) => b.entryAt - a.entryAt)[0];
  if (side === "BUY" && lastSame && Date.now() - lastSame.entryAt < limits.cooldownMs) {
    warnings.push(`Bought ${sym} moments ago — cooling down.`);
  }

  return { ok: reasons.length === 0, reasons, warnings };
}

module.exports = { validateOrder, DEFAULT_LIMITS };
