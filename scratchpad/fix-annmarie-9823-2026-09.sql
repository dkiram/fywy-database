-- ============================================================================
-- Annmarie Simmonds (customer 9823) - two payment corrections.
--
-- Standalone. Does NOT touch the other customers in
-- scratchpad/fix-legacy-payments-2026-09.sql. If you run this, SKIP Annmarie's
-- two sections in that other script (the 428639 void and the 428653 amount
-- edit) - this replaces her whole plan with:
--
--   1. payment 428653  (05 Aug 2026, J$250, Kellits, Glendise Mckenzie)
--      -> month-paid-for changed to July 2026.  Amount left at J$250.
--
--   2. payment 428654  (05 Aug 2026, J$0.00, no payment type - junk row)
--      -> deleted entirely.
--
-- Neither payment has an account_ledger_entries row, so no balance moves.
-- Deleting 428653's amount is NOT changed here; say so if you still want
-- J$250 -> J$2,500.
--
-- Plain SQL. TablePlus "Run All" or psql. Run on BOTH databases.
-- LAST LINE IS `ROLLBACK` - rehearsal. Read the printed blocks, then back up,
-- change ROLLBACK -> COMMIT, and run again.
--
--   docker exec -it spcl-backup sh /opt/spcl-deploy/backup.sh   # before COMMIT
--
-- CAVEAT on the delete: payment 428654 came from Access (source_staging_id
-- 431033). If the Access -> Postgres sync re-runs, a hard-deleted row can be
-- re-inserted. Voiding it instead keeps it gone from takings without that risk
-- - a commented-out void alternative is at the bottom of section 2.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- Actor: employee_id 2 (admin).
-- ----------------------------------------------------------------------------
CREATE TEMP TABLE actor ON COMMIT DROP AS
SELECT e.employee_id, e.first_name || ' ' || e.last_name AS actor_name
FROM public.employees e
WHERE e.employee_id = 2;

DO $g$
DECLARE n INTEGER;
BEGIN
    SELECT count(*) INTO n FROM actor;
    IF n <> 1 THEN
        RAISE EXCEPTION 'employee_id 2 matched % rows, expected 1. Nothing changed.', n;
    END IF;
END $g$;


-- ============================================================================
-- SECTION 1 - payment 428653: month-paid-for  ->  July 2026
--
-- App convention stores month_paid as the 1st of the month, so "July 2026" is
-- 2026-07-01. Change the value below if you want a different day.
-- ============================================================================
CREATE TEMP TABLE relabel_target ON COMMIT DROP AS
SELECT DATE '2026-07-01' AS new_month_paid;

CREATE TEMP TABLE p428653 ON COMMIT DROP AS
SELECT p.payment_id, p.amount_paid, p.month_paid AS old_month_paid,
       p.payment_date, p.location, p.cashier_name
FROM public.payments p
WHERE p.payment_id  = 428653
  AND p.customer_id = 9823
  AND p.month_paid   = DATE '2026-08-05'
  AND COALESCE(p.payment_type, p.legacy_payment_type) = 'Monthly Fee'
  AND p.voided_at IS NULL;

DO $g$
DECLARE n INTEGER;
BEGIN
    SELECT count(*) INTO n FROM p428653;
    IF n <> 1 THEN
        RAISE EXCEPTION
            'Payment 428653 did not resolve to 9823 / month-paid 2026-08-05 / Monthly Fee / not voided (got %). Nothing changed.', n;
    END IF;
END $g$;

SELECT 'ABOUT TO RELABEL' AS check, payment_id, amount_paid,
       old_month_paid, (SELECT new_month_paid FROM relabel_target) AS new_month_paid,
       payment_date, location, cashier_name
FROM p428653;

UPDATE public.payments
SET month_paid = (SELECT new_month_paid FROM relabel_target)
WHERE payment_id = 428653;

INSERT INTO public.audit_logs (
    employee_id, actor_name, action, entity_type, entity_id,
    field_name, old_value, new_value, reason, occurred_at, source_key
)
SELECT (SELECT employee_id FROM actor), (SELECT actor_name FROM actor),
       'Corrected payment month', 'payment', '428653',
       'month_paid', '2026-08-05',
       (SELECT new_month_paid::TEXT FROM relabel_target),
       'Month-paid-for corrected to July 2026 (Access import).',
       CURRENT_TIMESTAMP, 'fix-2026-09:annmarie-month:428653'
ON CONFLICT (source_key) DO NOTHING;


-- ============================================================================
-- SECTION 2 - delete payment 428654 (the J$0.00 / no-type junk row)
-- ============================================================================
CREATE TEMP TABLE doomed_payment ON COMMIT DROP AS
SELECT p.payment_id, p.customer_id, p.payment_type, p.legacy_payment_type,
       p.amount_paid, p.month_paid, p.payment_date, p.location, p.cashier_name,
       p.receipt_number, p.voided_at,
       (SELECT count(*) FROM public.account_ledger_entries e WHERE e.payment_id = p.payment_id)  AS ledger_rows,
       (SELECT count(*) FROM public.receipt_email_deliveries d WHERE d.payment_id = p.payment_id) AS email_rows
FROM public.payments p
WHERE p.payment_id  = 428654
  AND p.customer_id = 9823;

-- Guard 1: exactly one row, and it is the junk row we mean (J$0, no clean type).
DO $g$
DECLARE r RECORD;
BEGIN
    SELECT * INTO r FROM doomed_payment;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Payment 428654 for customer 9823 not found. Nothing changed. (Maybe already deleted.)';
    END IF;
    IF r.amount_paid <> 0.00 OR r.payment_type IS NOT NULL THEN
        RAISE EXCEPTION
            'Payment 428654 is NOT the expected junk row (amount %, type %). Refusing to delete. Nothing changed.',
            r.amount_paid, COALESCE(r.payment_type, '<null>');
    END IF;
END $g$;

-- Guard 2: nothing that would be silently lost. Ledger rows block (RESTRICT);
-- report email-delivery rows that would cascade so the delete is not a surprise.
DO $g$
DECLARE r RECORD;
BEGIN
    SELECT * INTO r FROM doomed_payment;
    IF r.ledger_rows > 0 THEN
        RAISE EXCEPTION 'Payment 428654 has % ledger row(s) - delete would be blocked / would lose money. Nothing changed.', r.ledger_rows;
    END IF;
    IF r.email_rows > 0 THEN
        RAISE WARNING 'Payment 428654 has % receipt_email_deliveries row(s); they will be CASCADE-deleted with it.', r.email_rows;
    END IF;
END $g$;

SELECT 'ABOUT TO DELETE' AS check, payment_id, customer_id, payment_type,
       legacy_payment_type, amount_paid, month_paid, payment_date,
       receipt_number, ledger_rows, email_rows
FROM doomed_payment;

DELETE FROM public.payments WHERE payment_id = 428654 AND customer_id = 9823;

INSERT INTO public.audit_logs (
    employee_id, actor_name, action, entity_type, entity_id,
    field_name, old_value, new_value, reason, occurred_at, source_key
)
SELECT (SELECT employee_id FROM actor), (SELECT actor_name FROM actor),
       'Deleted payment', 'payment', '428654',
       'payment', 'J$0.00 Monthly Fee (no payment type), Access import', 'deleted',
       'Empty J$0.00 payment with no payment type; removed at management request.',
       CURRENT_TIMESTAMP, 'fix-2026-09:annmarie-delete:428654'
ON CONFLICT (source_key) DO NOTHING;

-- Guard 3: it is actually gone.
DO $g$
DECLARE n INTEGER;
BEGIN
    SELECT count(*) INTO n FROM public.payments WHERE payment_id = 428654;
    IF n <> 0 THEN
        RAISE EXCEPTION 'Payment 428654 still present after delete (%). Nothing committed.', n;
    END IF;
END $g$;

-- --- ALTERNATIVE to the delete: void it instead (row stays, off the books,
-- --- survives an Access re-import). Comment out the DELETE + its audit insert
-- --- + Guard 3 above and use this instead:
--
-- UPDATE public.payments SET
--     voided_at = CURRENT_TIMESTAMP,
--     voided_by_employee_id = (SELECT employee_id FROM actor),
--     void_reason = 'Empty J$0.00 payment with no payment type; voided at management request.'
-- WHERE payment_id = 428654 AND customer_id = 9823 AND amount_paid = 0.00;


-- ============================================================================
-- VERIFY
-- ============================================================================
SELECT 'ANNMARIE PAYMENTS Jun-Aug 2026' AS check,
       p.payment_id, COALESCE(p.payment_type, p.legacy_payment_type) AS type,
       p.amount_paid, p.month_paid, p.payment_date, p.location, p.cashier_name,
       (p.voided_at IS NOT NULL) AS is_voided
FROM public.payments p
WHERE p.customer_id = 9823
  AND p.payment_date BETWEEN DATE '2026-06-01' AND DATE '2026-08-31'
ORDER BY p.payment_date, p.payment_id;

SELECT 'BALANCE (expect unchanged: 0.00)' AS check, customer_id, balance, outstanding_balance
FROM public.customer_billing_status
WHERE customer_id = 9823;

-- ----------------------------------------------------------------------------
-- ROLLBACK = rehearsal.  COMMIT = for real (back up first, run on BOTH DBs).
-- ----------------------------------------------------------------------------
ROLLBACK;
