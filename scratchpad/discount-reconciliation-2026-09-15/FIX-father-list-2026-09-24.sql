-- ============================================================================
-- Corrections from the 2026-09-24 list. All four clear the credit to 0.
--
--   Paulette McBean      "remove 5000 credit"        -> balance to 0
--   Timera Robinson      "should not have a credit"  -> balance to 0
--   Jamoi Phillip Myers  "remove 2500 credit"        -> balance to 0
--   Shanel Taylor        "should not have a credit"  -> balance to 0
--
-- (The message said "McLean"; corrected to McBEAN 2026-09-25. The search is
-- on the first name so it finds her either way, but the exact-match
-- preference needs the right spelling to do its job.)
--
-- No customer ids came with the message. The script resolves them: loose
-- search, then PREFER AN EXACT NAME MATCH where one exists. All four
-- surnames are common in this database (McBean, Robinson, Myers and Taylor
-- each have many accounts), so that preference is doing real work here.
-- A name still resolving to 0 or 2+ accounts is SKIPPED with its candidates
-- listed, never guessed.
--
-- *** SHANEL TAYLOR NEEDS YOUR EYES. ***
-- The review files contain "Shanel Taylor #2" (customer 3052), which means a
-- plain "Shanel Taylor" very likely exists as a SEPARATE account. If both
-- exist, exact-match picks the one without "#2" - which may or may not be the
-- one your father meant. 3052 also holds a large credit (the 2026-09-15
-- reconciliation targeted it at -12,500), so clearing the wrong one moves
-- real money. Check the name AND the amount in the RESOLVED block before
-- committing; if it is wrong, tell me and I will pin the id by hand.
--
-- Where the message named a figure it is shown as `father_said` next to the
-- live credit. A mismatch does NOT skip the row: "remove the credit" means
-- clear it whatever it is now, and the figure was simply what was on screen
-- when he looked (same as Demmo Sloley on 2026-09-18, whose 4,500 had become
-- 2,000 by the time we ran it). But a big gap is worth a second look.
--
-- Guards: exactly one account per name, it must be in credit, and it must
-- land on EXACTLY 0.00. Nothing here can put anyone into debt. Idempotent
-- via source_key.
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

CREATE TEMP TABLE wanted (label TEXT PRIMARY KEY, pattern TEXT, father_said NUMERIC(14,2)) ON COMMIT DROP;
INSERT INTO wanted VALUES
('Paulette McBean',     '%paulette%',       5000.00),
('Timera Robinson',     '%timera%',            NULL),
('Jamoi Phillip Myers', '%jamoi%',          2500.00),
('Shanel Taylor',       '%shanel%taylor%',     NULL);

CREATE TEMP TABLE matched ON COMMIT DROP AS
SELECT w.label,
       w.father_said,
       c.customer_id,
       c.name AS name_on_file,
       c.status,
       c.monthly_fee,
       b.balance,
       b.credit_balance,
       (LOWER(TRIM(c.name)) = LOWER(TRIM(w.label))) AS exact_match
FROM wanted w
JOIN public.customers c ON c.name ILIKE w.pattern
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

-- Every candidate considered, so a near-miss is visible even when one was chosen.
SELECT 'ALL CANDIDATES SEEN' AS check, label, customer_id, name_on_file, status,
       balance, credit_balance, exact_match
FROM matched
ORDER BY label, exact_match DESC, credit_balance DESC NULLS LAST, customer_id;

-- THE BLOCK TO READ: who was found, how much comes off, and what he said.
SELECT 'RESOLVED - WILL APPLY' AS check, label, customer_id, name_on_file, status,
       monthly_fee, balance AS balance_now, credit_balance AS removing,
       father_said,
       CASE WHEN father_said IS NULL                  THEN 'no figure given'
            WHEN father_said = credit_balance         THEN 'matches what he said'
            ELSE 'DIFFERS from what he said - look'   END AS figure_check,
       exact_match
FROM resolved WHERE skip_reason IS NULL
ORDER BY credit_balance DESC;

SELECT 'SKIPPED' AS check, label, customer_id, name_on_file, status,
       balance AS balance_now, credit_balance, candidates_for_name, skip_reason
FROM resolved WHERE skip_reason IS NOT NULL
ORDER BY label, customer_id;

INSERT INTO public.account_ledger_entries (
    customer_id, entry_type, amount, effective_date, description,
    created_by_employee_id, reason, is_verified, source_key
)
SELECT r.customer_id, 'adjustment', r.credit_balance,
       (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
       'Credit removed on review: the account should not be carrying a credit (account review 2026-09-24).',
       2,
       'Account review 2026-09-24 confirmed this account should not be holding a credit balance. Removed in full; the underlying payments are untouched.',
       TRUE,
       'father-credit-fix-20260924:' || r.customer_id::TEXT
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
       'Account review 2026-09-24: credit removed, the account should not be carrying one.',
       CURRENT_TIMESTAMP, 'father-credit-fix-20260924:' || r.customer_id::TEXT
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
