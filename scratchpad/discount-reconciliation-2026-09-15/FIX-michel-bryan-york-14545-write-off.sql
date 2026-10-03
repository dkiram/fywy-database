-- ============================================================================
-- Michel Bryan York (customer 14545) - write off the outstanding balance.
-- Balance +76,500.00 -> 0.00.
--
-- Instruction 2026-09-29: "Michel Bryan York remove 76,100 balance",
-- confirmed 2026-09-30 as clearing the whole balance (the message said
-- 76,100; the live balance is 76,500, and the intent is a clean zero rather
-- than leaving a J$400 residue to chase).
--
-- THIS IS NOT A PHANTOM-CREDIT CORRECTION. Every other entry in the daily
-- review series removes credit the customer never really had. This FORGIVES
-- MONEY OWED - J$76,500 of it, roughly thirty times the size of a typical
-- item in these lists. Recorded as a deliberate write-off so it reads that
-- way in the audit log rather than looking like routine tidying.
--
-- WHAT THE LEDGER SHOWS (checked 2026-09-29):
--   activation 2022-03-06, status active, monthly fee 2,500
--   32 monthly_charge rows totalling 80,000, dated 2024-02-06 to 2026-09-06
--    2 monthly_payment rows totalling -3,500, both posted 2026-09-29
--   balance 76,500
-- The debt is genuine accumulated billing - unpaid monthly charges over two
-- and a half years - not a legacy opening_balance or a migration artefact.
-- The customer has also been paying recently: 8 receipts, J$15,000, since
-- 2026-07-20, including J$3,500 on the day the instruction was written.
--
-- A SECOND ACCOUNT HAS THE SAME NAME AND THE SAME ACTIVATION DATE.
-- Customer 4715 "Michel Bryan York", activation 2022-03-06, disconnected,
-- owes J$10,000 (4 monthly charges, Oct 2023 - Jan 2024; 26 receipts
-- totalling 46,500 up to 2024-02-21). It looks like the same person
-- re-registered: the old account's payments stop in Feb 2024 and this one's
-- charges begin in Feb 2024. THIS SCRIPT DOES NOT TOUCH 4715. If that 10,000
-- should also go, or the accounts should be merged, that is a separate
-- decision - say so and I will write it.
--
-- Guards: the name on file must match, the balance must be EXACTLY
-- +76,500.00 now, and it must land on EXACTLY 0.00. If he has paid again
-- since the check the balance will differ and the script aborts, changing
-- nothing - re-read it rather than forcing it through. Idempotent via
-- source_key.
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
DECLARE nm TEXT; st TEXT; b NUMERIC;
BEGIN
    SELECT c.name, c.status, s.balance INTO nm, st, b
    FROM public.customers c
    JOIN public.customer_billing_status s USING (customer_id)
    WHERE c.customer_id = 14545;

    IF nm IS NULL THEN
        RAISE EXCEPTION 'Customer 14545 not found, or has no billing status row. Nothing changed.';
    END IF;
    IF LOWER(TRIM(nm)) <> 'michel bryan york' THEN
        RAISE EXCEPTION 'Customer 14545 is "%", expected Michel Bryan York. Nothing changed.', nm;
    END IF;
    IF b <> 76500.00 THEN
        RAISE EXCEPTION 'Balance for 14545 is %, expected 76500.00. He may have paid again since this was checked - re-read the account before writing anything off. Nothing changed.', b;
    END IF;
END $g$;

SELECT 'BEFORE' AS check, c.customer_id, c.name, c.status, c.monthly_fee,
       c.activation_date, b.balance, b.outstanding_balance, b.credit_balance
FROM public.customer_billing_status b
JOIN public.customers c USING (customer_id)
WHERE b.customer_id = 14545;

-- For the record in the rehearsal output: the other account with this name.
SELECT 'NOT TOUCHED - same name, second account' AS check,
       c.customer_id, c.name, c.status, c.activation_date, b.balance
FROM public.customers c
JOIN public.customer_billing_status b USING (customer_id)
WHERE c.customer_id = 4715;

INSERT INTO public.account_ledger_entries (
    customer_id, entry_type, amount, effective_date, description,
    created_by_employee_id, reason, is_verified, source_key
) VALUES (
    14545, 'adjustment', -76500.00,
    (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
    'Outstanding balance written off at management instruction (account review 2026-09-29).',
    2,
    'Management write-off approved 2026-09-29: the full outstanding balance of J$76,500.00 on this account is cleared. The balance was 32 unpaid monthly charges dated 2024-02-06 to 2026-09-06. This is a deliberate forgiveness of money owed, not a correction of a phantom credit. The underlying charges and payments are left on the ledger.',
    TRUE,
    'father-credit-fix-20260929:writeoff:14545'
)
ON CONFLICT (source_key) DO NOTHING;

DO $g$
DECLARE b NUMERIC;
BEGIN
    SELECT balance INTO b FROM public.customer_billing_status WHERE customer_id = 14545;
    IF b <> 0.00 THEN
        RAISE EXCEPTION 'Balance for 14545 is % after the write-off, expected 0.00. Nothing committed.', b;
    END IF;
END $g$;

INSERT INTO public.audit_logs (
    employee_id, actor_name, action, entity_type, entity_id,
    field_name, old_value, new_value, reason, occurred_at, source_key
)
SELECT (SELECT employee_id FROM actor), (SELECT actor_name FROM actor),
       'Wrote off account balance', 'customer', '14545',
       'balance', '76500.00', '0.00',
       'Management write-off approved 2026-09-29: J$76,500.00 of outstanding balance cleared in full. Money owed was forgiven; this was not a phantom-credit correction.',
       CURRENT_TIMESTAMP, 'father-credit-fix-20260929:writeoff:14545'
ON CONFLICT (source_key) DO NOTHING;

SELECT 'AFTER' AS check, b.balance, b.outstanding_balance, b.credit_balance
FROM public.customer_billing_status b
WHERE b.customer_id = 14545;

-- ----------------------------------------------------------------------------
-- ROLLBACK = rehearsal.  COMMIT = for real (back up first).
-- ----------------------------------------------------------------------------
ROLLBACK;
