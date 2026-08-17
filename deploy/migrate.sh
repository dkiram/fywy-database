#!/bin/sh
#
# Applies pending SQL migrations to the database, once each, in filename order.
#
# Runs inside the spcl-backup container, which already has psql and the PG*
# credentials, and can reach the private postgres container:
#
#   docker exec -it spcl-backup sh /opt/spcl-deploy/migrate.sh --status
#   docker exec -it spcl-backup sh /opt/spcl-deploy/migrate.sh --dry-run
#   docker exec -it spcl-backup sh /opt/spcl-deploy/migrate.sh
#
# Which migrations have run is recorded in public.schema_migrations. Each file
# is applied inside a single transaction together with its own bookkeeping row,
# so a migration that fails leaves neither a half-applied schema nor a false
# record that it succeeded.
#
# On a database that already has all 32 migrations applied by hand, run
# --baseline ONCE. That records every current file as applied without
# executing any of it. Skipping this step on an existing database would
# re-run migration 001 against live data.

set -eu

MIGRATIONS_DIR="${MIGRATIONS_DIR:-/opt/spcl-database/migrations}"
MODE="apply"

for arg in "$@"; do
  case "$arg" in
    --dry-run)  MODE="dry-run" ;;
    --baseline) MODE="baseline" ;;
    --status)   MODE="status" ;;
    -h|--help)
      sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      echo "Use --status, --dry-run, --baseline, or no option to apply." >&2
      exit 2
      ;;
  esac
done

log() {
  echo "$(date '+%Y-%m-%d %H:%M:%S') [migrate] $*"
}

fail() {
  log "FAILED: $*"
  exit 1
}

[ -d "$MIGRATIONS_DIR" ] || fail "no migrations directory at $MIGRATIONS_DIR (is ./database mounted into this container?)"

psql -v ON_ERROR_STOP=1 -q -c "
CREATE TABLE IF NOT EXISTS public.schema_migrations (
    filename    TEXT PRIMARY KEY,
    checksum    TEXT NOT NULL,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
" || fail "could not reach the database"

is_applied() {
  psql -tAc "SELECT 1 FROM public.schema_migrations WHERE filename = '$1';" | grep -q 1
}

recorded_checksum() {
  psql -tAc "SELECT checksum FROM public.schema_migrations WHERE filename = '$1';"
}

# Zero-padded numeric prefixes mean plain lexical order is also numeric order.
FILES="$(ls -1 "$MIGRATIONS_DIR" | grep '^[0-9][0-9][0-9]_.*\.sql$' | sort)"

[ -n "$FILES" ] || fail "no migration files found in $MIGRATIONS_DIR"

# A file edited after it was applied is a silent source of drift between this
# database and any other. Report it rather than quietly ignoring it.
DRIFT=""

for name in $FILES; do
  if is_applied "$name"; then
    NOW="$(sha256sum "$MIGRATIONS_DIR/$name" | cut -d' ' -f1)"
    THEN="$(recorded_checksum "$name")"

    if [ "$NOW" != "$THEN" ]; then
      DRIFT="$DRIFT $name"
    fi
  fi
done

if [ -n "$DRIFT" ]; then
  log "WARNING: these files changed after they were applied:"

  for name in $DRIFT; do
    log "  $name"
  done

  log "The database does not match what is now in the file. Write a new"
  log "migration for the difference rather than editing an applied one."
fi

PENDING=""

for name in $FILES; do
  is_applied "$name" || PENDING="$PENDING $name"
done

case "$MODE" in
  status)
    APPLIED_COUNT="$(psql -tAc 'SELECT count(*) FROM public.schema_migrations;')"
    TOTAL_COUNT="$(echo "$FILES" | wc -l | tr -d ' ')"

    log "$APPLIED_COUNT of $TOTAL_COUNT migrations applied"

    if [ -n "$PENDING" ]; then
      log "pending:"
      for name in $PENDING; do log "  $name"; done
    else
      log "nothing pending"
    fi

    psql -c "
      SELECT filename, applied_at
      FROM public.schema_migrations
      ORDER BY filename DESC
      LIMIT 5;
    "
    exit 0
    ;;

  baseline)
    if [ -z "$PENDING" ]; then
      log "already baselined - every migration file is recorded"
      exit 0
    fi

    log "recording these as already applied, WITHOUT running them:"

    for name in $PENDING; do
      SUM="$(sha256sum "$MIGRATIONS_DIR/$name" | cut -d' ' -f1)"

      psql -v ON_ERROR_STOP=1 -q -c "
        INSERT INTO public.schema_migrations (filename, checksum)
        VALUES ('$name', '$SUM')
        ON CONFLICT (filename) DO NOTHING;
      "

      log "  $name"
    done

    log "baseline complete - future runs will only apply new files"
    exit 0
    ;;

  dry-run)
    if [ -z "$PENDING" ]; then
      log "nothing to apply"
    else
      log "would apply, in this order:"
      for name in $PENDING; do log "  $name"; done
    fi
    exit 0
    ;;
esac

if [ -z "$PENDING" ]; then
  log "nothing to apply - database is up to date"
  exit 0
fi

# Refuse to run a full first-time migration set against a database that already
# has real tables in it. That combination almost always means --baseline was
# forgotten, and 001 onwards would be re-run over live data.
APPLIED_COUNT="$(psql -tAc 'SELECT count(*) FROM public.schema_migrations;')"

HAS_DATA="$(psql -tAc "
  SELECT count(*)
  FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_name IN ('customers', 'payments', 'employees', 'applications');
")"

if [ "$APPLIED_COUNT" = "0" ] && [ "$HAS_DATA" != "0" ]; then
  fail "this database already has application tables but no migration records.
       Run --baseline first to record the existing migrations as applied."
fi

# A fresh restore point immediately before any schema change, so rollback is
# never worse than losing the minutes since the deploy started. Set
# SKIP_BACKUP=true only when a backup was already taken by hand.
if [ "${SKIP_BACKUP:-false}" != "true" ]; then
  log "taking a safety backup before applying anything"

  if sh "$(dirname "$0")/backup.sh" >/dev/null 2>&1; then
    log "  safety backup written"
  else
    fail "the safety backup did not succeed, so nothing was applied.
       Fix the backup first: docker exec -it spcl-backup sh /opt/spcl-deploy/backup-check.sh"
  fi
fi

for name in $PENDING; do
  FILE="$MIGRATIONS_DIR/$name"
  SUM="$(sha256sum "$FILE" | cut -d' ' -f1)"

  log "applying $name"

  # The migration and its bookkeeping row go in as one transaction: -1 wraps
  # the whole stream, ON_ERROR_STOP aborts it on the first error.
  if ! {
        cat "$FILE"
        printf "\nINSERT INTO public.schema_migrations (filename, checksum) VALUES ('%s', '%s');\n" "$name" "$SUM"
      } | psql -v ON_ERROR_STOP=1 -1 -q
  then
    fail "$name did not apply - the database was rolled back to before it started"
  fi

  log "  applied $name"
done

log "done"
