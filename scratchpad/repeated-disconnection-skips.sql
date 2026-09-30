\pset pager off
BEGIN READ ONLY;
SET LOCAL statement_timeout = '20s';

SELECT olt_automation_run_id, billing_date, status, selected_count,
       disconnected_count, skipped_count, failed_count, remaining_count,
       error_message, started_at, completed_at
FROM public.olt_automation_runs
WHERE billing_date >= (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::date - 14
ORDER BY olt_automation_run_id DESC;

WITH recent AS (
  SELECT i.*, r.billing_date
  FROM public.olt_automation_run_items i
  JOIN public.olt_automation_runs r USING (olt_automation_run_id)
  WHERE r.billing_date >= (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::date - 14
), latest AS (
  SELECT DISTINCT ON (customer_id) *
  FROM recent ORDER BY customer_id, started_at DESC, olt_automation_run_item_id DESC
), counts AS (
  SELECT customer_id, COUNT(*) AS runs_seen,
         COUNT(*) FILTER (WHERE outcome LIKE 'skipped_%') AS skipped_runs,
         COUNT(*) FILTER (WHERE outcome IN ('failed','uncertain')) AS failed_or_uncertain_runs,
         MIN(billing_date) AS first_seen, MAX(billing_date) AS last_seen
  FROM recent GROUP BY customer_id
)
SELECT l.customer_id, c.name, c.status AS current_account_status,
       counts.*, l.olt_automation_run_id AS latest_run, l.outcome AS latest_outcome,
       l.message AS latest_reason
FROM latest l JOIN counts USING (customer_id)
JOIN public.customers c ON c.customer_id=l.customer_id
WHERE counts.skipped_runs > 0 OR counts.failed_or_uncertain_runs > 0
ORDER BY counts.last_seen DESC, counts.skipped_runs DESC, c.name;

SELECT i.customer_id,c.name,r.billing_date,i.olt_automation_run_id,
       i.outcome,i.message,i.olt_action_attempt_id
FROM public.olt_automation_run_items i
JOIN public.olt_automation_runs r USING(olt_automation_run_id)
JOIN public.customers c USING(customer_id)
WHERE r.billing_date >= (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::date - 7
  AND i.outcome NOT IN ('disconnected','already_deactivated')
ORDER BY r.billing_date DESC,c.name;
COMMIT;
