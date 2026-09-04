-- ============================================================================
-- Corrects six imported (Access) payments that cannot be fixed from the app.
--
-- Matched on payment_id (verified against a data pull on 2026-09-02), so there
-- is no date / month / amount guessing. Each section still re-checks the
-- payment_id resolves to the customer + amount + type we expect.
--
-- KEY FINDING FROM THE DATA PULL: none of these six payments has a row in
-- account_ledger_entries, and customers 9823 / 1572 / 12766 / 9847 have a net
-- ledger balance of 0.00 (2036 carries a -12,500 credit from elsewhere). These
-- accounts are not balance-tracked through the ledger, so:
--
--   * Voiding a payment here only flips voided_at (removes it from daily
--     takings). It does NOT change any displayed balance, because the payment
--     never posted to a balance in the first place.
--   * Editing the J$250 -> J$2,500 corrects the payment/receipt only. No
--     ledger row to update; no balance effect.
--
-- If any of these customers is meant to be actively billed, that missing-ledger
-- gap is a separate problem - this script does not try to fix it.
--
-- A guard STOPS the whole run if any target payment turns out to HAVE a ledger
-- entry (e.g. the other database is in a different state) - handle that case
-- separately rather than silently leaving a balance wrong.
--
-- Plain SQL. TablePlus "Run All" or piped through psql. Run on BOTH databases.
--
-- AS SHIPPED THE LAST LINE IS `ROLLBACK` - rehearsal only. Read every printed
-- block. If all six are right: back up, change ROLLBACK -> COMMIT, run again.
--
--   docker exec -it spcl-backup sh /opt/spcl-deploy/backup.sh   # before COMMIT
--
-- ----------------------------------------------------------------------------
--   1. VOID     payment 428639  Annmarie Simmonds 9823  J$2,500  paid 2026-07-16
--   2. EDIT     payment 428653  Annmarie Simmonds 9823  J$250 -> J$2,500 (Kellits)
--   3. VOID     payment 50911   Delroy Boothe    12766  J$4,000  paid 2026-08-03 (Newport)
--   4. VOID     payment 116062  Eleshia Mckenzie  2036  J$3,500  paid 2026-07-20 (Newport)
--   5. VOID     payment 81313   Georgette West    1572  J$2,500  paid 2026-08-05 (Newport)
--   6. RELABEL  payment 429137  Ashley Johnson    9847  month-paid 2025-08-25 -> 2026-08-25
--
-- Daily-takings totals move for: 16 Jul (Annmarie), 05 Aug Kellits (+J$2,250),
-- 03 Aug Newport, 20 Jul Newport, 05 Aug Newport.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- Actor: employee_id 2 (admin). Guard: resolves to exactly one employee.
-- ----------------------------------------------------------------------------
CREATE TEMP TABLE actor ON COMMIT DROP AS
SELECT e.employee_id,
       e.first_name || ' ' || e.last_name AS actor_name
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
-- SECTIONS 1, 3, 4, 5 - the four voids
-- ============================================================================
CREATE TEMP TABLE void_targets ON COMMIT DROP AS
SELECT * FROM (VALUES
    -- payment_id, customer_id, amount,   who,                  reason
    (428639, 9823,  2500.00, 'Annmarie Simmonds', 'Payment entered in error; void requested by management (Access import, not voidable in-app).'),
    (50911,  12766, 4000.00, 'Delroy Boothe',     'Payment entered in error; void requested by management (Access import, not voidable in-app).'),
    (116062, 2036,  3500.00, 'Eleshia Mckenzie',  'Payment entered in error; void requested by management (Access import, not voidable in-app).'),
    (81313,  1572,  2500.00, 'Georgette West',    'Payment entered in error; void requested by management (Access import, not voidable in-app).')
) AS v(payment_id, customer_id, amount, who, reason);

-- Resolve the payments and confirm each one is exactly what we think it is.
CREATE TEMP TABLE void_payments ON COMMIT DROP AS
SELECT vt.who, vt.customer_id, vt.reason,
       p.payment_id, p.amount_paid, p.month_paid, p.payment_date,
       p.location, p.cashier_name, c.status AS customer_status
FROM void_targets vt
JOIN public.payments p
      ON p.payment_id  = vt.payment_id
     AND p.customer_id = vt.customer_id
     AND p.amount_paid = vt.amount
     AND COALESCE(p.payment_type, p.legacy_payment_type) = 'Monthly Fee'
     AND p.voided_at IS NULL
JOIN public.customers c ON c.customer_id = vt.customer_id;

DO $g$
DECLARE n INTEGER;
BEGIN
    SELECT count(*) INTO n FROM void_payments;
    IF n <> 4 THEN
        RAISE EXCEPTION
            'Expected 4 void payments, resolved % '
            '(payment_id must match customer + amount + Monthly Fee + not already voided). '
            'Nothing changed.', n;
    END IF;
END $g$;

-- STOP if any target actually has a ledger entry - the balance-reversal path
-- would be needed and this script does not do it.
DO $g$
DECLARE bad INTEGER;
BEGIN
    SELECT count(*) INTO bad
    FROM public.account_ledger_entries e
    WHERE e.payment_id IN (SELECT payment_id FROM void_payments);
    IF bad > 0 THEN
        RAISE EXCEPTION
            '% of the target payments have account_ledger_entries rows on THIS database. '
            'Voiding them here would leave a balance wrong. Stop and handle the reversal. Nothing changed.', bad;
    END IF;
END $g$;

-- Warn (do not block) on any non-active account.
DO $g$
DECLARE r RECORD;
BEGIN
    FOR r IN SELECT who, customer_id, customer_status FROM void_payments WHERE customer_status <> 'active'
    LOOP
        RAISE WARNING '% (%) is "%", not active - review after COMMIT.', r.who, r.customer_id, r.customer_status;
    END LOOP;
END $g$;

SELECT 'ABOUT TO VOID' AS check, who, customer_id, payment_id, amount_paid,
       month_paid, payment_date, location, cashier_name, customer_status
FROM void_payments ORDER BY customer_id;

UPDATE public.payments p SET
    voided_at             = CURRENT_TIMESTAMP,
    voided_by_employee_id = (SELECT employee_id FROM actor),
    void_reason           = vp.reason
FROM void_payments vp
WHERE p.payment_id = vp.payment_id;

INSERT INTO public.audit_logs (
    employee_id, actor_name, action, entity_type, entity_id,
    field_name, old_value, new_value, reason, occurred_at, source_key
)
SELECT (SELECT employee_id FROM actor), (SELECT actor_name FROM actor),
       'Voided payment', 'payment', vp.payment_id::TEXT,
       'payment_status', 'active', 'voided', vp.reason, CURRENT_TIMESTAMP,
       'fix-2026-09:void:' || vp.payment_id::TEXT
FROM void_payments vp
ON CONFLICT (source_key) DO NOTHING;


-- ============================================================================
-- SECTION 2 - Annmarie Simmonds (9823): payment 428653  J$250 -> J$2,500
-- (cashier collected J$2,500 on 2026-08-05 at Kellits and keyed J$250).
-- No ledger row exists for this payment, so only the payment amount changes.
-- ============================================================================
CREATE TEMP TABLE annmarie_amount ON COMMIT DROP AS
SELECT p.payment_id, p.amount_paid AS old_amount, p.location, p.cashier_name
FROM public.payments p
WHERE p.payment_id  = 428653
  AND p.customer_id = 9823
  AND p.amount_paid = 250.00
  AND COALESCE(p.payment_type, p.legacy_payment_type) = 'Monthly Fee'
  AND p.voided_at IS NULL;

DO $g$
DECLARE n INTEGER;
BEGIN
    SELECT count(*) INTO n FROM annmarie_amount;
    IF n <> 1 THEN
        RAISE EXCEPTION 'Payment 428653 did not resolve to 9823 / J$250 / Monthly Fee / not voided (got %). Nothing changed.', n;
    END IF;
END $g$;

DO $g$
DECLARE n INTEGER;
BEGIN
    SELECT count(*) INTO n FROM public.account_ledger_entries WHERE payment_id = 428653;
    IF n <> 0 THEN
        RAISE EXCEPTION 'Payment 428653 now has % ledger row(s) on this database - editing the amount would leave the balance wrong. Nothing changed.', n;
    END IF;
END $g$;

SELECT 'ABOUT TO EDIT AMOUNT' AS check, payment_id, old_amount, 2500.00 AS new_amount, location, cashier_name
FROM annmarie_amount;

UPDATE public.payments SET amount_paid = 2500.00 WHERE payment_id = 428653;

INSERT INTO public.audit_logs (
    employee_id, actor_name, action, entity_type, entity_id,
    field_name, old_value, new_value, reason, occurred_at, source_key
)
SELECT (SELECT employee_id FROM actor), (SELECT actor_name FROM actor),
       'Corrected payment amount', 'payment', '428653',
       'amount_paid', '250.00', '2500.00',
       'Cashier collected J$2,500 on 2026-08-05 (Kellits) and keyed J$250; imported from Access.',
       CURRENT_TIMESTAMP, 'fix-2026-09:amount:428653'
ON CONFLICT (source_key) DO NOTHING;


-- ============================================================================
-- SECTION 6 - Ashley Johnson (9847): payment 429137 month-paid 2025-08-25 -> 2026-08-25
-- (customer restored 2026-07-18; this payment was tagged a year early).
-- month_paid is a display label only - not in any balance.
-- ============================================================================
CREATE TEMP TABLE ashley_relabel ON COMMIT DROP AS
SELECT p.payment_id, p.month_paid AS old_month, p.amount_paid, p.payment_date
FROM public.payments p
WHERE p.payment_id  = 429137
  AND p.customer_id = 9847
  AND p.month_paid  = DATE '2025-08-25'
  AND COALESCE(p.payment_type, p.legacy_payment_type) = 'Monthly Fee'
  AND p.voided_at IS NULL;

DO $g$
DECLARE n INTEGER;
BEGIN
    SELECT count(*) INTO n FROM ashley_relabel;
    IF n <> 1 THEN
        RAISE EXCEPTION 'Payment 429137 did not resolve to 9847 / month-paid 2025-08-25 / Monthly Fee (got %). Nothing changed.', n;
    END IF;
END $g$;

SELECT 'ABOUT TO RELABEL' AS check, payment_id, old_month, DATE '2026-08-25' AS new_month, amount_paid, payment_date
FROM ashley_relabel;

UPDATE public.payments SET month_paid = DATE '2026-08-25' WHERE payment_id = 429137;

INSERT INTO public.audit_logs (
    employee_id, actor_name, action, entity_type, entity_id,
    field_name, old_value, new_value, reason, occurred_at, source_key
)
SELECT (SELECT employee_id FROM actor), (SELECT actor_name FROM actor),
       'Corrected payment month', 'payment', '429137',
       'month_paid', '2025-08-25', '2026-08-25',
       'Month-paid-for tagged a year early; customer restored 2026-07-18, payment covers Aug 2026.',
       CURRENT_TIMESTAMP, 'fix-2026-09:month:429137'
ON CONFLICT (source_key) DO NOTHING;

-- --- OPTIONAL: the other two 9847 payments with the same year-early error. ---
-- --- Uncomment both statements per payment if you want them fixed too.     ---
--   payment 429135  month-paid 2025-09-01 -> 2026-09-01
--   payment 429136  month-paid 2025-10-01 -> 2026-10-01
--
-- UPDATE public.payments SET month_paid = DATE '2026-09-01'
--  WHERE payment_id = 429135 AND customer_id = 9847 AND month_paid = DATE '2025-09-01';
-- INSERT INTO public.audit_logs (employee_id, actor_name, action, entity_type, entity_id,
--     field_name, old_value, new_value, reason, occurred_at, source_key)
-- SELECT (SELECT employee_id FROM actor), (SELECT actor_name FROM actor),
--     'Corrected payment month', 'payment', '429135', 'month_paid', '2025-09-01', '2026-09-01',
--     'Month-paid-for tagged a year early; customer restored 2026-07-18.', CURRENT_TIMESTAMP,
--     'fix-2026-09:month:429135' ON CONFLICT (source_key) DO NOTHING;
--
-- UPDATE public.payments SET month_paid = DATE '2026-10-01'
--  WHERE payment_id = 429136 AND customer_id = 9847 AND month_paid = DATE '2025-10-01';
-- INSERT INTO public.audit_logs (employee_id, actor_name, action, entity_type, entity_id,
--     field_name, old_value, new_value, reason, occurred_at, source_key)
-- SELECT (SELECT employee_id FROM actor), (SELECT actor_name FROM actor),
--     'Corrected payment month', 'payment', '429136', 'month_paid', '2025-10-01', '2026-10-01',
--     'Month-paid-for tagged a year early; customer restored 2026-07-18.', CURRENT_TIMESTAMP,
--     'fix-2026-09:month:429136' ON CONFLICT (source_key) DO NOTHING;


-- ============================================================================
-- VERIFY
-- ============================================================================
SELECT 'PAYMENT FINAL STATE' AS check,
       p.payment_id, p.customer_id, cust.name,
       COALESCE(p.payment_type, p.legacy_payment_type) AS type,
       p.amount_paid, p.month_paid, p.payment_date, p.location, p.cashier_name,
       (p.voided_at IS NOT NULL) AS is_voided, p.void_reason
FROM public.payments p
JOIN public.customers cust ON cust.customer_id = p.customer_id
WHERE p.payment_id IN (428639, 428653, 50911, 116062, 81313, 429137)
ORDER BY p.customer_id, p.payment_id;

-- Balances should be UNCHANGED (these payments are not ledger-backed).
SELECT 'BALANCE (expect unchanged)' AS check, customer_id, balance, outstanding_balance
FROM public.customer_billing_status
WHERE customer_id IN (9823, 12766, 2036, 1572, 9847)
ORDER BY customer_id;

-- ----------------------------------------------------------------------------
-- ROLLBACK = rehearsal.  COMMIT = for real (back up first, run on BOTH DBs).
-- ----------------------------------------------------------------------------
ROLLBACK;
