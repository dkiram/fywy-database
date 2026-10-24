-- ============================================================================
-- Nigel Morgan (customer 13330) - re-tag the J$3,500 receipt from October 2026
-- to August 2026.
--
-- Instruction 2026-10-13: "The October 2026 J$3,500.00 payment should be for
-- August 2026".
--
-- WHAT THIS CHANGES: payments.month_paid on that one receipt, plus an audit
-- row. Nothing else.
--
-- WHY THE BALANCE SHOULD NOT MOVE. A new-system receipt's ledger credit
-- ('monthly_payment', source_key payment:<id>) is not tied to a month - the
-- billing view applies every credit to the oldest debt first. And the only
-- trigger on public.payments (trg_full_monthly_receipt_credit, migration 083)
-- is AFTER INSERT, so an UPDATE fires nothing. The guards assert the balance
-- is identical before and after; if it is not, the script aborts.
--
-- TWO THINGS THIS DOES NOT DO - read the BEFORE blocks for them:
--   * If no August charge exists on the ledger, a counter payment tagged
--     August would have raised one (paymentMonthCharge.ts rule 1). A re-tag
--     does not. The "BEFORE - charges" block shows whether it is there.
--   * If taking the payment as "October" raised an October charge early, that
--     charge stays. Same block - look for the reason "Raised when the month
--     was paid at the counter".
-- Either of those would need a follow-up; tell me what the blocks show.
--
-- Guards: exactly one live J$3,500 receipt for 13330 tagged October 2026,
-- name on file matches Nigel Morgan, balance unchanged by the update.
-- Re-running is harmless: once re-tagged, no October receipt matches and the
-- script stops before changing anything.
--
-- LAST LINE IS `ROLLBACK` - rehearsal. Read the BEFORE/AFTER blocks, back up,
-- THEN change ROLLBACK -> COMMIT and run again:
--   docker exec -it spcl-backup sh /opt/spcl-deploy/backup.sh   # before COMMIT
-- ============================================================================

BEGIN;

CREATE TEMP TABLE actor ON COMMIT DROP AS
SELECT e.employee_id, e.first_name || ' ' || e.last_name AS actor_name
FROM public.employees e
WHERE e.employee_id = 2;

-- The receipt being moved.
CREATE TEMP TABLE target ON COMMIT DROP AS
SELECT p.payment_id, p.month_paid, p.amount_paid, p.payment_date,
       p.legacy_payment_id, p.cashier_name
FROM public.payments p
WHERE p.customer_id = 13330
  AND p.voided_at IS NULL
  AND p.amount_paid = 3500.00
  AND DATE_TRUNC('month', p.month_paid) = DATE '2026-10-01';

CREATE TEMP TABLE balance_before ON COMMIT DROP AS
SELECT b.balance FROM public.customer_billing_status b WHERE b.customer_id = 13330;

DO $g$
DECLARE n INTEGER; nm TEXT;
BEGIN
    SELECT count(*) INTO n FROM actor;
    IF n <> 1 THEN RAISE EXCEPTION 'employee_id 2 matched % rows, expected 1. Nothing changed.', n; END IF;

    SELECT c.name INTO nm FROM public.customers c WHERE c.customer_id = 13330;
    IF nm IS NULL THEN RAISE EXCEPTION 'Customer 13330 not found. Nothing changed.'; END IF;
    IF nm NOT ILIKE '%nigel%morgan%' THEN
        RAISE EXCEPTION 'Customer 13330 is "%", expected Nigel Morgan. Nothing changed.', nm;
    END IF;

    SELECT count(*) INTO n FROM target;
    IF n = 0 THEN
        RAISE EXCEPTION 'No live J$3,500 receipt tagged October 2026 for 13330. It may already have been re-tagged. Nothing changed.';
    END IF;
    IF n > 1 THEN
        RAISE EXCEPTION '% live J$3,500 receipts tagged October 2026 for 13330 - say which one should move. Nothing changed.', n;
    END IF;
END $g$;

SELECT 'BEFORE - receipts Jul to Nov 2026' AS check,
       p.payment_id, p.legacy_payment_id, p.payment_type, p.payment_date,
       p.month_paid, p.amount_paid, p.cashier_name, p.location, p.voided_at
FROM public.payments p
WHERE p.customer_id = 13330
  AND DATE_TRUNC('month', p.month_paid) BETWEEN DATE '2026-07-01' AND DATE '2026-11-01'
ORDER BY p.month_paid, p.payment_id;

SELECT 'BEFORE - charges since July 2026' AS check,
       l.account_ledger_entry_id, l.entry_type, l.amount, l.due_date,
       l.effective_date, l.reason
FROM public.account_ledger_entries l
WHERE l.customer_id = 13330
  AND l.amount > 0
  AND COALESCE(l.due_date, l.effective_date) >= DATE '2026-07-01'
ORDER BY COALESCE(l.due_date, l.effective_date), l.account_ledger_entry_id;

SELECT 'BEFORE - balance' AS check, b.balance, b.outstanding_balance, b.credit_balance
FROM public.customer_billing_status b WHERE b.customer_id = 13330;

UPDATE public.payments p
SET month_paid = DATE '2026-08-01'
FROM target t
WHERE p.payment_id = t.payment_id
  AND p.customer_id = 13330
  AND p.voided_at IS NULL
  AND DATE_TRUNC('month', p.month_paid) = DATE '2026-10-01';

DO $g$
DECLARE mp DATE; bal_before NUMERIC; bal_after NUMERIC;
BEGIN
    SELECT p.month_paid INTO mp
    FROM public.payments p JOIN target t USING (payment_id);
    IF mp <> DATE '2026-08-01' THEN
        RAISE EXCEPTION 'Receipt is tagged to % after the update, expected 2026-08-01. Nothing committed.', mp;
    END IF;

    -- No money moved.
    SELECT balance INTO bal_before FROM balance_before;
    SELECT balance INTO bal_after FROM public.customer_billing_status WHERE customer_id = 13330;
    IF bal_after IS DISTINCT FROM bal_before THEN
        RAISE EXCEPTION 'Balance for 13330 went from % to % - something posted a ledger entry. Nothing committed.', bal_before, bal_after;
    END IF;
END $g$;

INSERT INTO public.audit_logs (
    employee_id, actor_name, action, entity_type, entity_id,
    field_name, old_value, new_value, reason, occurred_at, source_key
)
SELECT (SELECT employee_id FROM actor), (SELECT actor_name FROM actor),
       'Re-tagged paid month on payment', 'payment', t.payment_id::TEXT,
       'month_paid', t.month_paid::TEXT, '2026-08-01',
       'Account review 2026-10-13: the J$3,500 receipt was keyed as October 2026 but was for August 2026. Month tag corrected; the receipt''s ledger credit is not month-linked, so the balance is unchanged.',
       CURRENT_TIMESTAMP, 'retag-month-20261013:' || t.payment_id::TEXT
FROM target t
ON CONFLICT (source_key) DO NOTHING;

SELECT 'AFTER - receipts Jul to Nov 2026' AS check,
       p.payment_id, p.legacy_payment_id, p.payment_type, p.payment_date,
       p.month_paid, p.amount_paid, p.cashier_name, p.location, p.voided_at
FROM public.payments p
WHERE p.customer_id = 13330
  AND DATE_TRUNC('month', p.month_paid) BETWEEN DATE '2026-07-01' AND DATE '2026-11-01'
ORDER BY p.month_paid, p.payment_id;

SELECT 'AFTER - balance' AS check, b.balance, b.outstanding_balance, b.credit_balance
FROM public.customer_billing_status b WHERE b.customer_id = 13330;

-- ----------------------------------------------------------------------------
-- ROLLBACK = rehearsal.  COMMIT = for real (back up first).
-- ----------------------------------------------------------------------------
ROLLBACK;
