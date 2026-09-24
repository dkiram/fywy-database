-- ============================================================================
-- Corrections from the 2026-09-23 list. All three are the same instruction -
-- "should not have any credit" - so the target is 0 for each and no figure is
-- needed to pin them.
--
--   Gairy Hutchinson   "no credit"                  -> balance to 0
--   Tyreece Wright     "Should Not Have Any Credit" -> balance to 0
--   Tracy Thomas       "should not have any credit" -> balance to 0
--
-- No customer ids came with the message and none of the three are in the
-- 2026-09-15 review files, so this script resolves them itself. It searches
-- loosely, then PREFERS AN EXACT NAME MATCH where one exists - the trick that
-- separated Dishawn Crawford from 48 other Crawfords and Kedda Chaplin from
-- 11 other Chaplins. A name that still resolves to 0 or 2+ accounts is
-- SKIPPED and its candidates listed, not guessed at.
--
-- Because the target is 0 rather than a stated figure, there is no
-- "live balance must equal X" guard here - "take whatever credit is there to
-- zero" is well defined at any amount. The protections that matter still
-- apply: exactly one account per name, it must actually be in credit, and it
-- must land on EXACTLY 0.00. Nothing here can put anyone into debt.
--
-- READ THE RESOLVED BLOCK BEFORE COMMITTING. It prints the name on file and
-- the amount for each account, and that is the only confirmation that the
-- right person was found. Idempotent via source_key.
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

CREATE TEMP TABLE wanted (label TEXT PRIMARY KEY, pattern TEXT) ON COMMIT DROP;
INSERT INTO wanted VALUES
('Gairy Hutchinson', '%hutchinson%'),
('Tyreece Wright',   '%tyreece%'),
('Tracy Thomas',     '%tracy%thomas%');

-- Every account the loose search finds, flagging exact name matches.
CREATE TEMP TABLE matched ON COMMIT DROP AS
SELECT w.label,
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

-- Where an exact name match exists, use only that. Otherwise keep them all so
-- the ambiguity is visible.
CREATE TEMP TABLE chosen ON COMMIT DROP AS
SELECT m.*,
       COUNT(*) OVER (PARTITION BY m.label) AS candidates_for_name
FROM matched m
WHERE m.exact_match
   OR NOT EXISTS (SELECT 1 FROM matched m2 WHERE m2.label = m.label AND m2.exact_match);

CREATE TEMP TABLE resolved ON COMMIT DROP AS
SELECT c.*,
       CASE
           WHEN c.candidates_for_name > 1           THEN 'still ambiguous after exact-match - pin the id by hand'
           WHEN c.balance IS NULL                   THEN 'no billing status row'
           WHEN COALESCE(c.credit_balance, 0) <= 0  THEN 'not in credit - nothing to remove'
           ELSE NULL
       END AS skip_reason
FROM chosen c;

-- Names the search found nothing for at all.
SELECT 'NOT FOUND' AS check, w.label, w.pattern
FROM wanted w
WHERE NOT EXISTS (SELECT 1 FROM matched m WHERE m.label = w.label);

-- THE BLOCK TO READ: who was found, and how much comes off.
SELECT 'RESOLVED - WILL APPLY' AS check, label, customer_id, name_on_file, status,
       monthly_fee, balance AS balance_now, credit_balance AS removing, exact_match
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
       'Credit removed on review: the account should not be carrying a credit (account review 2026-09-23).',
       2,
       'Account review 2026-09-23 confirmed this account should not be holding a credit balance. Removed in full; the underlying payments are untouched.',
       TRUE,
       'father-credit-fix-20260923:' || r.customer_id::TEXT
FROM resolved r
WHERE r.skip_reason IS NULL
ON CONFLICT (source_key) DO NOTHING;

-- Guard: everyone landed on zero, nobody was pushed into debt.
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
       'Account review 2026-09-23: credit removed, the account should not be carrying one.',
       CURRENT_TIMESTAMP, 'father-credit-fix-20260923:' || r.customer_id::TEXT
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
