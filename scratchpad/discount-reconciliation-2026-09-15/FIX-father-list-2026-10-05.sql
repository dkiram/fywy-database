-- ============================================================================
-- Corrections from the 2026-10-05 list. Both clear a credit to 0.00.
--
--  11742 Kerryann Shand  "clear credit of 2500"      -> 0
--   2843 Opal Ward       "credit should be zero"     -> 0   (id inferred)
--
-- Kerryann Shand's account number came with the message and her figure is
-- pinned at -2,500.
--
-- OPAL WARD'S ID IS INFERRED, NOT GIVEN. 2843 is the only Opal Ward in the
-- 2026-09-15 review files, but in those files she was DISCONNECTED and OWING
-- J$9,500 - the opposite of holding a credit. So one of two things is true:
--   * her position has swung from owing 9,500 to being in credit over the last
--     three weeks (which is exactly what happened to Tamaim Richards Mckay
--     between the review and 2026-10-04, an 8,000 swing), or
--   * this is a different Opal Ward.
-- The script does not assume. It resolves the name itself, requires exactly
-- one match, requires her to actually be in credit, and prints every candidate
-- so a second Opal Ward would be visible. No figure was quoted for her, so
-- there is nothing to pin the amount against - "clear to zero whatever is
-- there" is the instruction, and the amount removed is whatever the BEFORE
-- block shows. READ THAT LINE: if she is holding something far from the 9,500
-- she owed, that is worth understanding before you commit.
--
-- Guards: name and id must agree for 11742; exactly one match and in credit
-- for Opal Ward; both must land on EXACTLY 0.00. Nothing here can create
-- debt. Idempotent via source_key.
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

-- expected_balance NULL = no figure was quoted, so clear whatever is there.
CREATE TEMP TABLE wanted (
    label            TEXT PRIMARY KEY,
    known_id         INTEGER,
    pattern          TEXT,
    expected_balance NUMERIC(14,2),
    instruction      TEXT
) ON COMMIT DROP;

INSERT INTO wanted VALUES
('Kerryann Shand', 11742, NULL,          -2500.00, 'clear the 2,500 credit'),
('Opal Ward',       NULL, '%opal%ward%',     NULL, 'credit should be zero');

CREATE TEMP TABLE matched ON COMMIT DROP AS
SELECT w.label, w.expected_balance, w.instruction,
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
       c.credit_balance AS adjustment,
       CASE
           WHEN c.candidates_for_name > 1          THEN 'more than one match - supply the account number'
           WHEN c.balance IS NULL                  THEN 'no billing status row'
           WHEN COALESCE(c.credit_balance, 0) <= 0 THEN 'not in credit - nothing to remove'
           WHEN c.expected_balance IS NOT NULL
            AND c.balance <> c.expected_balance    THEN 'live balance is not the figure in the message - check'
           ELSE NULL
       END AS skip_reason
FROM chosen c;

SELECT 'NOT FOUND' AS check, w.label, w.pattern
FROM wanted w
WHERE NOT EXISTS (SELECT 1 FROM matched m WHERE m.label = w.label);

-- Every candidate - a second Opal Ward would show up here.
SELECT 'ALL CANDIDATES SEEN' AS check, label, customer_id, name_on_file, status,
       monthly_fee, balance, credit_balance, exact_match
FROM matched
ORDER BY label, exact_match DESC, credit_balance DESC NULLS LAST, customer_id;

-- THE BLOCK TO READ - especially Opal Ward's amount, which is unpinned.
SELECT 'WILL APPLY' AS check, label, customer_id, name_on_file, status,
       monthly_fee, balance AS balance_now, adjustment AS removing,
       expected_balance AS message_said,
       CASE WHEN expected_balance IS NULL              THEN 'no figure quoted - clearing whatever is there'
            WHEN expected_balance = balance            THEN 'matches what he said'
            ELSE 'DIFFERS from what he said - look'    END AS figure_check,
       instruction
FROM resolved WHERE skip_reason IS NULL
ORDER BY adjustment DESC;

SELECT 'SKIPPED' AS check, label, customer_id, name_on_file, status,
       balance AS balance_now, credit_balance, expected_balance,
       candidates_for_name, skip_reason
FROM resolved WHERE skip_reason IS NOT NULL
ORDER BY label, customer_id;

INSERT INTO public.account_ledger_entries (
    customer_id, entry_type, amount, effective_date, description,
    created_by_employee_id, reason, is_verified, source_key
)
SELECT r.customer_id, 'adjustment', r.adjustment,
       (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
       'Credit removed on review: the account should not be carrying a credit (account review 2026-10-05).',
       2,
       'Account review 2026-10-05: ' || r.instruction || '. Removed in full; the underlying payments are untouched.',
       TRUE,
       'father-credit-fix-20261005:' || r.customer_id::TEXT
FROM resolved r
WHERE r.skip_reason IS NULL
ON CONFLICT (source_key) DO NOTHING;

-- Guard: both landed on zero, neither pushed into debt.
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
       'Account review 2026-10-05: credit removed, the account should not be carrying one.',
       CURRENT_TIMESTAMP, 'father-credit-fix-20261005:' || r.customer_id::TEXT
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
