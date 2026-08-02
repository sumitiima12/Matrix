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

/* H-04: daily risk windows (trade count, daily-loss circuit breaker) must reset on the EXCHANGE session day,
   not the server's local/UTC midnight. On a UTC host an Indian loss at 01:00 IST would otherwise count against
   the previous day. Derive midnight in the market's timezone (IST / ET-with-DST / UTC for 24×7 crypto). */
function startOfSessionDay(market) {
  const tz = market === "US" ? "America/New_York" : (market === "Crypto" ? "UTC" : "Asia/Kolkata");
  const now = new Date();
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(now).map((x) => [x.type, x.value]));
  const wallAsUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +(p.hour === "24" ? 0 : p.hour), +p.minute, +p.second);
  const offset = wallAsUTC - now.getTime();               // tz offset from UTC, DST-correct at this instant
  const midnightWallAsUTC = Date.UTC(+p.year, +p.month - 1, +p.day, 0, 0, 0);
  return midnightWallAsUTC - offset;                       // the real UTC instant of tz-local midnight today
}
const startOfDay = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };

/* R3-#6: a short consumes MARGIN, and the engine doesn't know the account's exact leverage. These are
   CONSERVATIVE (generous-leverage) per-market initial-margin fractions of notional — deliberately low so
   we only ever reject a short the account clearly can't afford (e.g. $10 wallet shorting $10k notional),
   never a normal leveraged short. The broker still does the exact margin math; this just stops the
   obvious "insufficient margin" rejection before it reaches the broker. */
const SHORT_MARGIN_FRACTION = { Crypto: 0.04, FNO: 0.15, IN: 0.20, US: 0.30, Commodity: 0.10 };
const shortMarginFraction = (market) => SHORT_MARGIN_FRACTION[market] != null ? SHORT_MARGIN_FRACTION[market] : 0.20;

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
  const sessionStart = startOfSessionDay(market);
  const todays = trades.filter((t) => (t.entryAt || 0) >= sessionStart && (t.market || "IN") === market);
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
       an existing LONG is a plain reduce/close (always allowed, no funds check). Any UNCOVERED portion
       opens/increases a short, which consumes margin like a buy — so it gets the same position-size / count
       caps (and a warning that the market/broker must permit shorting; the broker rejects an illegal short).
       H-05: only a LONG holding covers a SELL. An existing SHORT does NOT cover it — selling more INCREASES
       the short — so we must not treat a short holding as coverage (that bypassed the uncovered-short caps). */
    const heldIsShort = held && (held.short === true || String(held.side || "").toUpperCase() === "SELL");
    const longHeld = held && !heldIsShort ? (held.qty || 0) : 0;
    if (longHeld < qty) {
      const shortQty = qty - longHeld;
      const px = price || (held && (held.price || held.avg)) || 0;
      if (px > 0) {
        const equity = wallet + portfolio.reduce((a, h) => a + Math.abs(h.qty || 0) * (h.price || h.avg || 0), 0);
        const shortValue = shortQty * px;
        const pct = equity > 0 ? (shortValue / equity) * 100 : 100;
        if (pct > limits.maxPositionPct) reasons.push(`Short size ${pct.toFixed(1)}% of ${market} equity exceeds the ${limits.maxPositionPct}% cap.`);
        // R3-#6: actually validate MARGIN — a short the wallet can't margin gets rejected by the broker,
        // so catch it here first. Uses a conservative (generous-leverage) initial-margin estimate.
        const reqMargin = shortValue * shortMarginFraction(market);
        if (reqMargin > wallet) reasons.push(`Insufficient margin to short: needs ≈ ${reqMargin.toFixed(2)} but ${wallet.toFixed(2)} is available.`);
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
    .filter((t) => (t.exitAt || 0) >= sessionStart && (t.market || "IN") === market)
    .reduce((a, t) => a + (t.pnl || 0), 0);
  const startOfDayWallet = wallet - realisedToday;
  const lossCap = -(startOfDayWallet * limits.maxDailyLossPct) / 100;
  if (realisedToday < lossCap) {
    reasons.push(`Daily loss limit hit in ${market} (${realisedToday.toFixed(0)} vs cap ${lossCap.toFixed(0)}).`);
  }

  /* C-04: cooldown is a BLOCKING control, not a warning — it exists to kill resubmission loops that would
     otherwise place repeated real orders 15s apart (idempotency only stops same-key retries; a loop minting
     new keys would bypass it). Applies to a BUY and to opening/increasing an uncovered SHORT. */
  const lastSame = trades
    .filter((t) => t.sym === sym && t.entryAt)
    .sort((a, b) => b.entryAt - a.entryAt)[0];
  const openingExposure = side === "BUY" || (side === "SELL" && (!held || (held.short === true || String(held.side || "").toUpperCase() === "SELL")));
  if (openingExposure && lastSame && Date.now() - lastSame.entryAt < limits.cooldownMs) {
    const waitMs = limits.cooldownMs - (Date.now() - lastSame.entryAt);
    reasons.push(`Cooldown: ${sym} was traded ${Math.round((Date.now() - lastSame.entryAt) / 1000)}s ago — wait ${Math.ceil(waitMs / 1000)}s before another entry.`);
  }

  return { ok: reasons.length === 0, reasons, warnings };
}

module.exports = { validateOrder, DEFAULT_LIMITS };
