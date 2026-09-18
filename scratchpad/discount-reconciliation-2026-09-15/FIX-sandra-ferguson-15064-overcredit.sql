-- ============================================================================
-- Sandra Ferguson (customer 15064) - remove the J$2,500 over-credit from the
-- 2026-09-15 reconciliation, leaving J$2,500 OUTSTANDING.
--
-- Kept out of FIX-overcredit-addendum-charged-accounts.sql because that script
-- refuses to put anyone into debt. This one does, deliberately, and only for
-- this account. Approved by Kimmy 2026-09-17: "sandra should have $2500
-- outstanding not 3000".
--
-- The arithmetic behind that figure:
--     500.00  credit the reviewed proposal allowed her
--  -3,000.00  September monthly charge (monthly-charge:15064:2026-09-16)
--  =========
--   2,500.00  outstanding
--
-- Her ledger since the reconciliation:
--   2026-09-15  waiver         -3,000.00  final-reconciliation-20260915:15064
--   2026-09-16  monthly_charge +3,000.00  monthly-charge:15064:2026-09-16
--   balance now 0.00
--
-- The reconciliation gave her 3,000.00 credit where the proposal allowed
-- 500.00. This posts the 2,500.00 difference. It does NOT remove the whole
-- 3,000.00 - that would leave her owing 3,000.00, which is wrong: she is
-- entitled to the 500.00 the proposal allowed.
--
-- Guards: aborts unless her balance is EXACTLY 0.00 now, and aborts unless it
-- lands on EXACTLY 2,500.00 after. Idempotent via source_key, shared with the
-- other over-credit scripts so she cannot be corrected twice.
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

-- Guard: right account, and it is where we verified it on 2026-09-17.
DO $g$
DECLARE nm TEXT; b NUMERIC;
BEGIN
    SELECT c.name, s.balance INTO nm, b
    FROM public.customers c
    JOIN public.customer_billing_status s USING (customer_id)
    WHERE c.customer_id = 15064;

    IF nm IS NULL THEN
        RAISE EXCEPTION 'Customer 15064 not found. Nothing changed.';
    END IF;
    IF LOWER(TRIM(nm)) <> 'sandra ferguson' THEN
        RAISE EXCEPTION 'Customer 15064 is "%", expected Sandra Ferguson. Nothing changed.', nm;
    END IF;
    IF b <> 0.00 THEN
        RAISE EXCEPTION 'Balance for 15064 is %, expected 0.00. Something has moved since 2026-09-17 - recheck before correcting.', b;
    END IF;
END $g$;

SELECT 'BEFORE' AS check, c.name, b.balance, b.outstanding_balance, b.credit_balance
FROM public.customer_billing_status b
JOIN public.customers c USING (customer_id)
WHERE b.customer_id = 15064;

INSERT INTO public.account_ledger_entries (
    customer_id, entry_type, amount, effective_date, description,
    created_by_employee_id, reason, is_verified, source_key
) VALUES (
    15064, 'adjustment', 2500.00,
    (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
    'Corrects credit issued above the approved reconciliation amount on 2026-09-15.',
    2,
    'The 2026-09-15 reconciliation credited this account J$3,000.00 where the reviewed proposal allowed J$500.00. The September monthly charge has since consumed the credit, so removing the J$2,500.00 excess leaves J$2,500.00 outstanding. Approved 2026-09-17.',
    TRUE,
    'reconciliation-overcredit-fix:15064'
)
ON CONFLICT (source_key) DO NOTHING;

-- Guard: lands on exactly 2,500.00 outstanding.
DO $g$
DECLARE b NUMERIC;
BEGIN
    SELECT balance INTO b FROM public.customer_billing_status WHERE customer_id = 15064;
    IF b <> 2500.00 THEN
        RAISE EXCEPTION 'Balance for 15064 is % after the adjustment, expected 2500.00. Nothing committed.', b;
    END IF;
END $g$;

INSERT INTO public.audit_logs (
    employee_id, actor_name, action, entity_type, entity_id,
    field_name, old_value, new_value, reason, occurred_at, source_key
)
SELECT (SELECT employee_id FROM actor), (SELECT actor_name FROM actor),
       'Adjusted account balance', 'customer', '15064',
       'balance', '0.00', '2500.00',
       'Removed J$2,500.00 credit issued above the approved 2026-09-15 reconciliation amount; the September charge had already consumed the credit, leaving the balance outstanding.',
       CURRENT_TIMESTAMP, 'reconciliation-overcredit-fix:15064'
ON CONFLICT (source_key) DO NOTHING;

SELECT 'AFTER' AS check, b.balance, b.outstanding_balance, b.credit_balance
FROM public.customer_billing_status b
WHERE b.customer_id = 15064;

-- ----------------------------------------------------------------------------
-- ROLLBACK = rehearsal.  COMMIT = for real (back up first).
-- ----------------------------------------------------------------------------
ROLLBACK;
