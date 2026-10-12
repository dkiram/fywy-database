-- ============================================================================
-- Corrections from the 2026-10-09/10 lists. All seven clear to 0.00.
--
--    899 Paul Denton                   2,500   (id from the review files)
--   5855 Jodan Hanson                      -   "credit should be 0"
--  10640 Melissa Mitch Michian Jones       -   "clear credit", id given
--        Athlyn Lee                    1,400
--        Richard Burrell               4,000
--        Sanique Ormsby                1,500
--        Shana Thompson                    -   "credit should be 0"
--
-- Sanique Ormsby is searched on "sanique", not the surname: the review files
-- already contain a Debbie Ann Ormsby, a different customer.
--
-- Shana Thompson is searched on '%shana%thompson%', which will also catch
-- Shanakay/Shanae Thompson if they exist. Exact-match prefers a plain "Shana
-- Thompson"; check the ALL CANDIDATES block if more than one turns up.
--
-- Paul Denton (899) was DISCONNECTED and owing 4,000 in the 2026-09-15 review
-- files and your father now reports a 2,500 credit, so his position has
-- crossed zero since. The script zeroes whatever is actually there and labels
-- which direction it went, so a sign surprise cannot turn into a wrong write -
-- that is how Tamaim Richards Mckay was caught on 2026-10-04.
--
-- THIS SCRIPT IS SAFE TO RE-RUN. Any account already carrying this batch's
-- source_key is skipped as "already applied in an earlier run". That check was
-- added after FIX-father-list-2026-10-08-targets.sql aborted on a second run:
-- an "add X to balance" row recomputes a new destination each time while ON
-- CONFLICT blocks the duplicate insert, so the balance can never reach it and
-- the final guard rejects the whole transaction. Every batch gets the check
-- now, whatever modes it uses.
--
-- Guards: one account per name, name on file must match where an id is pinned,
-- not already at zero, and must land on EXACTLY 0.00. Idempotent via
-- source_key.
--
-- LAST LINE IS `ROLLBACK` - rehearsal. Read every block, back up,
-- THEN change ROLLBACK -> COMMIT and run again:
--   docker exec -it spcl-backup sh /opt/spcl-deploy/backup.sh   # before COMMIT
-- ============================================================================

BEGIN;

DROP TABLE IF EXISTS wanted, matched, chosen, resolved;

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
    father_said NUMERIC(14,2),
    instruction TEXT
) ON COMMIT DROP;

INSERT INTO wanted VALUES
('Paul Denton',                   899, NULL,                 2500.00, 'remove the 2,500 credit'),
('Jodan Hanson',                 5855, NULL,                     NULL, 'credit should be 0'),
('Melissa Mitch Michian Jones', 10640, NULL,                     NULL, 'clear the credit'),
('Athlyn Lee',                   NULL, '%athlyn%',            1400.00, 'clear the 1,400 credit'),
('Richard Burrell',              NULL, '%richard%burrell%',   4000.00, 'clear the 4,000 credit'),
('Sanique Ormsby',               NULL, '%sanique%',           1500.00, 'clear the 1,500 credit'),
('Shana Thompson',               NULL, '%shana%thompson%',       NULL, 'credit should be 0');

CREATE TEMP TABLE matched ON COMMIT DROP AS
SELECT w.label, w.father_said, w.instruction,
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
       (-c.balance) AS adjustment,
       CASE
           WHEN EXISTS (SELECT 1 FROM public.account_ledger_entries l
                        WHERE l.source_key = 'father-credit-fix-20261010:' || c.customer_id::TEXT)
                                          THEN 'already applied in an earlier run of this batch'
           WHEN c.candidates_for_name > 1 THEN 'more than one match - supply the account number'
           WHEN c.balance IS NULL         THEN 'no billing status row'
           WHEN c.balance = 0             THEN 'already at zero - nothing to do'
           ELSE NULL
       END AS skip_reason
FROM chosen c;

SELECT 'NOT FOUND' AS check, w.label, w.pattern, w.instruction
FROM wanted w
WHERE NOT EXISTS (SELECT 1 FROM matched m WHERE m.label = w.label);

SELECT 'ALL CANDIDATES SEEN' AS check, label, customer_id, name_on_file, status,
       monthly_fee, balance, credit_balance, exact_match
FROM matched
ORDER BY label, exact_match DESC, balance, customer_id;

-- THE BLOCK TO READ.
SELECT 'WILL APPLY' AS check, label, customer_id, name_on_file, status,
       monthly_fee, balance AS balance_now, adjustment, 0.00 AS balance_after,
       CASE WHEN balance < 0 THEN 'removes credit'
            ELSE                  'FORGIVES DEBT - gives money away' END AS direction,
       father_said,
       CASE WHEN father_said IS NULL          THEN 'no figure quoted'
            WHEN father_said = credit_balance THEN 'matches what he said'
            ELSE 'DIFFERS from what he said - look' END AS figure_check,
       instruction
FROM resolved WHERE skip_reason IS NULL
ORDER BY balance, label;

SELECT 'SKIPPED' AS check, label, customer_id, name_on_file, status,
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
       CASE WHEN r.balance > 0
            THEN 'Outstanding balance cleared at management instruction (account review 2026-10-10).'
            ELSE 'Credit removed on review: the account should not be carrying a credit (account review 2026-10-10).' END,
       2,
       CASE WHEN r.balance > 0
            THEN 'Management instruction 2026-10-10: ' || r.instruction || '. This forgives money owed. The underlying charges and payments are left on the ledger.'
            ELSE 'Account review 2026-10-10: ' || r.instruction || '. Removed in full; the underlying payments are untouched.' END,
       TRUE,
       'father-credit-fix-20261010:' || r.customer_id::TEXT
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
       CASE WHEN r.balance > 0 THEN 'Wrote off account balance'
            ELSE                    'Adjusted account balance' END,
       'customer', r.customer_id::TEXT,
       'balance', r.balance::TEXT, '0.00',
       CASE WHEN r.balance > 0
            THEN 'Management instruction 2026-10-10: outstanding balance of J$' || r.balance::TEXT || ' cleared. Money owed was forgiven.'
            ELSE 'Account review 2026-10-10: credit removed, the account should not be carrying one.' END,
       CURRENT_TIMESTAMP, 'father-credit-fix-20261010:' || r.customer_id::TEXT
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
