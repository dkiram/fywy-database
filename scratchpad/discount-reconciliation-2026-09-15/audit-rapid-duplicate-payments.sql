-- ============================================================================
-- READ ONLY. Are the rapid repeat receipts on 11423 and 12832 four/two months
-- paid in advance, or the same month keyed more than once?
--
--   11423 Rudolph Rose #2   4 x J$2,500 within 49 seconds on 2026-09-16
--                           (payments 442439, 442440, 442441, 442442)
--   12832 Tanyalee Campbell 2 x J$1,500 within 12 seconds on 2026-09-17
--                           (payments 442852, 442853)
--
-- month_paid settles it. FOUR DIFFERENT months = a customer paying ahead,
-- entered one receipt per month, which is the normal counter workflow. The
-- SAME month twice = duplicates, and the extra receipts should be voided
-- rather than adjusted away (a void reverses the credit and leaves the
-- receipt trail intact).
--
-- Both accounts' balances are already fully explained, and the over-credit
-- fix landed correctly on each - this is a separate question about the
-- receipts themselves.
--
-- Writes nothing.
--
-- Run on the NAS:
--   ssh -p 9222 SPCNAS@100.98.108.77 \
--     'docker exec -i spcl-postgres psql -U spcl_user -d spcl_db' \
--     < scratchpad/discount-reconciliation-2026-09-15/audit-rapid-duplicate-payments.sql
-- ============================================================================

-- 1. The receipts on those two accounts. Read the month_paid column.
SELECT p.customer_id,
       c.name,
       p.payment_id,
       p.receipt_number,
       p.recorded_at,
       p.payment_date,
       p.payment_type,
       p.amount_paid,
       p.month_paid,
       p.voided_at,
       p.cashier_name,
       p.location
FROM public.payments p
JOIN public.customers c USING (customer_id)
WHERE p.customer_id IN (11423, 12832)
  AND p.payment_date >= DATE '2026-09-15'
ORDER BY p.customer_id, p.recorded_at, p.payment_id;

-- 2. Same question across the whole system since 2026-09-01: non-voided
--    receipts that share customer + month_paid + amount and were keyed within
--    five minutes of each other. Those are duplicates, not advance payments -
--    an advance payment carries a different month on each receipt.
SELECT p.customer_id,
       c.name,
       p.month_paid,
       p.amount_paid,
       COUNT(*)                       AS receipts,
       MIN(p.recorded_at)             AS first_keyed,
       MAX(p.recorded_at)             AS last_keyed,
       MAX(p.recorded_at) - MIN(p.recorded_at) AS spread,
       STRING_AGG(p.payment_id::TEXT, ', ' ORDER BY p.payment_id) AS payment_ids,
       MAX(p.cashier_name)            AS cashier
FROM public.payments p
JOIN public.customers c USING (customer_id)
WHERE p.voided_at IS NULL
  AND p.month_paid IS NOT NULL
  AND p.recorded_at >= TIMESTAMP '2026-09-01 00:00:00'
GROUP BY p.customer_id, c.name, p.month_paid, p.amount_paid
HAVING COUNT(*) > 1
   AND MAX(p.recorded_at) - MIN(p.recorded_at) < INTERVAL '5 minutes'
ORDER BY COUNT(*) DESC, p.amount_paid DESC;

-- 3. Wider net, same period: any account with two or more non-voided receipts
--    for the SAME month, however far apart they were keyed. Catches a
--    duplicate re-keyed hours or days later.
SELECT p.customer_id,
       c.name,
       p.month_paid,
       COUNT(*)            AS receipts,
       SUM(p.amount_paid)  AS total_for_that_month,
       MAX(c.monthly_fee)  AS monthly_fee,
       STRING_AGG(p.payment_id::TEXT, ', ' ORDER BY p.payment_id) AS payment_ids
FROM public.payments p
JOIN public.customers c USING (customer_id)
WHERE p.voided_at IS NULL
  AND p.month_paid IS NOT NULL
  AND p.payment_type = 'Monthly Fee'
  AND p.recorded_at >= TIMESTAMP '2026-09-01 00:00:00'
GROUP BY p.customer_id, c.name, p.month_paid
HAVING COUNT(*) > 1
ORDER BY SUM(p.amount_paid) DESC
LIMIT 60;
