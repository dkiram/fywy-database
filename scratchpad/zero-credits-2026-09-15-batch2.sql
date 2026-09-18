-- ============================================================================
-- Balance corrections, batch 2 of 2026-09-15.
--
-- Same mechanism as the earlier batches: one 'adjustment' entry per customer
-- moves the balance to an exact target.
--
-- Three rows are already at their target (Carla Mayne, Samone Patterson,
-- Loretta Pryce) - they're listed so you can SEE they're already correct;
-- the script posts nothing for them (a 0.00 ledger entry is rejected by the
-- table's own CHECK amount <> 0 anyway).
--
-- Otis Reid (7545) is different from the rest of this batch: he doesn't have
-- a credit, he OWES 2,000.00. "No balance" still means target 0, but this
-- forgives a debt rather than removing a credit - double check that's really
-- what was meant before running.
--
-- HELD BACK: Nalda Hussling (12319) - "remove 2,500 from credit" but her
-- balance is 0.00, no credit exists to remove from. Not included here.
--
-- HELD BACK: Charmen Douglas (11478) - already 0.00/0.00, nothing to do, not
-- included here.
--
-- Plain SQL. TablePlus "Run All" or psql. Run on BOTH databases.
-- LAST LINE IS `ROLLBACK` - rehearsal. Read every printed row, back up,
-- change ROLLBACK -> COMMIT, run again.
--
--   docker exec -it spcl-backup sh /opt/spcl-deploy/backup.sh   # before COMMIT
-- ============================================================================

BEGIN;

CREATE TEMP TABLE actor ON COMMIT DROP AS
SELECT e.employee_id, e.first_name || ' ' || e.last_name AS actor_name
FROM public.employees e WHERE e.employee_id = 2;

DO $g$
DECLARE n INTEGER;
BEGIN
    SELECT count(*) INTO n FROM actor;
    IF n <> 1 THEN RAISE EXCEPTION 'employee_id 2 matched % rows, expected 1. Nothing changed.', n; END IF;
END $g$;

-- ----------------------------------------------------------------------------
-- THE ONLY BLOCK YOU EDIT.
-- ----------------------------------------------------------------------------
CREATE TEMP TABLE credit_fixes ON COMMIT DROP AS
SELECT * FROM (VALUES
    (13350, -2000.00::NUMERIC,     0.00::NUMERIC),  -- Shaneka Tyrell #2: no credit
    (7905,  -2500.00::NUMERIC, -2500.00::NUMERIC),  -- Carla Mayne: already correct (no-op)
    (9922,  -5000.00::NUMERIC, -3250.00::NUMERIC),  -- Catherine Harrison: credit should be 3,250
    (8080,  -2500.00::NUMERIC,     0.00::NUMERIC),  -- Dave O. Wedderburn: not supposed to have a credit
    (1365,      0.00::NUMERIC,     0.00::NUMERIC),  -- Samone Patterson: already correct (no-op)
    (4381,  -2500.00::NUMERIC,     0.00::NUMERIC),  -- Christal Fuller: should not have a credit
    (7435,  -4000.00::NUMERIC,     0.00::NUMERIC),  -- Rowan Patterson: no credit
    (5423,  -7000.00::NUMERIC, -3500.00::NUMERIC),  -- Richie Bramwell: only 3,500 credit
    (12121, -2500.00::NUMERIC,     0.00::NUMERIC),  -- Yanique Smith: clear credit
    (7545,   2000.00::NUMERIC,     0.00::NUMERIC),  -- Otis Reid: no balance (he OWES 2,000 - forgives a debt, not a credit)
    (9719,  -5000.00::NUMERIC, -2500.00::NUMERIC),  -- Delbert Lodge-Rose Hall: credit should only be 2,500
    (4834,  -4000.00::NUMERIC,     0.00::NUMERIC),  -- Lancaster S.D.A Church: no credit
    (4059,  -5000.00::NUMERIC, -5000.00::NUMERIC),  -- Loretta Pryce: already correct (no-op)
    (10076, -9000.00::NUMERIC,     0.00::NUMERIC)   -- Sanna Gay Rowe: clear credit
) AS v(customer_id, expected_balance_before, target_balance);

-- ----------------------------------------------------------------------------
-- Resolve current balances and validate every row before touching anything.
-- ----------------------------------------------------------------------------
CREATE TEMP TABLE credit_plan ON COMMIT DROP AS
SELECT f.customer_id,
       f.expected_balance_before,
       f.target_balance,
       c.name,
       b.balance AS balance_before,
       (f.target_balance - b.balance)::NUMERIC(14,2) AS adjustment_amount
FROM credit_fixes f
LEFT JOIN public.customers c               ON c.customer_id = f.customer_id
LEFT JOIN public.customer_billing_status b ON b.customer_id = f.customer_id;

DO $g$
DECLARE r RECORD;
    problems INTEGER := 0;
BEGIN
    FOR r IN SELECT * FROM credit_plan LOOP
        IF r.name IS NULL THEN
            RAISE WARNING 'customer % not found', r.customer_id; problems := problems + 1; CONTINUE;
        END IF;
        IF r.balance_before IS NULL THEN
            RAISE WARNING 'customer % (%) has no billing status row', r.customer_id, r.name;
            problems := problems + 1; CONTINUE;
        END IF;
        IF r.expected_balance_before IS NOT NULL AND r.balance_before <> r.expected_balance_before THEN
            RAISE WARNING 'customer % (%) balance is % but you expected % - skipping',
                r.customer_id, r.name, r.balance_before, r.expected_balance_before;
            problems := problems + 1; CONTINUE;
        END IF;
    END LOOP;
    IF problems > 0 THEN
        RAISE EXCEPTION '% row(s) failed validation - see warnings. Nothing changed.', problems;
    END IF;
END $g$;

SELECT 'ABOUT TO ADJUST' AS check, customer_id, name, balance_before,
       adjustment_amount AS adjustment_to_post, target_balance
FROM credit_plan ORDER BY customer_id;

INSERT INTO public.account_ledger_entries (
    customer_id, entry_type, amount, effective_date, description,
    created_by_employee_id, reason, is_verified, source_key
)
SELECT p.customer_id, 'adjustment', p.adjustment_amount,
       (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
       'Correction: balance adjusted to J$' || p.target_balance::TEXT || ' at management request',
       2,
       'Balance moved from ' || p.balance_before::TEXT || ' to ' || p.target_balance::TEXT || ' at management request.',
       TRUE,
       'fix-2026-09-15b:balance-correction:' || p.customer_id::TEXT
FROM credit_plan p
WHERE p.adjustment_amount <> 0
ON CONFLICT (source_key) DO NOTHING;

DO $g$
DECLARE r RECORD;
BEGIN
    FOR r IN
        SELECT p.customer_id, p.name, p.target_balance, b.balance
        FROM credit_plan p JOIN public.customer_billing_status b USING (customer_id)
    LOOP
        IF r.balance <> r.target_balance THEN
            RAISE EXCEPTION 'customer % (%) balance is % after adjustment, expected %. Nothing committed.',
                r.customer_id, r.name, r.balance, r.target_balance;
        END IF;
    END LOOP;
END $g$;

INSERT INTO public.audit_logs (
    employee_id, actor_name, action, entity_type, entity_id,
    field_name, old_value, new_value, reason, occurred_at, source_key
)
SELECT (SELECT employee_id FROM actor), (SELECT actor_name FROM actor),
       'Adjusted account balance', 'customer', p.customer_id::TEXT,
       'balance', p.balance_before::TEXT, p.target_balance::TEXT,
       'Balance corrected to J$' || p.target_balance::TEXT || ' at management request.',
       CURRENT_TIMESTAMP, 'fix-2026-09-15b:balance-correction:' || p.customer_id::TEXT
FROM credit_plan p
WHERE p.adjustment_amount <> 0
ON CONFLICT (source_key) DO NOTHING;

SELECT 'AFTER' AS check, p.customer_id, p.name, b.balance, b.outstanding_balance, b.credit_balance
FROM credit_plan p JOIN public.customer_billing_status b USING (customer_id)
ORDER BY p.customer_id;

-- ----------------------------------------------------------------------------
-- ROLLBACK = rehearsal.  COMMIT = for real (back up first, run on BOTH DBs).
-- ----------------------------------------------------------------------------
ROLLBACK;
