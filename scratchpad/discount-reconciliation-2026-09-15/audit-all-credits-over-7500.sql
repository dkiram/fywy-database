-- ============================================================================
-- READ ONLY. Every account currently sitting on more than J$7,500 credit,
-- regardless of bucket (not just latest_is_aug_2026). latest_month_paid is
-- shown for context only - it is not filtered on here.
--
-- Writes nothing, opens no transaction.
--
-- Run on the NAS:
--   ssh -p 9222 SPCNAS@100.98.108.77 \
--     'docker exec -i spcl-postgres psql -U spcl_user -d spcl_db' \
--     < scratchpad/discount-reconciliation-2026-09-15/audit-all-credits-over-7500.sql
-- Or paste into TablePlus and "Run All".
-- ============================================================================

WITH in_credit AS (
    SELECT b.customer_id, b.balance, b.credit_balance
    FROM public.customer_billing_status b
    WHERE b.balance < 0
      AND b.credit_balance > 7500
),
latest_paid AS (
    SELECT p.customer_id,
           MAX(DATE_TRUNC('month', p.month_paid))::DATE AS latest_month_paid
    FROM public.payments p
    JOIN in_credit USING (customer_id)
    WHERE p.payment_type = 'Monthly Fee'
      AND p.voided_at IS NULL
      AND p.month_paid IS NOT NULL
    GROUP BY p.customer_id
)
-- Headline
SELECT COUNT(*) AS accounts, SUM(ic.credit_balance) AS total_credit
FROM in_credit ic;

WITH in_credit AS (
    SELECT b.customer_id, b.balance, b.credit_balance
    FROM public.customer_billing_status b
    WHERE b.balance < 0
      AND b.credit_balance > 7500
),
latest_paid AS (
    SELECT p.customer_id,
           MAX(DATE_TRUNC('month', p.month_paid))::DATE AS latest_month_paid
    FROM public.payments p
    JOIN in_credit USING (customer_id)
    WHERE p.payment_type = 'Monthly Fee'
      AND p.voided_at IS NULL
      AND p.month_paid IS NOT NULL
    GROUP BY p.customer_id
)
-- Full list, largest first
SELECT ic.customer_id, c.name, c.status, ic.credit_balance, lp.latest_month_paid
FROM in_credit ic
JOIN public.customers c USING (customer_id)
LEFT JOIN latest_paid lp USING (customer_id)
ORDER BY ic.credit_balance DESC;
