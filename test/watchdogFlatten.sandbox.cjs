#!/usr/bin/env node
/* test/watchdogFlatten.sandbox.cjs — R41-P1-06 INDEPENDENT emergency-flatten watchdog.
 *
 * The MatrixOne-path E2E and the Delta cert both flatten in their OWN process teardown. But a hard crash, runner loss,
 * OOM, forced cancellation or network partition can kill that process BEFORE teardown runs — the exact failure class
 * being certified. This watchdog is a SEPARATE process, meant to run as its own CI job with `if: always()` AFTER the
 * E2E/cert job (or on a cron), with INDEPENDENT credentials and a BOUNDED expiry. It:
 *   1. verifies it targets an approved Delta TESTNET host (never production) and an ALLOW-LISTED product only,
 *   2. reads the account's live position for that product from broker truth,
 *   3. if there is ANY exposure, places reduce-only market closes until flat (bounded retries),
 *   4. re-reads to PROVE flat, writes a machine-readable evidence line, and
 *   5. exits 0 iff flat is proven; otherwise exits NON-ZERO so CI/paging escalates for manual intervention.
 *
 * It NEVER opens a position and NEVER touches any product other than the allow-listed one. Independent of any test
 * process: run it standalone.
 *
 * ENV:
 *   DELTA_WATCHDOG_KEY / DELTA_WATCHDOG_SECRET   (preferred) independent API creds; falls back to DELTA_SANDBOX_KEY/SECRET.
 *   DELTA_SANDBOX_BASE     (optional) default https://cdn-ind.testnet.deltaex.org (MUST be an approved testnet host)
 *   WATCHDOG_SYMBOL        (optional) default the allow-listed cert symbol (e.g. BTCUSD) — the ONLY product it may flatten
 *   WATCHDOG_ALLOW_SYMBOLS (optional) comma list of additionally-allowed symbols (defaults to just WATCHDOG_SYMBOL)
 *   WATCHDOG_MAX_MS        (optional) hard wall-clock budget (default 60000) — the bounded expiry
 *   WATCHDOG_EVIDENCE      (optional) path to append the evidence line (default artifacts/watchdog-flatten.txt)
 *
 * RUN (independent job, always):
 *   DELTA_WATCHDOG_KEY=… DELTA_WATCHDOG_SECRET=… node test/watchdogFlatten.sandbox.cjs
 */
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const BASE = String(process.env.DELTA_SANDBOX_BASE || "https://cdn-ind.testnet.deltaex.org").replace(/\/+$/, "");
// R42-P1-06: in STRICT mode (set by the release CI) the watchdog MUST use DEDICATED credentials and MUST fail (not
// silently SKIP) if they're absent — a cleanup that never authenticated is not a safety net. Only outside strict mode
// may it fall back to the sandbox creds (local/dev convenience).
const STRICT = process.env.WATCHDOG_STRICT === "1";
const DEDICATED_KEY = process.env.DELTA_WATCHDOG_KEY || "";
const DEDICATED_SECRET = process.env.DELTA_WATCHDOG_SECRET || "";
const KEY = DEDICATED_KEY || (STRICT ? "" : process.env.DELTA_SANDBOX_KEY || "");
const SECRET = DEDICATED_SECRET || (STRICT ? "" : process.env.DELTA_SANDBOX_SECRET || "");
const SYMBOL = String(process.env.WATCHDOG_SYMBOL || process.env.DELTA_SANDBOX_SYMBOL || "BTCUSD").trim().toUpperCase();
const ALLOW = new Set(
  String(process.env.WATCHDOG_ALLOW_SYMBOLS || SYMBOL).split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
);
const MAX_MS = Math.max(5000, Number(process.env.WATCHDOG_MAX_MS || 60000) || 60000);
const EVIDENCE = process.env.WATCHDOG_EVIDENCE || "artifacts/watchdog-flatten.txt";
// Only approved Delta TESTNET hosts — a watchdog that can place orders must NEVER be pointed at production.
const APPROVED_HOSTS = new Set(["cdn-ind.testnet.deltaex.org", "cdn.testnet.deltaex.org"]);

const started = Date.now();
const budgetLeft = () => MAX_MS - (Date.now() - started);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[watchdog]", ...a);

function hostOf(u) { try { return new URL(u).host; } catch { return ""; } }
function sign(method, p, body, ts) { return crypto.createHmac("sha256", SECRET).update(method + ts + p + (body || "")).digest("hex"); }
async function delta(method, p, { query = "", body = null } = {}) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const full = p + (query ? `?${query}` : "");
  const bodyStr = body ? JSON.stringify(body) : "";
  const sig = sign(method, full, bodyStr, ts);
  const r = await fetch(BASE + full, {
    method,
    headers: { "api-key": KEY, signature: sig, timestamp: ts, "Content-Type": "application/json", "User-Agent": "matrix-watchdog" },
    body: body ? bodyStr : undefined,
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, json: j };
}

async function resolveProduct(symbol) {
  const prod = await delta("GET", "/v2/products");
  const p = ((prod.json && prod.json.result) || []).find((x) => x.symbol === symbol);
  if (!p || !p.id) throw new Error(`product ${symbol} not resolvable on ${BASE_HOST}`);
  return p;
}
async function netSize(productId) {
  const pos = await delta("GET", "/v2/positions", { query: `product_id=${productId}` });
  let rows = pos.json && (Array.isArray(pos.json.result) ? pos.json.result : [pos.json.result]).filter(Boolean);
  let mine = (rows || []).find((r) => r && String(r.product_id) === String(productId));
  if (!mine || Number(mine.size || 0) === 0) {
    const marg = await delta("GET", "/v2/positions/margined");
    const list = (marg.json && (Array.isArray(marg.json.result) ? marg.json.result : [marg.json.result])) || [];
    const m2 = list.filter(Boolean).find((r) => r && String(r.product_id) === String(productId));
    if (m2 && Number(m2.size || 0) !== 0) mine = m2;
  }
  return mine ? Number(mine.size || 0) : 0;
}

const BASE_HOST = hostOf(BASE);
function writeEvidence(obj) {
  const line = `watchdog_flatten ${Object.entries(obj).map(([k, v]) => `${k}=${v}`).join(" ")} at=${new Date().toISOString()}`;
  try { fs.mkdirSync(path.dirname(EVIDENCE), { recursive: true }); fs.appendFileSync(EVIDENCE, line + "\n"); } catch { /* stdout still carries it */ }
  log(line);
}

(async function main() {
  // Fail-safe guards BEFORE any order can be placed.
  if (STRICT && (!DEDICATED_KEY || !DEDICATED_SECRET)) {
    writeEvidence({ result: "FAIL", reason: "strict_mode_requires_dedicated_watchdog_credentials" });
    log("STRICT: DELTA_WATCHDOG_KEY/SECRET are required (no sandbox-cred fallback) — failing"); process.exit(6);
  }
  if (!KEY || !SECRET) { writeEvidence({ result: "SKIP", reason: "no_credentials" }); log("no creds — nothing to guard; exiting 0"); process.exit(0); }
  if (!(APPROVED_HOSTS.has(BASE_HOST) && /testnet/i.test(BASE_HOST))) {
    writeEvidence({ result: "REFUSE", reason: "non_testnet_host", host: BASE_HOST });
    log(`refusing: ${BASE_HOST} is not an approved Delta testnet host`); process.exit(2);
  }
  if (!ALLOW.has(SYMBOL)) {
    writeEvidence({ result: "REFUSE", reason: "symbol_not_allow_listed", symbol: SYMBOL });
    process.exit(2);
  }

  let productId = null;
  try { productId = (await resolveProduct(SYMBOL)).id; }
  catch (e) { writeEvidence({ result: "FAIL", reason: "resolve_failed", symbol: SYMBOL, err: (e && e.message) || String(e) }); process.exit(3); }

  // Bounded reduce-only flatten loop.
  let size = null;
  try { size = await netSize(productId); } catch { size = null; }
  if (size === 0) { writeEvidence({ result: "FLAT", symbol: SYMBOL, action: "none", startExposure: 0 }); log("already flat — nothing to do"); process.exit(0); }

  const startExposure = size;
  let closes = 0;
  while (budgetLeft() > 1500) {
    let sz = 0;
    try { sz = await netSize(productId); } catch { sz = null; }
    if (sz === 0) { writeEvidence({ result: "FLATTENED", symbol: SYMBOL, startExposure, closes }); log("proved flat"); process.exit(0); }
    if (sz == null) { await sleep(600); continue; }
    const side = sz > 0 ? "sell" : "buy";
    try { await delta("POST", "/v2/orders", { body: { product_id: productId, size: Math.abs(sz), side, order_type: "market_order", reduce_only: true } }); closes++; }
    catch { /* retry within budget */ }
    await sleep(600);
  }

  // Budget exhausted without proving flat → PAGE (non-zero). Never claim flat we couldn't verify.
  let finalSz = null; try { finalSz = await netSize(productId); } catch { /* unknown */ }
  if (finalSz === 0) { writeEvidence({ result: "FLATTENED", symbol: SYMBOL, startExposure, closes }); process.exit(0); }
  writeEvidence({ result: "PAGE", reason: "could_not_prove_flat", symbol: SYMBOL, startExposure, residual: finalSz == null ? "unknown" : finalSz, closes });
  log("COULD NOT PROVE FLAT — paging for manual intervention");
  process.exit(4);
})().catch((e) => { writeEvidence({ result: "ERROR", err: (e && e.message) || String(e) }); process.exit(5); });
