-- ============================================================================
-- STOR: Promote hot JSONB fields on `trades` to typed, indexed columns.
-- Optimization plan §3 "Normalize hot JSONB fields" + §7 Phase-2.
--
-- SAFETY MODEL (read before running):
--   * This migration is ADDITIVE and REVERSIBLE. It never drops or rewrites the
--     authoritative `data` JSONB — the typed columns are a DERIVED projection.
--   * `data` REMAINS the single source of truth. The app is NOT changed by this
--     file. Adopting the columns for reads/writes is a SEPARATE, flag-gated,
--     dual-read step (see docs/jsonb-promotion-plan.md) so there is never a
--     second source of financial truth mid-migration.
--   * Every statement is idempotent (IF NOT EXISTS / guarded) so it can be
--     re-run safely, and indexes are built CONCURRENTLY to avoid locking writes.
--
-- RUN IN A MAINTENANCE WINDOW. CONCURRENTLY index builds cannot run inside a
-- transaction block — run this file statement-by-statement (psql \i is fine),
-- NOT wrapped in BEGIN/COMMIT.
-- ============================================================================

-- 1) Typed columns (nullable, derived). No default, no NOT NULL — backfill fills them.
ALTER TABLE trades ADD COLUMN IF NOT EXISTS exit_at     BIGINT;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS entry_at    BIGINT;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS is_real     BOOLEAN;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS symbol      TEXT;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS side        TEXT;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS strategy_id TEXT;

-- 2) Backfill from JSONB with SAFE casts. Numeric fields are regex-guarded so a
--    malformed value can never abort the batch (it just stays NULL, and the row's
--    JSONB is still authoritative). Run in bounded batches on very large tables;
--    the single UPDATE below is fine for small/medium tables.
UPDATE trades SET
  exit_at     = CASE WHEN (data->>'exitAt')  ~ '^-?[0-9]+$' THEN (data->>'exitAt')::bigint  ELSE exit_at  END,
  entry_at    = CASE WHEN (data->>'entryAt') ~ '^-?[0-9]+$' THEN (data->>'entryAt')::bigint ELSE entry_at END,
  is_real     = CASE WHEN lower(data->>'real') IN ('true','false') THEN (data->>'real')::boolean ELSE is_real END,
  symbol      = COALESCE(data->>'sym', data->>'symbol', symbol),
  side        = COALESCE(data->>'side', side),
  strategy_id = COALESCE(data->>'strategyId', strategy_id)
WHERE data IS NOT NULL;

-- 3) Indexes for the hot access patterns, built CONCURRENTLY (no write lock).
--    Partial index on OPEN rows mirrors the exit-monitor's predicate (open + real).
CREATE INDEX CONCURRENTLY IF NOT EXISTS trades_open_real
  ON trades (entry_at DESC) WHERE exit_at IS NULL AND is_real = true;
CREATE INDEX CONCURRENTLY IF NOT EXISTS trades_user_symbol
  ON trades (user_id, symbol);
CREATE INDEX CONCURRENTLY IF NOT EXISTS trades_strategy
  ON trades (strategy_id) WHERE strategy_id IS NOT NULL;

-- 4) Verification query — every row's typed columns must agree with its JSONB.
--    Expect ZERO rows. Run after backfill; investigate any drift before the app
--    is switched to read the typed columns.
--   SELECT id FROM trades
--   WHERE ( (data->>'exitAt') ~ '^-?[0-9]+$' AND exit_at IS DISTINCT FROM (data->>'exitAt')::bigint )
--      OR ( COALESCE(data->>'sym', data->>'symbol') IS DISTINCT FROM symbol )
--   LIMIT 50;

-- ============================================================================
-- ROLLBACK (safe — drops only the derived columns/indexes; JSONB untouched):
--   DROP INDEX CONCURRENTLY IF EXISTS trades_open_real;
--   DROP INDEX CONCURRENTLY IF EXISTS trades_user_symbol;
--   DROP INDEX CONCURRENTLY IF EXISTS trades_strategy;
--   ALTER TABLE trades DROP COLUMN IF EXISTS exit_at, DROP COLUMN IF EXISTS entry_at,
--     DROP COLUMN IF EXISTS is_real, DROP COLUMN IF EXISTS symbol,
--     DROP COLUMN IF EXISTS side, DROP COLUMN IF EXISTS strategy_id;
-- ============================================================================
