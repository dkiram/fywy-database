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
), evidence AS (
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
), payment_evidence AS (
 SELECT e.*, p.matched_paid_before, p.unlabelled,
        EXISTS(SELECT 1 FROM jsonb_array_elements(e.later_entries) x
          WHERE x->>1 IS DISTINCT FROM 'monthly_payment' OR (x->>2)::numeric>=0
             OR COALESCE(x->>5,'') NOT LIKE 'payment:%') AS unusual_later
 FROM evidence e
 CROSS JOIN LATERAL (
   SELECT COALESCE(SUM((x->>1)::numeric) FILTER(
              WHERE date_trunc('month',(x->>3)::date)::date=e.service_month),0) AS matched_paid_before,
          COALESCE(BOOL_OR(x->>3 IS NULL AND (x->>1)::numeric<>0),false) AS unlabelled
   FROM jsonb_array_elements(e.receipts) x
   WHERE (x->>5 IS NULL OR (x->>5)::timestamptz<=e.waiver_at)
     AND (x->>4 IS NULL OR (x->>4)::timestamptz>e.waiver_at)
     AND (x->>2)::date<=(e.waiver_at AT TIME ZONE 'America/Jamaica')::date
 ) p
), amounts AS (
 SELECT *, LEAST(cleared_current,GREATEST(charge_amount-matched_paid_before,0)) AS possible_restoration
 FROM payment_evidence
), initial_decisions AS (
 SELECT *, CASE
   WHEN waiver_status='reversed' THEN 'already_reversed'
   WHEN possible_restoration=0 THEN 'covered_by_receipts'
   WHEN waiver_status IS DISTINCT FROM 'approved' OR customer_status IS DISTINCT FROM 'active' THEN 'review_status'
   WHEN schedule_converted THEN 'review_prepaid_schedule'
   WHEN unlabelled THEN 'review_unlabelled_receipts'
   WHEN unusual_later THEN 'review_later_charges'
   WHEN matched_paid_before<0 THEN 'review_negative_receipts'
   ELSE 'proposed_restore' END AS initial_decision
 FROM amounts
), allocation_credits AS (
 SELECT e.customer_id,COALESCE(-SUM(e.amount) FILTER(WHERE e.amount<0),0) AS credits
 FROM public.account_ledger_entries e JOIN initial_decisions p USING(customer_id)
 WHERE p.initial_decision='proposed_restore' GROUP BY e.customer_id
), allocation_debits AS (
 SELECT e.customer_id,e.due_date,e.grace_end_date,e.account_ledger_entry_id,
   SUM(e.amount) OVER(PARTITION BY e.customer_id
      ORDER BY e.due_date NULLS FIRST,e.account_ledger_entry_id) AS cumulative
 FROM public.account_ledger_entries e JOIN initial_decisions p USING(customer_id)
 WHERE e.amount>0 AND p.initial_decision='proposed_restore'
), allocation_oldest AS (
 SELECT DISTINCT ON(d.customer_id) d.customer_id,d.due_date,d.grace_end_date
 FROM allocation_debits d JOIN allocation_credits c USING(customer_id)
 JOIN initial_decisions p USING(customer_id)
 WHERE d.cumulative+p.possible_restoration>c.credits
 ORDER BY d.customer_id,d.due_date NULLS FIRST,d.account_ledger_entry_id
), decisions AS (
 SELECT p.*, CASE WHEN p.initial_decision='proposed_restore'
   AND ((p.current_balance+p.possible_restoration>0
         AND (o.due_date IS DISTINCT FROM p.due_date OR o.grace_end_date IS DISTINCT FROM p.grace_end_date))
        OR (p.current_balance+p.possible_restoration<=0 AND o.customer_id IS NOT NULL))
   THEN 'review_due_allocation' ELSE p.initial_decision END AS decision
 FROM initial_decisions p LEFT JOIN allocation_oldest o USING(customer_id)
), preview AS (
 SELECT *, CASE WHEN decision='proposed_restore' THEN possible_restoration ELSE 0 END AS proposed_adjustment
 FROM decisions
) , chosen AS (SELECT * FROM preview WHERE decision='proposed_restore'),
credit_totals AS (
 SELECT e.customer_id,COALESCE(-SUM(e.amount) FILTER(WHERE e.amount<0),0) AS credits
 FROM public.account_ledger_entries e JOIN chosen p USING(customer_id) GROUP BY e.customer_id
), live_debits AS (
 SELECT e.customer_id,e.due_date,e.grace_end_date,e.account_ledger_entry_id,
   SUM(e.amount) OVER(PARTITION BY e.customer_id ORDER BY e.due_date NULLS FIRST,e.account_ledger_entry_id) AS cumulative
 FROM public.account_ledger_entries e JOIN chosen p USING(customer_id) WHERE e.amount>0
), simulated_oldest AS (
 SELECT DISTINCT ON(d.customer_id) d.customer_id,d.due_date,d.grace_end_date
 FROM live_debits d JOIN credit_totals c USING(customer_id) JOIN chosen p USING(customer_id)
 WHERE d.cumulative+p.proposed_adjustment>c.credits
 ORDER BY d.customer_id,d.due_date NULLS FIRST,d.account_ledger_entry_id
)
SELECT jsonb_build_object(
 'accounts',count(*),'amount',sum(p.proposed_adjustment),
 'nonpositive_after',count(*) FILTER(WHERE p.current_balance+p.proposed_adjustment<=0),
 'wrong_due_or_grace',count(*) FILTER(WHERE p.current_balance+p.proposed_adjustment>0
   AND (o.due_date IS DISTINCT FROM p.due_date OR o.grace_end_date IS DISTINCT FROM p.grace_end_date)),
 'unexpected_unpaid_when_covered',count(*) FILTER(WHERE p.current_balance+p.proposed_adjustment<=0 AND o.customer_id IS NOT NULL),
 'invalid_restoration',count(*) FILTER(WHERE p.proposed_adjustment<=0 OR p.proposed_adjustment>p.cleared_current OR p.proposed_adjustment>p.waiver_amount),
 'unpaid_grace_ends_today',count(*) FILTER(WHERE p.current_balance+p.proposed_adjustment>0 AND o.grace_end_date=DATE '2026-09-15'),
 'all_active',bool_and(p.customer_status='active'),
 'waivers_to_replace',count(*) FILTER(WHERE p.waiver_amount>p.proposed_adjustment),
 'credit_and_relief_to_retain',sum(p.waiver_amount-p.proposed_adjustment),
 'checked_at',CURRENT_TIMESTAMP
) AS payload FROM chosen p LEFT JOIN simulated_oldest o USING(customer_id);
