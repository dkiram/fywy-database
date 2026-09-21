-- ============================================================================
-- READ ONLY. What moved on Melodie OConnor (8571) after the 2026-09-18 15:23
-- message?
--
-- The message said she held a 500 credit and should instead owe 1,000. She
-- now holds a 1,500 credit - 1,000 more than described. Two very different
-- explanations:
--
--   a payment of 1,000 landed  -> she may have PAID the 1,000 she was meant to
--                                 owe. Correct position would then be 0, not
--                                 +1,000 owing. Charging her 1,000 on top would
--                                 make her pay it twice.
--   a waiver / adjustment      -> the credit grew for some other reason and
--                                 the original instruction (+1,000 owing)
--                                 probably still stands.
--
-- She is pending_reconnection, so this is likely a reconnection settlement in
-- progress - exactly the situation where a payment arriving mid-review is
-- normal.
--
-- Writes nothing.
-- ============================================================================

SELECT l.created_at,
       l.effective_date,
       l.entry_type,
       l.amount,
       l.source_key,
       LEFT(l.description, 70) AS description
FROM public.account_ledger_entries l
WHERE l.customer_id = 8571
  AND l.created_at >= TIMESTAMP '2026-09-17 00:00:00'
ORDER BY l.created_at, l.account_ledger_entry_id;

SELECT p.payment_id, p.receipt_number, p.recorded_at, p.payment_type,
       p.amount_paid, p.month_paid, p.voided_at, p.cashier_name, p.location
FROM public.payments p
WHERE p.customer_id = 8571
  AND p.recorded_at >= TIMESTAMP '2026-09-17 00:00:00'
ORDER BY p.recorded_at;

SELECT c.name, c.status, c.monthly_fee, b.balance, b.credit_balance, b.outstanding_balance
FROM public.customers c
JOIN public.customer_billing_status b USING (customer_id)
WHERE c.customer_id = 8571;
