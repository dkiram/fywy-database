-- ============================================================================
-- Andrea Williams-Green Street (customer 13566) - raise her credit from
-- J$1,500 to J$3,000.
--
-- Instruction 2026-09-17: "Andrea Williams-Green Street Should Have A Credit
-- Of 3000", confirmed 2026-09-18.
--
--   balance now     -1,500.00  (a J$1,500 credit)
--   balance wanted  -3,000.00  (a J$3,000 credit)
--   adjustment      -1,500.00  (a CREDIT entry - negative amount)
--
-- This is the ONLY correction in the 2026-09-17/18 batch that gives a
-- customer money instead of taking it, which is why it is on its own: every
-- batch script guards with "would not reduce credit" and would skip her.
--
-- Supporting evidence: she paid August as two receipts totalling exactly her
-- J$3,000 monthly fee (payments 438685 and 442838). Those were checked during
-- the duplicate-receipt sweep and are a normal split payment, not duplicates -
-- so the August money is real and a J$3,000 credit is consistent with it.
--
-- Guards: name must be Andrea Williams-Green Street, balance must be EXACTLY
-- -1,500.00 now, and must land on EXACTLY -3,000.00 after. Idempotent via
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
DECLARE nm TEXT; b NUMERIC;
BEGIN
    SELECT c.name, s.balance INTO nm, b
    FROM public.customers c
    JOIN public.customer_billing_status s USING (customer_id)
    WHERE c.customer_id = 13566;

    IF nm IS NULL THEN
        RAISE EXCEPTION 'Customer 13566 not found. Nothing changed.';
    END IF;
    IF LOWER(TRIM(nm)) <> 'andrea williams-green street' THEN
        RAISE EXCEPTION 'Customer 13566 is "%", expected Andrea Williams-Green Street. Nothing changed.', nm;
    END IF;
    IF b <> -1500.00 THEN
        RAISE EXCEPTION 'Balance for 13566 is %, expected -1500.00. Something has moved since it was checked - recheck before correcting.', b;
    END IF;
END $g$;

SELECT 'BEFORE' AS check, c.name, b.balance, b.outstanding_balance, b.credit_balance
FROM public.customer_billing_status b
JOIN public.customers c USING (customer_id)
WHERE b.customer_id = 13566;

INSERT INTO public.account_ledger_entries (
    customer_id, entry_type, amount, effective_date, description,
    created_by_employee_id, reason, is_verified, source_key
) VALUES (
    13566, 'adjustment', -1500.00,
    (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
    'Credit restored to the reviewed amount (account review 2026-09-18).',
    2,
    'Account review 2026-09-18 confirmed this account should be carrying a J$3,000.00 credit rather than J$1,500.00. Her August payment was taken as two receipts totalling her full J$3,000.00 monthly fee, which supports the larger credit.',
    TRUE,
    'father-credit-fix-20260917:13566'
)
ON CONFLICT (source_key) DO NOTHING;

DO $g$
DECLARE b NUMERIC;
BEGIN
    SELECT balance INTO b FROM public.customer_billing_status WHERE customer_id = 13566;
    IF b <> -3000.00 THEN
        RAISE EXCEPTION 'Balance for 13566 is % after the adjustment, expected -3000.00. Nothing committed.', b;
    END IF;
END $g$;

INSERT INTO public.audit_logs (
    employee_id, actor_name, action, entity_type, entity_id,
    field_name, old_value, new_value, reason, occurred_at, source_key
)
SELECT (SELECT employee_id FROM actor), (SELECT actor_name FROM actor),
       'Adjusted account balance', 'customer', '13566',
       'balance', '-1500.00', '-3000.00',
       'Account review 2026-09-18: credit restored to J$3,000.00, consistent with the full monthly fee paid for August.',
       CURRENT_TIMESTAMP, 'father-credit-fix-20260917:13566'
ON CONFLICT (source_key) DO NOTHING;

SELECT 'AFTER' AS check, b.balance, b.outstanding_balance, b.credit_balance
FROM public.customer_billing_status b
WHERE b.customer_id = 13566;

-- ----------------------------------------------------------------------------
-- ROLLBACK = rehearsal.  COMMIT = for real (back up first).
-- ----------------------------------------------------------------------------
ROLLBACK;
