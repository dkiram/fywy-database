-- ============================================================================
-- Melodie OConnor (customer 8571) - remove 1,500 of credit from a month that
-- was settled twice. Balance -1,500 -> 0.
--
-- REPLACES FIX-melodie-oconnor-8571-reconnection-fee.sql, which assumed the
-- fee was never charged. It was (2026-09-15, reconnection-fee:status-
-- history:19361) and that script correctly refused to run. Do not run it.
--
-- Her anniversary is the 4th, so a month's service bills on the 4th of the
-- FOLLOWING month. The full ledger:
--
--   2026-08-04  monthly_charge     +2,500   July service
--   2026-08-28  adjustment         -2,500   clean-slate:8571 "paid up to date"
--   2026-09-04  monthly_charge     +2,500   August service
--   2026-09-15  reconnection_fee   +1,500   auto-disconnected, Sep 4 unpaid
--   2026-09-18  monthly_payment    -1,500   tagged July    <- July was already
--   2026-09-18  monthly_payment    -2,500   tagged August     forgiven on Aug 28
--   2026-09-18  reconnection_pay     -500
--   2026-09-18  reconnection_pay   -1,000
--   balance: -1,500
--
-- The August payment clears the Sep 4 charge. The two fee payments clear the
-- fee. The July payment lands on a charge the clean-slate had already wiped -
-- the month is settled twice, once by forgiveness and once by cash. That
-- 1,500 is the credit. This is the "settled twice" case (Javid Christian
-- 10471, pass D of scratchpad/fix-phantom-credits-2026-09.sql).
--
-- The 2026-09-18 15:23 message ("clear the credit of 500 and she should have
-- a balance of 1000") was written while she stood at -500, with 1,000 of the
-- fee still unpaid: -500 + 1,500 = +1,000, exactly the figure given. She paid
-- that 1,000 at 15:05, so the target now is 0.
--
-- Guards: name must be Melodie Oconnor, balance EXACTLY -1,500.00, the
-- clean-slate adjustment and the July-tagged 1,500 receipt must both be on
-- record, and it must land on EXACTLY 0.00. Idempotent via source_key.
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
DECLARE nm TEXT; b NUMERIC; slate NUMERIC; july NUMERIC;
BEGIN
    SELECT c.name, s.balance INTO nm, b
    FROM public.customers c
    JOIN public.customer_billing_status s USING (customer_id)
    WHERE c.customer_id = 8571;

    IF nm IS NULL THEN
        RAISE EXCEPTION 'Customer 8571 not found. Nothing changed.';
    END IF;
    IF LOWER(TRIM(nm)) <> 'melodie oconnor' THEN
        RAISE EXCEPTION 'Customer 8571 is "%", expected Melodie Oconnor. Nothing changed.', nm;
    END IF;
    IF b <> -1500.00 THEN
        RAISE EXCEPTION 'Balance for 8571 is %, expected -1500.00. Something has moved - recheck before correcting.', b;
    END IF;

    SELECT l.amount INTO slate
    FROM public.account_ledger_entries l
    WHERE l.customer_id = 8571 AND l.source_key = 'clean-slate:8571';
    IF slate IS DISTINCT FROM -2500.00 THEN
        RAISE EXCEPTION 'Expected the clean-slate:8571 adjustment of -2500.00, found %. The premise does not hold. Nothing changed.', slate;
    END IF;

    SELECT p.amount_paid INTO july
    FROM public.payments p
    WHERE p.payment_id = 443379 AND p.customer_id = 8571
      AND p.month_paid = DATE '2026-07-01' AND p.voided_at IS NULL;
    IF july IS DISTINCT FROM 1500.00 THEN
        RAISE EXCEPTION 'Expected receipt 443379 (1500.00 tagged July 2026, not voided), found %. Nothing changed.', july;
    END IF;
END $g$;

SELECT 'BEFORE' AS check, c.name, c.status, b.balance, b.credit_balance
FROM public.customer_billing_status b
JOIN public.customers c USING (customer_id)
WHERE b.customer_id = 8571;

INSERT INTO public.account_ledger_entries (
    customer_id, entry_type, amount, effective_date, description,
    created_by_employee_id, reason, is_verified, source_key
) VALUES (
    8571, 'adjustment', 1500.00,
    (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
    'July 2026 settled twice: forgiven by the 2026-08-28 clean-slate, then paid again 2026-09-18. Credit removed.',
    2,
    'The Aug 4 charge (July service) was cleared by the 2026-08-28 clean-slate adjustment. Receipt 443379 (J$1,500.00, tagged July 2026) then paid it again on 2026-09-18, leaving the amount as credit. This removes that credit; the receipt itself is untouched. Account review 2026-09-18.',
    TRUE,
    'father-credit-fix-20260918:settled-twice:8571'
)
ON CONFLICT (source_key) DO NOTHING;

DO $g$
DECLARE b NUMERIC;
BEGIN
    SELECT balance INTO b FROM public.customer_billing_status WHERE customer_id = 8571;
    IF b <> 0.00 THEN
        RAISE EXCEPTION 'Balance for 8571 is % after the adjustment, expected 0.00. Nothing committed.', b;
    END IF;
END $g$;

INSERT INTO public.audit_logs (
    employee_id, actor_name, action, entity_type, entity_id,
    field_name, old_value, new_value, reason, occurred_at, source_key
)
SELECT (SELECT employee_id FROM actor), (SELECT actor_name FROM actor),
       'Adjusted account balance', 'customer', '8571',
       'balance', '-1500.00', '0.00',
       'July 2026 was forgiven by the 2026-08-28 clean-slate and then paid again on 2026-09-18; the duplicate settlement was removed as credit. Account review 2026-09-18.',
       CURRENT_TIMESTAMP, 'father-credit-fix-20260918:settled-twice:8571'
ON CONFLICT (source_key) DO NOTHING;

SELECT 'AFTER' AS check, b.balance, b.outstanding_balance, b.credit_balance
FROM public.customer_billing_status b
WHERE b.customer_id = 8571;

-- ----------------------------------------------------------------------------
-- ROLLBACK = rehearsal.  COMMIT = for real (back up first).
-- ----------------------------------------------------------------------------
ROLLBACK;
