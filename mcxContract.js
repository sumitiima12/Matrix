/**
 * mcxContract.js — resolve the CURRENT near-month MCX futures contract for a commodity.
 *
 * WHY THIS EXISTS
 * ---------------
 * The app's commodities (GOLD, SILVER, CRUDEOIL, ALUMINIUM) are priced off COMEX/NYMEX in USD by
 * default. When a user has FYERS connected, they instead want the Indian MCX contract, priced in
 * INR — but MCX futures roll every month (GOLD25AUGFUT → GOLD25SEPFUT → …), so we can't hard-code
 * a symbol. We read FYERS' public "symbol master" for MCX, find the nearest non-expired futures
 * contract for each underlying, and quote THAT.
 *
 * This module is PURE and dependency-free: it takes the symbol-master text (or already-parsed rows)
 * and a clock, and returns the contract to quote. All network/caching lives in server.js. That
 * separation is what makes it unit-testable without a live FYERS feed.
 */

/* COMEX/NYMEX Yahoo ticker  ->  MCX underlying base. This is how a quote request for "GC=F"
   (what the frontend sends for GOLD) gets mapped onto the MCX GOLD futures chain. */
const COMEX_TO_MCX = {
  "GC=F": "GOLD",
  "SI=F": "SILVER",
  "CL=F": "CRUDEOIL",
  "ALI=F": "ALUMINIUM",
};

/* App symbol -> MCX base, for callers that work in app symbols rather than Yahoo tickers. */
const APP_TO_MCX = { GOLD: "GOLD", SILVER: "SILVER", CRUDEOIL: "CRUDEOIL", ALUMINIUM: "ALUMINIUM" };

/* Curated per-underlying metadata. `lot` is the FYERS minimum order lot (almost always 1 for these
   — you buy N lots), `unit` is what the LTP is quoted in, and `quoteMult` maps 1 lot to its rupee
   exposure for position sizing. These are informational for the quote path; the live order path is
   intentionally NOT wired here. Values reflect standard MCX contract specs. */
const MCX_META = {
  GOLD:      { label: "Gold (MCX)",       unit: "₹/10g",   lot: 1, quoteMult: 100 },   // 1 kg, quoted /10g
  GOLDM:     { label: "Gold Mini (MCX)",  unit: "₹/10g",   lot: 1, quoteMult: 10 },    // 100 g
  SILVER:    { label: "Silver (MCX)",     unit: "₹/kg",    lot: 1, quoteMult: 30 },    // 30 kg
  SILVERM:   { label: "Silver Mini (MCX)",unit: "₹/kg",    lot: 1, quoteMult: 5 },     // 5 kg
  CRUDEOIL:  { label: "Crude Oil (MCX)",  unit: "₹/bbl",   lot: 1, quoteMult: 100 },   // 100 barrels
  CRUDEOILM: { label: "Crude Mini (MCX)", unit: "₹/bbl",   lot: 1, quoteMult: 10 },    // 10 barrels
  NATURALGAS:{ label: "Natural Gas (MCX)",unit: "₹/mmBtu", lot: 1, quoteMult: 1250 },
  ALUMINIUM: { label: "Aluminium (MCX)",  unit: "₹/kg",    lot: 1, quoteMult: 5000 },  // 5 MT
  COPPER:    { label: "Copper (MCX)",     unit: "₹/kg",    lot: 1, quoteMult: 2500 },  // 2.5 MT
  ZINC:      { label: "Zinc (MCX)",       unit: "₹/kg",    lot: 1, quoteMult: 5000 },
  LEAD:      { label: "Lead (MCX)",       unit: "₹/kg",    lot: 1, quoteMult: 5000 },
};

const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

/* Parse an MCX futures ticker like "MCX:GOLD25AUGFUT" into { base, yy, mon, expiryMs }.
   The base is matched non-greedily so GOLDM25AUGFUT resolves to base GOLDM (not GOLD).
   expiryMs is a PROXY — the last day of the contract month at IST end-of-day — good enough to
   rank near vs far. The precise exchange expiry (from the master's epoch column) overrides it in
   parseSymbolMaster when available. Returns null for anything that isn't an MCX FUT ticker. */
function parseTicker(ticker) {
  const m = /^MCX:([A-Z]+?)(\d{2})([A-Z]{3})FUT$/.exec(String(ticker || "").trim());
  if (!m) return null;
  const base = m[1];
  const yy = 2000 + Number(m[2]);
  const mon = MONTHS[m[3]];
  if (mon == null) return null;
  // last day of that month, 23:59 IST (IST = UTC+5:30) as a UTC epoch
  const lastDay = new Date(Date.UTC(yy, mon + 1, 0, 23, 59, 0)).getTime() - 5.5 * 3600 * 1000;
  return { base, yy, mon, ticker: `MCX:${base}${m[2]}${m[3]}FUT`, expiryMs: lastDay };
}

/* Turn the FYERS symbol-master CSV text into normalised futures rows:
     { base, ticker, expiryMs, lot }
   The master's column ORDER has changed across FYERS API versions, so rather than trust a fixed
   index we detect fields by shape: the ticker is the "MCX:…FUT" field, the expiry is a 10-digit
   (seconds) or 13-digit (ms) epoch, and the lot is the smallest plausible positive integer that
   isn't the epoch. Anything we can't confidently read falls back to values derived from the ticker
   / the curated MCX_META, so a column reshuffle upstream degrades gracefully instead of breaking. */
function parseSymbolMaster(csvText) {
  const out = [];
  const lines = String(csvText || "").split(/\r?\n/);
  for (const line of lines) {
    if (!line || !/MCX:/.test(line)) continue;
    const cols = line.split(",").map((c) => c.trim());
    const ticker = cols.find((c) => /^MCX:[A-Z]+\d{2}[A-Z]{3}FUT$/.test(c));
    if (!ticker) continue;
    const parsed = parseTicker(ticker);
    if (!parsed) continue;
    // Prefer a real epoch expiry column if one is present and sane (within ~5y of the ticker month).
    let expiryMs = parsed.expiryMs;
    for (const c of cols) {
      if (!/^\d{10}(\d{3})?$/.test(c)) continue;
      const asMs = c.length === 13 ? Number(c) : Number(c) * 1000;
      if (Math.abs(asMs - parsed.expiryMs) < 45 * 864e5) { expiryMs = asMs; break; }
    }
    const meta = MCX_META[parsed.base] || {};
    // lot: the smallest integer 1..100000 that isn't the epoch and isn't obviously a scrip code
    let lot = meta.lot || 1;
    const ints = cols.filter((c) => /^\d{1,5}$/.test(c)).map(Number).filter((n) => n >= 1 && n <= 100000);
    if (ints.length) lot = Math.min(...ints);
    out.push({ base: parsed.base, ticker: parsed.ticker, expiryMs, lot });
  }
  return out;
}

/* Given normalised rows and an underlying base, return the nearest contract whose expiry is still
   in the future (with a small grace so a contract doesn't vanish intraday on its expiry day).
   Returns null if the base has no live contract in the master. */
function nearestFut(rows, base, nowMs = Date.now(), graceMs = 12 * 3600 * 1000) {
  const cands = (rows || [])
    .filter((r) => r.base === base && r.expiryMs > nowMs - graceMs)
    .sort((a, b) => a.expiryMs - b.expiryMs);
  return cands[0] || null;
}

/* Resolve straight from a Yahoo COMEX ticker (what the frontend sends). Returns the MCX contract
   row augmented with display metadata, or null if this isn't a mappable commodity. */
function resolveFromYahoo(rows, yTicker, nowMs = Date.now()) {
  const base = COMEX_TO_MCX[yTicker];
  if (!base) return null;
  const c = nearestFut(rows, base, nowMs);
  if (!c) return null;
  return { ...c, ...(MCX_META[base] || {}), currency: "INR", exchange: "MCX" };
}

module.exports = {
  COMEX_TO_MCX,
  APP_TO_MCX,
  MCX_META,
  parseTicker,
  parseSymbolMaster,
  nearestFut,
  resolveFromYahoo,
};
