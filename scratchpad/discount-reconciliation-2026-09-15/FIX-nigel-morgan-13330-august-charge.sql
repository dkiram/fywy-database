-- ============================================================================
-- Nigel Morgan (customer 13330) - post the missing August 2026 charge.
-- STEP 2 OF 2. RUN FIX-nigel-morgan-13330-retag-august.sql FIRST.
--
-- *** THIS LEAVES HIM OWING MONEY. Read the arithmetic before committing. ***
--
-- Why it is needed: his anniversary is the 22nd, so each month bills in the
-- same month, and August's charge should have fallen due 2026-08-22. It never
-- did - this is a legacy account whose ledger only opens at the 2026-09-22
-- charge (migration 041's billing start was later than his real position).
-- So re-tagging the receipt to August leaves the label saying August while
-- nothing on the ledger settles August, and the J$3,500.00 sits as credit.
--
-- This is exactly what paymentMonthCharge.ts does at the counter when a
-- Monthly Fee payment is tagged to a past month with no charge: raise the
-- charge, at the rate in force on its due date, using the generator's own
-- source_key so the nightly run can never double it. The only reason it did
-- not happen automatically is that the receipt was keyed to October, which is
-- not a past month.
--
-- The arithmetic, with his J$4,000 fee:
--     Aug 4,000 + Sep 4,000 + reconnection 1,500  =  9,500 owed
--     paid 2026-10-12 (3,500 + 1,000 + 3,000 + 1,500)  =  9,000
--     => J$500.00 outstanding
-- The rehearsal prints the exact rate and landing balance. If the August rate
-- is 3,500 he lands on 0.00 instead; the script does not assume which.
--
-- If instead the view is that August should NOT be billed, do not run this -
-- but then the J$3,500.00 is a genuine prepayment and the receipt should stay
-- tagged to a month he is actually paying ahead for, not August.
--
-- Guards: customer must be Nigel Morgan with balance -3,500.00, receipt
-- 451937 must already be tagged 2026-08-01 (step 1 done), August must have NO
-- charge yet, the service timeline must say he was active on 2026-08-22, a
-- rate must exist, and the insert must survive the 054 trigger.
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
DECLARE nm TEXT; b NUMERIC; mth DATE; has_charge BOOLEAN; on_service BOOLEAN; rate NUMERIC;
BEGIN
    SELECT c.name, s.balance INTO nm, b
    FROM public.customers c
    JOIN public.customer_billing_status s USING (customer_id)
    WHERE c.customer_id = 13330;

    IF LOWER(TRIM(COALESCE(nm, ''))) <> 'nigel morgan' THEN
        RAISE EXCEPTION 'Customer 13330 is "%", expected Nigel Morgan. Nothing changed.', nm;
    END IF;
    IF b <> -3500.00 THEN
        RAISE EXCEPTION 'Balance for 13330 is %, expected -3500.00. Recheck before correcting.', b;
    END IF;

    SELECT month_paid INTO mth FROM public.payments WHERE payment_id = 451937;
    IF mth IS DISTINCT FROM DATE '2026-08-01' THEN
        RAISE EXCEPTION 'Receipt 451937 is tagged %, expected 2026-08-01. Run the re-tag script first. Nothing changed.', mth;
    END IF;

    SELECT EXISTS (
        SELECT 1 FROM public.account_ledger_entries l
        WHERE l.customer_id = 13330 AND l.entry_type = 'monthly_charge'
          AND COALESCE(l.due_date, l.effective_date) = DATE '2026-08-22'
    ) INTO has_charge;
    IF has_charge THEN
        RAISE EXCEPTION 'An August 2026 charge already exists on 13330. Nothing changed.';
    END IF;

    SELECT public.spcl_customer_service_active_on(13330, DATE '2026-08-22') INTO on_service;
    IF on_service IS NOT TRUE THEN
        RAISE EXCEPTION 'The service timeline says 13330 was not active on 2026-08-22, so August must not be billed. Nothing changed.';
    END IF;

    SELECT r.monthly_fee INTO rate
    FROM public.customer_rate_history r
    WHERE r.customer_id = 13330 AND r.effective_date <= DATE '2026-08-22'
    ORDER BY r.effective_date DESC, r.customer_rate_history_id DESC
    LIMIT 1;
    IF rate IS NULL OR rate <= 0 THEN
        RAISE EXCEPTION 'No usable rate in force for 13330 on 2026-08-22 (found %). Nothing changed.', rate;
    END IF;
END $g$;

SELECT 'BEFORE' AS check, c.name, c.monthly_fee AS fee_today, b.balance, b.credit_balance,
       (SELECT r.monthly_fee
          FROM public.customer_rate_history r
         WHERE r.customer_id = 13330 AND r.effective_date <= DATE '2026-08-22'
         ORDER BY r.effective_date DESC, r.customer_rate_history_id DESC LIMIT 1) AS august_rate,
       b.balance +
       (SELECT r.monthly_fee
          FROM public.customer_rate_history r
         WHERE r.customer_id = 13330 AND r.effective_date <= DATE '2026-08-22'
         ORDER BY r.effective_date DESC, r.customer_rate_history_id DESC LIMIT 1) AS balance_after
FROM public.customers c
JOIN public.customer_billing_status b USING (customer_id)
WHERE c.customer_id = 13330;

INSERT INTO public.account_ledger_entries (
    customer_id, entry_type, amount, effective_date, due_date, grace_end_date,
    description, customer_rate_history_id, created_by_employee_id, reason,
    is_verified, source_key
)
SELECT 13330, 'monthly_charge', r.monthly_fee,
       DATE '2026-08-22', DATE '2026-08-22', DATE '2026-08-22' + 10,
       'Monthly service charge for activation anniversary',
       r.customer_rate_history_id, 2,
       'Raised when the month was paid at the counter: August 2026 had not been billed because the legacy paid-through date was later than the customer''s real position. Receipt SPCL-20261012-000451937 pays this month.',
       TRUE,
       'monthly-charge:13330:2026-08-22'
FROM public.customer_rate_history r
WHERE r.customer_id = 13330 AND r.effective_date <= DATE '2026-08-22'
ORDER BY r.effective_date DESC, r.customer_rate_history_id DESC
LIMIT 1
ON CONFLICT (source_key) DO NOTHING;

-- The 054 trigger silently drops a monthly_charge it disagrees with. We asked
-- it the same question above, so this should never trip.
DO $g$
DECLARE n INTEGER;
BEGIN
    SELECT count(*) INTO n FROM public.account_ledger_entries
    WHERE source_key = 'monthly-charge:13330:2026-08-22';
    IF n <> 1 THEN
        RAISE EXCEPTION 'The August charge was not written (service timeline rejected it). Nothing committed.';
    END IF;
END $g$;

INSERT INTO public.audit_logs (
    employee_id, actor_name, action, entity_type, entity_id,
    field_name, old_value, new_value, reason, occurred_at, source_key
)
SELECT (SELECT employee_id FROM actor), (SELECT actor_name FROM actor),
       'Raised unbilled monthly charge at payment', 'customer', '13330',
       'monthly_charge', NULL, l.amount::TEXT,
       'August 2026 was never billed on this legacy account. Receipt SPCL-20261012-000451937 (J$3,500.00) was re-tagged from October to August 2026, so the matching charge was raised at the rate in force on its 2026-08-22 due date.',
       CURRENT_TIMESTAMP, 'monthly-charge-audit:13330:2026-08-22'
FROM public.account_ledger_entries l
WHERE l.source_key = 'monthly-charge:13330:2026-08-22'
ON CONFLICT (source_key) DO NOTHING;

SELECT 'AFTER' AS check, b.balance, b.outstanding_balance, b.credit_balance,
       b.oldest_unpaid_due_date
FROM public.customer_billing_status b
WHERE b.customer_id = 13330;

-- ----------------------------------------------------------------------------
-- ROLLBACK = rehearsal.  COMMIT = for real (back up first).
-- ----------------------------------------------------------------------------
ROLLBACK;
