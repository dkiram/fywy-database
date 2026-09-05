-- ============================================================================
-- Voids four imported (Access) payments that cannot be voided from the app
-- (no receipt_number / no recorded_by_employee_id - historical source
-- evidence, same reason as the other fix-legacy-payments scripts this month).
--
--   1. Oneil Morgan (2341) - 09 Jul 2026  Monthly Fee  "June 2026"    J$3,500
--   2. Jason Hanson (3657) - 05 Aug 2026  Monthly Fee  "August 2026"  J$2,500  (Mandeville, Shanae Wood)
--   3. Jason Hanson (3657) - 10 Jul 2026  Monthly Fee  "July 2026"    J$2,500
--   4. Jason Hanson (3657) - 30 Jun 2026  Monthly Fee  "June 2026"    J$2,500
--
-- Matched on customer_id + payment_date + amount (payment_date is what was
-- given as the transaction date; it proved reliable on the last four fixes).
-- The stated month ("June 2026" etc.) is checked by CALENDAR MONTH against
-- the stored month_paid, not by exact day - last time an exact-day match
-- (assuming month_paid is always the 1st) failed on every row, because Access
-- stores month_paid as a specific day, not the 1st.
--
-- Each target must resolve to EXACTLY ONE payment or the whole run aborts
-- before touching anything. If any of the four turns out to have an
-- account_ledger_entries row, the run also aborts - the last five fixes this
-- month were all payments with no ledger row (balance-effect: none, just
-- removed from daily takings), and this script assumes the same, but does not
-- trust that assumption blindly.
--
-- Plain SQL. TablePlus "Run All" or psql. Run on BOTH databases.
-- LAST LINE IS `ROLLBACK` - rehearsal. Read every printed block, then back up,
-- change ROLLBACK -> COMMIT, run again.
--
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
    IF n <> 1 THEN
        RAISE EXCEPTION 'employee_id 2 matched % rows, expected 1. Nothing changed.', n;
    END IF;
END $g$;

-- ----------------------------------------------------------------------------
-- The four targets. expected_month is the CALENDAR month the payment should
-- show as covering (first of that month, compared with DATE_TRUNC).
-- ----------------------------------------------------------------------------
CREATE TEMP TABLE void_targets ON COMMIT DROP AS
SELECT * FROM (VALUES
    (2341, DATE '2026-07-09', 3500.00, DATE '2026-06-01', 'Oneil Morgan', 'Payment entered in error; void requested by management (Access import, not voidable in-app).'),
    (3657, DATE '2026-08-05', 2500.00, DATE '2026-08-01', 'Jason Hanson', 'Payment entered in error; void requested by management (Access import, not voidable in-app).'),
    (3657, DATE '2026-07-10', 2500.00, DATE '2026-07-01', 'Jason Hanson', 'Payment entered in error; void requested by management (Access import, not voidable in-app).'),
    (3657, DATE '2026-06-30', 2500.00, DATE '2026-06-01', 'Jason Hanson', 'Payment entered in error; void requested by management (Access import, not voidable in-app).')
) AS v(customer_id, payment_date, amount, expected_month, who, reason);

-- Guard: every target resolves to exactly one un-voided Monthly Fee payment,
-- and its month_paid falls in the right calendar month.
CREATE TEMP TABLE match_counts ON COMMIT DROP AS
SELECT vt.customer_id, vt.payment_date, vt.amount, vt.who,
       count(p.payment_id) FILTER (
           WHERE DATE_TRUNC('month', p.month_paid) = vt.expected_month
       ) AS good_matches,
       count(p.payment_id) AS any_matches
FROM void_targets vt
LEFT JOIN public.payments p
      ON p.customer_id = vt.customer_id
     AND p.payment_date = vt.payment_date
     AND p.amount_paid  = vt.amount
     AND COALESCE(p.payment_type, p.legacy_payment_type) = 'Monthly Fee'
     AND p.voided_at IS NULL
GROUP BY vt.customer_id, vt.payment_date, vt.amount, vt.who;

DO $g$
DECLARE r RECORD;
    bad INTEGER;
BEGIN
    SELECT count(*) INTO bad FROM match_counts WHERE good_matches <> 1;
    IF bad > 0 THEN
        FOR r IN SELECT * FROM match_counts WHERE good_matches <> 1 LOOP
            RAISE WARNING
                '% / customer % / % / J$%: % payment(s) match customer+date+amount, % with month_paid in the right calendar month (need exactly 1).',
                r.who, r.customer_id, r.payment_date, r.amount, r.any_matches, r.good_matches;
        END LOOP;
        RAISE EXCEPTION '% of 4 targets did not resolve to exactly one payment. Nothing changed - see warnings above.', bad;
    END IF;
END $g$;

CREATE TEMP TABLE void_payments ON COMMIT DROP AS
SELECT vt.who, vt.customer_id, vt.reason,
       p.payment_id, p.amount_paid, p.month_paid, p.payment_date,
       p.location, p.cashier_name, c.status AS customer_status
FROM void_targets vt
JOIN public.payments p
      ON p.customer_id = vt.customer_id
     AND p.payment_date = vt.payment_date
     AND p.amount_paid  = vt.amount
     AND COALESCE(p.payment_type, p.legacy_payment_type) = 'Monthly Fee'
     AND p.voided_at IS NULL
     AND DATE_TRUNC('month', p.month_paid) = vt.expected_month
JOIN public.customers c ON c.customer_id = vt.customer_id;

DO $g$
DECLARE n INTEGER;
BEGIN
    SELECT count(*) INTO n FROM void_payments;
    IF n <> 4 THEN
        RAISE EXCEPTION 'Expected 4 resolved payments, got %. Nothing changed.', n;
    END IF;
END $g$;

-- Stop if any target actually has a ledger entry on this database.
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
FROM void_payments ORDER BY customer_id, payment_date;

UPDATE public.payments p SET
    voided_at             = CURRENT_TIMESTAMP,
    voided_by_employee_id = (SELECT employee_id FROM actor),
    void_reason            = vp.reason
FROM void_payments vp
WHERE p.payment_id = vp.payment_id;

INSERT INTO public.audit_logs (
    employee_id, actor_name, action, entity_type, entity_id,
    field_name, old_value, new_value, reason, occurred_at, source_key
)
SELECT (SELECT employee_id FROM actor), (SELECT actor_name FROM actor),
       'Voided payment', 'payment', vp.payment_id::TEXT,
       'payment_status', 'active', 'voided', vp.reason, CURRENT_TIMESTAMP,
       'fix-2026-09:void-oneil-jason:' || vp.payment_id::TEXT
FROM void_payments vp
ON CONFLICT (source_key) DO NOTHING;


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
WHERE p.payment_id IN (SELECT payment_id FROM void_payments)
ORDER BY p.customer_id, p.payment_id;

SELECT 'BALANCE (expect unchanged if these are not ledger-backed)' AS check,
       customer_id, balance, outstanding_balance
FROM public.customer_billing_status
WHERE customer_id IN (2341, 3657)
ORDER BY customer_id;

-- ----------------------------------------------------------------------------
-- ROLLBACK = rehearsal.  COMMIT = for real (back up first, run on BOTH DBs).
-- ----------------------------------------------------------------------------
ROLLBACK;
