-- READ-ONLY. Every fee posted WITH a Reconnection Fee payment since the
-- 27 Sept deploy, and whether a disconnection fee was already waiting unpaid
-- at that moment (= the 10413 double charge).
SELECT f.customer_id, c.name, c.status, b.balance AS balance_now,
       f.account_ledger_entry_id AS payment_fee_id, f.created_at::TIMESTAMP(0), f.amount,
       (SELECT COALESCE(SUM(x.amount), 0) FROM public.account_ledger_entries x
         LEFT JOIN public.payments p ON p.payment_id = x.payment_id
         WHERE x.customer_id = f.customer_id AND x.created_at <= f.created_at
           AND x.account_ledger_entry_id <> f.account_ledger_entry_id
           AND (x.entry_type IN ('reconnection_fee', 'suspension_reconnection_fee')
                OR (x.entry_type IN ('reconnection_payment', 'payment_void')
                    AND p.payment_type = 'Reconnection Fee' AND x.payment_id <> f.payment_id))
       ) AS unpaid_fee_already_there,
       CASE WHEN (SELECT COUNT(*) FROM public.account_ledger_entries r
                  WHERE r.customer_id = f.customer_id AND r.source_key LIKE 'fix-2026-09-29:duplicate-reconnection-fee:%') > 0
            THEN 'already fixed' END AS note
FROM public.account_ledger_entries f
JOIN public.customers c USING (customer_id)
JOIN public.customer_billing_status b USING (customer_id)
WHERE f.source_key LIKE 'reconnection-fee:payment:%' AND f.amount > 0
ORDER BY unpaid_fee_already_there DESC, f.created_at;
