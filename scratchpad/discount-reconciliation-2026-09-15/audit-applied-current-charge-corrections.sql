-- READ ONLY. Counts committed corrections and checks balances including later receipts.
WITH batch AS (
 SELECT a.entity_id::INTEGER AS customer_id,a.old_value::NUMERIC AS before_balance,
        a.new_value::NUMERIC AS committed_balance,a.occurred_at,
        w.waiver_request_id,w.status AS original_waiver_status,w.reversal_ledger_entry_id,
        r.account_ledger_entry_id AS retained_id,r.amount AS retained_amount
 FROM public.audit_logs a
 JOIN public.account_ledger_entries original
   ON original.source_key='final-reconciliation-20260915:'||a.entity_id
 JOIN public.waiver_requests w ON w.waiver_ledger_entry_id=original.account_ledger_entry_id
 LEFT JOIN public.account_ledger_entries r
   ON r.source_key='current-charge-correction-20260915:retained:'||a.entity_id
 WHERE a.source_key='current-charge-correction-20260915:'||a.entity_id
), observed AS (
 SELECT b.*,s.balance,
        b.committed_balance+s.after_correction AS expected_balance,
        billing.oldest_unpaid_due_date,billing.grace_end_date,c.status
 FROM batch b JOIN public.customers c USING(customer_id)
 JOIN public.customer_billing_status billing USING(customer_id)
 CROSS JOIN LATERAL (
   SELECT SUM(e.amount) AS balance,
      COALESCE(SUM(e.amount) FILTER(WHERE e.account_ledger_entry_id>
        GREATEST(b.reversal_ledger_entry_id,COALESCE(b.retained_id,0))),0) AS after_correction
   FROM public.account_ledger_entries e WHERE e.customer_id=b.customer_id
 ) s
)
SELECT jsonb_build_object(
 'accounts',count(*),'net_restored',sum(committed_balance-before_balance),
 'original_waivers_reversed',count(*) FILTER(WHERE original_waiver_status='reversed'),
 'replacement_credits',count(retained_id),'credit_and_relief_retained',-sum(retained_amount),
 'balance_mismatches',count(*) FILTER(WHERE balance IS DISTINCT FROM expected_balance),
 'excluded_accounts_touched',count(*) FILTER(WHERE customer_id IN(7026,15019)),
 'nonpositive_now',count(*) FILTER(WHERE balance<=0),
 'unpaid_grace_ends_today',count(*) FILTER(WHERE balance>0 AND grace_end_date=DATE '2026-09-15'),
 'committed_at',min(occurred_at),'checked_at',CURRENT_TIMESTAMP
) AS payload FROM observed;
