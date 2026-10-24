-- ============================================================================
-- Corrections from the 2026-10-13 list. All five clear to 0.00, and all five
-- are pinned by customer id.
--
--    563 Dawn Johnson            -       "no credit should be on"   (id given)
--   7377 Donavan Charles Brooks  4,000   remove the credit
--  14658 Doret Baker             2,500   remove the credit
--  10559 Dana Watson             -       "clear credit"             (id given)
--   2956 Daunly Morris           -       "clear the credit, there shouldnt be
--                                         any"                      (id given)
--
-- Every name is name-checked against the id as well, so a transposed digit
-- cannot quietly hit someone else.
--
-- TWO OF THESE WERE LARGE DEBTS IN SEPTEMBER AND ARE NOW IN CREDIT:
--    563 Dawn Johnson was DISCONNECTED owing J$5,000 in the 2026-09-15 review
--        files, targeted to 0.
--  14658 Doret Baker was DISCONNECTED owing J$67,500 - one of the largest
--        single adjustments in the whole reconciliation - and was also
--        targeted to 0.
-- Both have since crossed zero into credit. That is not suspicious on its own
-- (the reconciliation zeroed them and then payments landed), but Doret Baker
-- in particular went from a 67,500 debt to holding credit inside a month, so
-- her row is worth reading before you commit. The script zeroes whatever is
-- actually there and the `direction` column says which way it went.
--
-- SAFE TO RE-RUN: anything already carrying this batch's source_key is
-- skipped. Temp tables are named fix1013_* so they cannot collide with another
-- script's leftovers in the same session.
--
-- LAST LINE IS `ROLLBACK` - rehearsal. Read every block, back up,
-- THEN change ROLLBACK -> COMMIT and run again:
--   docker exec -it spcl-backup sh /opt/spcl-deploy/backup.sh   # before COMMIT
-- ============================================================================

BEGIN;

DROP TABLE IF EXISTS fix1013_wanted, fix1013_resolved;

CREATE TEMP TABLE fix1013_actor ON COMMIT DROP AS
SELECT e.employee_id, e.first_name || ' ' || e.last_name AS actor_name
FROM public.employees e
WHERE e.employee_id = 2;

DO $g$
DECLARE n INTEGER;
BEGIN
    SELECT count(*) INTO n FROM fix1013_actor;
    IF n <> 1 THEN RAISE EXCEPTION 'employee_id 2 matched % rows, expected 1. Nothing changed.', n; END IF;
END $g$;

CREATE TEMP TABLE fix1013_wanted (
    customer_id   INTEGER PRIMARY KEY,
    expected_name TEXT,
    father_said   NUMERIC(14,2),
    instruction   TEXT
) ON COMMIT DROP;

INSERT INTO fix1013_wanted VALUES
(  563, 'Dawn Johnson',              NULL, 'no credit should be on this account'),
( 7377, 'Donavan Charles Brooks', 4000.00, 'remove the 4,000 credit'),
(14658, 'Doret Baker',            2500.00, 'remove the 2,500 credit'),
(10559, 'Dana Watson',                NULL, 'clear the credit'),
( 2956, 'Daunly Morris',               NULL, 'clear the credit, there should not be any');

CREATE TEMP TABLE fix1013_resolved ON COMMIT DROP AS
SELECT w.customer_id,
       w.expected_name,
       c.name           AS name_on_file,
       c.status,
       c.monthly_fee,
       w.father_said,
       w.instruction,
       b.balance        AS live_balance,
       b.credit_balance AS credit_now,
       (-b.balance)     AS adjustment,
       CASE
           WHEN EXISTS (SELECT 1 FROM public.account_ledger_entries l
                        WHERE l.source_key = 'father-credit-fix-20261013:' || w.customer_id::TEXT)
                                      THEN 'already applied in an earlier run of this batch'
           WHEN c.customer_id IS NULL THEN 'customer id not found'
           WHEN LOWER(TRIM(c.name)) <> LOWER(TRIM(w.expected_name))
                                      THEN 'name on file does not match - WRONG ACCOUNT, do not force'
           WHEN b.customer_id IS NULL THEN 'no billing status row'
           WHEN b.balance = 0         THEN 'already at zero - nothing to do'
           ELSE NULL
       END AS skip_reason
FROM fix1013_wanted w
LEFT JOIN public.customers c               ON c.customer_id = w.customer_id
LEFT JOIN public.customer_billing_status b ON b.customer_id = w.customer_id;

-- THE BLOCK TO READ.
SELECT 'WILL APPLY' AS check, customer_id, name_on_file, status, monthly_fee,
       live_balance AS balance_now, adjustment, 0.00 AS balance_after,
       CASE WHEN live_balance < 0 THEN 'removes credit'
            ELSE                       'FORGIVES DEBT - gives money away' END AS direction,
       father_said,
       CASE WHEN father_said IS NULL        THEN 'no figure quoted'
            WHEN father_said = credit_now   THEN 'matches what he said'
            ELSE 'DIFFERS from what he said - look' END AS figure_check,
       instruction
FROM fix1013_resolved WHERE skip_reason IS NULL
ORDER BY live_balance, customer_id;

SELECT 'SKIPPED' AS check, customer_id, expected_name, name_on_file, status,
       live_balance AS balance_now, credit_now, father_said, skip_reason
FROM fix1013_resolved WHERE skip_reason IS NOT NULL
ORDER BY customer_id;

INSERT INTO public.account_ledger_entries (
    customer_id, entry_type, amount, effective_date, description,
    created_by_employee_id, reason, is_verified, source_key
)
SELECT r.customer_id, 'adjustment', r.adjustment,
       (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
       CASE WHEN r.live_balance > 0
            THEN 'Outstanding balance cleared at management instruction (account review 2026-10-13).'
            ELSE 'Credit removed on review: the account should not be carrying a credit (account review 2026-10-13).' END,
       2,
       CASE WHEN r.live_balance > 0
            THEN 'Management instruction 2026-10-13: ' || r.instruction || '. This forgives money owed. The underlying charges and payments are left on the ledger.'
            ELSE 'Account review 2026-10-13: ' || r.instruction || '. Removed in full; the underlying payments are untouched.' END,
       TRUE,
       'father-credit-fix-20261013:' || r.customer_id::TEXT
FROM fix1013_resolved r
WHERE r.skip_reason IS NULL
ON CONFLICT (source_key) DO NOTHING;

DO $g$
DECLARE bad INTEGER;
BEGIN
    SELECT count(*) INTO bad
    FROM fix1013_resolved r
    JOIN public.customer_billing_status b USING (customer_id)
    WHERE r.skip_reason IS NULL
      AND b.balance <> 0.00;
    IF bad > 0 THEN
        RAISE EXCEPTION '% account(s) did not land on 0.00. Nothing committed.', bad;
    END IF;
END $g$;

INSERT INTO public.audit_logs (
    employee_id, actor_name, action, entity_type, entity_id,
    field_name, old_value, new_value, reason, occurred_at, source_key
)
SELECT (SELECT employee_id FROM fix1013_actor), (SELECT actor_name FROM fix1013_actor),
       CASE WHEN r.live_balance > 0 THEN 'Wrote off account balance'
            ELSE                        'Adjusted account balance' END,
       'customer', r.customer_id::TEXT,
       'balance', r.live_balance::TEXT, '0.00',
       CASE WHEN r.live_balance > 0
            THEN 'Management instruction 2026-10-13: outstanding balance of J$' || r.live_balance::TEXT || ' cleared. Money owed was forgiven.'
            ELSE 'Account review 2026-10-13: credit removed, the account should not be carrying one.' END,
       CURRENT_TIMESTAMP, 'father-credit-fix-20261013:' || r.customer_id::TEXT
FROM fix1013_resolved r
WHERE r.skip_reason IS NULL
ON CONFLICT (source_key) DO NOTHING;

SELECT 'AFTER' AS check, r.customer_id, r.name_on_file, b.balance AS balance_now
FROM fix1013_resolved r
JOIN public.customer_billing_status b USING (customer_id)
WHERE r.skip_reason IS NULL
ORDER BY r.customer_id;

-- ----------------------------------------------------------------------------
-- ROLLBACK = rehearsal.  COMMIT = for real (back up first).
-- ----------------------------------------------------------------------------
ROLLBACK;
