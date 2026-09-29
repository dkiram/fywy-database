-- ============================================================================
-- Corrections from the 2026-09-28 list - the ten that clear to 0.
--
--   8746 Derol Francis      2,900   (id from the review files)
--        Simone Kelly       2,500
--  15117 Alica Forbes           -   "clear credit", no figure given
--        Trudy McIntosh     2,500
--        Donna McLeod       2,500
--        Bianca Johnson     1,500
--        Tyrone D Carter    4,000
--   9945 Telsia Reid        1,000   (id from the review files)
--        Verona Copeland    2,500
--        Marlene Lewis      4,000
--
-- Praise House Ministry/Evelyn Laurence (10592) is NOT here. That one ends up
-- OWING 4,500 - a 13,500 swing - so it is in its own file where the guard can
-- allow debt deliberately:
--   FIX-praise-house-10592-owes-4500.sql
-- Nothing in THIS script can put anyone into debt.
--
-- Eight names arrived without ids, so the script resolves them: loose search,
-- then PREFER AN EXACT NAME MATCH where one exists. Johnson, Lewis, Carter and
-- McLeod are all common here. A name resolving to 0 or 2+ accounts is SKIPPED
-- with its candidates listed, never guessed - that is what caught "Louise
-- RichardS Letts" and the two Remone Rainfords on 2026-09-26.
--
-- Note Trudy McIntosh vs the review files' "Donna Alexander-McIntosh", and
-- Donna McLeod vs that same name - McIntosh and McLeod are different people.
-- The patterns search on the first names to keep them apart.
--
-- `father_said` shows his figure next to the live credit. A mismatch does NOT
-- skip the row - "remove the credit" means clear it whatever it is now - but a
-- large gap is worth a look. Derol Francis's 2,900 is an unusual amount, and
-- he was DISCONNECTED owing 4,000 in the September review files, so his row is
-- the one to read most carefully.
--
-- Guards: exactly one account per name, it must be in credit, and it must land
-- on EXACTLY 0.00. Idempotent via source_key.
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
('Derol Francis',    8746,  NULL,               2900.00),
('Simone Kelly',     NULL,  '%simone%kelly%',   2500.00),
('Alica Forbes',     15117, NULL,                  NULL),
('Trudy McIntosh',   NULL,  '%trudy%',          2500.00),
('Donna McLeod',     NULL,  '%donna%mcleod%',   2500.00),
('Bianca Johnson',   NULL,  '%bianca%',         1500.00),
('Tyrone D Carter',  NULL,  '%tyrone%carter%',  4000.00),
('Telsia Reid',      9945,  NULL,               1000.00),
('Verona Copeland',  NULL,  '%verona%',         2500.00),
('Marlene Lewis',    NULL,  '%marlene%lewis%',  4000.00);

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

-- Names the search found nothing for.
SELECT 'NOT FOUND' AS check, w.label, w.pattern
FROM wanted w
WHERE NOT EXISTS (SELECT 1 FROM matched m WHERE m.label = w.label);

-- Every candidate considered, so near-misses stay visible.
SELECT 'ALL CANDIDATES SEEN' AS check, label, customer_id, name_on_file, status,
       balance, credit_balance, exact_match
FROM matched
ORDER BY label, exact_match DESC, credit_balance DESC NULLS LAST, customer_id;

-- THE BLOCK TO READ.
SELECT 'RESOLVED - WILL APPLY' AS check, label, customer_id, name_on_file, status,
       monthly_fee, balance AS balance_now, credit_balance AS removing,
       father_said,
       CASE WHEN father_said IS NULL              THEN 'no figure given'
            WHEN father_said = credit_balance     THEN 'matches what he said'
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
       'Credit removed on review: the account should not be carrying a credit (account review 2026-09-28).',
       2,
       'Account review 2026-09-28 confirmed this account should not be holding a credit balance. Removed in full; the underlying payments are untouched.',
       TRUE,
       'father-credit-fix-20260928:' || r.customer_id::TEXT
FROM resolved r
WHERE r.skip_reason IS NULL
ON CONFLICT (source_key) DO NOTHING;

-- Guard: everyone landed on zero, nobody pushed into debt.
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
       'Account review 2026-09-28: credit removed, the account should not be carrying one.',
       CURRENT_TIMESTAMP, 'father-credit-fix-20260928:' || r.customer_id::TEXT
FROM resolved r
WHERE r.skip_reason IS NULL
ON CONFLICT (source_key) DO NOTHING;

-- AFTER
SELECT 'AFTER' AS check, r.customer_id, r.name_on_file, b.balance AS balance_now
FROM resolved r
JOIN public.customer_billing_status b USING (customer_id)
WHERE r.skip_reason IS NULL
ORDER BY r.customer_id;

-- ----------------------------------------------------------------------------
-- ROLLBACK = rehearsal.  COMMIT = for real (back up first).
-- ----------------------------------------------------------------------------
ROLLBACK;
