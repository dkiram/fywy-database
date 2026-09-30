-- ============================================================================
-- Corrections from the 2026-09-29 list - the thirteen that clear to 0.
--
--  11391 Carlton Smith-cedar grove    2,500   (id from the review files)
--  10766 Donovan Thompson-Cedar Grove 2,500   (id from the review files)
--   5372 Simon Turner                 2,500   (id from the review files)
--        Tesma Peart                      -   "should not have any credit"
--        Shameka Mahoney              2,500
--        Errol Griffith                 500
--        Marcia Walker-Sunset         2,500
--        Juliet Smith                 2,500
--   5246 Sherina Williams             2,500   (id from the review files)
--  12290 Gilbert Beckford               500   (id from the review files)
--  11849 Trecian Grandison                -   "clear credit", id given
--        Simone Bell-Mullings         2,500
--        Rhodia Rayon                 3,500
--
-- FIVE ITEMS FROM THAT LIST ARE NOT HERE. They are not credit removals and
-- three of them need your father to confirm before anything is written - see
-- audit-father-list-2026-09-29-review.sql:
--   Michel Bryan York  "remove 76,100 BALANCE" - that is forgiving a DEBT of
--                      J$76,100, not clearing a credit. Thirty times larger
--                      than anything else in this series and the opposite
--                      operation. Needs an explicit decision.
--   Ryan Morris        "add 1950 to balance" - creates debt.
--   Dekano King  8509  "change credit to 5000" - could be up or down.
--   Curtis Davy   740  "should have a $2000 credit" - could be up or down.
--   Beverley           first name only, no surname - cannot be identified.
--
-- Four names here arrived with a slightly different spelling than the file
-- ("Carlton smith-cedar grove", "Donovan Thompson" for
-- "Donovan Thompson-Cedar Grove"), so those are pinned by id from the
-- 2026-09-15 review files rather than matched on text.
--
-- Three of the pinned accounts are NOT active - Donovan Thompson and Simon
-- Turner are disconnected, Gilbert Beckford is suspended. An adjustment is
-- fine on any status (it is not a monthly_charge, so the 054 trigger does not
-- apply), but the status is printed so you can see it.
--
-- Guards: exactly one account per name, it must be in credit, and it must land
-- on EXACTLY 0.00. Nothing here can put anyone into debt. Idempotent via
-- source_key.
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

CREATE TEMP TABLE wanted (
    label       TEXT PRIMARY KEY,
    known_id    INTEGER,
    pattern     TEXT,
    father_said NUMERIC(14,2)
) ON COMMIT DROP;

INSERT INTO wanted VALUES
('Carlton Smith-cedar grove',    11391, NULL,                2500.00),
('Donovan Thompson-Cedar Grove', 10766, NULL,                2500.00),
('Simon Turner',                  5372, NULL,                2500.00),
('Tesma Peart',                   NULL, '%tesma%',              NULL),
('Shameka Mahoney',               NULL, '%shameka%',         2500.00),
('Errol Griffith',                NULL, '%errol%griffith%',   500.00),
('Marcia Walker-Sunset',          NULL, '%marcia%walker%',   2500.00),
('Juliet Smith',                  NULL, '%juliet%smith%',    2500.00),
('Sherina Williams',              5246, NULL,                2500.00),
('Gilbert Beckford',             12290, NULL,                 500.00),
('Trecian Grandison',            11849, NULL,                   NULL),
('Simone Bell-Mullings',          NULL, '%bell%mullings%',   2500.00),
('Rhodia Rayon',                  NULL, '%rhodia%',          3500.00);

CREATE TEMP TABLE matched ON COMMIT DROP AS
SELECT w.label, w.father_said,
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
       CASE
           WHEN c.candidates_for_name > 1          THEN 'still ambiguous after exact-match - pin the id by hand'
           WHEN c.balance IS NULL                  THEN 'no billing status row'
           WHEN COALESCE(c.credit_balance, 0) <= 0 THEN 'not in credit - nothing to remove'
           ELSE NULL
       END AS skip_reason
FROM chosen c;

SELECT 'NOT FOUND' AS check, w.label, w.pattern
FROM wanted w
WHERE NOT EXISTS (SELECT 1 FROM matched m WHERE m.label = w.label);

SELECT 'ALL CANDIDATES SEEN' AS check, label, customer_id, name_on_file, status,
       balance, credit_balance, exact_match
FROM matched
ORDER BY label, exact_match DESC, credit_balance DESC NULLS LAST, customer_id;

-- THE BLOCK TO READ.
SELECT 'RESOLVED - WILL APPLY' AS check, label, customer_id, name_on_file, status,
       monthly_fee, balance AS balance_now, credit_balance AS removing,
       father_said,
       CASE WHEN father_said IS NULL          THEN 'no figure given'
            WHEN father_said = credit_balance THEN 'matches what he said'
            ELSE 'DIFFERS from what he said - look' END AS figure_check,
       exact_match
FROM resolved WHERE skip_reason IS NULL
ORDER BY credit_balance DESC;

SELECT 'SKIPPED' AS check, label, customer_id, name_on_file, status,
       balance AS balance_now, credit_balance, father_said,
       candidates_for_name, skip_reason
FROM resolved WHERE skip_reason IS NOT NULL
ORDER BY label, customer_id;

INSERT INTO public.account_ledger_entries (
    customer_id, entry_type, amount, effective_date, description,
    created_by_employee_id, reason, is_verified, source_key
)
SELECT r.customer_id, 'adjustment', r.credit_balance,
       (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
       'Credit removed on review: the account should not be carrying a credit (account review 2026-09-29).',
       2,
       'Account review 2026-09-29 confirmed this account should not be holding a credit balance. Removed in full; the underlying payments are untouched.',
       TRUE,
       'father-credit-fix-20260929:' || r.customer_id::TEXT
FROM resolved r
WHERE r.skip_reason IS NULL
ON CONFLICT (source_key) DO NOTHING;

DO $g$
DECLARE bad INTEGER;
BEGIN
    SELECT count(*) INTO bad
    FROM resolved r
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
SELECT (SELECT employee_id FROM actor), (SELECT actor_name FROM actor),
       'Adjusted account balance', 'customer', r.customer_id::TEXT,
       'balance', r.balance::TEXT, '0.00',
       'Account review 2026-09-29: credit removed, the account should not be carrying one.',
       CURRENT_TIMESTAMP, 'father-credit-fix-20260929:' || r.customer_id::TEXT
FROM resolved r
WHERE r.skip_reason IS NULL
ON CONFLICT (source_key) DO NOTHING;

SELECT 'AFTER' AS check, r.customer_id, r.name_on_file, b.balance AS balance_now
FROM resolved r
JOIN public.customer_billing_status b USING (customer_id)
WHERE r.skip_reason IS NULL
ORDER BY r.customer_id;

-- ----------------------------------------------------------------------------
-- ROLLBACK = rehearsal.  COMMIT = for real (back up first).
-- ----------------------------------------------------------------------------
ROLLBACK;
