-- ============================================================================
-- Corrections from the 2026-09-18 credit list. Unlike earlier batches this one
-- moves in BOTH directions, so every row carries an explicit before/after
-- BALANCE (signed: negative = credit, positive = owing) and the guards are on
-- balance, not credit. Nothing is inferred - every target is your father's.
--
--    6268 Janet Hall Robinson  "she paid the 1000 so just clear the credit of 1500"
--                              -2,500 -> -1,000   (+1,500) removes 1,500 credit, 1,000 stays
--   10995 Rochelle Baker       "remove 3500 credit"
--                              -3,500 ->      0   (+3,500) credit gone
--    8319 Kade Meeks           "add 2500 balance"
--                                   0 -> +2,500   (+2,500) NOW OWES 2,500
--    7848 Yvonne Shields       "add 1000 credit for September"
--                              -2,500 -> -3,500   (-1,000) credit UP
--     525 Kemar Levy           "Should Have A Credit Of $5000"
--                              -4,000 -> -5,000   (-1,000) credit UP
--
-- Kade Meeks matched 8 accounts named Meeks; 8319 is the exact-name match and
-- is the only "Kade". Pinned by id and name-checked below.
--
-- NOT here:
--    8571 Melodie OConnor  message said "clear the credit of 500 and she
--                          should have a balance of 1000", but she holds
--                          1,500 credit now, not 500. Something added 1,000
--                          after the message was written. If that was her
--                          paying the 1,000 she is meant to owe, the target
--                          has already been met. See
--                          audit-melodie-oconnor-8571.sql before deciding.
--
-- Guards: name on file must match, live balance must equal the figure
-- verified 2026-09-19, and each account must land EXACTLY on its target.
-- Idempotent via source_key.
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
    customer_id      INTEGER PRIMARY KEY,
    expected_name    TEXT,
    expected_balance NUMERIC(14,2),  -- verified live 2026-09-19
    target_balance   NUMERIC(14,2),
    instruction      TEXT
) ON COMMIT DROP;

INSERT INTO requested VALUES
( 6268, 'Janet Hall Robinson', -2500.00, -1000.00, 'clear 1,500 of the credit; the 1,000 she paid stays'),
(10995, 'Rochelle Baker',      -3500.00,     0.00, 'remove 3,500 credit'),
( 8319, 'Kade Meeks',              0.00,  2500.00, 'add 2,500 balance'),
( 7848, 'Yvonne Shields',      -2500.00, -3500.00, 'add 1,000 credit for September'),
(  525, 'Kemar Levy',          -4000.00, -5000.00, 'should have a credit of 5,000');

CREATE TEMP TABLE resolved ON COMMIT DROP AS
SELECT r.customer_id,
       r.expected_name,
       c.name                                AS name_on_file,
       c.status,
       r.expected_balance,
       r.target_balance,
       b.balance                             AS live_balance,
       (r.target_balance - b.balance)        AS adjustment,
       r.instruction,
       CASE
           WHEN c.customer_id IS NULL                 THEN 'customer id not found'
           WHEN LOWER(TRIM(c.name)) <> LOWER(TRIM(r.expected_name))
                                                      THEN 'name on file does not match - WRONG ACCOUNT, do not force'
           WHEN b.customer_id IS NULL                 THEN 'no billing status row'
           WHEN b.balance <> r.expected_balance       THEN 'live balance changed since it was verified on 2026-09-19'
           WHEN r.target_balance = b.balance          THEN 'already at target'
           ELSE NULL
       END AS skip_reason
FROM requested r
LEFT JOIN public.customers c               ON c.customer_id = r.customer_id
LEFT JOIN public.customer_billing_status b ON b.customer_id = r.customer_id;

-- BEFORE
SELECT 'WILL APPLY' AS outcome, customer_id, name_on_file, status,
       live_balance AS balance_now, target_balance, adjustment,
       CASE WHEN adjustment > 0 AND target_balance > 0 THEN 'CREATES / INCREASES DEBT'
            WHEN adjustment > 0                        THEN 'removes credit'
            ELSE                                            'ADDS credit' END AS direction,
       instruction
FROM resolved WHERE skip_reason IS NULL
ORDER BY customer_id;

SELECT 'SKIPPED' AS outcome, customer_id, expected_name, name_on_file,
       expected_balance AS verified_as, live_balance AS balance_now, skip_reason
FROM resolved WHERE skip_reason IS NOT NULL
ORDER BY customer_id;

INSERT INTO public.account_ledger_entries (
    customer_id, entry_type, amount, effective_date, description,
    created_by_employee_id, reason, is_verified, source_key
)
SELECT r.customer_id, 'adjustment', r.adjustment,
       (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
       'Balance corrected on review (account review 2026-09-18).',
       2,
       'Account review 2026-09-18: ' || r.instruction || '. The underlying payments are untouched.',
       TRUE,
       'father-credit-fix-20260918:' || r.customer_id::TEXT
FROM resolved r
WHERE r.skip_reason IS NULL
ON CONFLICT (source_key) DO NOTHING;

-- Guard: every account landed exactly on its target.
DO $g$
DECLARE bad INTEGER;
BEGIN
    SELECT count(*) INTO bad
    FROM resolved r
    JOIN public.customer_billing_status b USING (customer_id)
    WHERE r.skip_reason IS NULL
      AND b.balance <> r.target_balance;
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
       'balance', r.live_balance::TEXT, r.target_balance::TEXT,
       'Account review 2026-09-18: ' || r.instruction || '.',
       CURRENT_TIMESTAMP, 'father-credit-fix-20260918:' || r.customer_id::TEXT
FROM resolved r
WHERE r.skip_reason IS NULL
ON CONFLICT (source_key) DO NOTHING;

-- AFTER
SELECT r.customer_id, r.name_on_file, b.balance AS balance_now, r.target_balance AS expected
FROM resolved r
JOIN public.customer_billing_status b USING (customer_id)
WHERE r.skip_reason IS NULL
ORDER BY r.customer_id;

-- ----------------------------------------------------------------------------
-- ROLLBACK = rehearsal.  COMMIT = for real (back up first).
-- ----------------------------------------------------------------------------
ROLLBACK;
