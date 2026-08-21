"use strict";
/**
 * contractSpecs.js — the ONE canonical, provenance-tagged contract-specification service (Parts 13/14/16/17/42).
 *
 * PRINCIPLE (Part 28/38/39): a spec used for REAL-MONEY execution must come from an authoritative broker/exchange
 * instrument master. This module ships a small, SOURCE-CITED seed for reference/virtual use and for tests, but every
 * entry carries { metadataSource, verified, realExecution }. getContractSpec() returns null when it cannot supply a
 * spec that is safe for the requested mode — real-money callers MUST fail closed on null (DERIVATIVE_CONTRACT_
 * RESOLUTION_FAILED) rather than guess. When the live per-user instrument master is wired, prefer it over this seed.
 *
 * Verified in-session (Aug 2026) against authoritative sources — see SOURCES below.
 */

const METADATA_VERSION = "2026.08-seed";

// realExecution:true only where the value is a fixed exchange/broker contract definition we verified this session.
// realExecution:false = reference/virtual only until confirmed against the live instrument master for that account.
const SEED = {
  // ---- CRYPTO (Delta Exchange India) — VERIFIED ----
  "Crypto:BTC:FUTURE": {
    lotSize: 0.001, contractMultiplier: 1, quantityStep: 1, minQty: 1, tickSize: 0.5,
    exchange: "DELTA", metadataSource: "delta_exchange_india_perpetual_guide", verified: true, realExecution: true,
    note: "BTCUSD perpetual: 1 contract = 0.001 BTC (1000 lots = 1 BTC).",
  },
  "Crypto:ETH:FUTURE": {
    lotSize: 0.01, contractMultiplier: 1, quantityStep: 1, minQty: 1, tickSize: 0.05,
    exchange: "DELTA", metadataSource: "delta_exchange_india_min_order_size", verified: true, realExecution: true,
    note: "ETHUSD perpetual: 1 contract = 0.01 ETH (min order size 0.01 ETH).",
  },
  // Options on Delta exist for BTC/ETH; sizing must be read from the live options contract (varies) → fail closed
  // for real execution until confirmed, reference only.
  "Crypto:BTC:OPTION": { lotSize: 0.001, contractMultiplier: 1, quantityStep: 1, minQty: 1, exchange: "DELTA",
    metadataSource: "reference_pending_live_master", verified: false, realExecution: false },
  "Crypto:ETH:OPTION": { lotSize: 0.01, contractMultiplier: 1, quantityStep: 1, minQty: 1, exchange: "DELTA",
    metadataSource: "reference_pending_live_master", verified: false, realExecution: false },

  // ---- US EQUITY OPTIONS — standard multiplier VERIFIED (OCC standard) ----
  // Per-underlying lot handled by broker; contractMultiplier 100 shares/contract is the standard. Indexes (SPX/NDX)
  // differ and MUST come from the master.
  "US:*:OPTION": { lotSize: 1, contractMultiplier: 100, quantityStep: 1, minQty: 1, exchange: "OPRA",
    metadataSource: "occ_standard_equity_option_multiplier", verified: true, realExecution: false,
    note: "Standard US equity option = 100 shares/contract; index options differ → live master required." },

  // ---- COMMODITY (MCX) — contract SIZES verified (Gold 1kg / Silver 30kg confirmed this session; mini/guinea/petal
  //      are long-standing MCX product definitions). Real execution stays gated on the live master (per-account
  //      lot/tick/expiry) — reference/virtual only here. ----
  "Commodity:GOLD:FUTURE":        { lotSize: 1,   unit: "kg",    contractMultiplier: 1000, quantityStep: 1, minQty: 1, tickSize: 1, exchange: "MCX", metadataSource: "mcx_bullion_spec", verified: true,  realExecution: false, note: "Gold 1 kg." },
  "Commodity:GOLDMINI:FUTURE":    { lotSize: 100, unit: "g",     contractMultiplier: 100,  quantityStep: 1, minQty: 1, tickSize: 1, exchange: "MCX", metadataSource: "mcx_bullion_spec", verified: false, realExecution: false, note: "Gold Mini 100 g — confirm vs live master." },
  "Commodity:GOLDGUINEA:FUTURE":  { lotSize: 8,   unit: "g",     contractMultiplier: 8,    quantityStep: 1, minQty: 1, tickSize: 1, exchange: "MCX", metadataSource: "mcx_bullion_spec", verified: false, realExecution: false, note: "Gold Guinea 8 g — confirm vs live master." },
  "Commodity:GOLDPETAL:FUTURE":   { lotSize: 1,   unit: "g",     contractMultiplier: 1,    quantityStep: 1, minQty: 1, tickSize: 1, exchange: "MCX", metadataSource: "mcx_bullion_spec", verified: false, realExecution: false, note: "Gold Petal 1 g — confirm vs live master." },
  "Commodity:SILVER:FUTURE":      { lotSize: 30,  unit: "kg",    contractMultiplier: 30,   quantityStep: 1, minQty: 1, tickSize: 1, exchange: "MCX", metadataSource: "mcx_bullion_spec", verified: true,  realExecution: false, note: "Silver 30 kg." },
  "Commodity:SILVERMINI:FUTURE":  { lotSize: 5,   unit: "kg",    contractMultiplier: 5,    quantityStep: 1, minQty: 1, tickSize: 1, exchange: "MCX", metadataSource: "mcx_bullion_spec", verified: false, realExecution: false, note: "Silver Mini 5 kg — confirm vs live master." },

  // ---- INDIA EQUITY/INDEX DERIVATIVES — lot sizes CHANGE and MUST come from the live FYERS/NSE instrument master.
  //      Deliberately NOT seeded → getContractSpec returns null → fail closed for real execution (Part 16/28). ----
};

const SOURCES = {
  delta_exchange_india_perpetual_guide: "https://guides.delta.exchange/delta-exchange-india-user-guide/derivatives-guide/docs",
  delta_exchange_india_min_order_size: "https://www.delta.exchange/support/solutions/articles/80001177912",
  occ_standard_equity_option_multiplier: "https://www.optionseducation.org (standard 100-share multiplier)",
  mcx_bullion_spec: "https://www.mcxindia.com (bullion contract specifications)",
};

/**
 * @param {object} q { market, underlying, productType }
 * @param {object} opts { mode: "real"|"virtual", liveMaster?: (q)=>spec|null }
 * @returns spec (with provenance) or null. For mode "real" a spec is returned ONLY if realExecution is true OR the
 *          liveMaster supplied one; otherwise null (caller must fail closed).
 */
function getContractSpec(q = {}, opts = {}) {
  const mode = String(opts.mode || "virtual").toLowerCase();
  // 1) Prefer the authoritative live instrument master when provided.
  if (typeof opts.liveMaster === "function") {
    const live = opts.liveMaster(q);
    if (live && Number(live.lotSize) > 0 && Number(live.contractMultiplier) > 0) {
      return { ...live, metadataSource: live.metadataSource || "live_instrument_master", verified: true, realExecution: true, metadataVersion: live.metadataVersion || "live" };
    }
  }
  // 2) Seed fallback (reference/virtual + verified-fixed contracts).
  const key = `${q.market}:${String(q.underlying || "").toUpperCase()}:${q.productType}`;
  const wildcard = `${q.market}:*:${q.productType}`;
  const spec = SEED[key] || SEED[wildcard] || null;
  if (!spec) return null;                                    // unknown → fail closed
  if (mode === "real" && !spec.realExecution) return null;   // not safe for real money → fail closed
  return { ...spec, metadataVersion: METADATA_VERSION };
}

module.exports = { getContractSpec, SEED, SOURCES, METADATA_VERSION };
