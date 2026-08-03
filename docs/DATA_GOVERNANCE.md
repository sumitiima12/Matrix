# MatrixOne — Data Retention & Governance

Scope: how MatrixOne stores, retains, anonymizes, exposes and purges trading and account data. This document
is the reference for the retention behaviour the code enforces and the audit questions a review will ask.

## 1. Data categories

| Store | Table / file | Purpose | Contains personal data? |
|---|---|---|---|
| Users | `users` | Login identity, approval, PIN hash, recovery Q/A hash | Yes (phone, name, email, hashes) |
| Trades (projection) | `trades` | Display/history of trades (paper + real) | Yes (trading activity) |
| Fills (immutable ledger) | `fills` | Append-only VERIFIED broker executions — the audit source | Yes (trading activity) |
| Idempotency | `order_idempotency` | Duplicate-order protection + replay identity | Pseudonymous (keys, hashes) |
| Order intents | `order_intents` | Candle-idempotent entry claims | Pseudonymous |
| Pending protection | `pending_protection` | Delayed-fill reconciliation jobs | Pseudonymous |
| Managed positions | `managed_positions` | Live real positions + exit state | Yes (positions) |
| Broker creds | `broker_creds` | Encrypted per-user broker API keys/tokens | Yes (secrets, encrypted) |
| Notices | `user_notices` | In-app user notices | Yes |
| Risk policy / automation | `risk_policy`, `automation_flags`, `real_strategies` | User risk caps + armed automation | Yes |

## 2. Retention & purge behaviour (enforced in `db.deleteAccount` / `purgeLedgersForUser`)

Two deletion modes:

- **Account deletion, retained history (`preserveTrades: true`, the default).** The product retains trade history
  as a financial/audit record under a soft-deleted, de-identified user stub (login disabled, token revoked). The
  **fills ledger is retained alongside the trades** (`purgeLedgersForUser(uid, { preserveFills: true })`) — the
  projection must never be kept without its immutable audit evidence (R24-P2-04). Credentials, config, strategies,
  positions, order intents, pending-protection rows and notices are erased.
- **Full erasure (`preserveTrades: false`).** Trades AND fills AND all pseudonymous ledgers AND notices are
  deleted; the user row is removed. This is the right-to-erasure path.

Deletion **fails loud**: `deleteAccount` collects the stores it could not clear and THROWS with the list rather
than reporting a partial deletion as success.

**Recycled phone numbers.** When a number is reused, the previous owner's trades AND fills are moved to a
deterministic archive key inside ONE transaction (`reassignAndArchiveTrades`); a failure to move the fills rolls
back the whole handoff (R25-P2-05), so a new owner can never inherit the prior person's executions.

## 3. Idempotency ledger — archive policy (M04)

The idempotency ledger is **never auto-deleted**: purging a terminal key could turn a lost-response success into a
duplicate real order (R24-P1-02). Consequences and policy:

- **`unknown` rows** (ambiguous outcome) are retained until resolved. Resolution: a same-key retry probes the
  broker order book (`brokerOrderProbe`) and finalizes the row `succeeded`/`rejected`; a rising `unknown` count is
  the operational **resolution queue** signal. These must be worked down by operators/broker reconciliation.
- **`succeeded` rows** are retained for replay/uniqueness. **Archive policy:** succeeded rows older than the
  archive window (default 90 days, configurable) are candidates for a compact `order_idempotency_archive` table
  that is STILL consulted on claim for replay/uniqueness — identity is preserved, only the hot table is bounded.
  Until the archive table ships, retention is unbounded-by-design and **monitored**: `idempotencyStats()` logs
  `idempotency.stats` (total / unknown / succeeded / in_flight) every 30 min so growth is observable.

## 4. Access

- All trade/fill/idempotency reads are scoped to the authenticated user's storage key (`storageKeyFor`); a
  client-chosen id can never address another user's row (user-namespaced ids + ownership-safe upsert).
- Admin console can view/clear trade history per type; deletion of another user's data requires admin identity.

## 5. Verifiable purge

- Flat-file and Postgres purge paths are covered by tests: `test/archLedger.test.cjs` (fills erasure/preserve),
  `test/pgIntegration.test.cjs` (PG deletion retention, fill migration) — run in CI with `DATABASE_URL`.

## 6. P&L labelling (M06)

Displayed and backtested P&L are **estimates**: they do not yet uniformly include brokerage, taxes, spread,
slippage, funding/FX and corporate actions. P&L figures shown to users are labelled *estimated*. Automated risk
decisions do **not** use displayed P&L — risk is derived server-side from verified executions (the immutable
fills ledger; `deriveRiskFromFills`, currently in shadow-compare against the `trades` projection before it
becomes the sole source).

## 7. Open items (tracked)

- Compact idempotency archive table (this doc, §3) — implement when growth warrants.
- Full cost-model P&L (M06) — brokerage/taxes/slippage/funding.
- Broker-normalized intent status + adapter certification (H09/H11) — gated behind FYERS/Delta sandbox journeys.
- Distributed throttle / shared safety-state across replicas (M05) — required before multi-instance scale-out.
