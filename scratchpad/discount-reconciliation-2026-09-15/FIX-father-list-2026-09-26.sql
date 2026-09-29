-- ============================================================================
-- Corrections from the 2026-09-26 list. TWO DIFFERENT OPERATIONS - read the
-- mode column.
--
-- CLEAR (balance to 0) - "please clear credit of X for ...":
--        Nicholas Nelson         2,500
--        Khallil Reckley         3,000
--        Sashel Howe             5,000
--  10991 Louise Richards Letts   2,600   (pinned - see note below)
--  14548 Remone Rainford         1,500   (pinned - see note below)
--        Christine Lawrence      2,500
--        Nordia Letts            2,500   WILL SKIP - already at 0.00
--   6304 Tashana Bryan             500   WILL SKIP - she OWES 500, not holding it
--
-- REDUCE (take a fixed amount off, keep the rest):
--        Robert Powell         2,500   "remove 2500 FROM the credit"
--
-- Robert Powell's wording is the odd one out and it means something different.
-- Everything else names the amount the account happens to hold and asks for it
-- gone; his asks for 2,500 to come OFF a credit that may be larger. If he
-- holds 5,000 he keeps 2,500. If he holds less than 2,500 the row is SKIPPED
-- rather than pushing him into debt.
--
-- *** TWO ROBERT POWELLS. *** The review files show "Robert Powell" (7001)
-- AND "Robert Powell #2" (13714). Exact-match picks 7001, which is what the
-- message says, but check the ALL CANDIDATES block - if your father meant the
-- #2 account, tell me and I will pin 13714 instead. Same shape as the Shanel
-- Taylor question on 2026-09-24.
--
-- No ids for the other eight, so the script resolves them: loose search, then
-- PREFER AN EXACT NAME MATCH where one exists. Powell, Lawrence and Nelson
-- are all common surnames here. A name resolving to 0 or 2+ accounts is
-- SKIPPED with its candidates listed, never guessed.
--
-- Guards: exactly one account per name, it must be in credit, and it must land
-- EXACTLY on its target - 0 for a clear, credit-minus-amount for a reduce.
-- Nothing here can put anyone into debt. Idempotent via source_key.
--
-- LAST LINE IS `ROLLBACK` - rehearsal. Read every block, back up,
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

-- mode 'clear'  = take the whole credit to 0; father_said is what he quoted.
-- mode 'reduce' = take exactly father_said off the credit and keep the rest.
CREATE TEMP TABLE wanted (
    label       TEXT PRIMARY KEY,
    known_id    INTEGER,
    pattern     TEXT,
    mode        TEXT,
    father_said NUMERIC(14,2)
) ON COMMIT DROP;

INSERT INTO wanted VALUES
('Nicholas Nelson',       NULL, '%nicholas%nelson%',  'clear',  2500.00),
('Khallil Reckley',       NULL, '%reckley%',          'clear',  3000.00),
('Sashel Howe',           NULL, '%sashel%',           'clear',  5000.00),
-- Pinned 2026-09-27: the name on file is "Louise RichardS Letts", so the
-- exact-match against "Louise Richard Letts" failed and all nine Louises came
-- back ambiguous. 10991 is the one, active, holding 2,500.
('Louise Richards Letts', 10991, NULL,               'clear',  2600.00),
-- Pinned 2026-09-27: TWO accounts are named exactly "Remone Rainford", so
-- exact-match could not break the tie. 14548 is active and holds exactly the
-- 1,500 quoted; 11806 is terminated and OWES 2,500. Taking the active one.
('Remone Rainford',       14548, NULL,               'clear',  1500.00),
('Christine Lawrence',    NULL, '%christine%lawrence%','clear', 2500.00),
-- These two will SKIP again on purpose - they are questions for your father,
-- not things to force. Left in so the skip stays on the record each run.
--   Nordia Letts 13072 is already at 0.00 - nothing to remove.
--   Tashana Bryan 6304 OWES 500, she is not holding it. Clearing "credit"
--     here would push her to owing 1,000.
('Nordia Letts',          NULL, '%nordia%',           'clear',  2500.00),
('Tashana Bryan',         6304, NULL,                 'clear',   500.00),
('Robert Powell',         NULL, '%robert%powell%',    'reduce', 2500.00);

CREATE TEMP TABLE matched ON COMMIT DROP AS
SELECT w.label, w.mode, w.father_said,
       c.customer_id,
       c.name AS name_on_file,
       c.status,
       c.monthly_fee,
       b.balance,
       b.credit_balance,
       (LOWER(TRIM(c.name)) = LOWER(TRIM(w.label))) AS exact_match
FROM wanted w
JOIN public.customers c
  ON (w.known_id IS NOT NULL AND c.customer_id = w.known_id)
  OR (w.known_id IS NULL AND c.name ILIKE w.pattern)
LEFT JOIN public.customer_billing_status b ON b.customer_id = c.customer_id;

CREATE TEMP TABLE chosen ON COMMIT DROP AS
SELECT m.*,
       COUNT(*) OVER (PARTITION BY m.label) AS candidates_for_name
FROM matched m
WHERE m.exact_match
   OR NOT EXISTS (SELECT 1 FROM matched m2 WHERE m2.label = m.label AND m2.exact_match);

CREATE TEMP TABLE resolved ON COMMIT DROP AS
SELECT c.*,
       CASE c.mode WHEN 'clear'  THEN c.credit_balance
                   WHEN 'reduce' THEN c.father_said END AS adjustment,
       CASE c.mode WHEN 'clear'  THEN 0::NUMERIC(14,2)
                   WHEN 'reduce' THEN (c.balance + c.father_said)::NUMERIC(14,2) END AS target_balance,
       CASE
           WHEN c.candidates_for_name > 1              THEN 'still ambiguous after exact-match - pin the id by hand'
           WHEN c.balance IS NULL                      THEN 'no billing status row'
           WHEN COALESCE(c.credit_balance, 0) <= 0     THEN 'not in credit - nothing to remove'
           WHEN c.mode = 'reduce'
            AND c.credit_balance < c.father_said       THEN 'credit is smaller than the amount to remove - would create debt'
           ELSE NULL
       END AS skip_reason
FROM chosen c;

-- Names the search found nothing for.
SELECT 'NOT FOUND' AS check, w.label, w.pattern
FROM wanted w
WHERE NOT EXISTS (SELECT 1 FROM matched m WHERE m.label = w.label);

-- Every candidate considered - this is where a second Robert Powell shows up.
SELECT 'ALL CANDIDATES SEEN' AS check, label, customer_id, name_on_file, status,
       balance, credit_balance, exact_match
FROM matched
ORDER BY label, exact_match DESC, credit_balance DESC NULLS LAST, customer_id;

-- THE BLOCK TO READ.
SELECT 'RESOLVED - WILL APPLY' AS check, label, mode, customer_id, name_on_file, status,
       balance AS balance_now, adjustment AS removing, target_balance AS balance_after,
       father_said,
       CASE WHEN mode = 'reduce'                  THEN 'fixed reduction, keeps the rest'
            WHEN father_said = credit_balance     THEN 'matches what he said'
            ELSE 'DIFFERS from what he said - look' END AS figure_check,
       exact_match
FROM resolved WHERE skip_reason IS NULL
ORDER BY adjustment DESC;

SELECT 'SKIPPED' AS check, label, mode, customer_id, name_on_file, status,
       balance AS balance_now, credit_balance, father_said,
       candidates_for_name, skip_reason
FROM resolved WHERE skip_reason IS NOT NULL
ORDER BY label, customer_id;

INSERT INTO public.account_ledger_entries (
    customer_id, entry_type, amount, effective_date, description,
    created_by_employee_id, reason, is_verified, source_key
)
SELECT r.customer_id, 'adjustment', r.adjustment,
       (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
       'Credit corrected on review (account review 2026-09-26).',
       2,
       CASE r.mode
         WHEN 'clear'  THEN 'Account review 2026-09-26 confirmed this account should not be holding a credit balance. Removed in full; the underlying payments are untouched.'
         WHEN 'reduce' THEN 'Account review 2026-09-26: J$' || r.father_said::TEXT || ' removed from the credit on this account; the remainder stands. The underlying payments are untouched.'
       END,
       TRUE,
       'father-credit-fix-20260926:' || r.customer_id::TEXT
FROM resolved r
WHERE r.skip_reason IS NULL
ON CONFLICT (source_key) DO NOTHING;

-- Guard: everyone landed on target, nobody pushed into debt.
DO $g$
DECLARE bad INTEGER;
BEGIN
    SELECT count(*) INTO bad
    FROM resolved r
    JOIN public.customer_billing_status b USING (customer_id)
    WHERE r.skip_reason IS NULL
      AND (b.balance <> r.target_balance OR b.balance > 0);
    IF bad > 0 THEN
        RAISE EXCEPTION '% account(s) did not land on target or ended up owing. Nothing committed.', bad;
    END IF;
END $g$;

INSERT INTO public.audit_logs (
    employee_id, actor_name, action, entity_type, entity_id,
    field_name, old_value, new_value, reason, occurred_at, source_key
)
SELECT (SELECT employee_id FROM actor), (SELECT actor_name FROM actor),
       'Adjusted account balance', 'customer', r.customer_id::TEXT,
       'balance', r.balance::TEXT, r.target_balance::TEXT,
       CASE r.mode
         WHEN 'clear'  THEN 'Account review 2026-09-26: credit removed, the account should not be carrying one.'
         WHEN 'reduce' THEN 'Account review 2026-09-26: J$' || r.father_said::TEXT || ' removed from the credit; the remainder stands.'
       END,
       CURRENT_TIMESTAMP, 'father-credit-fix-20260926:' || r.customer_id::TEXT
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
