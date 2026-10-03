-- ============================================================================
-- Corrections from the 2026-09-30 list - the nine that clear to 0.
--
--  14298 Camille Brown/Boose and Games         3,000   (id, see note)
--  14356 Camille Brown\Di Imerial Entertainment 3,000   (id, see note)
--        Camille Brown Newport Square          2,500
--        Deon Nosworthy                        2,500
--        Una Jones                               300
--        Oral Murray                           2,500
--        Shanoya Small                         2,500
--  14461 Lenmore Douglas                           -   "clear credit", id given
--        Garcia Brown                          2,509
--
-- THE TWO PINNED CAMILLE BROWNS ARE SPELLED DIFFERENTLY ON FILE:
--   message "Camille brown/noose and games" -> file "Camille Brown/Boose and
--     Games" (14298) - B, not N.
--   message "Camille brown/di imperial" -> file "Camille Brown\Di Imerial
--     Entertainment" (14356) - BACKSLASH, and "Imerial" with no p.
-- Neither would have matched on text, so both are pinned by id from the
-- 2026-09-15 review files. The third (Newport Square) is not in those files
-- and is searched for. All three are separate accounts, not duplicates.
--
-- Garcia Brown's figure reads 2,509, which is almost certainly 2,500 mistyped.
-- It makes no difference here - the instruction is to clear the credit, so
-- whatever is there goes - but `figure_check` will show the gap.
--
-- READING OF THE BARE "remove X" ITEMS. Deon Nosworthy, Una Jones, Oral
-- Murray and Shanoya Small are all written as "remove <amount>" with no noun.
-- Taken as CREDIT, because three weeks of these lists use "remove X" for
-- credit and say "balance" explicitly when they mean debt - and your father
-- did exactly that in this same message ("Kenroy christian add 1250
-- balance"). If any of those four were meant as debt forgiveness instead,
-- stop before committing.
--
-- NOT HERE:
--   Kenroy Christian, Ameika McLean, Eric Dunn, Sashika Paul - different
--     operations, see FIX-father-list-2026-09-30-part2.sql
--   Terry-Ann Francis "add 4500" - no noun at all, so it is either 4,500 of
--     credit or 4,500 of debt. Opposite directions; needs one word from him.
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
('Camille Brown/Boose and Games',          14298, NULL,                        3000.00),
('Camille Brown\Di Imerial Entertainment', 14356, NULL,                        3000.00),
('Camille Brown Newport Square',            NULL, '%camille%brown%newport%',   2500.00),
('Deon Nosworthy',                          NULL, '%nosworthy%',               2500.00),
('Una Jones',                               NULL, '%una%jones%',                300.00),
('Oral Murray',                             NULL, '%oral%murray%',             2500.00),
('Shanoya Small',                           NULL, '%shanoya%',                 2500.00),
('Lenmore Douglas',                        14461, NULL,                           NULL),
('Garcia Brown',                            NULL, '%garcia%brown%',            2509.00);

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
       'Credit removed on review: the account should not be carrying a credit (account review 2026-09-30).',
       2,
       'Account review 2026-09-30 confirmed this account should not be holding a credit balance. Removed in full; the underlying payments are untouched.',
       TRUE,
       'father-credit-fix-20260930:' || r.customer_id::TEXT
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
       'Account review 2026-09-30: credit removed, the account should not be carrying one.',
       CURRENT_TIMESTAMP, 'father-credit-fix-20260930:' || r.customer_id::TEXT
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
