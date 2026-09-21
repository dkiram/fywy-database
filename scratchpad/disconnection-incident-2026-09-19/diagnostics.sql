\pset pager off
BEGIN READ ONLY;
SET LOCAL statement_timeout = '20s';
SELECT CURRENT_TIMESTAMP AS checked_at, pg_postmaster_start_time() AS database_started;
SELECT * FROM public.olt_automation_runs WHERE olt_automation_run_id >= 30 ORDER BY olt_automation_run_id;
SELECT i.customer_id,c.name,i.outcome,i.message,i.started_at,i.completed_at,i.olt_action_attempt_id
FROM public.olt_automation_run_items i JOIN public.customers c USING(customer_id)
WHERE i.olt_automation_run_id=32 ORDER BY i.started_at;
SELECT a.olt_action_attempt_id,a.customer_id,c.name,a.action,a.outcome,a.requested_at,a.completed_at,
       a.before_control_flag,a.after_control_flag,a.result_message,a.account_status_applied_at
FROM public.olt_action_attempts a JOIN public.customers c USING(customer_id)
WHERE a.requested_at BETWEEN TIMESTAMPTZ '2026-09-19 00:15:00-05' AND TIMESTAMPTZ '2026-09-19 01:00:00-05'
   OR (a.customer_id IN (11294,8571,9544) AND a.requested_at >= TIMESTAMPTZ '2026-09-12 00:00:00-05')
ORDER BY a.requested_at;
SELECT * FROM public.olt_automation_save_jobs WHERE olt_automation_run_id >= 30;
SELECT j.*,c.name,c.status AS account_status FROM public.olt_reconnection_automation_jobs j
JOIN public.customers c USING(customer_id)
WHERE c.status='pending_reconnection' OR j.customer_id IN(11294,8571,9544)
ORDER BY j.updated_at DESC;
SELECT c.customer_id,c.name,c.status,b.ready_for_reconnection,b.outstanding_balance,
       a.customer_ont_assignment_id,a.mapping_status,host(o.management_ip) AS management_ip,
       a.frame_number,a.slot_number,a.pon_port_number,a.ont_id,a.ont_serial,a.ont_description_override
FROM public.customers c JOIN public.customer_billing_status b USING(customer_id)
LEFT JOIN public.customer_ont_assignments a ON a.customer_id=c.customer_id AND a.ended_at IS NULL
LEFT JOIN public.olts o ON o.olt_id=a.olt_id
WHERE c.status='pending_reconnection' OR c.customer_id IN(11294,8571,9544);
SELECT a.pid,a.state,a.query_start,a.wait_event_type,a.wait_event,LEFT(a.query,300) AS query
FROM pg_stat_activity a WHERE a.pid IN(SELECT pid FROM pg_locks WHERE locktype='advisory' AND objid=56802026);
COMMIT;
