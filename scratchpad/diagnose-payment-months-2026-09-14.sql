-- Run this file on the same database where the correction failed.
-- Clears the failed correction transaction; the SELECT changes no records.
-- Send back the result, including match counts and recent_payments.
ROLLBACK;

WITH requested AS (
    SELECT c.customer_id, c.name, 'Zhanay: latest two July payments collected 2026-09-14' AS requested_change,
           2 AS needed, DATE '2026-07-01' AS old_month, DATE '2026-09-14' AS collected_on,
           TRUE AS choose_latest
    FROM public.customers c
    WHERE LOWER(REGEXP_REPLACE(TRIM(c.name), '\s+', ' ', 'g')) = 'zhanay williams'
    UNION ALL
    SELECT c.customer_id, c.name, r.requested_change, 1, r.old_month, r.collected_on, r.choose_latest
    FROM (VALUES
        (13976, 'Void August payment collected 2026-08-18', DATE '2026-08-01', DATE '2026-08-18', FALSE),
        (6461, 'Latest July payment to September (final instruction)', DATE '2026-07-01', NULL::DATE, TRUE),
        (13856, 'September payment to August', DATE '2026-09-01', NULL::DATE, FALSE)
    ) r(customer_id, requested_change, old_month, collected_on, choose_latest)
    LEFT JOIN public.customers c ON c.customer_id = r.customer_id
), diagnostics AS (
    SELECT r.*,
           (SELECT COUNT(*) FROM public.payments p
            WHERE p.customer_id = r.customer_id
              AND DATE_TRUNC('month', p.month_paid) = r.old_month
              AND (r.collected_on IS NULL OR p.payment_date = r.collected_on)
              AND COALESCE(p.payment_type, p.legacy_payment_type) = 'Monthly Fee'
              AND p.voided_at IS NULL) AS matching_payments,
           (SELECT JSONB_AGG(TO_JSONB(recent) ORDER BY recent.payment_date DESC, recent.payment_id DESC)
            FROM (
                SELECT p.payment_id, p.payment_date, p.recorded_at, p.month_paid,
                       p.payment_type, p.legacy_payment_type, p.amount_paid,
                       p.voided_at, p.location, p.cashier_name
                FROM public.payments p WHERE p.customer_id = r.customer_id
                ORDER BY p.payment_date DESC, p.payment_id DESC LIMIT 30
            ) recent) AS recent_payments
    FROM requested r
)
SELECT customer_id, name, requested_change, needed, matching_payments,
       CASE WHEN customer_id IS NULL THEN 'CUSTOMER NOT FOUND'
            WHEN choose_latest AND matching_payments >= needed THEN 'MATCH OK (latest selected)'
            WHEN NOT choose_latest AND matching_payments = needed THEN 'MATCH OK'
            WHEN matching_payments < needed THEN 'MISSING PAYMENT: inspect dates, months, types, and void status'
            ELSE 'MULTIPLE PAYMENTS: exact payment ID needed'
       END AS result,
       recent_payments
FROM diagnostics ORDER BY customer_id;
