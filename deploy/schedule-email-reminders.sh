#!/usr/bin/env bash
# Schedules the first live reminder run without restarting the API. Deploy the
# matching code afterward; its start-date lock prevents an early send.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF="$SCRIPT_DIR/deploy.conf"

[ -f "$CONF" ] || { echo "Missing deploy/deploy.conf" >&2; exit 1; }

# shellcheck disable=SC1090
. "$CONF"

SPCL_SSH_PORT="${SPCL_SSH_PORT:-9222}"
SPCL_REMOTE_DIR="${SPCL_REMOTE_DIR:-}"
[ -n "${SPCL_SSH:-}" ] || { echo "SPCL_SSH is missing from deploy.conf" >&2; exit 1; }
[ -n "$SPCL_REMOTE_DIR" ] || { echo "SPCL_REMOTE_DIR is missing from deploy.conf" >&2; exit 1; }

START_DATE="${1:-2026-08-27}"
START_HOUR="${2:-7}"
START_MINUTE="${3:-30}"

[[ "$START_DATE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] \
  || { echo "Start date must use YYYY-MM-DD." >&2; exit 1; }
[[ "$START_HOUR" =~ ^([0-9]|1[0-9]|2[0-3])$ ]] \
  || { echo "Hour must be 0 through 23." >&2; exit 1; }
[[ "$START_MINUTE" =~ ^([0-9]|[1-5][0-9])$ ]] \
  || { echo "Minute must be 0 through 59." >&2; exit 1; }

echo "Scheduling email reminders for $START_DATE at $(printf '%02d:%02d' "$START_HOUR" "$START_MINUTE") Jamaica time."
echo "Enter the NAS password when SSH asks for it."

{
  printf 'EMAIL_REMINDERS_ENABLED=true\n'
  printf 'EMAIL_REMINDERS_START_DATE=%s\n' "$START_DATE"
  printf 'EMAIL_REMINDERS_HOUR=%s\n' "$START_HOUR"
  printf 'EMAIL_REMINDERS_MINUTE=%s\n' "$START_MINUTE"
  printf 'EMAIL_REMINDERS_BATCH_SIZE=20\n'
  printf 'EMAIL_REMINDERS_DAILY_LIMIT=1500\n'
  printf 'EMAIL_REMINDERS_MAX_ATTEMPTS=3\n'
} | ssh -p "$SPCL_SSH_PORT" "$SPCL_SSH" \
  "cd '$SPCL_REMOTE_DIR' &&
   test -f .env.production &&
   cp -p .env.production .env.production.before-email-reminder-schedule &&
   awk '!/^EMAIL_REMINDERS_[A-Z0-9_]*=/' .env.production > .env.production.tmp &&
   printf '\n# Scheduled customer email reminders\n' >> .env.production.tmp &&
   cat >> .env.production.tmp &&
   chmod 600 .env.production.tmp &&
   mv .env.production.tmp .env.production"

echo "Reminder schedule installed on the NAS."
echo "It will take effect when the updated application is deployed."
