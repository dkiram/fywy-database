-- ============================================================================
-- Read-only: split the "admin_credit" bucket from audit-account-credits.sql
-- into what it really is.
--
-- Since migration 070 a negative 'waiver' ledger row means one of two things:
--   is_credit = TRUE   an Add Credit - money SPCL chose to put on the account.
--                      Stays, no questions.
--   is_credit = FALSE  a discount - money forgiven off what the customer OWED.
--                      A discount can only ever bring a balance down towards
--                      zero; if the account is now in credit, the discount was
--                      bigger than the debt, or was applied to a bill the
--                      customer had already paid.
--
-- For every account in credit that carries an approved, unreversed discount,
-- this works out the balance the moment BEFORE the discount posted and sorts
-- the discount into:
--   owed_nothing          balance was already <= 0: the whole discount is
--                         credit from nowhere.
--   bigger_than_debt      balance was > 0 but smaller than the discount: the
--                         excess is credit from nowhere.
--   paid_after_discount   the discount was smaller than the debt, but the
--                         customer then paid the pre-discount amount anyway.
--                         Real money - decide, don't assume.
--   covered_debt          discount fit inside the debt and nobody overpaid;
--                         the credit comes from something else on the account.
--
-- Run:  docker exec -i spcl-postgres psql -U spcl_user -d spcl_db < audit-waiver-credits.sql
-- Or TablePlus "Run All". Writes nothing (temp table + ROLLBACK).
-- ============================================================================
BEGIN;

CREATE TEMP TABLE waiver_audit ON COMMIT DROP AS
SELECT
    w.waiver_request_id,
    w.customer_id,
    c.name,
    c.status,
    w.is_credit,
    w.amount                         AS waiver_amount,
    w.reason,
    w.review_note,
    (w.reviewed_at AT TIME ZONE 'America/Jamaica')::DATE AS approved_on,
    b.credit_balance                 AS credit_now,
    -- Ledger position the instant before this waiver row was written.
    COALESCE((
        SELECT SUM(l.amount)
        FROM public.account_ledger_entries l
        WHERE l.customer_id = w.customer_id
          AND l.account_ledger_entry_id < w.waiver_ledger_entry_id
    ), 0)::NUMERIC(14,2)             AS balance_before,
    -- Payments that landed after the discount.
    COALESCE((
        SELECT -SUM(l.amount)
        FROM public.account_ledger_entries l
        WHERE l.customer_id = w.customer_id
          AND l.entry_type IN ('monthly_payment','reconnection_payment')
          AND l.account_ledger_entry_id > w.waiver_ledger_entry_id
    ), 0)::NUMERIC(14,2)             AS paid_after
FROM public.waiver_requests w
JOIN public.customers c USING (customer_id)
JOIN public.customer_billing_status b USING (customer_id)
WHERE w.status = 'approved'
  AND w.waiver_ledger_entry_id IS NOT NULL
  AND b.balance < 0;

ALTER TABLE waiver_audit ADD COLUMN class TEXT;
UPDATE waiver_audit SET class =
    CASE
        WHEN is_credit                          THEN 'admin_credit'
        WHEN balance_before <= 0                THEN 'owed_nothing'
        WHEN balance_before < waiver_amount     THEN 'bigger_than_debt'
        WHEN paid_after > 0                     THEN 'paid_after_discount'
        ELSE                                         'covered_debt'
    END;

-- 1. The split that answers "how much of the J$2.4M is real admin credit".
SELECT class,
       COUNT(DISTINCT customer_id) AS accounts,
       COUNT(*)                    AS waivers,
       SUM(waiver_amount)          AS waiver_total,
       SUM(CASE WHEN class = 'owed_nothing'     THEN waiver_amount
                WHEN class = 'bigger_than_debt' THEN waiver_amount - balance_before
                ELSE 0 END)        AS credit_from_nowhere
FROM waiver_audit
GROUP BY ROLLUP (class)
ORDER BY class NULLS LAST;

-- 2. Which bulk runs / reasons the discounts came from.
SELECT class, LEFT(reason, 60) AS reason, LEFT(review_note, 60) AS review_note,
       COUNT(*) AS waivers, SUM(waiver_amount) AS total
FROM waiver_audit
WHERE NOT is_credit
GROUP BY 1, 2, 3
ORDER BY waivers DESC
LIMIT 30;

-- 3. When they were approved.
SELECT class, approved_on, COUNT(*) AS waivers, SUM(waiver_amount) AS total
FROM waiver_audit
GROUP BY 1, 2
ORDER BY approved_on DESC, class;

-- 4. Every discount that made credit from nowhere, largest first.
SELECT waiver_request_id, customer_id, name, status, class,
       waiver_amount, balance_before, paid_after, credit_now,
       approved_on, LEFT(reason, 50) AS reason, LEFT(review_note, 40) AS review_note
FROM waiver_audit
WHERE class IN ('owed_nothing', 'bigger_than_debt')
ORDER BY waiver_amount DESC, customer_id;

-- 5. Discounts where the customer paid the pre-discount amount anyway.
SELECT waiver_request_id, customer_id, name, status,
       waiver_amount, balance_before, paid_after, credit_now,
       approved_on, LEFT(reason, 50) AS reason
FROM waiver_audit
WHERE class = 'paid_after_discount'
ORDER BY credit_now DESC;

ROLLBACK;
