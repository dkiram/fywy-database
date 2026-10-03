-- ============================================================================
-- The four items from the 2026-09-30 list that are not clear-to-zero. Three
-- different operations, so read the `mode` column.
--
--   addbal        Kenroy Christian  "add 1250 balance"       adjustment +1,250
--   addbal        Ameika McLean     "add 100 to bal"         adjustment   +100
--   reducecredit  Eric Dunn         "remove 4000 from credit" adjustment +4,000
--   target  11422 Sashika Paul      "must have a credit of 2500" -> -2,500
--
-- WHAT EACH MODE MEANS
--
-- addbal: add the amount to what the customer owes. Deliberately creates or
--   increases debt. No "must be in credit" requirement - these two may already
--   be at zero or owing. Both figures are small (1,250 and 100) and are
--   applied as stated.
--
-- reducecredit: take a FIXED amount off the credit and leave the rest. "remove
--   4000 FROM credit" is the Robert Powell wording from 2026-09-26, and it
--   means something different from "remove 4000 credit": if Eric Dunn holds
--   more than 4,000 he keeps the difference. If he holds LESS the row is
--   skipped rather than tipping him into debt.
--
-- target: move the balance to an exact figure. Sashika Paul must end at
--   -2,500. Whether that removes credit or ADDS it depends on where she is
--   now, so the `direction` column says which - if it reads "ADDS CREDIT"
--   that is giving money and worth a second look before committing.
--
-- NOT HERE: Terry-Ann Francis "add 4500". No noun, so it is either 4,500 of
-- credit or 4,500 of debt - opposite directions on the same account. Your
-- father wrote "add 1250 balance" and "add 100 to bal" in this same message,
-- so he does say "balance" when he means it, which makes the bare one
-- genuinely unclear. One word from him settles it.
--
-- Guards: exactly one account per name, name on file must match, and each must
-- land EXACTLY on its computed target. Idempotent via source_key.
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
    label          TEXT PRIMARY KEY,
    known_id       INTEGER,
    pattern        TEXT,
    mode           TEXT,            -- addbal | reducecredit | target
    amount         NUMERIC(14,2),   -- for addbal and reducecredit
    target_balance NUMERIC(14,2),   -- for target
    instruction    TEXT
) ON COMMIT DROP;

INSERT INTO wanted VALUES
('Kenroy Christian', NULL,  '%kenroy%christian%', 'addbal',       1250.00, NULL,     'add 1,250 to the balance'),
('Ameika McLean',    NULL,  '%ameika%',           'addbal',        100.00, NULL,     'add 100 to the balance'),
('Eric Dunn',        NULL,  '%eric%dunn%',        'reducecredit', 4000.00, NULL,     'remove 4,000 from the credit'),
('Sashika Paul',     11422, NULL,                 'target',          NULL, -2500.00, 'must have a credit of 2,500');

CREATE TEMP TABLE matched ON COMMIT DROP AS
SELECT w.label, w.mode, w.amount, w.target_balance, w.instruction,
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
       CASE c.mode
         WHEN 'addbal'       THEN c.amount
         WHEN 'reducecredit' THEN c.amount
         WHEN 'target'       THEN (c.target_balance - c.balance)
       END AS adjustment,
       CASE c.mode
         WHEN 'addbal'       THEN (c.balance + c.amount)
         WHEN 'reducecredit' THEN (c.balance + c.amount)
         WHEN 'target'       THEN c.target_balance
       END AS computed_target,
       CASE
           WHEN c.candidates_for_name > 1   THEN 'still ambiguous after exact-match - pin the id by hand'
           WHEN c.balance IS NULL           THEN 'no billing status row'
           WHEN c.mode = 'reducecredit'
            AND COALESCE(c.credit_balance, 0) < c.amount
                                            THEN 'credit is smaller than the amount to remove - would create debt'
           WHEN c.mode = 'target'
            AND c.target_balance = c.balance THEN 'already at target'
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
SELECT 'WILL APPLY' AS check, label, mode, customer_id, name_on_file, status,
       monthly_fee, balance AS balance_now, adjustment, computed_target AS balance_after,
       CASE WHEN adjustment < 0                           THEN 'ADDS CREDIT - gives money'
            WHEN computed_target > 0 AND balance > 0       THEN 'INCREASES DEBT'
            WHEN computed_target > 0                       THEN 'CREATES DEBT'
            ELSE                                                'removes credit' END AS direction,
       instruction
FROM resolved WHERE skip_reason IS NULL
ORDER BY label;

SELECT 'SKIPPED' AS check, label, mode, customer_id, name_on_file,
       balance AS balance_now, credit_balance, amount, target_balance,
       candidates_for_name, skip_reason
FROM resolved WHERE skip_reason IS NOT NULL
ORDER BY label, customer_id;

INSERT INTO public.account_ledger_entries (
    customer_id, entry_type, amount, effective_date, description,
    created_by_employee_id, reason, is_verified, source_key
)
SELECT r.customer_id, 'adjustment', r.adjustment,
       (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
       'Balance corrected on review (account review 2026-09-30).',
       2,
       'Account review 2026-09-30: ' || r.instruction || '. The underlying payments are untouched.',
       TRUE,
       'father-credit-fix-20260930:' || r.customer_id::TEXT
FROM resolved r
WHERE r.skip_reason IS NULL
ON CONFLICT (source_key) DO NOTHING;

-- Guard: every account landed exactly where the mode says it should.
DO $g$
DECLARE bad INTEGER;
BEGIN
    SELECT count(*) INTO bad
    FROM resolved r
    JOIN public.customer_billing_status b USING (customer_id)
    WHERE r.skip_reason IS NULL
      AND b.balance <> r.computed_target;
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
       'balance', r.balance::TEXT, r.computed_target::TEXT,
       'Account review 2026-09-30: ' || r.instruction || '.',
       CURRENT_TIMESTAMP, 'father-credit-fix-20260930:' || r.customer_id::TEXT
FROM resolved r
WHERE r.skip_reason IS NULL
ON CONFLICT (source_key) DO NOTHING;

SELECT 'AFTER' AS check, r.customer_id, r.name_on_file, b.balance AS balance_now,
       r.computed_target AS expected
FROM resolved r
JOIN public.customer_billing_status b USING (customer_id)
WHERE r.skip_reason IS NULL
ORDER BY r.customer_id;

-- ----------------------------------------------------------------------------
-- ROLLBACK = rehearsal.  COMMIT = for real (back up first).
-- ----------------------------------------------------------------------------
ROLLBACK;
