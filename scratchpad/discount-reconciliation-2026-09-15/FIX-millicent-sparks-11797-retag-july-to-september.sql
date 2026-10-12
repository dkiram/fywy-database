-- ============================================================================
-- Millicent Sparks (customer 11797) - re-tag legacy receipt 35993 from July
-- 2026 to September 2026. Balance stays at 0.00.
--
-- Instruction 2026-10-06: "just make one of the july payments to be
-- september, so it would remain at $0.0".
--
-- WHY RE-TAG RATHER THAN REMOVE. She has TWO legacy receipts tagged July 2026:
--   35992  paid 2026-07-03, month paid 2026-07-03, J$2,500
--   35993  paid 2026-08-07, month paid 2026-07-14, J$2,500   <- this one moves
-- plus the new-system receipt 437375 (paid 2026-09-01, tagged August 2026).
-- Moving 35993 to September leaves her reading July / August / September with
-- no duplicate, and keeps the money on her record. Deleting it would have
-- thrown away a real receipt; the original request to void it could not have
-- worked anyway, since the app refuses legacy Access imports by design.
--
-- WHY THE BALANCE CANNOT MOVE. Two independent reasons:
--   * Migration 041 deleted every legacy payment's ledger credit and records
--     legacy history through customer_billing_start.paid_through instead, so
--     this receipt is not a line item in her balance.
--   * The only trigger on public.payments is trg_full_monthly_receipt_credit
--     (migration 083), and it is AFTER INSERT only - an UPDATE fires nothing.
-- The guards below assert 0.00 before AND after, so if either of those is
-- wrong the script aborts rather than silently moving money.
--
-- 35992 IS NOT TOUCHED. Only the 2026-08-07 receipt moves.
--
-- WHAT THIS DOES CHANGE: her latest tagged month becomes September 2026
-- rather than August, which is what the credit audits read when they compute
-- "latest month paid for". That is the intended effect - her record now shows
-- her paid through September.
--
-- The new month_paid is written as 2026-09-01. Legacy Access rows carry raw
-- dates in this column (2026-07-14, 2026-04-10 and so on) while new-system
-- rows use the first of the month; everything that reads the column applies
-- DATE_TRUNC('month', ...), so the day is immaterial and the 1st is clearest.
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

DO $g$
DECLARE n INTEGER;
BEGIN
    SELECT count(*) INTO n FROM actor;
    IF n <> 1 THEN RAISE EXCEPTION 'employee_id 2 matched % rows, expected 1. Nothing changed.', n; END IF;
END $g$;

DO $g$
DECLARE nm TEXT; cid INTEGER; mp DATE; amt NUMERIC; legacy BIGINT; voided TIMESTAMPTZ; bal NUMERIC;
BEGIN
    SELECT p.customer_id, c.name, p.month_paid, p.amount_paid,
           p.legacy_payment_id, p.voided_at
      INTO cid, nm, mp, amt, legacy, voided
    FROM public.payments p
    JOIN public.customers c USING (customer_id)
    WHERE p.payment_id = 35993;

    IF cid IS NULL THEN
        RAISE EXCEPTION 'Payment 35993 not found. Nothing changed.';
    END IF;
    IF cid <> 11797 THEN
        RAISE EXCEPTION 'Payment 35993 belongs to customer %, expected 11797. Nothing changed.', cid;
    END IF;
    IF nm NOT ILIKE '%millicent%spark%' THEN
        RAISE EXCEPTION 'Customer 11797 is "%", expected Millicent Sparks. Nothing changed.', nm;
    END IF;
    IF voided IS NOT NULL THEN
        RAISE EXCEPTION 'Payment 35993 is voided (at %). Nothing changed.', voided;
    END IF;
    IF amt <> 2500.00 THEN
        RAISE EXCEPTION 'Payment 35993 is for %, expected 2500.00. Nothing changed.', amt;
    END IF;
    IF mp IS NULL OR DATE_TRUNC('month', mp) <> DATE '2026-07-01' THEN
        RAISE EXCEPTION 'Payment 35993 is tagged to %, expected a July 2026 month. It may already have been re-tagged. Nothing changed.', mp;
    END IF;
    IF legacy IS NULL THEN
        RAISE EXCEPTION 'Payment 35993 is NOT a legacy import - it would carry a real ledger credit and re-tagging it needs different handling. Nothing changed.';
    END IF;

    SELECT balance INTO bal FROM public.customer_billing_status WHERE customer_id = 11797;
    IF bal <> 0.00 THEN
        RAISE EXCEPTION 'Balance for 11797 is %, expected 0.00. Something has moved - recheck before re-tagging. Nothing changed.', bal;
    END IF;
END $g$;

SELECT 'BEFORE - her July/September receipts' AS check,
       p.payment_id, p.legacy_payment_id, p.payment_date, p.month_paid,
       p.amount_paid, p.cashier_name, p.location
FROM public.payments p
WHERE p.customer_id = 11797
  AND (DATE_TRUNC('month', p.month_paid) IN (DATE '2026-07-01', DATE '2026-08-01', DATE '2026-09-01'))
ORDER BY p.month_paid, p.payment_id;

SELECT 'BEFORE - balance' AS check, b.balance, b.outstanding_balance, b.credit_balance
FROM public.customer_billing_status b WHERE b.customer_id = 11797;

UPDATE public.payments
SET month_paid = DATE '2026-09-01'
WHERE payment_id = 35993
  AND customer_id = 11797
  AND voided_at IS NULL
  AND DATE_TRUNC('month', month_paid) = DATE '2026-07-01';

DO $g$
DECLARE mp DATE; bal NUMERIC;
BEGIN
    SELECT month_paid INTO mp FROM public.payments WHERE payment_id = 35993;
    IF mp <> DATE '2026-09-01' THEN
        RAISE EXCEPTION 'Payment 35993 is tagged to % after the update, expected 2026-09-01. Nothing committed.', mp;
    END IF;

    -- The whole point: no money moved.
    SELECT balance INTO bal FROM public.customer_billing_status WHERE customer_id = 11797;
    IF bal <> 0.00 THEN
        RAISE EXCEPTION 'Balance for 11797 is % after the re-tag, expected 0.00. Something posted a ledger entry - nothing committed.', bal;
    END IF;
END $g$;

INSERT INTO public.audit_logs (
    employee_id, actor_name, action, entity_type, entity_id,
    field_name, old_value, new_value, reason, occurred_at, source_key
)
SELECT (SELECT employee_id FROM actor), (SELECT actor_name FROM actor),
       'Re-tagged paid month on payment', 'payment', '35993',
       'month_paid', '2026-07-14', '2026-09-01',
       'Account review 2026-10-06: this account carried two legacy receipts tagged July 2026 (35992 and 35993). The 2026-08-07 receipt was re-tagged to September 2026 so the record reads July / August / September with no duplicate month. No ledger entry exists for a legacy receipt, so the balance is unchanged at J$0.00.',
       CURRENT_TIMESTAMP, 'retag-month-20261006:35993'
ON CONFLICT (source_key) DO NOTHING;

SELECT 'AFTER - her July/September receipts' AS check,
       p.payment_id, p.legacy_payment_id, p.payment_date, p.month_paid,
       p.amount_paid, p.cashier_name, p.location
FROM public.payments p
WHERE p.customer_id = 11797
  AND (DATE_TRUNC('month', p.month_paid) IN (DATE '2026-07-01', DATE '2026-08-01', DATE '2026-09-01'))
ORDER BY p.month_paid, p.payment_id;

SELECT 'AFTER - balance' AS check, b.balance, b.outstanding_balance, b.credit_balance
FROM public.customer_billing_status b WHERE b.customer_id = 11797;

-- ----------------------------------------------------------------------------
-- ROLLBACK = rehearsal.  COMMIT = for real (back up first).
-- ----------------------------------------------------------------------------
ROLLBACK;
