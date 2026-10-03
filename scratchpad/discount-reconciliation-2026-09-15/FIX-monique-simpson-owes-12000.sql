-- ============================================================================
-- Monique Simpson - outstanding balance should be J$12,000, not J$4,000.
--
-- Instruction 2026-10-03: "monique simpson should be outstanding 12000 not
-- 4000".
--
--   balance now      4,000.00  (outstanding)
--   balance wanted  12,000.00  (outstanding)
--   adjustment       8,000.00
--
-- THIS RAISES A DEBT BY J$8,000. Nearly everything else in this review series
-- removes phantom credit; this one triples what a customer owes, so two
-- consequences are worth knowing before it is committed:
--
--   * Delinquency. At 12,000 outstanding she sits much deeper into the
--     delinquency chase list, the dashboard delinquent count, and the
--     grace/disconnection reminder emails. She stays under the 15,000 default
--     threshold that tools/sync_delinquent_olt_status.py
--     --disconnect-nonpaying uses, but the nightly delinquency worker is a
--     separate path - check she is not about to be cut off automatically.
--
--   * What the 8,000 represents. If it is months that were never billed, an
--     'adjustment' records the money but not WHICH months, so her
--     month-by-month history will not explain the figure later. That is
--     unavoidable where the months fall in a period migration 054 blocks a
--     monthly_charge for (the Miriam Richards Swaby precedent), but if these
--     are months the generator simply skipped while she was active, posting
--     the charges themselves would leave a better trail. Worth asking which.
--
-- NO ACCOUNT NUMBER came with the message and Simpson is a common surname
-- here, so the script resolves the name itself, preferring an exact match, and
-- requires BOTH that exactly one account matches AND that it is sitting at
-- exactly 4,000.00. Those two together are the safety: if the name resolves to
-- somebody else, her balance will not be 4,000 and the script aborts.
--
-- Guards: exactly one "Monique Simpson", balance EXACTLY 4,000.00 now, lands
-- on EXACTLY 12,000.00. Idempotent via source_key.
--
-- LAST LINE IS `ROLLBACK` - rehearsal. Read the CANDIDATES and BEFORE blocks,
-- back up, THEN change ROLLBACK -> COMMIT and run again:
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

CREATE TEMP TABLE matched ON COMMIT DROP AS
SELECT c.customer_id,
       c.name AS name_on_file,
       c.status,
       c.monthly_fee,
       c.activation_date,
       b.balance,
       b.outstanding_balance,
       b.credit_balance,
       (LOWER(TRIM(c.name)) = 'monique simpson') AS exact_match
FROM public.customers c
LEFT JOIN public.customer_billing_status b ON b.customer_id = c.customer_id
WHERE c.name ILIKE '%monique%simpson%';

CREATE TEMP TABLE chosen ON COMMIT DROP AS
SELECT m.* FROM matched m
WHERE m.exact_match
   OR NOT EXISTS (SELECT 1 FROM matched m2 WHERE m2.exact_match);

-- Show everything the search saw, so a wrong pick is visible.
SELECT 'CANDIDATES' AS check, customer_id, name_on_file, status, monthly_fee,
       balance, credit_balance, exact_match
FROM matched
ORDER BY exact_match DESC, customer_id;

DO $g$
DECLARE n INTEGER; b NUMERIC; cid INTEGER; nm TEXT;
BEGIN
    SELECT count(*) INTO n FROM chosen;
    IF n = 0 THEN
        RAISE EXCEPTION 'No customer matched "Monique Simpson". Check the spelling or supply the account number. Nothing changed.';
    END IF;
    IF n > 1 THEN
        RAISE EXCEPTION '% accounts matched - see the CANDIDATES block and supply the account number. Nothing changed.', n;
    END IF;

    SELECT customer_id, name_on_file, balance INTO cid, nm, b FROM chosen;

    IF b IS NULL THEN
        RAISE EXCEPTION 'Customer % ("%") has no billing status row. Nothing changed.', cid, nm;
    END IF;
    IF b <> 4000.00 THEN
        RAISE EXCEPTION 'Customer % ("%") is at %, not the 4000.00 the instruction describes. Either this is the wrong account or her balance has moved - check before raising a debt. Nothing changed.', cid, nm, b;
    END IF;
END $g$;

SELECT 'BEFORE' AS check, customer_id, name_on_file, status, monthly_fee,
       activation_date, balance AS balance_now, outstanding_balance,
       12000.00 AS target_balance, 8000.00 AS adjustment
FROM chosen;

INSERT INTO public.account_ledger_entries (
    customer_id, entry_type, amount, effective_date, description,
    created_by_employee_id, reason, is_verified, source_key
)
SELECT ch.customer_id, 'adjustment', 8000.00,
       (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
       'Balance corrected on review: outstanding should be J$12,000.00 (account review 2026-10-03).',
       2,
       'Account review 2026-10-03 confirmed this account should be showing J$12,000.00 outstanding rather than J$4,000.00. The underlying payments are untouched.',
       TRUE,
       'father-credit-fix-20261003:' || ch.customer_id::TEXT
FROM chosen ch
ON CONFLICT (source_key) DO NOTHING;

DO $g$
DECLARE b NUMERIC; cid INTEGER;
BEGIN
    SELECT ch.customer_id, s.balance INTO cid, b
    FROM chosen ch JOIN public.customer_billing_status s USING (customer_id);
    IF b <> 12000.00 THEN
        RAISE EXCEPTION 'Balance for % is % after the adjustment, expected 12000.00. Nothing committed.', cid, b;
    END IF;
END $g$;

INSERT INTO public.audit_logs (
    employee_id, actor_name, action, entity_type, entity_id,
    field_name, old_value, new_value, reason, occurred_at, source_key
)
SELECT (SELECT employee_id FROM actor), (SELECT actor_name FROM actor),
       'Adjusted account balance', 'customer', ch.customer_id::TEXT,
       'balance', '4000.00', '12000.00',
       'Account review 2026-10-03: outstanding balance raised to J$12,000.00.',
       CURRENT_TIMESTAMP, 'father-credit-fix-20261003:' || ch.customer_id::TEXT
FROM chosen ch
ON CONFLICT (source_key) DO NOTHING;

-- AFTER, with the delinquency picture that follows from it.
SELECT 'AFTER' AS check, ch.customer_id, ch.name_on_file, ch.status,
       b.balance AS balance_now, b.outstanding_balance,
       b.oldest_unpaid_due_date
FROM chosen ch
JOIN public.customer_billing_status b USING (customer_id);

-- ----------------------------------------------------------------------------
-- ROLLBACK = rehearsal.  COMMIT = for real (back up first).
-- ----------------------------------------------------------------------------
ROLLBACK;
