-- ============================================================================
-- The seven items from the 2026-10-07/08 lists that go to a stated figure
-- rather than to zero. Read the `direction` column - these move both ways.
--
-- Credit targets:
--    7905  Carla Mayne             "paid in advance for sept, should have
--                                   a $2500 credit"          -> -2,500
--          Catherine Harrison      "credit should be 3250"    -> -3,250
--          Richie Bramwell         "only 3500 credit"         -> -3,500
--    9719  Delbert Lodge-Rose Hall "credit should only be 2500" -> -2,500
--          Michael Spence          "credit should be 2500"    -> -2,500
--
-- Debt:
--          Novelett Marshall       "add 3500 balance"     adjustment +3,500
--   11780  Venese Windeth          "remove 500 credit and add 2500 balance"
--                                                             -> +2,500
--
-- Venese Windeth's instruction has two halves and they combine: clearing a
-- 500 credit reaches zero, then 2,500 of balance is raised on top. If she is
-- at -500 now that is a 3,000 adjustment, not 2,500 - the BEFORE block shows
-- the arithmetic.
--
-- Novelett Marshall is the one mode here that does NOT target a figure: "add
-- 3500 balance" adds 3,500 to wherever she is. If she is in credit it eats
-- the credit first; if she is at zero she ends up owing 3,500.
--
-- A target can go either way depending on where the account sits now, so any
-- row labelled "ADDS CREDIT" is giving the customer money - worth a look
-- before committing. Carla Mayne's is explicitly that case: she is described
-- as having PAID AHEAD for September, so a credit is expected there.
--
-- Delbert Lodge-Rose Hall (9719) also appeared in the settled-twice sweep on
-- 2026-09-19 as a clean-slate account that had paid a forgiven month again.
-- He has not been corrected for that, so some of his credit may be the
-- duplicate settlement rather than real prepayment. Capping him at 2,500 is
-- consistent with removing the excess either way.
--
-- Added 2026-10-09 once the amounts came back:
--          Marlon Mayne CX   "should not have a credit and should have a
--                             balance", confirmed as owing 2,500  -> +2,500
--          Rachea Matthews   "should have a balance for sept", confirmed as
--                             ONE MONTH'S FEE                     -> +fee
--
-- Rachea Matthews uses the 'owemonth' mode: her target is her OWN monthly fee
-- read from the account, not a number typed into this script. If her fee is
-- 2,500 she ends owing 2,500; if it is 4,000 she ends owing 4,000. That is
-- what "one month's fee" means and it cannot drift out of date. The row is
-- skipped if no fee is on file.
--
-- Marlon Mayne (8125) appeared in the settled-twice sweep on 2026-09-19 -
-- clean-slate, with two December 2025 receipts for the same month. "Should not
-- have a credit and should have a balance" fits that: the credit was a
-- duplicate settlement and the month underneath is genuinely unpaid. Note
-- your father wrote "Marlon mayne cx"; the search is on the name alone, so
-- check the candidates block for whether an account carries that suffix.
--
-- Guards: one account per name, name on file must match where an id is
-- pinned, and each must land EXACTLY on its computed target. Idempotent via
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

-- mode 'target'   = move to target_balance.
-- mode 'addbal'   = add amount to whatever the balance is now.
-- mode 'owemonth' = end up owing exactly one month's fee, read from the
--                   account's own monthly_fee.
CREATE TEMP TABLE wanted (
    label          TEXT PRIMARY KEY,
    known_id       INTEGER,
    pattern        TEXT,
    mode           TEXT,
    amount         NUMERIC(14,2),
    target_balance NUMERIC(14,2),
    instruction    TEXT
) ON COMMIT DROP;

INSERT INTO wanted VALUES
('Carla Mayne',             7905, NULL,                   'target', NULL, -2500.00, 'paid in advance for September, should have a 2,500 credit'),
('Catherine Harrison',      NULL, '%catherine%harrison%', 'target', NULL, -3250.00, 'credit should be 3,250'),
('Richie Bramwell',         NULL, '%richie%bramwell%',    'target', NULL, -3500.00, 'should have only 3,500 credit'),
('Delbert Lodge-Rose Hall', 9719, NULL,                   'target', NULL, -2500.00, 'credit should only be 2,500'),
('Michael Spence',          NULL, '%michael%spence%',     'target', NULL, -2500.00, 'credit should be 2,500'),
('Venese Windeth',         11780, NULL,                   'target', NULL,  2500.00, 'remove the 500 credit and add 2,500 balance'),
('Novelett Marshall',       NULL, '%novelett%marshall%',  'addbal', 3500.00,  NULL, 'add 3,500 balance'),
('Rachea Matthews',         NULL, '%rache%matthews%',   'owemonth', NULL,     NULL, 'should have a balance for September - one month''s fee');

-- MARLON MAYNE IS DELIBERATELY NOT IN THE LIST ABOVE. The instruction was
-- "should not have a credit and should have a balance", confirmed as owing
-- 2,500 - but customer 8125 "Marlon Mayne" is DISCONNECTED and already OWES
-- J$12,000. He holds no credit at all, so the premise behind the instruction
-- does not hold, and setting him to owe 2,500 would FORGIVE J$9,500 of debt.
-- That is not a credit correction, it is a large write-off, and it needs to be
-- asked rather than inferred. To apply it once confirmed, add:
--   ('Marlon Mayne CX', 8125, NULL, 'target', NULL, 2500.00,
--    'should owe 2,500'),
-- and expect a row labelled "FORGIVES DEBT" in the WILL APPLY block.

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
         WHEN 'target'   THEN (c.target_balance - c.balance)
         WHEN 'addbal'   THEN c.amount
         WHEN 'owemonth' THEN (c.monthly_fee - c.balance)
       END AS adjustment,
       CASE c.mode
         WHEN 'target'   THEN c.target_balance
         WHEN 'addbal'   THEN (c.balance + c.amount)
         WHEN 'owemonth' THEN c.monthly_fee
       END AS computed_target,
       CASE
           -- Added 2026-10-09. Without this the script is not re-runnable: an
           -- 'addbal' row recomputes a NEW destination every run (balance +
           -- amount), while ON CONFLICT blocks the second insert, so the
           -- balance cannot reach it and the final guard aborts the whole
           -- transaction. Novelett Marshall hit exactly that. 'target' rows
           -- self-heal because their destination is absolute; this makes every
           -- mode safe to re-run.
           WHEN EXISTS (SELECT 1 FROM public.account_ledger_entries l
                        WHERE l.source_key = 'father-credit-fix-20261008:' || c.customer_id::TEXT)
                                          THEN 'already applied in an earlier run of this batch'
           WHEN c.candidates_for_name > 1 THEN 'more than one match - supply the account number'
           WHEN c.balance IS NULL         THEN 'no billing status row'
           WHEN c.mode = 'target'
            AND c.target_balance = c.balance THEN 'already at target - nothing to do'
           WHEN c.mode = 'owemonth'
            AND COALESCE(c.monthly_fee, 0) <= 0
                                          THEN 'no monthly fee on file - cannot work out one month'
           WHEN c.mode = 'owemonth'
            AND c.monthly_fee = c.balance THEN 'already owes exactly one month - nothing to do'
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
SELECT 'WILL APPLY' AS check, label, mode, customer_id, name_on_file, status,
       monthly_fee, balance AS balance_now, adjustment,
       computed_target AS balance_after,
       CASE WHEN adjustment < 0                          THEN 'ADDS CREDIT - gives money'
            WHEN computed_target > 0 AND balance > 0      THEN 'INCREASES DEBT'
            WHEN computed_target > 0                      THEN 'CREATES DEBT'
            ELSE                                               'removes credit' END AS direction,
       instruction
FROM resolved WHERE skip_reason IS NULL
ORDER BY label;

SELECT 'SKIPPED' AS check, label, mode, customer_id, name_on_file,
       balance AS balance_now, credit_balance, target_balance, amount,
       candidates_for_name, skip_reason
FROM resolved WHERE skip_reason IS NOT NULL
ORDER BY label, customer_id;

INSERT INTO public.account_ledger_entries (
    customer_id, entry_type, amount, effective_date, description,
    created_by_employee_id, reason, is_verified, source_key
)
SELECT r.customer_id, 'adjustment', r.adjustment,
       (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
       CASE WHEN r.adjustment < 0
            THEN 'Credit adjusted on review (account review 2026-10-08).'
            ELSE 'Balance corrected on review (account review 2026-10-08).' END,
       2,
       'Account review 2026-10-08: ' || r.instruction || '. The underlying payments are untouched.',
       TRUE,
       'father-credit-fix-20261008:' || r.customer_id::TEXT
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
       'Account review 2026-10-08: ' || r.instruction || '.',
       CURRENT_TIMESTAMP, 'father-credit-fix-20261008:' || r.customer_id::TEXT
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
