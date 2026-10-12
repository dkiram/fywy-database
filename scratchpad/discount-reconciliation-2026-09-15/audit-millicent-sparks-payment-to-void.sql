-- ============================================================================
-- READ ONLY. Identify the Millicent Sparks payment to be voided, confirm it
-- CAN be voided, and show what voiding it will do.
--
-- Target (from the message): 7 Aug 2026, Monthly Fee, month paid July 2026,
-- J$2,500.00, Newport, cashier Lidia Cohall.
--
-- VOID IT IN THE APP, NOT HERE. The app's void does four things this script
-- deliberately does not attempt:
--   * sets voided_at / voided_by_employee_id / void_reason on the receipt;
--   * posts a payment_void ledger entry of -amount
--     (source_key payment-void:<payment_id>) to reverse the credit;
--   * reverses an associated reconnection fee separately, if there is one;
--   * if the account is pending_reconnection and goes unpaid again, returns
--     it to DISCONNECTED and writes the status-history row for it.
-- Reproducing that by hand is how an account ends up half-voided. Section 3
-- tells you whether that disconnection branch applies to her.
--
-- Constraints worth knowing before you try:
--   * only the Admin role can void a payment;
--   * a void reason of 3-500 characters is required and is stored;
--   * legacy Access imports cannot be voided (they are source evidence) -
--     section 1 shows whether this is one;
--   * an already-voided payment cannot be voided twice.
--
-- Writes nothing.
--
-- Run on the NAS:
--   ssh -p 9222 SPCNAS@100.98.108.77 \
--     'docker exec -i spcl-postgres psql -U spcl_user -d spcl_db' \
--     < scratchpad/discount-reconciliation-2026-09-15/audit-millicent-sparks-payment-to-void.sql
-- ============================================================================

-- 1. The payment itself. `voidable` is the answer to "can the app void this".
SELECT 'THE PAYMENT' AS check,
       p.payment_id,
       p.receipt_number,
       c.customer_id,
       c.name,
       p.payment_date,
       p.recorded_at,
       p.payment_type,
       p.amount_paid,
       p.month_paid,
       p.location,
       p.cashier_name,
       p.legacy_payment_id,
       p.voided_at,
       p.void_reason,
       CASE
           WHEN p.voided_at IS NOT NULL        THEN 'NO - already voided'
           WHEN p.legacy_payment_id IS NOT NULL THEN 'NO - legacy Access import, the app refuses these'
           ELSE                                     'yes'
       END AS voidable
FROM public.payments p
JOIN public.customers c USING (customer_id)
WHERE c.name ILIKE '%millicent%spark%'
  AND p.payment_date = DATE '2026-08-07'
  AND p.amount_paid = 2500.00
ORDER BY p.payment_id;

-- 2. Every payment on her account, in case the one above is not unique or the
--    date is slightly off. Look for a second J$2,500 tagged July 2026 - if
--    there are two, this may be a duplicate and that changes the reason you
--    give for the void.
SELECT 'ALL HER PAYMENTS' AS check,
       p.payment_id, p.receipt_number, p.payment_date, p.recorded_at,
       p.payment_type, p.amount_paid, p.month_paid, p.location, p.cashier_name,
       p.voided_at
FROM public.payments p
JOIN public.customers c USING (customer_id)
WHERE c.name ILIKE '%millicent%spark%'
ORDER BY p.payment_date DESC, p.payment_id DESC
LIMIT 30;

-- 3. Where she stands, and what the void will do to it. If status is
--    pending_reconnection AND the balance goes above zero, the app will put
--    her back to disconnected.
SELECT 'EFFECT OF VOIDING' AS check,
       c.customer_id, c.name, c.status, c.monthly_fee,
       b.balance            AS balance_now,
       b.outstanding_balance,
       b.credit_balance,
       (b.balance + 2500.00) AS balance_after_void,
       CASE
           WHEN c.status = 'pending_reconnection' AND (b.balance + 2500.00) > 0
               THEN 'WARNING - the app will return this account to DISCONNECTED'
           WHEN (b.balance + 2500.00) > 0
               THEN 'she will owe money after the void'
           ELSE 'she stays in credit after the void'
       END AS consequence
FROM public.customers c
JOIN public.customer_billing_status b USING (customer_id)
WHERE c.name ILIKE '%millicent%spark%';

-- 4. Is July 2026 charged on her ledger? If the month has a charge and this
--    was the only payment for it, voiding leaves July genuinely unpaid - which
--    is right if the money never arrived, and wrong if it did.
SELECT 'JULY 2026 ON HER LEDGER' AS check,
       l.account_ledger_entry_id, l.effective_date, l.due_date,
       l.entry_type, l.amount, l.source_key
FROM public.account_ledger_entries l
JOIN public.customers c USING (customer_id)
WHERE c.name ILIKE '%millicent%spark%'
  AND COALESCE(l.due_date, l.effective_date) BETWEEN DATE '2026-07-01' AND DATE '2026-08-31'
ORDER BY l.effective_date, l.account_ledger_entry_id;
