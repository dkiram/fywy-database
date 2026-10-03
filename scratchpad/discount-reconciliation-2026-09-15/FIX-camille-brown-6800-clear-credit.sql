-- ============================================================================
-- Camille Brown (customer 6800) - clear the credit. Balance -2,500 -> 0.
--
-- This is the "Camille brown Newport square" from the 2026-09-30 list, the one
-- FIX-father-list-2026-09-30.sql reported as NOT FOUND. The account name on
-- file is simply "Camille Brown" with NO suffix - Newport Square is where she
-- is, not part of the name - so every pattern containing "newport" missed her.
--
-- Why this is the right account:
--   * she is the only remaining "Camille Brown" once 14298 (Boose and Games)
--     and 14356 (Di Imerial Entertainment) are accounted for, and both of
--     those are already cleared;
--   * she holds EXACTLY the J$2,500 the message quoted;
--   * no account with "Newport" in its name belongs to a Camille Brown.
--
-- Her two namesakes were separate businesses with suffixes; this one is the
-- residential account. All three were distinct accounts, not duplicates.
--
-- Guards: the name on file must be exactly "Camille Brown" (so a suffixed
-- namesake cannot be hit by mistake), the balance must be EXACTLY -2,500.00,
-- and it must land on EXACTLY 0.00. Idempotent via source_key, which follows
-- the same 2026-09-30 batch key so this reads as part of that day's work.
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
    WHERE c.customer_id = 6800;

    IF nm IS NULL THEN
        RAISE EXCEPTION 'Customer 6800 not found, or has no billing status row. Nothing changed.';
    END IF;
    -- Exact, not a LIKE: "Camille Brown/Boose and Games" must not pass here.
    IF LOWER(TRIM(nm)) <> 'camille brown' THEN
        RAISE EXCEPTION 'Customer 6800 is "%", expected exactly "Camille Brown". Nothing changed.', nm;
    END IF;
    IF b <> -2500.00 THEN
        RAISE EXCEPTION 'Balance for 6800 is %, expected -2500.00. Something has moved - recheck before correcting.', b;
    END IF;
END $g$;

SELECT 'BEFORE' AS check, c.customer_id, c.name, c.status, c.monthly_fee,
       b.balance, b.outstanding_balance, b.credit_balance
FROM public.customer_billing_status b
JOIN public.customers c USING (customer_id)
WHERE b.customer_id = 6800;

INSERT INTO public.account_ledger_entries (
    customer_id, entry_type, amount, effective_date, description,
    created_by_employee_id, reason, is_verified, source_key
) VALUES (
    6800, 'adjustment', 2500.00,
    (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
    'Credit removed on review: the account should not be carrying a credit (account review 2026-09-30).',
    2,
    'Account review 2026-09-30 confirmed this account should not be holding a credit balance. Removed in full; the underlying payments are untouched.',
    TRUE,
    'father-credit-fix-20260930:6800'
)
ON CONFLICT (source_key) DO NOTHING;

DO $g$
DECLARE b NUMERIC;
BEGIN
    SELECT balance INTO b FROM public.customer_billing_status WHERE customer_id = 6800;
    IF b <> 0.00 THEN
        RAISE EXCEPTION 'Balance for 6800 is % after the adjustment, expected 0.00. Nothing committed.', b;
    END IF;
END $g$;

INSERT INTO public.audit_logs (
    employee_id, actor_name, action, entity_type, entity_id,
    field_name, old_value, new_value, reason, occurred_at, source_key
)
SELECT (SELECT employee_id FROM actor), (SELECT actor_name FROM actor),
       'Adjusted account balance', 'customer', '6800',
       'balance', '-2500.00', '0.00',
       'Account review 2026-09-30: credit removed, the account should not be carrying one.',
       CURRENT_TIMESTAMP, 'father-credit-fix-20260930:6800'
ON CONFLICT (source_key) DO NOTHING;

SELECT 'AFTER' AS check, b.balance, b.outstanding_balance, b.credit_balance
FROM public.customer_billing_status b
WHERE b.customer_id = 6800;

-- ----------------------------------------------------------------------------
-- ROLLBACK = rehearsal.  COMMIT = for real (back up first).
-- ----------------------------------------------------------------------------
ROLLBACK;
