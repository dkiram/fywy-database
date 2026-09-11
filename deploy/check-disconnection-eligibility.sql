-- Read-only production diagnosis. Run with psql -X -v ON_ERROR_STOP=1.
BEGIN TRANSACTION READ ONLY;

SELECT CURRENT_TIMESTAMP AS checked_at,
       CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica' AS jamaica_time;

SELECT olt_automation_run_id, billing_date, status, candidate_count,
       selected_count, remaining_count, disconnected_count, skipped_count,
       failed_count, started_at, completed_at, error_message
FROM public.olt_automation_runs
ORDER BY started_at DESC LIMIT 20;

SELECT r.billing_date, i.outcome, i.message, COUNT(*) AS customers
FROM public.olt_automation_run_items i
JOIN public.olt_automation_runs r USING (olt_automation_run_id)
WHERE r.billing_date >= (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE - 7
GROUP BY r.billing_date, i.outcome, i.message
ORDER BY r.billing_date DESC, customers DESC;

-- Match the visible delinquent report, then explain the first automation gate.
WITH report_accounts AS (
  SELECT c.customer_id, b.grace_end_date, b.unverified_entries,
    CASE
      WHEN b.is_on_hold THEN 'Active disconnection hold'
      WHEN a.customer_ont_assignment_id IS NULL
        OR a.mapping_status IS DISTINCT FROM 'verified'
        OR NULLIF(TRIM(a.ont_serial), '') IS NULL
        OR o.management_ip IS NULL THEN 'Missing verified OLT mapping or serial'
      WHEN EXISTS (
        SELECT 1 FROM public.olt_action_attempts attempt
        WHERE attempt.customer_ont_assignment_id = a.customer_ont_assignment_id
          AND attempt.outcome IN ('requested', 'uncertain')
      ) THEN 'Unresolved previous OLT action'
      ELSE 'Passes selection gates; inspect run result and live identity verification'
    END AS reason
  FROM public.customer_billing_status b
  JOIN public.customers c USING (customer_id)
  LEFT JOIN public.customer_ont_assignments a
    ON a.customer_id = c.customer_id AND a.ended_at IS NULL
  LEFT JOIN public.olts o ON o.olt_id = a.olt_id
  WHERE b.is_delinquent AND c.status = 'active' AND c.hidden_from_app = FALSE
    AND (c.source_staging_id IS NULL OR b.grace_end_date >= DATE '2025-01-01')
)
SELECT reason, COUNT(*) AS customers,
       COUNT(*) FILTER (WHERE unverified_entries > 0) AS with_unverified_entries,
       ARRAY_AGG(customer_id ORDER BY grace_end_date, customer_id) AS customer_ids
FROM report_accounts GROUP BY reason ORDER BY customers DESC;

SELECT olt_automation_run_id, host(management_ip) AS olt, status,
       attempt_count, next_attempt_at, error_message
FROM public.olt_automation_save_jobs
WHERE status <> 'succeeded'
ORDER BY next_attempt_at;

ROLLBACK;
