-- ============================================================================
-- Melodie OConnor (customer 8571) - post the reconnection fee she paid but was
-- never charged. Balance -1,500 -> 0.
--
-- What the ledger shows for 2026-09-18 (all Shanta Fearon, Kellits):
--   14:07  monthly_payment        -1,500  July 2026    } clears 4,000 arrears
--   14:08  monthly_payment        -2,500  August 2026  }   to exactly 0
--   14:08  reconnection_payment     -500               } fee paid: 1,500
--   15:05  reconnection_payment   -1,000               }   no fee debit exists
--   balance now: -1,500 = the two fee payments sitting as credit
--
-- The 2026-09-18 15:23 message ("clear the credit of 500 and she should have
-- a balance of 1000") describes the account between 14:08 and 15:05: 500 of
-- the fee paid, 1,000 still owed. She paid that 1,000 at 15:05. The fee is
-- fully paid, so her correct balance is 0 - NOT +1,000 owing. Charging her
-- 1,000 now would be charging it twice.
--
-- This is the pattern from customer 11321 (see memory:
-- reconnection-credits-without-charges): a reconnection fee collected at the
-- counter with no reconnection_fee debit, because the disconnection took a
-- path that never posted one. Fix is to post the fee, exactly as pass A of
-- scratchpad/fix-phantom-credits-2026-09.sql does - NOT to touch the
-- payments.
--
-- Guards: name must be Melodie Oconnor, balance must be EXACTLY -1,500.00,
-- there must be NO existing reconnection_fee debit and EXACTLY 1,500.00 of
-- reconnection payments on the account, and it must land on EXACTLY 0.00.
-- Idempotent via source_key.
--
-- The BEFORE output also shows the package's configured reconnection fee. If
-- that is not 1,500, look before committing - it would mean she paid more or
-- less than the standard fee, and the difference is real credit or real debt.
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
DECLARE nm TEXT; b NUMERIC; fee_paid NUMERIC; fee_charged NUMERIC;
BEGIN
    SELECT c.name, s.balance INTO nm, b
    FROM public.customers c
    JOIN public.customer_billing_status s USING (customer_id)
    WHERE c.customer_id = 8571;

    IF nm IS NULL THEN
        RAISE EXCEPTION 'Customer 8571 not found. Nothing changed.';
    END IF;
    IF LOWER(TRIM(nm)) <> 'melodie oconnor' THEN
        RAISE EXCEPTION 'Customer 8571 is "%", expected Melodie Oconnor. Nothing changed.', nm;
    END IF;
    IF b <> -1500.00 THEN
        RAISE EXCEPTION 'Balance for 8571 is %, expected -1500.00. Something has moved - recheck before correcting.', b;
    END IF;

    SELECT COALESCE(-SUM(l.amount) FILTER (WHERE l.entry_type = 'reconnection_payment'), 0),
           COALESCE( SUM(l.amount) FILTER (WHERE l.entry_type = 'reconnection_fee'), 0)
    INTO fee_paid, fee_charged
    FROM public.account_ledger_entries l
    WHERE l.customer_id = 8571;

    IF fee_charged <> 0 THEN
        RAISE EXCEPTION 'Customer 8571 already has % of reconnection_fee on the ledger - the credit is not what this script assumes. Nothing changed.', fee_charged;
    END IF;
    IF fee_paid <> 1500.00 THEN
        RAISE EXCEPTION 'Customer 8571 has % of reconnection payments, expected 1500.00. Nothing changed.', fee_paid;
    END IF;
END $g$;

SELECT 'BEFORE' AS check, c.name, c.status, b.balance, b.credit_balance,
       pk.reconnection_fee AS package_reconnection_fee
FROM public.customer_billing_status b
JOIN public.customers c USING (customer_id)
LEFT JOIN public.packages pk ON pk.package_id = c.package_id
WHERE b.customer_id = 8571;

INSERT INTO public.account_ledger_entries (
    customer_id, entry_type, amount, effective_date, due_date, grace_end_date,
    description, created_by_employee_id, reason, is_verified, source_key
) VALUES (
    8571, 'reconnection_fee', 1500.00,
    (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
    (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
    (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
    'Reconnection fee (paid at the counter 2026-09-18; the disconnection never posted the charge)',
    2,
    'J$1,500.00 of Reconnection Fee payments on record (500 + 1,000, both 2026-09-18) with no matching reconnection_fee debit; posted to match what was collected. Account review 2026-09-18.',
    TRUE,
    'father-credit-fix-20260918:recon-fee:8571'
)
ON CONFLICT (source_key) DO NOTHING;

DO $g$
DECLARE b NUMERIC;
BEGIN
    SELECT balance INTO b FROM public.customer_billing_status WHERE customer_id = 8571;
    IF b <> 0.00 THEN
        RAISE EXCEPTION 'Balance for 8571 is % after posting the fee, expected 0.00. Nothing committed.', b;
    END IF;
END $g$;

INSERT INTO public.audit_logs (
    employee_id, actor_name, action, entity_type, entity_id,
    field_name, old_value, new_value, reason, occurred_at, source_key
)
SELECT (SELECT employee_id FROM actor), (SELECT actor_name FROM actor),
       'Adjusted account balance', 'customer', '8571',
       'balance', '-1500.00', '0.00',
       'Posted the J$1,500.00 reconnection fee collected 2026-09-18 that had no matching charge on the ledger. Account review 2026-09-18.',
       CURRENT_TIMESTAMP, 'father-credit-fix-20260918:recon-fee:8571'
ON CONFLICT (source_key) DO NOTHING;

SELECT 'AFTER' AS check, b.balance, b.outstanding_balance, b.credit_balance
FROM public.customer_billing_status b
WHERE b.customer_id = 8571;

-- ----------------------------------------------------------------------------
-- ROLLBACK = rehearsal.  COMMIT = for real (back up first).
-- ----------------------------------------------------------------------------
ROLLBACK;
