\pset pager off
BEGIN READ ONLY;
SET LOCAL statement_timeout = '20s';
SELECT i.customer_id, c.name, i.outcome,
       a.customer_ont_assignment_id, a.mapping_status,
       (NULLIF(TRIM(a.ont_serial),'') IS NOT NULL) AS has_serial,
       (o.management_ip IS NOT NULL) AS has_olt_address
FROM public.olt_automation_run_items i JOIN public.customers c USING(customer_id)
LEFT JOIN public.customer_ont_assignments a ON a.customer_id=c.customer_id AND a.ended_at IS NULL
LEFT JOIN public.olts o ON o.olt_id=a.olt_id
WHERE i.olt_automation_run_id=40 AND i.outcome LIKE 'skipped_%'
ORDER BY c.name;
SELECT olt_action_attempt_id,customer_id,action,outcome,requested_at,completed_at,result_message,
       before_control_flag,after_control_flag
FROM public.olt_action_attempts WHERE olt_action_attempt_id IN(1433,1530);
SELECT i.customer_id,c.name,i.outcome,i.message
FROM public.olt_automation_run_items i JOIN public.customers c USING(customer_id)
WHERE i.olt_automation_run_id=38 AND i.outcome LIKE 'skipped_%'
  AND NOT EXISTS(SELECT 1 FROM public.olt_automation_run_items j WHERE j.olt_automation_run_id=40 AND j.customer_id=i.customer_id AND j.outcome LIKE 'skipped_%')
ORDER BY c.name;
COMMIT;
