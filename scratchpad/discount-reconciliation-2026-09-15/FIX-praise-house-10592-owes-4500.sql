-- ============================================================================
-- Praise House Ministry/Evelyn Laurence (customer 10592) - clear a J$9,000
-- credit and leave J$4,500 OWING.
--
-- Instruction 2026-09-28: "Clear the credit of 9000 they should have a balance
-- of 4500".
--
--   balance now      -9,000.00  (a J$9,000 credit)
--   balance wanted    4,500.00  (J$4,500 outstanding)
--   adjustment       13,500.00
--
-- In its own file because it is the only correction in this batch that puts an
-- account into debt, and the batch script's guards refuse that on purpose.
-- Same handling as Sandra Ferguson (15064) and Alfred A Brown (3709).
--
-- Note the adjustment is 13,500, not 9,000: clearing the credit only reaches
-- zero. Going from a 9,000 credit to a 4,500 debt is a 13,500 swing. This is
-- the largest single correction in the daily review series so far, which is
-- why both ends are pinned exactly.
--
-- Guards: the name on file must match, the balance must be EXACTLY -9,000.00
-- now, and it must land on EXACTLY 4,500.00 after. If anything has moved since
-- the message was written the script aborts and changes nothing - re-check
-- rather than forcing it. Idempotent via source_key.
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

-- The name on file may be punctuated differently ("Praise House
-- Ministry/Evelyn Laurence", "... Lawrence", a different separator), so this
-- checks the distinctive parts rather than demanding an exact string.
DO $g$
DECLARE nm TEXT; b NUMERIC;
BEGIN
    SELECT c.name, s.balance INTO nm, b
    FROM public.customers c
    JOIN public.customer_billing_status s USING (customer_id)
    WHERE c.customer_id = 10592;

    IF nm IS NULL THEN
        RAISE EXCEPTION 'Customer 10592 not found, or has no billing status row. Nothing changed.';
    END IF;
    IF nm NOT ILIKE '%praise%house%' THEN
        RAISE EXCEPTION 'Customer 10592 is "%", which does not look like Praise House Ministry. Nothing changed.', nm;
    END IF;
    IF b <> -9000.00 THEN
        RAISE EXCEPTION 'Balance for 10592 is %, expected -9000.00. Something has moved since the message - recheck before correcting.', b;
    END IF;
END $g$;

SELECT 'BEFORE' AS check, c.customer_id, c.name, c.status, c.monthly_fee,
       b.balance, b.outstanding_balance, b.credit_balance
FROM public.customer_billing_status b
JOIN public.customers c USING (customer_id)
WHERE b.customer_id = 10592;

INSERT INTO public.account_ledger_entries (
    customer_id, entry_type, amount, effective_date, description,
    created_by_employee_id, reason, is_verified, source_key
) VALUES (
    10592, 'adjustment', 13500.00,
    (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
    'Balance corrected on review: the J$9,000 credit removed and J$4,500 raised as outstanding (account review 2026-09-28).',
    2,
    'Account review 2026-09-28 confirmed this account should be showing J$4,500.00 outstanding rather than a J$9,000.00 credit. The 13,500.00 adjustment covers removing the credit and raising the amount owed. The underlying payments are untouched.',
    TRUE,
    'father-credit-fix-20260928:10592'
)
ON CONFLICT (source_key) DO NOTHING;

DO $g$
DECLARE b NUMERIC;
BEGIN
    SELECT balance INTO b FROM public.customer_billing_status WHERE customer_id = 10592;
    IF b <> 4500.00 THEN
        RAISE EXCEPTION 'Balance for 10592 is % after the adjustment, expected 4500.00. Nothing committed.', b;
    END IF;
END $g$;

INSERT INTO public.audit_logs (
    employee_id, actor_name, action, entity_type, entity_id,
    field_name, old_value, new_value, reason, occurred_at, source_key
)
SELECT (SELECT employee_id FROM actor), (SELECT actor_name FROM actor),
       'Adjusted account balance', 'customer', '10592',
       'balance', '-9000.00', '4500.00',
       'Account review 2026-09-28: the J$9,000.00 credit was removed and J$4,500.00 raised as outstanding.',
       CURRENT_TIMESTAMP, 'father-credit-fix-20260928:10592'
ON CONFLICT (source_key) DO NOTHING;

SELECT 'AFTER' AS check, b.balance, b.outstanding_balance, b.credit_balance
FROM public.customer_billing_status b
WHERE b.customer_id = 10592;

-- ----------------------------------------------------------------------------
-- ROLLBACK = rehearsal.  COMMIT = for real (back up first).
-- ----------------------------------------------------------------------------
ROLLBACK;
