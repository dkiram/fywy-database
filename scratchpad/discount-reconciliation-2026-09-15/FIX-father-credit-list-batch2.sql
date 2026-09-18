-- ============================================================================
-- Second batch from the 2026-09-17 credit list. All three were given as
-- "<amount> credit / Should not have credit", so the target is 0.
--
--    5422 Nicola Morgan Thomas   holds 2,500 -> remove 2,500, leaving 0
--    7855 Jermain Kennedy        holds 3,700 -> remove 3,700, leaving 0
--    6500 Jennieve Rudolph       holds 2,500 -> remove 2,500, leaving 0
--
-- J$8,700 in total. Separate file from
-- FIX-father-credit-list-clear-cases.sql because that one is already
-- committed; re-running it would just report its five accounts as skipped.
--
-- IDENTIFICATION MATTERS HERE. The surname search turned up other accounts
-- holding exactly the same amounts - Nicola Green (4854) and Nicola Taylor
-- (5863) both hold 2,500, as does Rudolph Rose (10455). Each account below
-- was picked by EXACT name match, is pinned by id, and is re-checked against
-- the name on file before anything is written. A near-miss cannot go through.
--
-- Do not confuse 6500 Jennieve Rudolph with 11423 Rudolph Rose #2, who holds
-- J$11,500. That credit was already investigated and is real: four receipts
-- paying October 2026 through January 2027 in advance. Leave it alone.
--
-- Guards: name must match, live credit must equal the figure verified
-- 2026-09-17, and nobody may end up owing money. Idempotent via source_key.
--
-- LAST LINE IS `ROLLBACK` - rehearsal. Read APPLIED and SKIPPED, back up,
-- THEN change ROLLBACK -> COMMIT and run again:
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

CREATE TEMP TABLE requested (
    customer_id     INTEGER PRIMARY KEY,
    expected_name   TEXT,
    expected_credit NUMERIC(14,2),  -- verified live 2026-09-17
    target_credit   NUMERIC(14,2)
) ON COMMIT DROP;

INSERT INTO requested VALUES
(7855, 'Jermain Kennedy',      3700.00, 0.00),
(5422, 'Nicola Morgan Thomas', 2500.00, 0.00),
(6500, 'Jennieve Rudolph',     2500.00, 0.00);

CREATE TEMP TABLE resolved ON COMMIT DROP AS
SELECT r.customer_id,
       r.expected_name,
       c.name                               AS name_on_file,
       r.expected_credit,
       r.target_credit,
       b.credit_balance                     AS live_credit,
       (b.credit_balance - r.target_credit) AS adjustment,
       CASE
           WHEN c.customer_id IS NULL                   THEN 'customer id not found'
           WHEN LOWER(TRIM(c.name)) <> LOWER(TRIM(r.expected_name))
                                                        THEN 'name on file does not match - WRONG ACCOUNT, do not force'
           WHEN b.customer_id IS NULL                   THEN 'no billing status row'
           WHEN b.credit_balance <> r.expected_credit   THEN 'live credit changed since it was verified on 2026-09-17'
           WHEN b.credit_balance - r.target_credit <= 0 THEN 'would not reduce credit'
           ELSE NULL
       END AS skip_reason
FROM requested r
LEFT JOIN public.customers c               ON c.customer_id = r.customer_id
LEFT JOIN public.customer_billing_status b ON b.customer_id = r.customer_id;

-- BEFORE
SELECT 'WILL APPLY' AS outcome, customer_id, name_on_file,
       live_credit AS credit_now, target_credit, adjustment AS removing
FROM resolved WHERE skip_reason IS NULL
ORDER BY adjustment DESC;

SELECT 'SKIPPED' AS outcome, customer_id, expected_name, name_on_file,
       expected_credit AS verified_as, live_credit AS credit_now, skip_reason
FROM resolved WHERE skip_reason IS NOT NULL
ORDER BY customer_id;

INSERT INTO public.account_ledger_entries (
    customer_id, entry_type, amount, effective_date, description,
    created_by_employee_id, reason, is_verified, source_key
)
SELECT r.customer_id, 'adjustment', r.adjustment,
       (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
       'Credit removed on review: the account should not be carrying a credit (account review 2026-09-17).',
       2,
       'Account review 2026-09-17 confirmed this account should not be holding a credit balance. Removed in full; the underlying payments are untouched.',
       TRUE,
       'father-credit-fix-20260917:' || r.customer_id::TEXT
FROM resolved r
WHERE r.skip_reason IS NULL
ON CONFLICT (source_key) DO NOTHING;

-- Guard: landed on target, and nobody owes money.
DO $g$
DECLARE bad INTEGER;
BEGIN
    SELECT count(*) INTO bad
    FROM resolved r
    JOIN public.customer_billing_status b USING (customer_id)
    WHERE r.skip_reason IS NULL
      AND (b.balance <> -r.target_credit OR b.balance > 0);
    IF bad > 0 THEN
        RAISE EXCEPTION '% account(s) did not land on target. Nothing committed.', bad;
    END IF;
END $g$;

INSERT INTO public.audit_logs (
    employee_id, actor_name, action, entity_type, entity_id,
    field_name, old_value, new_value, reason, occurred_at, source_key
)
SELECT (SELECT employee_id FROM actor), (SELECT actor_name FROM actor),
       'Adjusted account balance', 'customer', r.customer_id::TEXT,
       'balance', (-r.live_credit)::TEXT, (-r.target_credit)::TEXT,
       'Credit removed on review: the account should not be carrying a credit balance.',
       CURRENT_TIMESTAMP, 'father-credit-fix-20260917:' || r.customer_id::TEXT
FROM resolved r
WHERE r.skip_reason IS NULL
ON CONFLICT (source_key) DO NOTHING;

-- AFTER
SELECT r.customer_id, r.name_on_file, b.balance AS balance_now
FROM resolved r
JOIN public.customer_billing_status b USING (customer_id)
WHERE r.skip_reason IS NULL
ORDER BY r.customer_id;

-- ----------------------------------------------------------------------------
-- ROLLBACK = rehearsal.  COMMIT = for real (back up first).
-- ----------------------------------------------------------------------------
ROLLBACK;
