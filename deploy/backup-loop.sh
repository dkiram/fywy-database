#!/bin/sh
#
# Entrypoint for the spcl-backup container.
#
# Sleeps until BACKUP_HOUR (Jamaica time), takes one backup, then repeats. A
# plain loop is used instead of cron so that failures land in the container log
# where `docker logs spcl-backup` shows them.

set -eu

BACKUP_HOUR="${BACKUP_HOUR:-2}"
BACKUP_ROOT="${BACKUP_ROOT:-/backups}"

mkdir -p "$BACKUP_ROOT"

echo "$(date '+%Y-%m-%d %H:%M:%S') [backup] service started, nightly run at ${BACKUP_HOUR}:00 Jamaica time"

# If the container starts and no backup has ever been taken, take one now so
# there is a restore point before anybody touches the system.
if [ ! -d "$BACKUP_ROOT/daily" ] || [ -z "$(ls -A "$BACKUP_ROOT/daily" 2>/dev/null || true)" ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') [backup] no existing backups found, taking an initial one"
  sh /opt/spcl-deploy/backup.sh || echo "$(date '+%Y-%m-%d %H:%M:%S') [backup] initial backup FAILED"
fi

while true; do
  # awk is used rather than shell arithmetic because "08" and "09" are invalid
  # octal to the shell and would abort the loop at those times of day.
  NOW_SECONDS="$(date '+%H %M %S' | awk '{ print $1 * 3600 + $2 * 60 + $3 }')"

  TARGET_SECONDS="$(( BACKUP_HOUR * 3600 ))"

  WAIT="$(( TARGET_SECONDS - NOW_SECONDS ))"

  if [ "$WAIT" -le 0 ]; then
    WAIT="$(( WAIT + 86400 ))"
  fi

  echo "$(date '+%Y-%m-%d %H:%M:%S') [backup] sleeping ${WAIT}s until the next run"
  sleep "$WAIT"

  sh /opt/spcl-deploy/backup.sh || echo "$(date '+%Y-%m-%d %H:%M:%S') [backup] nightly backup FAILED"
done
