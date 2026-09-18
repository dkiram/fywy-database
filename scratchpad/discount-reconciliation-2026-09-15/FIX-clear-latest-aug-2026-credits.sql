-- ============================================================================
-- Clears credit for every account whose LATEST "month paid for" (MAX of
-- payments.month_paid across non-voided Monthly Fee payments, an aggregate -
-- entry order/payment_date/payment id do not matter) is August 2026.
-- Accounts whose latest tagged month is September/October 2026 or later are
-- untouched. This is the write this rule needed; the earlier
-- audit-latest-month-paid-credits.sql only ever reported the numbers - it
-- had no INSERT in it, so toggling its ROLLBACK to COMMIT changed nothing.
--
-- Scope note: two groups from the audit are DELIBERATELY left out, same as
-- flagged before:
--   - latest_is_before_aug_2026 (last payment older than August 2026)
--   - no_monthly_fee_month_paid (credit with no Monthly Fee month tag at all,
--     e.g. pure admin/waiver credit)
-- Neither matches "latest month paid for is August 2026" as stated. If you
-- want those swept too, say so and I'll add them - do not just edit the
-- WHERE clause below without checking, since "before August" and "no month
-- tag at all" are different risk profiles (older debt gap vs. admin intent).
--
-- One 'adjustment' ledger entry per account, amount = credit_balance, dated
-- today - brings balance to exactly 0.00. Does not touch or void the
-- underlying payments. Idempotent via source_key (safe to run twice; the
-- second run inserts nothing new).
--
-- Plain SQL. TablePlus "Run All" or:
--   ssh -p 9222 SPCNAS@100.98.108.77 \
--     'docker exec -i spcl-postgres psql -U spcl_user -d spcl_db' \
--     < scratchpad/discount-reconciliation-2026-09-15/FIX-clear-latest-aug-2026-credits.sql
--
-- LAST LINE IS `ROLLBACK` - rehearsal. Read the BEFORE/AFTER output below,
-- back up, THEN change ROLLBACK -> COMMIT and run again:
--   docker exec -it spcl-backup sh /opt/spcl-deploy/backup.sh   # before COMMIT
-- ============================================================================

BEGIN;

CREATE TEMP TABLE actor ON COMMIT DROP AS
SELECT e.employee_id, e.first_name || ' ' || e.last_name AS actor_name
FROM public.employees e
WHERE e.employee_id = 2;

DO $g$
DECLARE n INTEGER;
BEGIN
    SELECT count(*) INTO n FROM actor;
    IF n <> 1 THEN RAISE EXCEPTION 'employee_id 2 matched % rows, expected 1. Nothing changed.', n; END IF;
END $g$;

CREATE TEMP TABLE targets ON COMMIT DROP AS
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
SELECT ic.customer_id, c.name, ic.credit_balance, lp.latest_month_paid
FROM in_credit ic
JOIN public.customers c USING (customer_id)
JOIN latest_paid lp USING (customer_id)
WHERE lp.latest_month_paid = DATE '2026-08-01';

-- BEFORE: what this run is about to touch.
SELECT COUNT(*) AS accounts, SUM(credit_balance) AS total_credit_to_remove
FROM targets;

SELECT customer_id, name, credit_balance, latest_month_paid
FROM targets
ORDER BY credit_balance DESC;

INSERT INTO public.account_ledger_entries (
    customer_id, entry_type, amount, effective_date, description,
    created_by_employee_id, reason, is_verified, source_key
)
SELECT
    t.customer_id, 'adjustment', t.credit_balance,
    (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
    'Credit removed 2026-09-15: latest Monthly Fee payment tagged to August 2026, no payment for September or later.',
    2,
    'Bulk cleanup: accounts whose latest month_paid is August 2026 carry no evidence of paying past August, so the ledger credit does not represent a real prepayment.',
    TRUE,
    'clear-credit-latest-aug-2026:' || t.customer_id::TEXT
FROM targets t
ON CONFLICT (source_key) DO NOTHING;

-- Guard: every targeted account is now at exactly 0.00.
DO $g$
DECLARE bad INTEGER;
BEGIN
    SELECT count(*) INTO bad
    FROM public.customer_billing_status b
    JOIN targets t USING (customer_id)
    WHERE b.balance <> 0.00;
    IF bad > 0 THEN
        RAISE EXCEPTION '% target account(s) did not land on 0.00 balance. Nothing committed.', bad;
    END IF;
END $g$;

INSERT INTO public.audit_logs (
    employee_id, actor_name, action, entity_type, entity_id,
    field_name, old_value, new_value, reason, occurred_at, source_key
)
SELECT (SELECT employee_id FROM actor), (SELECT actor_name FROM actor),
       'Adjusted account balance', 'customer', t.customer_id::TEXT,
       'balance', (-t.credit_balance)::TEXT, '0.00',
       'Credit removed: latest month paid for is August 2026, no payment for September or later.',
       CURRENT_TIMESTAMP, 'clear-credit-latest-aug-2026:' || t.customer_id::TEXT
FROM targets t
ON CONFLICT (source_key) DO NOTHING;

-- AFTER
SELECT COUNT(*) AS accounts_fixed, SUM(-t.credit_balance) AS total_removed
FROM targets t
JOIN public.customer_billing_status b USING (customer_id)
WHERE b.balance = 0.00;

-- ----------------------------------------------------------------------------
-- ROLLBACK = rehearsal.  COMMIT = for real (back up first).
-- ----------------------------------------------------------------------------
ROLLBACK;
