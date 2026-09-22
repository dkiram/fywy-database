-- ============================================================================
-- Howard Sutherland-Mcnie - clear the credit, balance to 0.
--
-- Instruction 2026-09-21: "Showing a credit when it should be 0".
--
-- No customer id came with the message and the name is not in any review
-- file, so this script finds the account itself. It searches loosely (the
-- hyphen and the capital N in McNie may differ on file) and REFUSES to run
-- unless exactly one customer matches. The BEFORE block prints who it found
-- and what they hold - read that line before you commit.
--
-- Guards: exactly one name match, the account must be in credit, and it must
-- land on EXACTLY 0.00 - it can never push anyone into debt. Idempotent via
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

-- Resolve. Loose on purpose; the count guard below is what keeps it safe.
CREATE TEMP TABLE target ON COMMIT DROP AS
SELECT c.customer_id, c.name, c.status, c.monthly_fee,
       b.balance, b.credit_balance
FROM public.customers c
LEFT JOIN public.customer_billing_status b ON b.customer_id = c.customer_id
WHERE c.name ILIKE '%sutherland%'
  AND c.name ILIKE '%mcnie%';

-- Show every candidate, so an ambiguous result is visible rather than silent.
SELECT 'CANDIDATES' AS check, customer_id, name, status, monthly_fee, balance, credit_balance
FROM target ORDER BY customer_id;

DO $g$
DECLARE n INTEGER; b NUMERIC;
BEGIN
    SELECT count(*) INTO n FROM target;
    IF n = 0 THEN
        RAISE EXCEPTION 'No customer matched "Sutherland" + "McNie". Check the spelling on file. Nothing changed.';
    END IF;
    IF n > 1 THEN
        RAISE EXCEPTION '% customers matched - see the CANDIDATES block and pin the right id. Nothing changed.', n;
    END IF;
    SELECT balance INTO b FROM target;
    IF b IS NULL THEN
        RAISE EXCEPTION 'Matched customer has no billing status row. Nothing changed.';
    END IF;
    IF b >= 0 THEN
        RAISE EXCEPTION 'Matched customer is not in credit (balance %). Nothing to clear. Nothing changed.', b;
    END IF;
END $g$;

SELECT 'BEFORE' AS check, customer_id, name, status, balance, credit_balance,
       credit_balance AS removing
FROM target;

INSERT INTO public.account_ledger_entries (
    customer_id, entry_type, amount, effective_date, description,
    created_by_employee_id, reason, is_verified, source_key
)
SELECT t.customer_id, 'adjustment', t.credit_balance,
       (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
       'Credit removed on review: the account should not be carrying a credit (account review 2026-09-21).',
       2,
       'Account review 2026-09-21 confirmed this account should be at 0.00, not in credit. Removed in full; the underlying payments are untouched.',
       TRUE,
       'father-credit-fix-20260921:' || t.customer_id::TEXT
FROM target t
ON CONFLICT (source_key) DO NOTHING;

DO $g$
DECLARE b NUMERIC; cid INTEGER;
BEGIN
    SELECT t.customer_id, s.balance INTO cid, b
    FROM target t JOIN public.customer_billing_status s USING (customer_id);
    IF b <> 0.00 THEN
        RAISE EXCEPTION 'Balance for % is % after the adjustment, expected 0.00. Nothing committed.', cid, b;
    END IF;
END $g$;

INSERT INTO public.audit_logs (
    employee_id, actor_name, action, entity_type, entity_id,
    field_name, old_value, new_value, reason, occurred_at, source_key
)
SELECT (SELECT employee_id FROM actor), (SELECT actor_name FROM actor),
       'Adjusted account balance', 'customer', t.customer_id::TEXT,
       'balance', t.balance::TEXT, '0.00',
       'Account review 2026-09-21: credit removed, account should be at zero.',
       CURRENT_TIMESTAMP, 'father-credit-fix-20260921:' || t.customer_id::TEXT
FROM target t
ON CONFLICT (source_key) DO NOTHING;

SELECT 'AFTER' AS check, t.customer_id, t.name, s.balance AS balance_now
FROM target t JOIN public.customer_billing_status s USING (customer_id);

-- ----------------------------------------------------------------------------
-- ROLLBACK = rehearsal.  COMMIT = for real (back up first).
-- ----------------------------------------------------------------------------
ROLLBACK;
