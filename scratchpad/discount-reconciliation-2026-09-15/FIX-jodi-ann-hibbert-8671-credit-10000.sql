-- ============================================================================
-- Jodi-Ann Hibbert (customer 8671) - clear the outstanding balance and give
-- her a J$10,000 credit. Balance +4,000.00 -> -10,000.00.
--
-- Instruction 2026-10-03: "change it from outstanding $4000 to a credit that
-- will last until 21 Jan 2027 for $2500 a month", settled the same day as
-- "just give her $10000 credit and remove the outstanding".
--
--   balance now       4,000.00  (outstanding)
--   balance wanted  -10,000.00  (a J$10,000 credit)
--   adjustment      -14,000.00
--
-- Note the adjustment is 14,000, not 10,000: clearing the 4,000 debt only
-- reaches zero, and the credit is granted from there. The two halves together
-- are a 14,000 swing, which makes this the largest giveaway in the daily
-- review series - the York entry was larger but that forgave a debt rather
-- than granting credit.
--
-- RECORDED AS A MANAGEMENT GRANT, NOT A CORRECTION. Almost every other entry
-- in this series removes credit a customer never really had. This does the
-- opposite: it hands over J$10,000 of service. The description and audit
-- reason below say so plainly, so that a year from now this reads as a
-- decision someone made rather than as phantom-credit tidying. The stated
-- purpose was to cover her monthly charges through 21 January 2027 at
-- J$2,500 a month.
--
-- The credit is left to be consumed by the generator in the normal way - each
-- monthly charge will eat into it as it falls due. No charges are suppressed
-- and no billing schedule is altered, so if her rate changes the credit simply
-- runs out earlier or later than January.
--
-- Guards: the name on file must look like Jodi-Ann Hibbert, the balance must be
-- EXACTLY 4,000.00 now, and it must land on EXACTLY -10,000.00. If her balance
-- has moved the script aborts and changes nothing. Idempotent via source_key.
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
    WHERE c.customer_id = 8671;

    IF nm IS NULL THEN
        RAISE EXCEPTION 'Customer 8671 not found, or has no billing status row. Nothing changed.';
    END IF;
    -- Loose on the hyphen/space in "Jodi-Ann", strict on the surname.
    IF nm NOT ILIKE '%jodi%' OR nm NOT ILIKE '%hibbert%' THEN
        RAISE EXCEPTION 'Customer 8671 is "%", which does not look like Jodi-Ann Hibbert. Nothing changed.', nm;
    END IF;
    IF b <> 4000.00 THEN
        RAISE EXCEPTION 'Balance for 8671 is %, expected 4000.00 outstanding. Something has moved - recheck before granting credit. Nothing changed.', b;
    END IF;
END $g$;

SELECT 'BEFORE' AS check, c.customer_id, c.name, c.status, c.monthly_fee,
       c.activation_date, b.balance, b.outstanding_balance, b.credit_balance
FROM public.customer_billing_status b
JOIN public.customers c USING (customer_id)
WHERE b.customer_id = 8671;

INSERT INTO public.account_ledger_entries (
    customer_id, entry_type, amount, effective_date, description,
    created_by_employee_id, reason, is_verified, source_key
) VALUES (
    8671, 'adjustment', -14000.00,
    (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
    'Outstanding balance cleared and J$10,000.00 credit granted at management instruction (account review 2026-10-03).',
    2,
    'Management decision 2026-10-03: the J$4,000.00 outstanding on this account is cleared and a J$10,000.00 credit granted, intended to cover her monthly charges through 21 January 2027 at J$2,500.00 a month. This is a deliberate grant of service, not a correction of a phantom credit. The credit will be consumed by monthly charges as they fall due; no charges are suppressed.',
    TRUE,
    'father-credit-fix-20261003:grant:8671'
)
ON CONFLICT (source_key) DO NOTHING;

DO $g$
DECLARE b NUMERIC;
BEGIN
    SELECT balance INTO b FROM public.customer_billing_status WHERE customer_id = 8671;
    IF b <> -10000.00 THEN
        RAISE EXCEPTION 'Balance for 8671 is % after the adjustment, expected -10000.00. Nothing committed.', b;
    END IF;
END $g$;

INSERT INTO public.audit_logs (
    employee_id, actor_name, action, entity_type, entity_id,
    field_name, old_value, new_value, reason, occurred_at, source_key
)
SELECT (SELECT employee_id FROM actor), (SELECT actor_name FROM actor),
       'Adjusted account balance', 'customer', '8671',
       'balance', '4000.00', '-10000.00',
       'Management decision 2026-10-03: J$4,000.00 outstanding cleared and a J$10,000.00 credit granted, to cover monthly charges through 21 January 2027.',
       CURRENT_TIMESTAMP, 'father-credit-fix-20261003:grant:8671'
ON CONFLICT (source_key) DO NOTHING;

SELECT 'AFTER' AS check, b.balance, b.outstanding_balance, b.credit_balance
FROM public.customer_billing_status b
WHERE b.customer_id = 8671;

-- ----------------------------------------------------------------------------
-- ROLLBACK = rehearsal.  COMMIT = for real (back up first).
-- ----------------------------------------------------------------------------
ROLLBACK;
