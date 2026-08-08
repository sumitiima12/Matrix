# JSONB → typed-column promotion — staging & rollback plan

**Status:** migration SQL ready (`migrations/2026-08_trades_jsonb_typed_columns.sql`); adoption is gated and staged. Pick a window to run.

## Why this is staged, not "just run"

The `trades.data` JSONB is authoritative financial history. Promoting hot fields (`exitAt`, `entryAt`, `real`, `symbol`, `side`, `strategyId`) to typed columns is worth it for index efficiency and cleaner queries, but doing it carelessly risks creating a **second source of truth** that can drift from the JSONB. So the JSONB stays authoritative throughout, and the typed columns are a derived projection adopted only after a dual-read window proves they agree.

## Phases

**Phase A — migrate (this file).** Run `migrations/2026-08_trades_jsonb_typed_columns.sql` in a maintenance window (indexes build `CONCURRENTLY`, so run statement-by-statement, not inside a transaction). It adds nullable typed columns, backfills them from JSONB with regex-guarded safe casts, and builds partial indexes. The app is unchanged; nothing reads the new columns yet. Fully reversible via the ROLLBACK block.

**Phase B — dual-write (small code change, flag-gated).** Behind `TRADES_TYPED_WRITE=1`, have `saveTrade`/`updateTrade`/`recordExitAtomic` also write the typed columns alongside the JSONB in the same statement. JSONB is still the source of truth; the columns are kept in sync going forward. Deploy and let it bake.

**Phase C — dual-read verify (log-only).** Behind `TRADES_TYPED_SHADOW=1`, a periodic job compares typed columns vs JSONB projection (the verification query in the SQL) and logs any drift via `logFinancial`. Mirrors the existing risk-from-fills shadow (H03/H04). Run until drift is consistently zero across a full trading cycle.

**Phase D — switch reads.** Only after Phase C shows zero drift, flip hot read/filter queries (open-trade sweep, per-symbol, per-strategy) to the typed columns behind `TRADES_TYPED_READ=1`. JSONB remains the durable record and the rollback path.

## Rollback

At any phase: turn off the flag (B/C/D) — the app reverts to JSONB reads/writes instantly. To remove the schema, run the ROLLBACK block in the SQL file; it drops only the derived columns/indexes and never touches `data`.

## Acceptance (from the optimization plan)

- Backfill verification query returns zero drift rows.
- No endpoint regresses; order/fill/protection/recovery suites stay green.
- `EXPLAIN (ANALYZE, BUFFERS)` on the open-trade sweep shows the new partial index in use on production-shaped data before Phase D.
