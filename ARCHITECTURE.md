# MatrixOne backend — architecture & decomposition map (REC-8)

`server.js` is the composition root: it wires HTTP routes, broker adapters, the auto-buy/auto-exit engines and
the background workers. It is large (~10k lines) by design as the wiring layer, but the **decision logic it
depends on is extracted into small, pure, unit-tested modules**. This document is the living map of that
decomposition and the principle behind it, so the split can continue incrementally without a risky big-bang
rewrite.

## The principle

Anything that is a *decision* — a calculation, a policy, a state transition, a classification — is pulled out
of `server.js` into a **pure module** (no I/O, no clock unless injected, deterministic) and covered by a
`test/*.test.cjs` suite. `server.js` keeps only *orchestration*: reading the DB, calling brokers, and handing
the pure module its inputs. This is what makes the money path auditable — every rule that matters is a function
you can read and a test you can run, not a branch buried in a request handler.

Current state: **37 extracted modules, 75 test suites.**

## Module map by domain

**Order lifecycle & fill truth**
`fillContract.js` (normalized broker fill states) · `orderIntegrity.js` · `orderRecovery.js` (broker-keyed
crash recovery adapters) · `orderDeadline.js` (fill-or-cancel) · `orderTypes.js` (per-broker order-type matrix)
· `reconcile.js` · `feeReconcile.js` / `feeStatement.js` (authoritative fee overlay).

**Risk & safety**
`riskPolicy.js` (strictest-wins per-order caps + `effectiveRiskPolicy`) · `riskEngine.js` (platform ceilings) ·
`portfolioRisk.js` (REC-1, account-wide concentration / aggregate stop-risk) · `signalGuards.js` (stale-signal
+ duplicate-symbol) · `marketDataGovernance.js` (REC-3, provenance + staleness fail-closed).

**Broker capability & certification**
`brokerCapabilities.js` (server-owned matrix + REC-4 per-SHA content digest) · `proxyRouting.js` (per-user
static-IP routing).

**Strategy & scoring**
`strategyEngine.js` · `strategyStates.js` · `optimizerCore.js` · `patterns.js` · `smartScore.js` (REC-2,
transparent 4-factor pick scoring).

**Accounts, auth & governance**
`auth.js` · `pinLock.js` · `otp.js` · `adminRoles.js` (RBAC) · `suitability.js` (REC-5, onboarding knowledge
check) · `incidents.js` (REC-7, support ticket + incident lifecycle/SLA).

**Analytics & ops**
`tradingAnalytics.js` (REC-6, trustworthy trade stats) · `driftMetrics.js` (FIN-2 slippage/drift) ·
`drReconstruct.js` (OPS-2 DR rebuild from the ledger) · `corporateActions.js` · `alertSeverity.js`.

**Time & instruments**
`marketHours.js` · `mcxContract.js` · `migrations.js` · `db.js` (the persistence boundary — PG with a
flat-file fallback, so every store has one interface).

## Seams still inside `server.js` (next extraction targets, in priority order)

1. **Broker order executors** — the per-broker `place / verifyFill / squareOff` branches. Extract each into a
   `brokers/<name>.js` adapter behind one interface (the recovery registry already points this way). Highest
   value, highest care (money path) — do one broker at a time with the hermetic route harness.
2. **Auto-buy / auto-exit engine loops** — the entry/exit evaluation bodies. Extract the pure "should this
   fire now?" decision from the "place it" side effect.
3. **Quote assembly & precision** — the per-market quote-shaping + adaptive tiny-value precision helpers.
4. **Notice/notification fan-out** — `notifyPush` + `addUserNotice` severity stamping into a `notifier.js`.

Each is done the same way: pull the decision into a pure module + tests, leave the I/O in `server.js`, verify
`node --check` + the suite stays green, ship. No rewrite, no flag day.
