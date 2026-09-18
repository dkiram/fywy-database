-- ============================================================================
-- Addendum to FIX-reconciliation-overcredit-remaining.sql.
--
-- Three accounts it skipped are in fact safe to correct. They were skipped by
-- the "credit already reduced since 2026-09-15" guard, but the ledger shows
-- the reduction was the NORMAL GENERATOR raising a September monthly charge
-- (source_key monthly-charge:<id>:2026-09-16), not a correction:
--
--   3334 Tashia Brown #2         waiver -2,500, then monthly_charge +2,500
--   5810 Jerome Young            waiver -7,000, then monthly_charge +3,500
--   6301 Cynthia E Griffiths     waiver -5,000, then monthly_charge +2,500
--
-- A monthly charge consuming credit does not remove the over-credit - the
-- customer was still given more advance credit than the proposal allowed, and
-- it is still in the balance. Each stays in credit after the correction.
--
-- THE OTHER THREE SKIPPED ACCOUNTS ARE NOT HERE, on purpose:
--
--   12121 Yanique Smith   already corrected by
--                         fix-2026-09-15b:balance-correction:12121
--                         ("balance adjusted to J$0.00 at management
--                         request"). Correcting again double-charges her.
--
--   6554 Yvonne Stiff     13 backfilled suspension_charge rows (J$500 each,
--                         2025-09 to 2026-09, suspension-charge:21125:*) were
--                         posted 2026-09-16. Removing her J$8,000 over-credit
--                         would leave her OWING J$2,500. Her proposal target
--                         predates those suspension fees. Needs a human call.
--
--   15064 Sandra Ferguson at 0.00 after her September charge. Removing
--                         J$2,500 would leave her OWING J$2,500. Needs a
--                         human call.
--
-- Guards: name must match, live credit must equal the exact figure verified
-- 2026-09-17, no non-reconciliation adjustment may exist since 2026-09-15,
-- and the account must remain in credit afterwards. Idempotent via source_key,
-- shared with the main script so an account cannot be corrected by both.
--
-- LAST LINE IS `ROLLBACK` - rehearsal. Read APPLIED and SKIPPED, back up,
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

CREATE TEMP TABLE addendum (
    customer_id     INTEGER PRIMARY KEY,
    expected_name   TEXT,
    expected_credit NUMERIC(14,2),  -- verified live 2026-09-17
    overcredit      NUMERIC(14,2)
) ON COMMIT DROP;

INSERT INTO addendum VALUES
(3334, 'Tashia Brown #2',          2500.00,  850.00),
(5810, 'Jerome Young',             3500.00, 3000.00),
(6301, 'Cynthia Elaine Griffiths', 2500.00, 2400.00);

CREATE TEMP TABLE resolved ON COMMIT DROP AS
SELECT a.customer_id,
       a.expected_name,
       c.name                            AS name_on_file,
       a.expected_credit,
       a.overcredit,
       b.credit_balance                  AS live_credit,
       (b.credit_balance - a.overcredit) AS credit_after,
       CASE
           WHEN c.customer_id IS NULL                   THEN 'customer id not found'
           WHEN LOWER(TRIM(c.name)) <> LOWER(TRIM(a.expected_name))
                                                        THEN 'name on file does not match'
           WHEN b.customer_id IS NULL                   THEN 'no billing status row'
           WHEN b.credit_balance <> a.expected_credit   THEN 'live credit changed since it was verified on 2026-09-17'
           WHEN b.credit_balance - a.overcredit < 0     THEN 'would put the customer into debt'
           WHEN EXISTS (SELECT 1 FROM public.account_ledger_entries l
                        WHERE l.customer_id = a.customer_id
                          AND l.entry_type = 'adjustment'
                          AND l.created_at >= TIMESTAMP '2026-09-15 00:00:00'
                          AND COALESCE(l.source_key, '') NOT LIKE 'final-reconciliation-20260915:%')
                                                        THEN 'another correction already touched this account'
           ELSE NULL
       END AS skip_reason
FROM addendum a
LEFT JOIN public.customers c               ON c.customer_id = a.customer_id
LEFT JOIN public.customer_billing_status b ON b.customer_id = a.customer_id;

-- BEFORE
SELECT 'WILL APPLY' AS outcome, customer_id, name_on_file,
       live_credit AS credit_now, overcredit AS removing, credit_after
FROM resolved WHERE skip_reason IS NULL
ORDER BY overcredit DESC;

SELECT 'SKIPPED' AS outcome, customer_id, expected_name, name_on_file,
       expected_credit AS verified_as, live_credit AS credit_now, skip_reason
FROM resolved WHERE skip_reason IS NOT NULL
ORDER BY customer_id;

INSERT INTO public.account_ledger_entries (
    customer_id, entry_type, amount, effective_date, description,
    created_by_employee_id, reason, is_verified, source_key
)
SELECT r.customer_id, 'adjustment', r.overcredit,
       (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
       'Corrects credit issued above the approved reconciliation amount on 2026-09-15.',
       2,
       'The 2026-09-15 reconciliation posted more advance credit than the reviewed proposal allowed for this account. The September monthly charge has since consumed part of that credit, but the excess remains in the balance. This removes only the excess; the customer keeps the prepaid credit they actually paid for.',
       TRUE,
       'reconciliation-overcredit-fix:' || r.customer_id::TEXT
FROM resolved r
WHERE r.skip_reason IS NULL
ON CONFLICT (source_key) DO NOTHING;

-- Guard: nobody ended up owing money.
DO $g$
DECLARE bad INTEGER;
BEGIN
    SELECT count(*) INTO bad
    FROM resolved r
    JOIN public.customer_billing_status b USING (customer_id)
    WHERE r.skip_reason IS NULL
      AND b.balance > 0;
    IF bad > 0 THEN
        RAISE EXCEPTION '% account(s) ended up owing money. Nothing committed.', bad;
    END IF;
END $g$;

INSERT INTO public.audit_logs (
    employee_id, actor_name, action, entity_type, entity_id,
    field_name, old_value, new_value, reason, occurred_at, source_key
)
SELECT (SELECT employee_id FROM actor), (SELECT actor_name FROM actor),
       'Adjusted account balance', 'customer', r.customer_id::TEXT,
       'balance', (-r.live_credit)::TEXT, (-r.credit_after)::TEXT,
       'Removed credit issued above the approved 2026-09-15 reconciliation amount for this account.',
       CURRENT_TIMESTAMP, 'reconciliation-overcredit-fix:' || r.customer_id::TEXT
FROM resolved r
WHERE r.skip_reason IS NULL
ON CONFLICT (source_key) DO NOTHING;

-- AFTER
SELECT r.customer_id, r.name_on_file, b.balance AS balance_now,
       -r.credit_after AS expected
FROM resolved r
JOIN public.customer_billing_status b USING (customer_id)
WHERE r.skip_reason IS NULL
ORDER BY r.customer_id;

-- ----------------------------------------------------------------------------
-- ROLLBACK = rehearsal.  COMMIT = for real (back up first).
-- ----------------------------------------------------------------------------
ROLLBACK;
