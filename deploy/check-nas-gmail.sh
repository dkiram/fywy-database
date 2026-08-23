#!/usr/bin/env bash
#
# Answers one question: why does receipt email fail on the NAS when the same
# credentials send fine from a laptop?
#
#   ./deploy/check-nas-gmail.sh
#
# Read-only. It sends no email, changes no configuration and restarts nothing.
# Secrets are never printed - only whether a value is present and how long it
# is, which is enough to spot a truncated refresh token without exposing it.
#
# Run `npm run check:gmail` in server/ first. That proves the credentials
# themselves work. This proves whether the NAS has those same credentials and
# can reach Google at all.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF="$SCRIPT_DIR/deploy.conf"

if [ ! -f "$CONF" ]; then
  echo "Missing $CONF. Copy deploy.conf.template to deploy.conf first." >&2
  exit 1
fi

# shellcheck disable=SC1090
. "$CONF"

SPCL_SSH_PORT="${SPCL_SSH_PORT:-9222}"
SPCL_REMOTE_DIR="${SPCL_REMOTE_DIR:-/Volume1/SPCL/deployment}"
API_CONTAINER="${API_CONTAINER:-spcl-api}"

# TOS gives non-interactive ssh a minimal PATH, so docker has to be resolved
# explicitly or found through a login shell - the same problem deploy.sh has.
if [ -n "${SPCL_DOCKER:-}" ]; then
  DOCKER="$SPCL_DOCKER"
else
  DOCKER="$(ssh -p "$SPCL_SSH_PORT" "$SPCL_SSH" 'bash -lc "command -v docker"' 2>/dev/null || true)"
  DOCKER="${DOCKER:-/Volume1/@apps/DockerEngine/dockerd/bin/docker}"
fi

run_remote() {
  ssh -p "$SPCL_SSH_PORT" "$SPCL_SSH" "$1"
}

echo
echo "SPCL receipt-email check on the NAS - $(date '+%Y-%m-%d %H:%M:%S')"
echo "Container: $API_CONTAINER   docker: $DOCKER"

echo
echo "=== 1. Is the API container running? ==="
run_remote "$DOCKER ps --filter name=$API_CONTAINER --format '{{.Names}}  {{.Status}}'" || {
  echo "Could not reach the NAS or list containers." >&2
  exit 1
}

echo
echo "=== 2. Do the Gmail values exist INSIDE the running container? ==="
echo "(docker-compose defaults each to empty, so a missing .env.production key"
echo " becomes an empty string rather than an error.)"
# The node program is fed on stdin so no quoting has to survive ssh, the shell
# and docker exec all at once.
run_remote "$DOCKER exec -i $API_CONTAINER node" <<'NODE'
const keys = [
  "GMAIL_CLIENT_ID",
  "GMAIL_CLIENT_SECRET",
  "GMAIL_REFRESH_TOKEN",
  "GMAIL_SENDER_ADDRESS",
  "GMAIL_SENDER_NAME",
];
let missing = 0;
for (const key of keys) {
  const raw = process.env[key];
  const value = (raw ?? "").trim();
  if (!value) {
    missing++;
    console.log(`  ${key.padEnd(22)} MISSING or empty`);
    continue;
  }
  // Length and edges only. Enough to compare against the laptop and to catch a
  // token that got truncated or line-wrapped on the way into .env.production.
  const shape = value.length <= 12
    ? `set (${value.length} chars)`
    : `${value.slice(0, 6)}...${value.slice(-4)} (${value.length} chars)`;
  const untrimmed = raw !== value ? "  [WARNING: has surrounding whitespace]" : "";
  const quoted = /^["'].*["']$/.test(value) ? "  [WARNING: value is wrapped in quotes]" : "";
  console.log(`  ${key.padEnd(22)} ${shape}${untrimmed}${quoted}`);
}
if (missing > 0) {
  console.log(`\n  ${missing} value(s) missing. Add them to .env.production on the NAS and`);
  console.log("  restart the api container. Compare lengths against server/.env.gmail");
  console.log("  on your laptop - they should match exactly.");
}
NODE

echo
echo "=== 3. Can the container actually reach Google? ==="
echo "(This is the difference a laptop test cannot show. A blocked or"
echo " DNS-less container fails with a message that looks like nothing"
echo " in particular, which is why the app just said 'Gmail could not send'.)"
run_remote "$DOCKER exec -i $API_CONTAINER node" <<'NODE'
const hosts = [
  "https://oauth2.googleapis.com/tokeninfo",
  "https://gmail.googleapis.com/",
];

for (const url of hosts) {
  const host = new URL(url).host;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    // "Got an HTTP response" is not quite "reached Google" - a filtering proxy
    // answers too - but the test must not cry wolf either. Google replies to
    // these unauthenticated requests with a JSON error on the token endpoint
    // and a plain HTML 404 at the API root, and both are legitimate. So only a
    // body that actually reads like a block page is treated as interference;
    // completing TLS to the real hostname is otherwise taken as reachable.
    const body = (await response.text()).slice(0, 200).replace(/\s+/g, " ").trim();
    const blocked = /blocked|not in allowlist|access denied|forbidden by|proxy|firewall|captive/i
      .test(body);

    if (blocked) {
      console.log(`  ${host.padEnd(26)} INTERCEPTED (HTTP ${response.status})`);
      console.log(`      Body: ${body || "(empty)"}`);
      console.log("      -> A proxy or filtering appliance is answering instead of Google.");
    } else {
      console.log(`  ${host.padEnd(26)} REACHABLE (HTTP ${response.status})`);
    }
  } catch (error) {
    const cause = error?.cause?.message ? ` (${error.cause.message})` : "";
    console.log(`  ${host.padEnd(26)} FAILED: ${error?.message ?? error}${cause}`);
    if (/ENOTFOUND|EAI_AGAIN/.test(`${error?.message}${cause}`)) {
      console.log("      -> DNS is not resolving inside the container.");
      console.log("         Add a dns: entry to the api service in docker-compose.prod.yml");
      console.log("         (for example 8.8.8.8) and recreate the container.");
    } else if (/ETIMEDOUT|ECONNREFUSED|ECONNRESET|certificate/i.test(`${error?.message}${cause}`)) {
      console.log("      -> Outbound HTTPS to Google is blocked or intercepted.");
      console.log("         Check the NAS firewall and any upstream filtering.");
    }
  }
}
NODE

echo
echo "=== 4. What the API logged about receipt email ==="
run_remote "$DOCKER logs --since 72h $API_CONTAINER 2>&1 | grep -i 'receipt' | tail -25" \
  || echo "  (nothing logged in the last 72h)"

echo
echo "=== 5. The failures recorded in the database ==="
echo "Run this in TablePlus for the real provider error. last_error_detail is"
echo "populated only once migration 052 is applied and the new payments.ts is"
echo "deployed; before that it will be NULL and last_error is the vague one."
cat <<'SQL'

  SELECT receipt_email_delivery_id, payment_id, recipient_email,
         status, attempt_count, last_attempted_at,
         last_error, last_error_detail
    FROM public.receipt_email_deliveries
   ORDER BY receipt_email_delivery_id DESC
   LIMIT 20;

SQL

echo "Done. Nothing was changed."
