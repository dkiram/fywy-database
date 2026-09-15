-- ============================================================================
-- Balance corrections, batch 2026-09-15.
--
-- Same mechanism as zero-credits-2026-09.sql: one 'adjustment' entry per
-- customer moves the balance to an exact target. Most here are "clear the
-- credit" (target 0.00); two are "should have a credit of 2,500" - Trace
-- Thomas and Jason Burrel currently owe nothing and have no credit, so this
-- CREATES a 2,500 credit for them rather than correcting an existing one.
--
-- NOT INCLUDED: Annett Miller (14954) - she has a -5,000 credit but only a
-- month-label fix was requested for her; see fix-annett-miller-14954-2026-09.sql.
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
--   expected_balance_before - NULL to skip the check
--   target_balance          - 0.00 clears a credit; negative leaves a smaller
--                             credit; here also used to CREATE a credit from 0
-- ----------------------------------------------------------------------------
CREATE TEMP TABLE credit_fixes ON COMMIT DROP AS
SELECT * FROM (VALUES
    (8429,  0.00::NUMERIC,     -2500.00::NUMERIC),  -- Trace Thomas: create 2,500 credit
    (9818,  -2500.00::NUMERIC,     0.00::NUMERIC),  -- Garfield Kelly: clear credit
    (11308, -1500.00::NUMERIC,     0.00::NUMERIC),  -- Camoya Mason: zero the credit (was 1,500, not 2,500)
    (12061, 0.00::NUMERIC,     -2500.00::NUMERIC),  -- Jason Burrel: create 2,500 credit
    (13856, -3000.00::NUMERIC,     0.00::NUMERIC),  -- Natalee Grant Williams: clear credit (was 3,000)
    (3696,  -2500.00::NUMERIC,     0.00::NUMERIC),  -- Cheryl Hanson: clear credit
    (9193,  -2500.00::NUMERIC,     0.00::NUMERIC),  -- Lilleth Scott: clear credit
    (10290, -2500.00::NUMERIC,     0.00::NUMERIC),  -- Vanessa Thomas Campbell: clear credit
    (3729,  -5000.00::NUMERIC, -2500.00::NUMERIC)   -- Janet Rose-marie Reid-Hyman: 5,000 credit -> keep only 2,500
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
       'fix-2026-09-15:balance-correction:' || p.customer_id::TEXT
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
       CURRENT_TIMESTAMP, 'fix-2026-09-15:balance-correction:' || p.customer_id::TEXT
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
