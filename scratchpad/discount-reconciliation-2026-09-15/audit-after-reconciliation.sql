-- READ ONLY: actual committed reconciliation entries and today's balances.
-- This reports what happened; it does not repeat or reverse any adjustment.
WITH affected AS (
 SELECT l.customer_id,l.account_ledger_entry_id,l.amount,l.created_at,
        w.waiver_request_id,w.status AS waiver_status,w.reversed_at,
        w.reversal_ledger_entry_id
 FROM public.account_ledger_entries l
 LEFT JOIN public.waiver_requests w ON w.waiver_ledger_entry_id=l.account_ledger_entry_id
 WHERE l.source_key='final-reconciliation-20260915:'||l.customer_id::text
), balances AS (
 SELECT e.customer_id,SUM(e.amount) AS current_balance
 FROM public.account_ledger_entries e JOIN affected a USING(customer_id)
 GROUP BY e.customer_id
)
SELECT a.customer_id,c.name,c.status,a.created_at AS reconciliation_at,
       -a.amount AS original_credit,a.waiver_request_id,a.waiver_status,
       a.reversed_at,a.reversal_ledger_entry_id,b.current_balance,
       COUNT(*) OVER() AS original_adjustment_count,
       -SUM(a.amount) OVER() AS original_total_credit
FROM affected a JOIN public.customers c USING(customer_id)
JOIN balances b USING(customer_id)
ORDER BY a.customer_id;
