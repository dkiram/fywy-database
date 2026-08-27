#!/usr/bin/env bash
# Copies only the protected REMINDER_GMAIL_* values to the NAS environment.
# Values are piped over SSH and are never printed or committed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONF="$SCRIPT_DIR/deploy.conf"
LOCAL_ENV="$REPO_ROOT/server/.env.gmail.reminders"

[ -f "$CONF" ] || { echo "Missing deploy/deploy.conf" >&2; exit 1; }
[ -f "$LOCAL_ENV" ] || { echo "Missing server/.env.gmail.reminders" >&2; exit 1; }

# shellcheck disable=SC1090
. "$CONF"

SPCL_SSH_PORT="${SPCL_SSH_PORT:-9222}"
SPCL_REMOTE_DIR="${SPCL_REMOTE_DIR:-}"
[ -n "${SPCL_SSH:-}" ] || { echo "SPCL_SSH is missing from deploy.conf" >&2; exit 1; }
[ -n "$SPCL_REMOTE_DIR" ] || { echo "SPCL_REMOTE_DIR is missing from deploy.conf" >&2; exit 1; }

expected_keys=(
  REMINDER_GMAIL_CLIENT_ID
  REMINDER_GMAIL_CLIENT_SECRET
  REMINDER_GMAIL_REFRESH_TOKEN
  REMINDER_GMAIL_SENDER_ADDRESS
  REMINDER_GMAIL_SENDER_NAME
)

for key in "${expected_keys[@]}"; do
  if ! grep -q "^${key}=." "$LOCAL_ENV"; then
    echo "$key is missing or empty in server/.env.gmail.reminders" >&2
    exit 1
  fi
done

echo "Copying the reminder mailbox settings to the NAS."
echo "Enter the NAS password when SSH asks for it."

awk '/^REMINDER_GMAIL_[A-Z0-9_]*=/' "$LOCAL_ENV" |
ssh -p "$SPCL_SSH_PORT" "$SPCL_SSH" \
  "cd '$SPCL_REMOTE_DIR' &&
   test -f .env.production &&
   cp -p .env.production .env.production.before-reminder-gmail &&
   awk '!/^REMINDER_GMAIL_[A-Z0-9_]*=/' .env.production > .env.production.tmp &&
   printf '\n# Separate Gmail reminder sender\n' >> .env.production.tmp &&
   cat >> .env.production.tmp &&
   chmod 600 .env.production.tmp &&
   mv .env.production.tmp .env.production"

echo "Reminder Gmail settings installed on the NAS."
echo "A backup is at .env.production.before-reminder-gmail"
