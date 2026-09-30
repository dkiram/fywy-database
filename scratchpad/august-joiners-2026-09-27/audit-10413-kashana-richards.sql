-- READ-ONLY. Why does 10413 Kashana Kimberlie Richards show J$1,500 owing
-- after paying the reconnection fee?

-- 1. Every ledger line, oldest first, with a running balance.
SELECT e.account_ledger_entry_id AS id, e.created_at::TIMESTAMP(0) AS posted_at,
       e.entry_type, e.amount,
       SUM(e.amount) OVER (ORDER BY e.created_at, e.account_ledger_entry_id) AS running_balance,
       e.due_date, e.payment_id, e.source_key, e.description
FROM public.account_ledger_entries e
WHERE e.customer_id = 10413
ORDER BY e.created_at, e.account_ledger_entry_id;

-- 2. Receipts since August.
SELECT payment_id, payment_type, amount_paid, month_paid, payment_date,
       recorded_at::TIMESTAMP(0), cashier_name, voided_at::TIMESTAMP(0), receipt_number
FROM public.payments
WHERE customer_id = 10413 AND payment_date >= DATE '2026-08-01'
ORDER BY recorded_at NULLS FIRST, payment_id;

-- 3. Status changes (each app disconnection posts its own fee).
SELECT account_status_history_id AS id, changed_at::TIMESTAMP(0), from_status, to_status, reason
FROM public.account_status_history
WHERE customer_id = 10413 AND changed_at >= TIMESTAMPTZ '2026-08-01'
ORDER BY changed_at, account_status_history_id;

-- 4. The fee lines side by side: two fee debits for one reconnection = double charge.
SELECT e.entry_type, e.amount, e.created_at::TIMESTAMP(0), e.source_key,
       CASE
         WHEN e.source_key LIKE 'reconnection-fee:payment:%'           THEN 'posted WITH the fee payment (new 27 Sept rule)'
         WHEN e.source_key LIKE 'reconnection-fee:status-history:%'    THEN 'posted when the app disconnected the account'
         WHEN e.source_key LIKE 'legacy-reconnection-fee:%'            THEN 'legacy import'
         WHEN e.source_key LIKE 'fix-2026-09-27:reconnection-credit:%' THEN 'FIX-reconnection-fee-credits.sql'
         WHEN e.source_key LIKE 'suspension-reconnection-fee:%'        THEN 'end of a suspension'
         ELSE 'other: ' || COALESCE(e.source_key, 'no key')
       END AS where_it_came_from
FROM public.account_ledger_entries e
WHERE e.customer_id = 10413
  AND (e.entry_type IN ('reconnection_fee', 'suspension_reconnection_fee', 'reconnection_payment')
       OR e.source_key LIKE 'fix-2026-09-27:%')
ORDER BY e.created_at;

-- 5. (added 29 Sept) Everything logged on her account that afternoon, and who
-- held the payment IDs around hers. Explains the 16:14:38 "queued" entry.
SELECT audit_log_id, occurred_at::TIMESTAMP(0), actor_name, action, entity_type, entity_id,
       field_name, old_value, new_value, LEFT(reason, 160) AS reason
FROM public.audit_logs
WHERE occurred_at >= TIMESTAMPTZ '2026-09-29 00:00 America/Jamaica'
  AND (entity_id = '10413' OR entity_id IN ('447600', '447601', '447602', '447603'))
ORDER BY occurred_at, audit_log_id;

SELECT payment_id, customer_id, payment_type, amount_paid, recorded_at::TIMESTAMP(3), cashier_name, voided_at
FROM public.payments WHERE payment_id BETWEEN 447596 AND 447606 ORDER BY payment_id;
