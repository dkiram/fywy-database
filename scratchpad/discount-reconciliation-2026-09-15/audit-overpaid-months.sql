-- ============================================================================
-- READ ONLY. Which months have been paid for MORE than they cost?
--
-- Two or more receipts for one month is usually innocent - a split payment,
-- where the receipts sum to exactly that month's fee. Denise Williams keying
-- 2 x J$1,500 twenty-one seconds apart against a J$3,000 fee is one payment
-- in two halves, not a duplicate.
--
-- What actually signals a duplicate is receipts EXCEEDING the rate that was in
-- force for that month. This compares against customer_rate_history, not
-- customers.monthly_fee, because the current fee is wrong for an older month
-- (e.g. Robert Murray 2's April 2025).
--
-- Overpaying a month is not automatically an error either - a customer can
-- deliberately pay extra and carry the rest as credit. Same amount, same
-- month, keyed minutes apart is the shape that is not deliberate.
--
-- If a receipt is a genuine duplicate, VOID it in the app rather than
-- adjusting the balance here. A void reverses the credit, posts the
-- payment_void ledger entry and keeps the receipt trail, which is what staff
-- need when the customer asks. An adjustment silently hides the second
-- receipt and the customer's records stop matching ours.
--
-- Writes nothing.
--
-- Run on the NAS:
--   ssh -p 9222 SPCNAS@100.98.108.77 \
--     'docker exec -i spcl-postgres psql -U spcl_user -d spcl_db' \
--     < scratchpad/discount-reconciliation-2026-09-15/audit-overpaid-months.sql
-- ============================================================================

-- 1. Every month since 2026-09-01 whose receipts exceed the rate in force.
--    No LIMIT: this is the whole picture, not the top 60.
WITH paid_months AS (
    SELECT p.customer_id,
           p.month_paid,
           COUNT(*)           AS receipts,
           SUM(p.amount_paid) AS total_paid,
           MIN(p.recorded_at) AS first_keyed,
           MAX(p.recorded_at) AS last_keyed,
           STRING_AGG(p.payment_id::TEXT, ', ' ORDER BY p.payment_id) AS payment_ids,
           STRING_AGG(DISTINCT p.cashier_name, ', ')                  AS cashiers
    FROM public.payments p
    WHERE p.voided_at IS NULL
      AND p.month_paid IS NOT NULL
      AND p.payment_type = 'Monthly Fee'
      AND p.recorded_at >= TIMESTAMP '2026-09-01 00:00:00'
    GROUP BY p.customer_id, p.month_paid
    HAVING COUNT(*) > 1
),
with_rate AS (
    SELECT pm.*,
           c.name,
           c.status,
           c.monthly_fee AS fee_today,
           rate.monthly_fee AS rate_that_month
    FROM paid_months pm
    JOIN public.customers c USING (customer_id)
    LEFT JOIN LATERAL (
        SELECT r.monthly_fee
        FROM public.customer_rate_history r
        WHERE r.customer_id = pm.customer_id
          AND r.effective_date <= pm.month_paid
        ORDER BY r.effective_date DESC, r.customer_rate_history_id DESC
        LIMIT 1
    ) rate ON TRUE
)
SELECT customer_id, name, status, month_paid, receipts,
       total_paid, rate_that_month, fee_today,
       (total_paid - COALESCE(rate_that_month, fee_today)) AS excess,
       last_keyed - first_keyed AS spread,
       payment_ids, cashiers
FROM with_rate
WHERE total_paid > COALESCE(rate_that_month, fee_today)
ORDER BY (total_paid - COALESCE(rate_that_month, fee_today)) DESC;

-- 2. The individual receipts behind the four already flagged, so staff can see
--    exactly which one to void.
SELECT p.customer_id,
       c.name,
       p.payment_id,
       p.receipt_number,
       p.recorded_at,
       p.payment_date,
       p.amount_paid,
       p.month_paid,
       p.cashier_name,
       p.location,
       p.note
FROM public.payments p
JOIN public.customers c USING (customer_id)
WHERE p.voided_at IS NULL
  AND p.customer_id IN (11026, 14258, 9544, 14080)
  AND p.month_paid IS NOT NULL
ORDER BY p.customer_id, p.month_paid, p.recorded_at;

-- 3. Same-amount repeats keyed within five minutes, scored against the rate
--    in force. A row here whose excess is 0 or less is a split payment and
--    can be ignored; anything above 0 is worth a call to the cashier.
WITH rapid AS (
    SELECT p.customer_id, p.month_paid, p.amount_paid,
           COUNT(*) AS receipts,
           MIN(p.recorded_at) AS first_keyed,
           MAX(p.recorded_at) AS last_keyed,
           STRING_AGG(p.payment_id::TEXT, ', ' ORDER BY p.payment_id) AS payment_ids,
           MAX(p.cashier_name) AS cashier
    FROM public.payments p
    WHERE p.voided_at IS NULL
      AND p.month_paid IS NOT NULL
      AND p.recorded_at >= TIMESTAMP '2026-09-01 00:00:00'
    GROUP BY p.customer_id, p.month_paid, p.amount_paid
    HAVING COUNT(*) > 1
       AND MAX(p.recorded_at) - MIN(p.recorded_at) < INTERVAL '5 minutes'
)
SELECT r.customer_id, c.name, r.month_paid, r.amount_paid, r.receipts,
       (r.amount_paid * r.receipts) AS keyed_total,
       rate.monthly_fee             AS rate_that_month,
       (r.amount_paid * r.receipts - rate.monthly_fee) AS excess,
       r.last_keyed - r.first_keyed AS spread,
       r.payment_ids, r.cashier
FROM rapid r
JOIN public.customers c USING (customer_id)
LEFT JOIN LATERAL (
    SELECT rh.monthly_fee
    FROM public.customer_rate_history rh
    WHERE rh.customer_id = r.customer_id
      AND rh.effective_date <= r.month_paid
    ORDER BY rh.effective_date DESC, rh.customer_rate_history_id DESC
    LIMIT 1
) rate ON TRUE
ORDER BY (r.amount_paid * r.receipts - COALESCE(rate.monthly_fee, 0)) DESC;
