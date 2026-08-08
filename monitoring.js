/**
 * monitoring.js — MU-2: monitoring / alerting / on-call plumbing (pure evaluation core).
 *
 * The server already EMITS observability metrics; what was missing is a single place that turns a health
 * SNAPSHOT into a verdict — which conditions are fine, which are degraded, and which are PAGE-WORTHY (wake
 * someone up) — plus a deterministic de-dup key + cooldown so a flapping condition doesn't spam the on-call.
 * Kept pure so the escalation rules are unit-tested; the server assembles the snapshot and does the dispatch.
 *
 * A snapshot is a flat object; every field is optional and missing/unknown is treated conservatively (a check
 * it can't evaluate does NOT fabricate "healthy"). Fields consumed:
 *   { schemaReady, dbOk, liveHalted, unresolvedAttempts, unknownOrders, pendingProtection,
 *     lastEngineTickMs, nowMs, pushEnabled, errorRate5m, mdgovShadowBlocks5m }
 */

// Each check: id, a predicate over the snapshot returning {ok, severity, message}. severity ∈ page|warn|info.
const CHECKS = [
  {
    id: "schema_ready",
    run: (s) => s.schemaReady === false
      ? { ok: false, severity: "page", message: "DB schema not ready — money-moving routes are refusing (fail-closed)." }
      : { ok: true, severity: "info", message: "Schema ready." },
  },
  {
    id: "db_reachable",
    run: (s) => s.dbOk === false
      ? { ok: false, severity: "page", message: "Database is unreachable." }
      : { ok: true, severity: "info", message: "Database reachable." },
  },
  {
    id: "live_halt",
    run: (s) => s.liveHalted === true
      ? { ok: false, severity: "page", message: "Live trading is HALTED (safety lock engaged) — real orders are blocked." }
      : { ok: true, severity: "info", message: "Live trading not halted." },
  },
  {
    id: "unresolved_order_attempts",
    run: (s) => {
      const n = Number(s.unresolvedAttempts) || 0;
      if (n >= 5) return { ok: false, severity: "page", message: `${n} unresolved order attempts — real exposure may be un-reconciled.` };
      if (n >= 1) return { ok: false, severity: "warn", message: `${n} unresolved order attempt(s) awaiting reconciliation.` };
      return { ok: true, severity: "info", message: "No unresolved order attempts." };
    },
  },
  {
    id: "unknown_orders",
    run: (s) => {
      const n = Number(s.unknownOrders) || 0;
      if (n >= 1) return { ok: false, severity: "warn", message: `${n} order(s) with unknown outcome — accounts entry-blocked until resolved.` };
      return { ok: true, severity: "info", message: "No unknown-outcome orders." };
    },
  },
  {
    id: "engine_heartbeat",
    run: (s) => {
      const now = Number(s.nowMs) > 0 ? Number(s.nowMs) : Date.now();
      const last = Number(s.lastEngineTickMs);
      if (!(last > 0)) return { ok: false, severity: "warn", message: "No engine heartbeat recorded yet." };
      const ageMs = now - last;
      if (ageMs > 5 * 60_000) return { ok: false, severity: "page", message: `Auto-buy/exit engine last ticked ${Math.round(ageMs / 60_000)} min ago — automation may be stalled.` };
      return { ok: true, severity: "info", message: "Engine heartbeat healthy." };
    },
  },
  {
    id: "error_rate",
    run: (s) => {
      const r = Number(s.errorRate5m);
      if (Number.isFinite(r) && r >= 0.1) return { ok: false, severity: "page", message: `5-min error rate ${(r * 100).toFixed(1)}% (≥10%).` };
      if (Number.isFinite(r) && r >= 0.03) return { ok: false, severity: "warn", message: `5-min error rate ${(r * 100).toFixed(1)}% (≥3%).` };
      return { ok: true, severity: "info", message: "Error rate nominal." };
    },
  },
  {
    id: "market_data_governance",
    run: (s) => {
      const n = Number(s.mdgovShadowBlocks5m) || 0;
      if (n >= 20) return { ok: false, severity: "warn", message: `${n} market-data shadow blocks in 5 min — real marks are often stale/untrusted; investigate the feed before enforcing REC-3.` };
      return { ok: true, severity: "info", message: "Market-data quality nominal." };
    },
  },
];

/**
 * Evaluate a snapshot into an overall health verdict.
 * Returns { status, pageWorthy, failing:[{id,severity,message}], checks:[{id,ok,severity,message}], summary }.
 * status: "critical" if any page-severity check fails, "degraded" if any warn fails, else "healthy".
 */
function evaluateHealth(snapshot = {}) {
  const s = snapshot || {};
  const checks = CHECKS.map((c) => ({ id: c.id, ...c.run(s) }));
  const failing = checks.filter((c) => !c.ok);
  const anyPage = failing.some((c) => c.severity === "page");
  const anyWarn = failing.some((c) => c.severity === "warn");
  const status = anyPage ? "critical" : anyWarn ? "degraded" : "healthy";
  return {
    status, pageWorthy: anyPage,
    failing: failing.map(({ id, severity, message }) => ({ id, severity, message })),
    checks,
    summary: status === "healthy" ? "All checks passing." : `${failing.length} check(s) failing: ${failing.map((f) => f.id).join(", ")}.`,
  };
}

/**
 * On-call de-dup: a stable key for a verdict's failing set, so identical alerts inside a cooldown window are
 * suppressed. `shouldPage(verdict, lastPagedAtByKey, opts)` returns { page, key } — page=true only when it's
 * page-worthy AND (new key OR the cooldown has elapsed). Pure: the caller owns the lastPagedAt map + dispatch.
 */
function pageKey(verdict) {
  return verdict.failing.filter((f) => f.severity === "page").map((f) => f.id).sort().join("|") || "none";
}
function shouldPage(verdict, lastPagedAtByKey = {}, opts = {}) {
  if (!verdict || !verdict.pageWorthy) return { page: false, key: "none" };
  const key = pageKey(verdict);
  const now = Number(opts.nowMs) > 0 ? Number(opts.nowMs) : Date.now();
  const cooldownMs = Number(opts.cooldownMs) > 0 ? Number(opts.cooldownMs) : 15 * 60_000;
  const last = Number(lastPagedAtByKey[key]) || 0;
  return { page: now - last >= cooldownMs, key };
}

module.exports = { CHECKS, evaluateHealth, pageKey, shouldPage };
