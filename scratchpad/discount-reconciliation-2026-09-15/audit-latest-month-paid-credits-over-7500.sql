-- ============================================================================
-- READ ONLY. Drill-down on audit-latest-month-paid-credits.sql: within the
-- "latest month paid for = August 2026" bucket (the one the removal rule
-- targets), which accounts are carrying more than J$7,500 credit?
--
-- Same classification logic as audit-latest-month-paid-credits.sql, run
-- again here so this stands alone. Ends in ROLLBACK - writes nothing.
--
-- Run on the NAS:
--   ssh -p 9222 SPCNAS@100.98.108.77 \
--     'docker exec -i spcl-postgres psql -U spcl_user -d spcl_db' \
--     < scratchpad/discount-reconciliation-2026-09-15/audit-latest-month-paid-credits-over-7500.sql
-- Or paste into TablePlus and "Run All".
-- ============================================================================

BEGIN;

CREATE TEMP TABLE classified ON COMMIT DROP AS
WITH in_credit AS (
    SELECT b.customer_id, b.balance, b.credit_balance
    FROM public.customer_billing_status b
    WHERE b.balance < 0
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
SELECT ic.customer_id, c.name, c.status, ic.balance, ic.credit_balance,
       lp.latest_month_paid,
       CASE
           WHEN lp.latest_month_paid IS NULL              THEN 'no_monthly_fee_month_paid'
           WHEN lp.latest_month_paid = DATE '2026-08-01'  THEN 'latest_is_aug_2026'
           WHEN lp.latest_month_paid >= DATE '2026-09-01' THEN 'latest_is_sep_2026_or_later'
           ELSE                                                 'latest_is_before_aug_2026'
       END AS bucket
FROM in_credit ic
JOIN public.customers c USING (customer_id)
LEFT JOIN latest_paid lp USING (customer_id);

-- ----------------------------------------------------------------------------
-- Headline: how many, and how much, within the removal-target bucket alone.
-- ----------------------------------------------------------------------------
SELECT COUNT(*) AS accounts, SUM(credit_balance) AS total_credit
FROM classified
WHERE bucket = 'latest_is_aug_2026'
  AND credit_balance > 7500;

-- ----------------------------------------------------------------------------
-- Full list, largest credit first.
-- ----------------------------------------------------------------------------
SELECT customer_id, name, status, credit_balance, latest_month_paid
FROM classified
WHERE bucket = 'latest_is_aug_2026'
  AND credit_balance > 7500
ORDER BY credit_balance DESC;

ROLLBACK;
