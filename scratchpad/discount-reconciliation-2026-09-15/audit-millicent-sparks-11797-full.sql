-- ============================================================================
-- READ ONLY. Confirm that legacy payment 35993 on Millicent Sparks (11797)
-- carries no ledger credit, so that "removing" it would change no money.
--
-- Why this matters: the request was to remove her 2026-08-07 J$2,500 receipt
-- (month paid July 2026). Two things stand in the way of treating that as a
-- normal void:
--
--   1. It is a legacy Access import (legacy_payment_id 468167). The app's void
--      endpoint refuses these deliberately - "Access imports are historical
--      source evidence and cannot be voided here".
--
--   2. Migration 041 DELETED every legacy payment's ledger credit and
--      represents legacy payment history solely through
--      customer_billing_start.paid_through. So a legacy receipt is a record of
--      what Access said, not a line item in the balance. Section 1 proves it
--      either way for this specific payment.
--
-- If section 1 returns no rows, the receipt contributes nothing to her balance
-- and deleting it would be a change to historical records with no financial
-- effect. Her balance is already 0.00.
--
-- She also has TWO legacy receipts tagged July 2026 - 35992 (month paid
-- 2026-07-03) and 35993 (2026-07-14) - which is probably what prompted the
-- request. Section 4 lays them side by side.
--
-- Writes nothing.
-- ============================================================================

-- 1. THE DECIDING QUESTION: does payment 35993 have ANY ledger entry?
--    Checked three ways, because the link could be by payment_id or source_key.
SELECT 'LEDGER ENTRIES FOR PAYMENT 35993' AS check,
       l.account_ledger_entry_id, l.customer_id, l.effective_date,
       l.entry_type, l.amount, l.source_key, l.payment_id
FROM public.account_ledger_entries l
WHERE l.payment_id = 35993
   OR l.source_key = 'payment:35993'
   OR l.source_key LIKE '%35993%'
ORDER BY l.account_ledger_entry_id;

-- 2. For comparison: the new-system receipt 437375 DOES have one. If section 1
--    is empty and this is not, that is the difference between a legacy record
--    and a live ledger credit.
SELECT 'LEDGER ENTRIES FOR PAYMENT 437375 (new system)' AS check,
       l.account_ledger_entry_id, l.effective_date, l.entry_type, l.amount,
       l.source_key, l.payment_id
FROM public.account_ledger_entries l
WHERE l.payment_id = 437375
   OR l.source_key = 'payment:437375'
ORDER BY l.account_ledger_entry_id;

-- 3. Her complete ledger and her billing-start row. paid_through is how
--    migration 041 records her legacy payment history - if anything represents
--    that July receipt in the balance, it is this.
SELECT 'HER COMPLETE LEDGER' AS check,
       l.account_ledger_entry_id, l.effective_date, l.due_date,
       l.entry_type, l.amount,
       SUM(l.amount) OVER (ORDER BY l.effective_date, l.account_ledger_entry_id) AS running_balance,
       l.source_key
FROM public.account_ledger_entries l
WHERE l.customer_id = 11797
ORDER BY l.effective_date, l.account_ledger_entry_id;

SELECT 'HER BILLING START' AS check,
       bs.customer_id, bs.billing_start_date, bs.paid_through
FROM public.customer_billing_start bs
WHERE bs.customer_id = 11797;

-- 4. The two July receipts side by side, plus every legacy receipt, so the
--    duplicate can be judged on what Access actually recorded.
SELECT 'HER LEGACY RECEIPTS' AS check,
       p.payment_id, p.legacy_payment_id, p.payment_date, p.month_paid,
       p.payment_type, p.amount_paid, p.location, p.cashier_name,
       p.legacy_payment_type, p.legacy_payment_date_raw
FROM public.payments p
WHERE p.customer_id = 11797
  AND p.legacy_payment_id IS NOT NULL
ORDER BY p.month_paid NULLS FIRST, p.payment_date;
