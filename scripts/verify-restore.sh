#!/usr/bin/env bash
# MU-7a — verify a RESTORED database is actually usable (a backup you never restore is not a backup).
#
# Point this at a SCRATCH copy restored from backup/PITR — NEVER at production. It checks that the money-critical
# tables exist and carry data, so you know the restore is real before you'd ever need it in an incident.
#
#   RESTORED_DATABASE_URL='postgres://…scratch…' bash scripts/verify-restore.sh
#
# Exit 0 = restore looks usable; non-zero = a required table is missing/empty (investigate the backup).
set -euo pipefail

DB="${RESTORED_DATABASE_URL:-}"
if [[ -z "$DB" ]]; then
  echo "Set RESTORED_DATABASE_URL to the RESTORED (scratch) DB connection string — not production." >&2
  exit 2
fi
if ! command -v psql >/dev/null 2>&1; then
  echo "psql not found. Install the PostgreSQL client (e.g. 'brew install libpq' or 'apt-get install postgresql-client')." >&2
  exit 2
fi

# Safety: refuse an obviously-production-looking URL unless explicitly allowed.
if [[ "$DB" == *"$(printf '%s' "${PROD_DB_HOST:-__none__}")"* && "${ALLOW_PROD:-0}" != "1" ]]; then
  echo "Refusing: URL matches PROD_DB_HOST. This drill must run on a RESTORED scratch copy. Set ALLOW_PROD=1 only if you are certain." >&2
  exit 2
fi

# Money-critical tables that MUST exist for a usable restore.
REQUIRED_TABLES=(users trades fills managed_positions order_attempts broker_connections)
# Of these, the ones that should normally be NON-EMPTY on a live system (a restore with zero fills is suspicious).
NONEMPTY_TABLES=(users trades fills)

fail=0
q() { psql "$DB" -tAc "$1"; }

echo "== Verifying restored database =="
for t in "${REQUIRED_TABLES[@]}"; do
  exists="$(q "SELECT to_regclass('public.$t') IS NOT NULL;")"
  if [[ "$exists" != "t" ]]; then
    echo "  MISSING TABLE: $t" >&2; fail=1; continue
  fi
  count="$(q "SELECT count(*) FROM public.$t;")"
  printf "  %-22s exists, rows=%s\n" "$t" "$count"
  for n in "${NONEMPTY_TABLES[@]}"; do
    if [[ "$t" == "$n" && "$count" -eq 0 ]]; then
      echo "  WARNING: $t is EMPTY — a live restore should have rows here." >&2; fail=1
    fi
  done
done

# Schema-version sanity: the migrations table should exist and record a version.
if [[ "$(q "SELECT to_regclass('public.schema_migrations') IS NOT NULL;" 2>/dev/null || echo f)" == "t" ]]; then
  ver="$(q "SELECT max(version) FROM public.schema_migrations;" 2>/dev/null || echo '?')"
  echo "  schema_migrations max version=$ver"
fi

if [[ "$fail" -eq 0 ]]; then
  echo "== RESTORE OK — required tables present and populated. =="
  exit 0
else
  echo "== RESTORE CHECK FAILED — see warnings above. Do not trust this backup until resolved. ==" >&2
  exit 1
fi
