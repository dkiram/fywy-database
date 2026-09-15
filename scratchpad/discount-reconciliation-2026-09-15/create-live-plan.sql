CREATE TEMP TABLE spcl_reconciliation_20260915_snapshot AS
-- Management's broadened one-time relief rule, all accounts.
-- Recent payment activity: positive NET Monthly Fee receipts since Aug 1.
-- Future paid months use the stated rule: due days 1-15 bill the previous
-- month; due days 16-31 bill the same month. Existing credit is never removed.
-- Read-only. This is management relief, not a claim every balance is invalid.
WITH settings AS (
 SELECT DATE '2026-09-15' AS as_of, DATE '2026-08-01' AS recent_start
), payments AS (
 SELECT p.customer_id,
   SUM(p.amount_paid) FILTER (WHERE p.payment_date >= s.recent_start
     AND p.payment_date <= s.as_of) AS recent_net_paid,
   MAX(p.payment_date) FILTER (WHERE p.amount_paid > 0 AND p.payment_date <= s.as_of) AS last_paid,
   COUNT(*) FILTER (WHERE p.amount_paid > 0 AND p.payment_date >= s.recent_start
     AND p.payment_date <= s.as_of) AS recent_receipts,
   SUM(p.amount_paid) FILTER (WHERE p.month_paid IS NULL AND p.payment_date >= s.recent_start
     AND p.payment_date <= s.as_of) AS recent_unlabelled,
   SUM(p.amount_paid) FILTER (WHERE p.payment_date <= s.as_of AND c.activation_date IS NOT NULL
     AND public.spcl_anniversary_date(c.activation_date,
       (DATE_TRUNC('month', p.month_paid) + CASE WHEN EXTRACT(DAY FROM c.activation_date) <= 15
         THEN INTERVAL '1 month' ELSE INTERVAL '0 months' END)::DATE) > s.as_of) AS future_paid,
   MD5(STRING_AGG(CONCAT_WS(':',p.payment_id,p.amount_paid,p.payment_date,p.month_paid),
       ',' ORDER BY p.payment_id)) AS payment_fingerprint,
   JSONB_OBJECT_AGG(p.payment_id::TEXT, JSONB_BUILD_ARRAY(p.amount_paid,p.payment_date,p.month_paid))
     FILTER (WHERE p.payment_date >= s.recent_start AND p.payment_date <= s.as_of) AS recent_evidence
 FROM public.payments p JOIN public.customers c USING (customer_id) CROSS JOIN settings s
 WHERE p.voided_at IS NULL AND COALESCE(p.payment_type,p.legacy_payment_type) = 'Monthly Fee'
 GROUP BY p.customer_id
), plan AS (
 SELECT c.customer_id, c.name, c.status, c.monthly_fee, c.activation_date,
   c.hidden_from_app, b.balance, b.oldest_unpaid_due_date, b.grace_end_date,
   COALESCE(p.recent_net_paid,0)::NUMERIC(14,2) AS recent_net_paid,
   p.last_paid, p.recent_receipts, COALESCE(p.recent_unlabelled,0) AS recent_unlabelled,
   GREATEST(COALESCE(p.future_paid,0)-COALESCE(f.posted_future_charges,0),0)::NUMERIC(14,2) AS future_paid,
   CASE WHEN COALESCE(p.recent_net_paid,0) > 0 OR COALESCE(p.future_paid,0) > 0
     THEN LEAST(b.balance,-GREATEST(COALESCE(p.future_paid,0)-COALESCE(f.posted_future_charges,0),0))
     ELSE b.balance END::NUMERIC(14,2) AS target_balance,
   p.recent_evidence, p.payment_fingerprint,
   COALESCE(f.posted_future_charges,0) AS posted_future_charges
 FROM public.customers c JOIN public.customer_billing_status b USING(customer_id)
 LEFT JOIN payments p USING(customer_id)
 LEFT JOIN LATERAL (
   SELECT SUM(e.amount) AS posted_future_charges
   FROM public.account_ledger_entries e CROSS JOIN settings s
   WHERE e.customer_id=c.customer_id AND e.entry_type='monthly_charge'
     AND e.amount>0 AND e.due_date>s.as_of
 ) f ON TRUE
)
SELECT * FROM plan;