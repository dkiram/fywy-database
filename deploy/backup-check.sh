#!/bin/sh
#
# Answers one question: if the NAS died right now, is there a usable backup?
#
#   docker exec -it spcl-backup sh /opt/spcl-deploy/backup-check.sh
#
# Exits 0 when everything is fine, 1 when something needs attention, so it can
# also be run from a scheduled task without anybody reading the output.
#
# This checks that backups EXIST and are INTACT. It does not prove one restores
# - that is restore-verify.sh, which is worth running monthly.

set -eu

BACKUP_ROOT="${BACKUP_ROOT:-/backups}"
DAILY_DIR="$BACKUP_ROOT/daily"
MONTHLY_DIR="$BACKUP_ROOT/monthly"
GLOBALS_DIR="$BACKUP_ROOT/globals"
LOG_FILE="$BACKUP_ROOT/backup.log"

# A nightly backup at 02:00 should never be older than this. 26 hours leaves
# room for the run itself and a late start without crying wolf.
MAX_AGE_HOURS="${MAX_AGE_HOURS:-26}"
MIN_DUMP_BYTES="${MIN_DUMP_BYTES:-10240}"

PROBLEMS=0

ok()   { echo "  OK       $*"; }
warn() { echo "  WARNING  $*"; PROBLEMS=$((PROBLEMS + 1)); }
bad()  { echo "  PROBLEM  $*"; PROBLEMS=$((PROBLEMS + 1)); }

echo
echo "SPCL backup check - $(date '+%Y-%m-%d %H:%M:%S')"
echo

echo "Backup folder"

if [ ! -d "$DAILY_DIR" ]; then
  bad "$DAILY_DIR does not exist - no backup has ever been taken"
  echo
  echo "The spcl-backup container takes one immediately on first start."
  echo "Check it is running:  docker ps --filter name=spcl-backup"
  exit 1
fi

ok "$BACKUP_ROOT is present and readable"

# The NAS folder being mounted but empty is the failure that looks like success:
# the container writes happily into its own filesystem and nothing lands on the
# drive. A recent dump on disk is the proof that the mount is real.
LATEST="$(ls -1t "$DAILY_DIR"/spcl-*.dump 2>/dev/null | head -n 1 || true)"

if [ -z "$LATEST" ]; then
  bad "no .dump files in $DAILY_DIR"
  echo
  echo "Check the container log:  docker logs --tail 50 spcl-backup"
  exit 1
fi

echo
echo "Most recent backup"
echo "  $(basename "$LATEST")"

NOW="$(date '+%s')"
MTIME="$(date -r "$LATEST" '+%s' 2>/dev/null || stat -c '%Y' "$LATEST")"
AGE_HOURS="$(( (NOW - MTIME) / 3600 ))"

if [ "$AGE_HOURS" -gt "$MAX_AGE_HOURS" ]; then
  bad "it is ${AGE_HOURS}h old - the nightly run has not been working"
else
  ok "${AGE_HOURS}h old"
fi

SIZE="$(wc -c < "$LATEST" | tr -d ' ')"

if [ "$SIZE" -lt "$MIN_DUMP_BYTES" ]; then
  bad "only $SIZE bytes - too small to be a real dump"
else
  ok "$SIZE bytes"
fi

if [ -f "$LATEST.sha256" ]; then
  if ( cd "$DAILY_DIR" && sha256sum -c "$(basename "$LATEST").sha256" >/dev/null 2>&1 ); then
    ok "checksum verifies - the file is not corrupted"
  else
    bad "CHECKSUM MISMATCH - this file is corrupted, do not rely on it"
  fi
else
  warn "no .sha256 alongside it"
fi

echo
echo "Retention"

DAILY_COUNT="$(find "$DAILY_DIR" -name 'spcl-*.dump' 2>/dev/null | wc -l | tr -d ' ')"
MONTHLY_COUNT="$(find "$MONTHLY_DIR" -name 'spcl-*.dump' 2>/dev/null | wc -l | tr -d ' ')"

echo "  $DAILY_COUNT daily, $MONTHLY_COUNT monthly"

if [ "$DAILY_COUNT" -lt 2 ]; then
  warn "only $DAILY_COUNT daily backup - one bad night leaves nothing to fall back to"
else
  ok "more than one restore point"
fi

if [ -f "$GLOBALS_DIR/globals-latest.sql" ]; then
  ok "roles and permissions captured"
else
  warn "no globals-latest.sql - roles would have to be recreated by hand"
fi

echo
echo "Failures since the last good backup"

# The question worth asking is "is the backup broken NOW", not "has it ever
# failed". A failure followed by a successful dump is resolved history, and a
# window of the last N lines keeps reporting it for weeks afterwards - which
# teaches you to scroll past the one time it matters. So: count only the
# failures recorded after the most recent successful dump.
if [ -f "$LOG_FILE" ]; then
  SINCE_GOOD="$(awk '
    /\[backup\] wrote /  { n = 0 }
    /FAILED/             { n = n + 1 }
    END                  { print n + 0 }
  ' "$LOG_FILE")"

  RESOLVED="$(grep -c 'FAILED' "$LOG_FILE" 2>/dev/null || true)"
  RESOLVED="$(( ${RESOLVED:-0} - SINCE_GOOD ))"

  if [ "$SINCE_GOOD" = "0" ]; then
    if [ "$RESOLVED" -gt 0 ]; then
      ok "none - $RESOLVED earlier failure(s), each followed by a good dump"
    else
      ok "none, ever"
    fi
  else
    bad "$SINCE_GOOD failure(s) since the last good dump - see: tail -50 $LOG_FILE"
  fi
else
  warn "no backup.log yet"
fi

echo
echo "Off-NAS copy"
echo "  Not checkable from inside this container. RAID 1 mirrors a deletion to"
echo "  both drives instantly, so the external drive is the real protection."
echo "  Confirm TOS USB Copy has run recently: /SPCL/database-backups -> USB."

echo

if [ "$PROBLEMS" = "0" ]; then
  echo "All checks passed."
  exit 0
fi

echo "$PROBLEMS item(s) need attention."
exit 1
