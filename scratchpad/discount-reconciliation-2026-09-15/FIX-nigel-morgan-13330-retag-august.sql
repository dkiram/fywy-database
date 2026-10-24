-- ============================================================================
-- Nigel Morgan (customer 13330) - re-tag the J$3,500.00 receipt from
-- October 2026 to August 2026. STEP 1 OF 2.
--
-- Receipt 451937 (SPCL-20261012-000451937), taken 2026-10-12 09:44 by Quacian
-- Babootie at Blenheim, J$3,500.00, currently tagged 2026-10-01.
--
-- This moves the LABEL only. No money changes: the ledger credit is
-- payment:451937 for -3,500.00 either way, and the 083 receipt trigger is
-- AFTER INSERT, so an UPDATE fires nothing. The guard at the end proves the
-- balance did not move.
--
-- Chosen over void-and-rekey deliberately: a void issues a NEW receipt number,
-- so the paper receipt the customer is holding would stop matching our
-- records. The amount, date and cashier are all correct here - only the month
-- is wrong - so the receipt stays valid and only the tag is corrected.
--
-- STEP 2 IS SEPARATE AND NOT DONE HERE. August has no charge on this account
-- (it is a legacy account whose ledger only opens at September), so after this
-- re-tag the receipt will say "August" while nothing settles August and the
-- J$3,500.00 stays as credit. His October charge falls due 2026-10-22 and will
-- consume that credit, which means August is never paid and the money pays
-- October instead. FIX-nigel-morgan-13330-august-charge.sql posts the missing
-- August charge - read its header before running it, because it leaves him
-- OWING money.
--
-- Guards: customer must be Nigel Morgan, the receipt must be exactly the
-- J$3,500.00 Monthly Fee tagged 2026-10-01 and not voided, exactly one row
-- must change, and the balance must still be -3,500.00 afterwards.
--
-- LAST LINE IS `ROLLBACK` - rehearsal. Read the BEFORE/AFTER rows, back up,
-- THEN change ROLLBACK -> COMMIT and run again:
--   docker exec -it spcl-backup sh /opt/spcl-deploy/backup.sh   # before COMMIT
-- ============================================================================

BEGIN;

CREATE TEMP TABLE actor ON COMMIT DROP AS
SELECT e.employee_id, e.first_name || ' ' || e.last_name AS actor_name
FROM public.employees e WHERE e.employee_id = 2;

DO $g$
DECLARE n INTEGER;
BEGIN
    SELECT count(*) INTO n FROM actor;
    IF n <> 1 THEN RAISE EXCEPTION 'employee_id 2 matched % rows, expected 1. Nothing changed.', n; END IF;
END $g$;

DO $g$
DECLARE nm TEXT; b NUMERIC; amt NUMERIC; mth DATE; cid INTEGER; voided TIMESTAMPTZ; ptype TEXT;
BEGIN
    SELECT c.name, s.balance INTO nm, b
    FROM public.customers c
    JOIN public.customer_billing_status s USING (customer_id)
    WHERE c.customer_id = 13330;

    IF nm IS NULL THEN
        RAISE EXCEPTION 'Customer 13330 not found. Nothing changed.';
    END IF;
    -- There are two Nigel Morgans (4662 and 13330). Make sure this is 13330.
    IF LOWER(TRIM(nm)) <> 'nigel morgan' THEN
        RAISE EXCEPTION 'Customer 13330 is "%", expected Nigel Morgan. Nothing changed.', nm;
    END IF;
    IF b <> -3500.00 THEN
        RAISE EXCEPTION 'Balance for 13330 is %, expected -3500.00. Something has moved since 2026-10-13 - recheck before correcting.', b;
    END IF;

    SELECT p.customer_id, p.amount_paid, p.month_paid, p.voided_at, p.payment_type
    INTO cid, amt, mth, voided, ptype
    FROM public.payments p WHERE p.payment_id = 451937;

    IF cid IS NULL THEN
        RAISE EXCEPTION 'Payment 451937 not found. Nothing changed.';
    END IF;
    IF cid <> 13330 THEN
        RAISE EXCEPTION 'Payment 451937 belongs to customer %, expected 13330. Nothing changed.', cid;
    END IF;
    IF amt <> 3500.00 OR mth <> DATE '2026-10-01' OR ptype <> 'Monthly Fee' OR voided IS NOT NULL THEN
        RAISE EXCEPTION 'Payment 451937 is % / % / % / voided %, expected 3500.00 / 2026-10-01 / Monthly Fee / not voided. Nothing changed.',
            amt, mth, ptype, voided;
    END IF;
END $g$;

SELECT 'BEFORE' AS check, p.payment_id, p.receipt_number, p.amount_paid, p.month_paid,
       p.cashier_name, b.balance, b.credit_balance
FROM public.payments p
JOIN public.customer_billing_status b USING (customer_id)
WHERE p.payment_id = 451937;

UPDATE public.payments
SET month_paid = DATE '2026-08-01',
    note = TRIM(BOTH E'\n' FROM COALESCE(note || E'\n', '') ||
           'Month corrected 2026-10-13: receipt was keyed October 2026, the payment is for August 2026.')
WHERE payment_id = 451937
  AND customer_id = 13330
  AND amount_paid = 3500.00
  AND month_paid = DATE '2026-10-01'
  AND payment_type = 'Monthly Fee'
  AND voided_at IS NULL;

DO $g$
DECLARE n INTEGER; b NUMERIC;
BEGIN
    SELECT count(*) INTO n FROM public.payments
    WHERE payment_id = 451937 AND month_paid = DATE '2026-08-01';
    IF n <> 1 THEN
        RAISE EXCEPTION 'Payment 451937 is not tagged 2026-08-01 after the update. Nothing committed.';
    END IF;
    -- The 083 trigger is AFTER INSERT, so this must not have moved any money.
    SELECT balance INTO b FROM public.customer_billing_status WHERE customer_id = 13330;
    IF b <> -3500.00 THEN
        RAISE EXCEPTION 'Balance for 13330 changed to % during a label-only update. Nothing committed.', b;
    END IF;
END $g$;

INSERT INTO public.audit_logs (
    employee_id, actor_name, action, entity_type, entity_id,
    field_name, old_value, new_value, reason, occurred_at, source_key
)
SELECT (SELECT employee_id FROM actor), (SELECT actor_name FROM actor),
       'Corrected paid month on receipt', 'payment', '451937',
       'month_paid', '2026-10-01', '2026-08-01',
       'Receipt SPCL-20261012-000451937 (J$3,500.00, taken 2026-10-12) was keyed to October 2026; the payment is for August 2026. Amount, date and cashier unchanged, so the receipt the customer holds stays valid.',
       CURRENT_TIMESTAMP, 'retag-month:451937'
ON CONFLICT (source_key) DO NOTHING;

SELECT 'AFTER' AS check, p.payment_id, p.receipt_number, p.amount_paid, p.month_paid,
       b.balance, b.credit_balance, p.note
FROM public.payments p
JOIN public.customer_billing_status b USING (customer_id)
WHERE p.payment_id = 451937;

-- ----------------------------------------------------------------------------
-- ROLLBACK = rehearsal.  COMMIT = for real (back up first).
-- ----------------------------------------------------------------------------
ROLLBACK;
