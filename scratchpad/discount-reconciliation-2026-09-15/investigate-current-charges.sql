-- READ ONLY. Reconstruct the ledger immediately before the September 15 waiver.
-- A candidate is NOT approval to collect: receipts, prior credits and later
-- corrections must be reviewed. Payment month mapping follows the user's rule.
WITH waivers AS MATERIALIZED (
 SELECT w.*, c.name, c.status AS customer_status, c.activation_date,
        wr.waiver_request_id, wr.status AS waiver_status
 FROM public.account_ledger_entries w
 JOIN public.customers c USING(customer_id)
 LEFT JOIN public.waiver_requests wr ON wr.waiver_ledger_entry_id=w.account_ledger_entry_id
 WHERE w.source_key='final-reconciliation-20260915:'||w.customer_id::text
), totals AS (
 SELECT w.customer_id, SUM(e.amount) AS before_balance,
        COALESCE(-SUM(e.amount) FILTER(WHERE e.amount<0),0) AS credits
 FROM waivers w JOIN public.account_ledger_entries e USING(customer_id)
 WHERE e.account_ledger_entry_id<w.account_ledger_entry_id
 GROUP BY w.customer_id
), debits AS (
 SELECT e.*, SUM(e.amount) OVER(PARTITION BY e.customer_id
   ORDER BY e.due_date NULLS FIRST,e.account_ledger_entry_id) AS cumulative_debits
 FROM waivers w JOIN public.account_ledger_entries e USING(customer_id)
 WHERE e.account_ledger_entry_id<w.account_ledger_entry_id AND e.amount>0
), affected AS (
 SELECT d.*, t.before_balance,
   LEAST(d.amount,GREATEST(d.cumulative_debits-t.credits,0))
   - LEAST(d.amount,GREATEST(d.cumulative_debits-t.credits+w.amount,0)) AS cleared_current
 FROM debits d JOIN totals t USING(customer_id) JOIN waivers w USING(customer_id)
 WHERE d.entry_type='monthly_charge'
   AND d.grace_end_date >= (w.created_at AT TIME ZONE 'America/Jamaica')::date
), candidates AS (
 SELECT a.*, w.name,w.customer_status,w.activation_date,w.waiver_request_id,w.waiver_status,
        w.account_ledger_entry_id AS waiver_id,w.created_at AS waiver_at,-w.amount AS waiver_amount,
        (date_trunc('month',a.due_date) - CASE WHEN extract(day FROM w.activation_date)<=15
          THEN interval '1 month' ELSE interval '0 months' END)::date AS service_month
 FROM affected a JOIN waivers w USING(customer_id) WHERE a.cleared_current>0
)
SELECT jsonb_agg(to_jsonb(r) ORDER BY customer_id,due_date) AS payload FROM (
 SELECT a.customer_id,a.name,a.customer_status,a.before_balance,a.waiver_amount,
        a.waiver_id,a.waiver_at,a.waiver_request_id,a.waiver_status,
        a.account_ledger_entry_id AS charge_id,a.amount AS charge_amount,
        a.created_at AS charge_posted_at,a.due_date,a.grace_end_date,a.service_month,a.cleared_current,
        (SELECT sum(e.amount) FROM public.account_ledger_entries e WHERE e.customer_id=a.customer_id) AS current_balance,
        (SELECT jsonb_agg(jsonb_build_array(p.payment_id,p.amount_paid,p.payment_date,p.month_paid,p.voided_at,p.recorded_at)
                         ORDER BY p.payment_id)
         FROM public.payments p WHERE p.customer_id=a.customer_id
           AND coalesce(p.payment_type,p.legacy_payment_type)='Monthly Fee'
           AND (p.month_paid>=a.service_month OR p.payment_date>=DATE '2026-08-01')) AS receipts,
        (SELECT jsonb_agg(jsonb_build_array(e.account_ledger_entry_id,e.entry_type,e.amount,e.due_date,e.created_at,e.source_key,e.reason)
                         ORDER BY e.account_ledger_entry_id)
         FROM public.account_ledger_entries e WHERE e.customer_id=a.customer_id
           AND e.account_ledger_entry_id>a.waiver_id) AS later_entries,
        EXISTS(SELECT 1 FROM public.audit_logs l
          WHERE l.source_key='final-reconciliation-20260915:schedule:'||a.customer_id::text) AS schedule_converted
 FROM candidates a
) r;
