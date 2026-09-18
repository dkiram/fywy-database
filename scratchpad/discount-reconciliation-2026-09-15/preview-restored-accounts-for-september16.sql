-- READ ONLY: restored accounts whose existing grace expires September 15.
-- This does not disconnect accounts or bypass payment, hold or OLT checks.
WITH corrected AS (
 SELECT DISTINCT entity_id::INTEGER AS customer_id
 FROM public.audit_logs
 WHERE source_key='current-charge-correction-20260915:'||entity_id
    OR source_key='staff-reviewed-correction-20260915:'||entity_id
)
SELECT c.customer_id,c.name,b.outstanding_balance,b.oldest_unpaid_due_date,
       b.grace_end_date,DATE '2026-09-16' AS eligible_from,
       EXISTS(SELECT 1 FROM public.disconnection_holds h WHERE h.customer_id=c.customer_id
         AND h.status='active' AND h.expires_on>=DATE '2026-09-16') AS hold_on_september16,
       a.mapping_status,a.ont_serial IS NOT NULL AS has_serial,
       o.management_ip IS NOT NULL AS has_olt_address
FROM corrected r JOIN public.customers c USING(customer_id)
JOIN public.customer_billing_status b USING(customer_id)
LEFT JOIN public.customer_ont_assignments a ON a.customer_id=c.customer_id AND a.ended_at IS NULL
LEFT JOIN public.olts o ON o.olt_id=a.olt_id
WHERE c.status='active' AND NOT c.hidden_from_app
  AND b.balance>0 AND b.grace_end_date=DATE '2026-09-15'
ORDER BY c.customer_id;
