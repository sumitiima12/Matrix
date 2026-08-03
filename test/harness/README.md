# C03 fault-injection harness

Test-only infrastructure to build and PROVE the C03 durable order-recovery subsystem (write-before-send order
attempt + startup broker-backed reconciliation) before any of that behaviour is enabled in production.

Submitted **separately** from the C03 behaviour change so the harness can be reviewed on its own. Nothing here
is imported by production code — `server.js`/`db.js` never require `test/harness/*`.

## Pieces

| Module | Purpose |
|---|---|
| `clock.cjs` | Deterministic, injectable time (`makeClock`). No wall-clock in time-dependent assertions. |
| `faults.cjs` | Named fault registry (`makeFaults`, `globalFaults`). Arm a boundary to fail N times; code consults `gate(name)`/`tripped(name)` at each persistence & broker-call boundary. |
| `fakeFyers.cjs` | Deterministic FYERS: `placeOrder` → fill/partial/reject/pending/**timeout (accepted, response lost — recoverable by orderTag)**; `getOrders`/`tradeBook`/`positions` for reconciliation. |
| `restart.cjs` | Simulates a process restart: `freshRequire` drops the app module cache (in-memory state + pg pool) while PostgreSQL persists — so freshly-loaded code must recover from PG alone. `requirePgOrSkip` gates restart tests on a real DB. |

## Canonical fault boundaries (the C03 change will call these)

```
db.attempt.prepare         commit the PREPARED order_attempt (write-BEFORE-send)
db.attempt.transition      PREPARED → SUBMITTING/UNKNOWN
db.attempt.finalize        transactional ACCEPTED/PARTIAL/FILLED/REJECTED/UNKNOWN + fills/trade/risk-lock
db.pendingProtection.save  persist pending protection for an accepted order
db.riskLock.set            durable risk-lock write
fyers.place                submit order to FYERS
fyers.orders               read FYERS order book (by orderTag/id)
fyers.tradebook            read FYERS trade/execution book
fyers.positions            read FYERS positions
```

## Mandatory C03 tests this harness enables (implemented WITH the behaviour change, not here)

1. DB failure before submission ⇒ FYERS receives zero orders. (`arm db.attempt.prepare`, assert `fakeFyers._orders.size === 0`)
2. FYERS accepts, response lost, DB fails, restart ⇒ exactly one order; startup finds it by orderTag. (`setNextBehavior("timeout")` + `arm db.attempt.finalize` + `freshRequire`)
3. Crash immediately after acceptance ⇒ startup reconciles by orderTag.
4. Delayed/partial fill ⇒ exact quantities adopted; no duplicate. (`partial` then `settle`)
5. Pending-protection write failure ⇒ account remains locked through restart. (`arm db.pendingProtection.save`)
6. Broker unavailable at restart ⇒ lock remains. (`arm fyers.orders`/`fyers.positions`)
7. Malformed/partial broker response ⇒ lock remains.
8. Broker confirms rejection/absence conclusively ⇒ safe resolution.
9. Broker confirms fill ⇒ immutable fill + trade projection restored **once**.
10. Concurrent startup workers ⇒ one reconciliation owner (advisory lock), no duplicate repair.
11. C02 unlock cannot succeed until FYERS orders, trade book and positions reconcile.

## Enforcement

- `test/ciPgRequired.test.cjs` fails CI when `CI` is set but `DATABASE_URL` is absent — PostgreSQL skips can no
  longer hide missing safety coverage.
- CI (`.github/workflows/ci.yml`) provisions an ephemeral Postgres and runs the full suite against it.
- The C03 subsystem stays **disabled in production** (flag) until every fault-injection test above passes.
