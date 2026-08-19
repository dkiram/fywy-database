#!/bin/sh
#
# Takes one PostgreSQL backup in custom format, verifies it is not empty,
# writes a checksum, promotes a monthly copy on the first of the month, and
# prunes anything past the retention window.
#
# Runs inside the spcl-backup container, where /backups is the NAS folder
# /SPCL/database-backups.

set -eu

BACKUP_ROOT="${BACKUP_ROOT:-/backups}"
DAILY_DIR="$BACKUP_ROOT/daily"
WEEKLY_DIR="$BACKUP_ROOT/weekly"
MONTHLY_DIR="$BACKUP_ROOT/monthly"
GLOBALS_DIR="$BACKUP_ROOT/globals"
LOG_FILE="$BACKUP_ROOT/backup.log"

# Three tiers rather than one long run of dailies. A week of dailies covers
# "undo yesterday", two months of weeklies cover "something went wrong a while
# back and nobody noticed", and a year of monthlies covers the rest. Fewer
# files than 30 dailies, and it reaches further back.
DAILY_RETENTION_DAYS="${DAILY_RETENTION_DAYS:-7}"
WEEKLY_RETENTION_WEEKS="${WEEKLY_RETENTION_WEEKS:-8}"
MONTHLY_RETENTION_MONTHS="${MONTHLY_RETENTION_MONTHS:-12}"

# A real dump of this database is far bigger than this. Anything smaller means
# pg_dump produced a shell of a file and the backup must be treated as failed.
MIN_DUMP_BYTES="${MIN_DUMP_BYTES:-10240}"

mkdir -p "$DAILY_DIR" "$WEEKLY_DIR" "$MONTHLY_DIR" "$GLOBALS_DIR"

log() {
  echo "$(date '+%Y-%m-%d %H:%M:%S') [backup] $*" | tee -a "$LOG_FILE"
}

fail() {
  log "FAILED: $*"
  exit 1
}

STAMP="$(date '+%Y-%m-%d-%H%M%S')"
TARGET="$DAILY_DIR/spcl-$STAMP.dump"

log "starting dump of $PGDATABASE"

# The staging schema holds the raw Access import - scratch data from a
# one-off cutover that never changes again. It was adding roughly six
# megabytes to every single nightly backup for no benefit. The CSVs it was
# loaded from are the real archive. Drop --exclude-schema to put it back.
if ! pg_dump --format=custom --compress=6 --exclude-schema=staging --file="$TARGET.partial"; then
  rm -f "$TARGET.partial"
  fail "pg_dump returned an error"
fi

SIZE="$(wc -c < "$TARGET.partial" | tr -d ' ')"

if [ "$SIZE" -lt "$MIN_DUMP_BYTES" ]; then
  rm -f "$TARGET.partial"
  fail "dump was only $SIZE bytes, which cannot be a real backup"
fi

# Only becomes a real .dump once it is known-good, so a half-written file is
# never mistaken for a usable backup.
mv "$TARGET.partial" "$TARGET"

( cd "$DAILY_DIR" && sha256sum "$(basename "$TARGET")" > "$(basename "$TARGET").sha256" )

log "wrote $(basename "$TARGET") ($SIZE bytes)"

# Roles and permissions live outside the database dump, so capture them too.
# Weekly is enough - they change rarely.
if [ "$(date '+%u')" = "7" ] || [ ! -f "$GLOBALS_DIR/globals-latest.sql" ]; then
  if pg_dumpall --globals-only --file="$GLOBALS_DIR/globals-$STAMP.sql"; then
    cp "$GLOBALS_DIR/globals-$STAMP.sql" "$GLOBALS_DIR/globals-latest.sql"
    log "captured roles and permissions"
  else
    log "WARNING: could not capture roles and permissions"
  fi
fi

# Keep one dump per week, taken on Sunday. Promotion happens before pruning so
# a backup is never deleted as an expired daily before it has been kept as a
# weekly.
if [ "$(date '+%u')" = "7" ]; then
  cp "$TARGET" "$WEEKLY_DIR/spcl-week-$(date '+%Y-%V').dump"
  log "promoted a weekly copy for week $(date '+%Y-%V')"
fi

# Keep one dump per month, taken on the first.
if [ "$(date '+%d')" = "01" ]; then
  cp "$TARGET" "$MONTHLY_DIR/spcl-$(date '+%Y-%m').dump"
  log "promoted a monthly copy for $(date '+%Y-%m')"
fi

# Prune. -mtime is in days; monthly retention is converted to days.
find "$DAILY_DIR" -name 'spcl-*.dump' -mtime "+$DAILY_RETENTION_DAYS" -delete
find "$DAILY_DIR" -name 'spcl-*.dump.sha256' -mtime "+$DAILY_RETENTION_DAYS" -delete
find "$WEEKLY_DIR" -name 'spcl-week-*.dump' -mtime "+$((WEEKLY_RETENTION_WEEKS * 7))" -delete
find "$MONTHLY_DIR" -name 'spcl-*.dump' -mtime "+$((MONTHLY_RETENTION_MONTHS * 31))" -delete
find "$GLOBALS_DIR" -name 'globals-2*.sql' -mtime +90 -delete

TOTAL="$(find "$DAILY_DIR" -name 'spcl-*.dump' | wc -l | tr -d ' ')"
WEEKLIES="$(find "$WEEKLY_DIR" -name 'spcl-week-*.dump' | wc -l | tr -d ' ')"
MONTHLIES="$(find "$MONTHLY_DIR" -name 'spcl-*.dump' | wc -l | tr -d ' ')"
log "done - $TOTAL daily, $WEEKLIES weekly, $MONTHLIES monthly on disk"
