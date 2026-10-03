-- ============================================================================
-- The three resolvable items from the 2026-09-29 list that are not
-- clear-to-zero. Guards are on signed BALANCE (negative = credit, positive =
-- owing) because these move in different directions.
--
--    4741 Ryan Morris    "add 1950 to balance"
--                          +550 -> +2,500   (+1,950)  INCREASES DEBT
--    8509 Delano King    "change credit to 5000"
--                        -7,500 -> -5,000   (+2,500)  removes credit
--     740 Curtis Davy    "should have a $2000 credit"
--                             0 -> -2,000   (-2,000)  ADDS CREDIT
--
-- NOTES ON EACH
--
-- Ryan Morris 4741 is an exact name match. His fee is 2,500 and he owes 550,
-- so adding 1,950 puts him at exactly one month owed - which is consistent
-- with a part-paid month being corrected to the full amount. (The search also
-- turned up "KerryAnn Morris" 13409, because "Ker-RYANN MORRIS" contains the
-- pattern. Not the same person; ignored.)
--
-- Delano King 8509: THE MESSAGE SAID "Dekano King" AND THE ACCOUNT IS
-- "Delano King". One letter apart (k/l) on the account number your father
-- himself supplied, holding 7,500 credit where he asked for 5,000 - so it is
-- almost certainly a typo for the same person. The guard below accepts
-- "Delano King" deliberately. If 8509 is NOT who he meant, stop and tell me.
--
-- Curtis Davy 740 is the only one here that gives a customer money, and it is
-- included because two independent sources agree on the figure: your father
-- asked for a 2,000 credit, and the 2026-09-15 reconciliation had already
-- targeted this account at exactly -2,000 (see FINAL-review.md). He now sits
-- at 0.00, so that target was either never applied or has since been consumed.
-- His monthly fee has also gone 3,000 -> 5,000 since the review, so his
-- position has moved; the guard pins the balance at exactly 0.00.
--
-- NOT HERE - both need a decision first, see
-- audit-father-list-2026-09-29-review.sql and the notes sent with it:
--   Michel Bryan York  two accounts share that exact name, the live debt is
--                      76,500 not 76,100, and it is 32 unpaid monthly charges
--                      over two and a half years. A write-off that size is not
--                      a daily credit tidy-up.
--   Beverley           45 accounts match on the first name alone.
--
-- Guards: name on file must match, live balance must equal the figure verified
-- 2026-09-29, and each must land EXACTLY on its target. Idempotent via
-- source_key.
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
    expected_balance NUMERIC(14,2),  -- verified live 2026-09-29
    target_balance   NUMERIC(14,2),
    instruction      TEXT
) ON COMMIT DROP;

INSERT INTO requested VALUES
(4741, 'Ryan Morris',   550.00,  2500.00, 'add 1,950 to the balance'),
(8509, 'Delano King', -7500.00, -5000.00, 'change the credit to 5,000'),
( 740, 'Curtis Davy',     0.00, -2000.00, 'should have a 2,000 credit');

CREATE TEMP TABLE resolved ON COMMIT DROP AS
SELECT r.customer_id,
       r.expected_name,
       c.name                         AS name_on_file,
       c.status,
       c.monthly_fee,
       r.expected_balance,
       r.target_balance,
       b.balance                      AS live_balance,
       (r.target_balance - b.balance) AS adjustment,
       r.instruction,
       CASE
           WHEN c.customer_id IS NULL           THEN 'customer id not found'
           WHEN LOWER(TRIM(c.name)) <> LOWER(TRIM(r.expected_name))
                                                THEN 'name on file does not match - WRONG ACCOUNT, do not force'
           WHEN b.customer_id IS NULL           THEN 'no billing status row'
           WHEN b.balance <> r.expected_balance THEN 'live balance changed since it was verified on 2026-09-29'
           WHEN r.target_balance = b.balance    THEN 'already at target'
           ELSE NULL
       END AS skip_reason
FROM requested r
LEFT JOIN public.customers c               ON c.customer_id = r.customer_id
LEFT JOIN public.customer_billing_status b ON b.customer_id = r.customer_id;

-- BEFORE
SELECT 'WILL APPLY' AS outcome, customer_id, name_on_file, status, monthly_fee,
       live_balance AS balance_now, target_balance, adjustment,
       CASE WHEN adjustment < 0                            THEN 'ADDS CREDIT - gives money'
            WHEN target_balance > 0 AND live_balance > 0    THEN 'INCREASES DEBT'
            WHEN target_balance > 0                         THEN 'CREATES DEBT'
            ELSE                                                 'removes credit' END AS direction,
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
       'Balance corrected on review (account review 2026-09-29).',
       2,
       'Account review 2026-09-29: ' || r.instruction || '. The underlying payments are untouched.',
       TRUE,
       'father-credit-fix-20260929:' || r.customer_id::TEXT
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
       'Account review 2026-09-29: ' || r.instruction || '.',
       CURRENT_TIMESTAMP, 'father-credit-fix-20260929:' || r.customer_id::TEXT
FROM resolved r
WHERE r.skip_reason IS NULL
ON CONFLICT (source_key) DO NOTHING;

-- AFTER
SELECT 'AFTER' AS check, r.customer_id, r.name_on_file, b.balance AS balance_now,
       r.target_balance AS expected
FROM resolved r
JOIN public.customer_billing_status b USING (customer_id)
WHERE r.skip_reason IS NULL
ORDER BY r.customer_id;

-- ----------------------------------------------------------------------------
-- ROLLBACK = rehearsal.  COMMIT = for real (back up first).
-- ----------------------------------------------------------------------------
ROLLBACK;
