-- ============================================================================
-- Alfred A Brown (customer 3709) - turn a J$500 credit into J$500 OWING.
--
-- Instruction 2026-09-18: "as of rn he should owe 500, not have a credit of
-- 500". Original note was "500 credit should a balance for August".
--
--   balance now      -500.00  (a J$500 credit)
--   balance wanted    500.00  (J$500 outstanding)
--   adjustment       1000.00
--
-- Kept in its own file because it is the only one of this batch that puts a
-- customer into debt, and the guards in the batch scripts refuse to do that
-- on purpose. Same handling as Sandra Ferguson (15064).
--
-- Note the adjustment is 1,000, not 500: removing the 500 credit only brings
-- him to zero. Going from a 500 credit to a 500 debt is a 1,000 swing.
--
-- Guards: name must be Alfred A Brown, balance must be EXACTLY -500.00 now,
-- and must land on EXACTLY 500.00 after. Idempotent via source_key.
--
-- LAST LINE IS `ROLLBACK` - rehearsal. Read the BEFORE/AFTER rows, back up,
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

DO $g$
DECLARE nm TEXT; b NUMERIC;
BEGIN
    SELECT c.name, s.balance INTO nm, b
    FROM public.customers c
    JOIN public.customer_billing_status s USING (customer_id)
    WHERE c.customer_id = 3709;

    IF nm IS NULL THEN
        RAISE EXCEPTION 'Customer 3709 not found. Nothing changed.';
    END IF;
    IF LOWER(TRIM(nm)) <> 'alfred a brown' THEN
        RAISE EXCEPTION 'Customer 3709 is "%", expected Alfred A Brown. Nothing changed.', nm;
    END IF;
    IF b <> -500.00 THEN
        RAISE EXCEPTION 'Balance for 3709 is %, expected -500.00. Something has moved since it was checked - recheck before correcting.', b;
    END IF;
END $g$;

SELECT 'BEFORE' AS check, c.name, b.balance, b.outstanding_balance, b.credit_balance
FROM public.customer_billing_status b
JOIN public.customers c USING (customer_id)
WHERE b.customer_id = 3709;

INSERT INTO public.account_ledger_entries (
    customer_id, entry_type, amount, effective_date, description,
    created_by_employee_id, reason, is_verified, source_key
) VALUES (
    3709, 'adjustment', 1000.00,
    (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
    'Balance corrected on review: August is outstanding, not in credit (account review 2026-09-18).',
    2,
    'Account review 2026-09-18 confirmed this account should be showing J$500.00 outstanding for August rather than a J$500.00 credit. The 1,000.00 adjustment covers removing the credit and raising the amount owed.',
    TRUE,
    'father-credit-fix-20260917:3709'
)
ON CONFLICT (source_key) DO NOTHING;

DO $g$
DECLARE b NUMERIC;
BEGIN
    SELECT balance INTO b FROM public.customer_billing_status WHERE customer_id = 3709;
    IF b <> 500.00 THEN
        RAISE EXCEPTION 'Balance for 3709 is % after the adjustment, expected 500.00. Nothing committed.', b;
    END IF;
END $g$;

INSERT INTO public.audit_logs (
    employee_id, actor_name, action, entity_type, entity_id,
    field_name, old_value, new_value, reason, occurred_at, source_key
)
SELECT (SELECT employee_id FROM actor), (SELECT actor_name FROM actor),
       'Adjusted account balance', 'customer', '3709',
       'balance', '-500.00', '500.00',
       'Account review 2026-09-18: August is outstanding on this account, so the J$500.00 credit was replaced with J$500.00 owing.',
       CURRENT_TIMESTAMP, 'father-credit-fix-20260917:3709'
ON CONFLICT (source_key) DO NOTHING;

SELECT 'AFTER' AS check, b.balance, b.outstanding_balance, b.credit_balance
FROM public.customer_billing_status b
WHERE b.customer_id = 3709;

-- ----------------------------------------------------------------------------
-- ROLLBACK = rehearsal.  COMMIT = for real (back up first).
-- ----------------------------------------------------------------------------
ROLLBACK;
