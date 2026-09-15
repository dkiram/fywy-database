-- Value of charges already deferred by imported paid-through dates.
-- Any conversion to visible credit must preserve this existing coverage.
SELECT JSONB_AGG(JSONB_BUILD_ARRAY(customer_id,name,status,balance,target_balance,
 future_paid,billing_start_date,deferred_value,adjusted_target)) AS payload
FROM (
 SELECT p.*, b.billing_start_date, d.deferred_value,
   LEAST(p.target_balance,LEAST(p.balance,0)-d.deferred_value) AS adjusted_target
 FROM spcl_reconciliation_20260915_snapshot p
 JOIN public.customers c USING(customer_id)
 JOIN public.customer_billing_start b USING(customer_id)
 CROSS JOIN LATERAL (
   SELECT COALESCE(SUM(COALESCE(rate.monthly_fee,c.monthly_fee)),0)::NUMERIC(14,2) AS deferred_value
   FROM GENERATE_SERIES(DATE '2026-09-01',DATE_TRUNC('month',b.billing_start_date)::DATE,INTERVAL '1 month') m(month_start)
   CROSS JOIN LATERAL (
     SELECT public.spcl_anniversary_date(c.activation_date,m.month_start::DATE) AS due_date
   ) due
   LEFT JOIN LATERAL (
     SELECT r.monthly_fee FROM public.customer_rate_history r
     WHERE r.customer_id=c.customer_id AND r.effective_date<=due.due_date
     ORDER BY r.effective_date DESC,r.customer_rate_history_id DESC LIMIT 1
   ) rate ON TRUE
   WHERE due.due_date>DATE '2026-09-15' AND due.due_date<=b.billing_start_date
     AND due.due_date>COALESCE(c.reactivation_date,c.activation_date)
     AND NOT EXISTS (SELECT 1 FROM public.account_ledger_entries l
       WHERE l.customer_id=c.customer_id AND l.entry_type='monthly_charge'
         AND l.due_date=due.due_date)
 ) d
 WHERE b.billing_start_date>DATE '2026-09-15' AND p.future_paid>0 AND NOT p.hidden_from_app
) x;
