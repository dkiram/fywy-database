-- Eligible OLT-disconnection candidates whose grace ended by 2026-07-20.
-- Mirrors the automation's candidate filter, adds the hard date ceiling,
-- and splits by whether a verified OLT mapping exists (only mapping-ready
-- accounts actually get an OLT command; the rest are skipped).
WITH today AS (
  SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE AS billing_date
),
candidate AS (
  SELECT
    customer.customer_id,
    billing.grace_end_date,
    (assignment.customer_ont_assignment_id IS NOT NULL
      AND assignment.mapping_status = 'verified'
      AND assignment.ont_serial IS NOT NULL
      AND olt.management_ip IS NOT NULL) AS mapping_ready
  FROM public.customer_billing_status billing
  JOIN public.customers customer USING (customer_id)
  LEFT JOIN public.customer_ont_assignments assignment
    ON assignment.customer_id = customer.customer_id
   AND assignment.ended_at IS NULL
  LEFT JOIN public.olts olt ON olt.olt_id = assignment.olt_id
  CROSS JOIN today
  WHERE billing.eligible_for_disconnection
    AND customer.hidden_from_app = FALSE
    AND billing.unverified_entries = 0
    AND NOT EXISTS (
      SELECT 1
      FROM public.olt_automation_run_items earlier_item
      JOIN public.olt_automation_runs earlier_run
        ON earlier_run.olt_automation_run_id = earlier_item.olt_automation_run_id
      WHERE earlier_run.billing_date = today.billing_date
        AND earlier_item.customer_id = customer.customer_id
    )
    AND (
      customer.source_staging_id IS NULL
      OR billing.grace_end_date >= DATE '2025-01-01'
    )
    AND billing.grace_end_date <= DATE '2026-07-20'
)
SELECT
  COUNT(*) FILTER (WHERE mapping_ready)             AS ready_through_jul20,
  COUNT(*) FILTER (WHERE NOT mapping_ready)         AS not_ready_through_jul20,
  LEAST(COUNT(*) FILTER (WHERE mapping_ready), 300) AS batch_size,
  MIN(grace_end_date) FILTER (WHERE mapping_ready)  AS oldest_grace_end,
  MAX(grace_end_date) FILTER (WHERE mapping_ready)  AS newest_grace_end
FROM candidate;
