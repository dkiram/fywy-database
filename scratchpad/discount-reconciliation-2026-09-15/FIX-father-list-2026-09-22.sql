-- ============================================================================
-- Corrections from the 2026-09-22 credit list. Guards are on signed BALANCE
-- (negative = credit, positive = owing). Every target is your father's.
--
--   10704 Annakay Simpson   "clear credit of 5000"
--                           -5,000 ->      0   (+5,000)
--    5706 Vanessa Francis   "only 2500 credit"
--                           -5,000 -> -2,500   (+2,500)
--    2363 Pauline Kennedy   "remove 4000 credit"
--                           -4,000 ->      0   (+4,000)
--    6855 kajay Brown       "no credit"
--                           -3,500 ->      0   (+3,500)
--   10075 Abigail Greaves   "remove 3000 credit"
--                           -3,000 ->      0   (+3,000)
--   14777 Kymani Bruce      "remove 2500 credit add 1000 balance"
--                           -2,500 -> +1,000   (+3,500)  NOW OWES
--    9613 Kedda Chaplin     "remove 1000 credit"
--                           -1,000 ->      0   (+1,000)
--
-- IDENTIFICATION. Two names matched several accounts and were resolved by
-- exact name, then pinned by id and re-checked against the name on file:
--   Kedda Chaplin -> 9613. Twelve Chaplins matched; 9613 is the only Kedda
--     AND the only one holding exactly the J$1,000 in the message.
--   Kymani Bruce  -> 14777. The other hit was Kymani Leslie, a different
--     surname entirely.
--
-- Pauline Kennedy (2363) held NO credit when the Kennedys were resolved on
-- 2026-09-17; she now holds exactly the 4,000 in the message. The account is
-- right - her balance simply moved in between.
--
-- kajay Brown (6855) was disconnected owing 5,000 in the 2026-09-15 review
-- files and is now active holding 3,500 credit. Also just movement, but it is
-- the biggest swing in this batch, so the BEFORE block is worth reading.
--
-- Guards: name on file must match, live balance must equal the figure
-- verified 2026-09-22, and each account must land EXACTLY on its target.
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
    expected_balance NUMERIC(14,2),  -- verified live 2026-09-22
    target_balance   NUMERIC(14,2),
    instruction      TEXT
) ON COMMIT DROP;

INSERT INTO requested VALUES
(10704, 'Annakay Simpson', -5000.00,     0.00, 'clear the 5,000 credit'),
( 5706, 'Vanessa Francis', -5000.00, -2500.00, 'should have only 2,500 credit'),
( 2363, 'Pauline Kennedy', -4000.00,     0.00, 'remove the 4,000 credit'),
( 6855, 'kajay Brown',     -3500.00,     0.00, 'should have no credit'),
(10075, 'Abigail Greaves', -3000.00,     0.00, 'remove the 3,000 credit'),
(14777, 'Kymani Bruce',    -2500.00,  1000.00, 'remove the 2,500 credit and add 1,000 balance'),
( 9613, 'Kedda Chaplin',   -1000.00,     0.00, 'remove the 1,000 credit');

CREATE TEMP TABLE resolved ON COMMIT DROP AS
SELECT r.customer_id,
       r.expected_name,
       c.name                         AS name_on_file,
       c.status,
       r.expected_balance,
       r.target_balance,
       b.balance                      AS live_balance,
       (r.target_balance - b.balance) AS adjustment,
       r.instruction,
       CASE
           WHEN c.customer_id IS NULL             THEN 'customer id not found'
           WHEN LOWER(TRIM(c.name)) <> LOWER(TRIM(r.expected_name))
                                                  THEN 'name on file does not match - WRONG ACCOUNT, do not force'
           WHEN b.customer_id IS NULL             THEN 'no billing status row'
           WHEN b.balance <> r.expected_balance   THEN 'live balance changed since it was verified on 2026-09-22'
           WHEN r.target_balance = b.balance      THEN 'already at target'
           ELSE NULL
       END AS skip_reason
FROM requested r
LEFT JOIN public.customers c               ON c.customer_id = r.customer_id
LEFT JOIN public.customer_billing_status b ON b.customer_id = r.customer_id;

-- BEFORE
SELECT 'WILL APPLY' AS outcome, customer_id, name_on_file, status,
       live_balance AS balance_now, target_balance, adjustment,
       CASE WHEN target_balance > 0 THEN 'CREATES DEBT'
            WHEN adjustment > 0     THEN 'removes credit'
            ELSE                         'ADDS credit' END AS direction,
       instruction
FROM resolved WHERE skip_reason IS NULL
ORDER BY adjustment DESC, customer_id;

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
       'Balance corrected on review (account review 2026-09-22).',
       2,
       'Account review 2026-09-22: ' || r.instruction || '. The underlying payments are untouched.',
       TRUE,
       'father-credit-fix-20260922:' || r.customer_id::TEXT
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
       'Account review 2026-09-22: ' || r.instruction || '.',
       CURRENT_TIMESTAMP, 'father-credit-fix-20260922:' || r.customer_id::TEXT
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
