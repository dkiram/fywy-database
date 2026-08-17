#!/bin/sh
#
# Proves a backup can actually be restored. A backup nobody has restored is a
# guess, not a backup - run this after the first deployment and then monthly.
#
#   docker exec -it spcl-backup sh /opt/spcl-deploy/restore-verify.sh
#
# Restores into a scratch database, prints row counts for the tables that
# matter, then drops the scratch database. The live database is never touched.

set -eu

BACKUP_ROOT="${BACKUP_ROOT:-/backups}"
DAILY_DIR="$BACKUP_ROOT/daily"
SCRATCH_DB="${SCRATCH_DB:-spcl_restore_check}"

DUMP="${1:-}"

if [ -z "$DUMP" ]; then
  DUMP="$(ls -1t "$DAILY_DIR"/spcl-*.dump 2>/dev/null | head -n 1 || true)"
fi

if [ -z "$DUMP" ] || [ ! -f "$DUMP" ]; then
  echo "No backup file found in $DAILY_DIR"
  exit 1
fi

echo "Verifying: $DUMP"
echo

# Checksum first, so a corrupted file is caught before wasting a restore.
CHECKSUM_FILE="$DUMP.sha256"

if [ -f "$CHECKSUM_FILE" ]; then
  if ( cd "$DAILY_DIR" && sha256sum -c "$(basename "$CHECKSUM_FILE")" >/dev/null 2>&1 ); then
    echo "Checksum OK"
  else
    echo "CHECKSUM MISMATCH - this file is corrupted, do not rely on it"
    exit 1
  fi
else
  echo "No checksum file alongside this dump, continuing without that check"
fi

echo "Creating scratch database $SCRATCH_DB"
dropdb --if-exists "$SCRATCH_DB"
createdb "$SCRATCH_DB"

echo "Restoring..."

# A few benign errors are normal when restoring into a fresh database
# (ownership, extensions). Real breakage shows up in the counts below.
pg_restore --dbname="$SCRATCH_DB" --no-owner --no-privileges "$DUMP" \
  || echo "pg_restore reported non-fatal messages, checking the data anyway"

echo
echo "Row counts in the restored copy:"
echo

psql --dbname="$SCRATCH_DB" --tuples-only --no-align --command "
  SELECT
    table_name || ': ' ||
    (xpath(
      '/row/c/text()',
      query_to_xml(
        format('SELECT count(*) AS c FROM %I.%I', table_schema, table_name),
        false, true, ''
      )
    ))[1]::text
  FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_type = 'BASE TABLE'
  ORDER BY table_name;
"

echo
echo "Dropping scratch database"
dropdb --if-exists "$SCRATCH_DB"

echo
echo "Restore verification finished. Compare the counts above with the live"
echo "database before trusting this backup."
