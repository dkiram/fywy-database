-- ============================================================================
-- READ ONLY. Answers one question: of the accounts currently sitting on a
-- credit (balance < 0), how many have a LATEST "month paid for" of August
-- 2026 (i.e. they have not yet paid for September or later)?
--
-- "Latest month paid for" = MAX(payments.month_paid) across that customer's
-- non-voided Monthly Fee payments, truncated to the calendar month. This is
-- an aggregate MAX(), so it is independent of the order rows were entered,
-- payment_date, or payment id - only the tagged month itself matters.
--
-- The classification is materialized into a TEMP table so all three report
-- queries below see the same snapshot (a WITH ... AS CTE only lives for the
-- one statement it's attached to - reusing it across semicolons, as an
-- earlier version of this script tried to do, fails with "relation does not
-- exist"). Everything ends in ROLLBACK: nothing is written. The only reason
-- this needs BEGIN/ROLLBACK at all rather than plain SELECTs is that
-- Postgres refuses CREATE TEMP TABLE inside a read-only transaction.
--
-- Run on the NAS:
--   ssh -p 9222 SPCNAS@100.98.108.77 \
--     'docker exec -i spcl-postgres psql -U spcl_user -d spcl_db' \
--     < scratchpad/discount-reconciliation-2026-09-15/audit-latest-month-paid-credits.sql
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
           WHEN lp.latest_month_paid IS NULL             THEN 'no_monthly_fee_month_paid'
           WHEN lp.latest_month_paid = DATE '2026-08-01' THEN 'latest_is_aug_2026'
           WHEN lp.latest_month_paid >= DATE '2026-09-01' THEN 'latest_is_sep_2026_or_later'
           ELSE                                                'latest_is_before_aug_2026'
       END AS bucket
FROM in_credit ic
JOIN public.customers c USING (customer_id)
LEFT JOIN latest_paid lp USING (customer_id);

-- ----------------------------------------------------------------------------
-- 1. Headline: this is the count/total the removal rule as described would
--    touch (latest_is_aug_2026), next to the other buckets for context.
--    latest_is_before_aug_2026 and no_monthly_fee_month_paid are NOT covered
--    by "August 2026 or September/October 2026" as stated - listed separately
--    so nothing ambiguous gets swept in silently.
-- ----------------------------------------------------------------------------
SELECT bucket,
       COUNT(*)                      AS accounts,
       SUM(credit_balance)           AS total_credit,
       ROUND(AVG(credit_balance), 2) AS avg_credit
FROM classified
GROUP BY ROLLUP (bucket)
ORDER BY total_credit DESC NULLS LAST;

-- ----------------------------------------------------------------------------
-- 2. Same split, by current account status (a disconnected/offline account
--    holding "credit" behaves differently than an active one).
-- ----------------------------------------------------------------------------
SELECT bucket, status, COUNT(*) AS accounts, SUM(credit_balance) AS total_credit
FROM classified
GROUP BY bucket, status
ORDER BY bucket, total_credit DESC;

-- ----------------------------------------------------------------------------
-- 3. Full list of the accounts the stated rule would remove credit from
--    (latest month paid for = August 2026 exactly).
-- ----------------------------------------------------------------------------
SELECT customer_id, name, status, credit_balance, latest_month_paid
FROM classified
WHERE bucket = 'latest_is_aug_2026'
ORDER BY credit_balance DESC;

ROLLBACK;
