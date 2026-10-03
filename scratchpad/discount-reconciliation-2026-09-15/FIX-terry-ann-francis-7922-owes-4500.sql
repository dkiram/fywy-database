-- ============================================================================
-- Terry-Ann Francis (customer 7922) - balance to J$4,500 OUTSTANDING.
--
-- Instruction 2026-09-30: "Terry-Ann Francis add 4500", clarified 2026-10-01
-- as "should be outstanding $4500" on account 7922. The original message had
-- no noun after "add", so it could have meant 4,500 of credit or 4,500 of
-- debt - opposite directions. Now settled: she ends up OWING 4,500.
--
-- In its own file because it is the only debt-creating item left from that
-- list, and because the target is absolute rather than a fixed adjustment -
-- the amount posted depends on where she is now:
--     if she is at 0        -> adjustment +4,500
--     if she holds 2,500    -> adjustment +7,000
--     if she already owes 1,000 -> adjustment +3,500
-- The BEFORE block prints her live balance and the adjustment that follows
-- from it. READ THAT before committing.
--
-- SANITY LIMIT. Because the adjustment is computed rather than stated, a wrong
-- account number would post a wrong - possibly enormous - amount silently. The
-- guard below aborts if the required adjustment exceeds J$20,000 in either
-- direction, which is far more than any plausible correction here and well
-- clear of the arithmetic above. If it trips, the account is probably not the
-- one intended - check 7922 before overriding anything.
--
-- Guards: the name on file must match Terry-Ann Francis, the adjustment must
-- be within the sanity limit, and the balance must land on EXACTLY 4,500.00.
-- Idempotent via source_key.
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

CREATE TEMP TABLE plan ON COMMIT DROP AS
SELECT c.customer_id,
       c.name,
       c.status,
       c.monthly_fee,
       b.balance                   AS balance_now,
       b.credit_balance            AS credit_now,
       4500.00::NUMERIC(14,2)      AS target_balance,
       (4500.00 - b.balance)::NUMERIC(14,2) AS adjustment
FROM public.customers c
JOIN public.customer_billing_status b USING (customer_id)
WHERE c.customer_id = 7922;

DO $g$
DECLARE nm TEXT; adj NUMERIC; n INTEGER;
BEGIN
    SELECT count(*) INTO n FROM plan;
    IF n <> 1 THEN
        RAISE EXCEPTION 'Customer 7922 not found, or has no billing status row. Nothing changed.';
    END IF;

    SELECT name, adjustment INTO nm, adj FROM plan;

    IF nm NOT ILIKE '%terry%ann%francis%' THEN
        RAISE EXCEPTION 'Customer 7922 is "%", which does not look like Terry-Ann Francis. Nothing changed.', nm;
    END IF;
    IF adj = 0 THEN
        RAISE EXCEPTION 'Customer 7922 is already at 4500.00. Nothing to do.';
    END IF;
    IF ABS(adj) > 20000.00 THEN
        RAISE EXCEPTION 'Reaching 4500.00 on customer 7922 needs an adjustment of % - far larger than expected. This is probably not the right account. Nothing changed.', adj;
    END IF;
END $g$;

SELECT 'BEFORE' AS check, customer_id, name, status, monthly_fee,
       balance_now, credit_now, target_balance, adjustment,
       CASE WHEN balance_now < 0 THEN 'clears a credit AND raises a debt'
            WHEN balance_now = 0 THEN 'raises a debt from zero'
            ELSE                      'increases an existing debt' END AS what_happens
FROM plan;

INSERT INTO public.account_ledger_entries (
    customer_id, entry_type, amount, effective_date, description,
    created_by_employee_id, reason, is_verified, source_key
)
SELECT p.customer_id, 'adjustment', p.adjustment,
       (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
       'Balance corrected on review: account should be showing J$4,500.00 outstanding (account review 2026-09-30).',
       2,
       'Account review 2026-09-30 confirmed this account should be showing J$4,500.00 outstanding. The underlying payments are untouched.',
       TRUE,
       'father-credit-fix-20260930:7922'
FROM plan p
ON CONFLICT (source_key) DO NOTHING;

DO $g$
DECLARE b NUMERIC;
BEGIN
    SELECT balance INTO b FROM public.customer_billing_status WHERE customer_id = 7922;
    IF b <> 4500.00 THEN
        RAISE EXCEPTION 'Balance for 7922 is % after the adjustment, expected 4500.00. Nothing committed.', b;
    END IF;
END $g$;

INSERT INTO public.audit_logs (
    employee_id, actor_name, action, entity_type, entity_id,
    field_name, old_value, new_value, reason, occurred_at, source_key
)
SELECT (SELECT employee_id FROM actor), (SELECT actor_name FROM actor),
       'Adjusted account balance', 'customer', '7922',
       'balance', p.balance_now::TEXT, '4500.00',
       'Account review 2026-09-30: account set to J$4,500.00 outstanding.',
       CURRENT_TIMESTAMP, 'father-credit-fix-20260930:7922'
FROM plan p
ON CONFLICT (source_key) DO NOTHING;

SELECT 'AFTER' AS check, b.balance, b.outstanding_balance, b.credit_balance
FROM public.customer_billing_status b
WHERE b.customer_id = 7922;

-- ----------------------------------------------------------------------------
-- ROLLBACK = rehearsal.  COMMIT = for real (back up first).
-- ----------------------------------------------------------------------------
ROLLBACK;
