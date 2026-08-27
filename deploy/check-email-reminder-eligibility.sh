#!/usr/bin/env bash
# Read-only diagnostic for the daily five-day payment-reminder filters.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF="$SCRIPT_DIR/deploy.conf"

[ -f "$CONF" ] || { echo "Missing deploy/deploy.conf" >&2; exit 1; }

# shellcheck disable=SC1090
. "$CONF"

SPCL_SSH_PORT="${SPCL_SSH_PORT:-9222}"
SPCL_DOCKER="${SPCL_DOCKER:-/Volume1/@apps/DockerEngine/dockerd/bin/docker}"
API_DB_CONTAINER="${DB_CONTAINER:-spcl-postgres}"

[ -n "${SPCL_SSH:-}" ] || { echo "SPCL_SSH is missing from deploy.conf" >&2; exit 1; }

echo "Checking today's reminder eligibility in Jamaica."
echo "This is read-only and sends no emails."
echo "Enter the NAS password when SSH asks for it."
echo

ssh -p "$SPCL_SSH_PORT" "$SPCL_SSH" \
  "$SPCL_DOCKER exec -i '$API_DB_CONTAINER' sh -c 'psql -X -v ON_ERROR_STOP=1 -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -P pager=off'" <<'SQL'
WITH clock AS (
  SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE AS today
), base AS (
  SELECT c.email, b.oldest_unpaid_due_date, b.grace_end_date,
         b.is_on_hold, b.unverified_entries
  FROM public.customer_billing_status b
  JOIN public.customers c USING (customer_id)
  WHERE c.status = 'active'
    AND c.hidden_from_app = FALSE
    AND b.outstanding_balance > 0
), stages AS (
  SELECT 1 AS step, 'Active, visible accounts with a recorded balance' AS filter,
         COUNT(*)::INTEGER AS customers
  FROM base
  UNION ALL
  SELECT 2, 'Exactly 5 days overdue today', COUNT(*)::INTEGER
  FROM base, clock
  WHERE oldest_unpaid_due_date = today - 5
  UNION ALL
  SELECT 3, 'Also has the expected 10-day grace period', COUNT(*)::INTEGER
  FROM base, clock
  WHERE oldest_unpaid_due_date = today - 5
    AND grace_end_date = today + 5
  UNION ALL
  SELECT 4, 'Also has no active disconnection hold', COUNT(*)::INTEGER
  FROM base, clock
  WHERE oldest_unpaid_due_date = today - 5
    AND grace_end_date = today + 5
    AND is_on_hold = FALSE
  UNION ALL
  SELECT 5, 'Also has a usable email (would be sent)', COUNT(*)::INTEGER
  FROM base, clock
  WHERE oldest_unpaid_due_date = today - 5
    AND grace_end_date = today + 5
    AND is_on_hold = FALSE
    AND email IS NOT NULL
    AND LENGTH(BTRIM(email)) <= 254
    AND BTRIM(email) ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  UNION ALL
  SELECT 6, 'Has unverified entries (informational; still allowed)', COUNT(*)::INTEGER
  FROM base, clock
  WHERE oldest_unpaid_due_date = today - 5
    AND grace_end_date = today + 5
    AND is_on_hold = FALSE
    AND unverified_entries > 0
)
SELECT step, filter, customers
FROM stages
ORDER BY step;

SELECT
  b.oldest_unpaid_due_date AS oldest_due_date,
  ((CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE
    - b.oldest_unpaid_due_date) AS days_overdue,
  COUNT(*)::INTEGER AS active_accounts_with_balance
FROM public.customer_billing_status b
JOIN public.customers c USING (customer_id)
WHERE c.status = 'active'
  AND c.hidden_from_app = FALSE
  AND b.outstanding_balance > 0
  AND b.oldest_unpaid_due_date IS NOT NULL
GROUP BY b.oldest_unpaid_due_date
ORDER BY b.oldest_unpaid_due_date DESC
LIMIT 14;
SQL
