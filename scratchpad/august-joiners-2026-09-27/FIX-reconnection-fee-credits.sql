-- ============================================================================
-- Accounts sitting in credit because a Reconnection Fee payment had no fee
-- to pay. Companion to the code change in server/src/routes/
-- reconnectionFeeCharge.ts, which stops new ones from 2026-09-27.
--
-- Why it happens: the receipt always posts a `reconnection_payment` credit,
-- but the `reconnection_fee` debit is only posted when the APP disconnects
-- the account. Legacy, scripted, bulk and OLT-side cut-offs never got one,
-- so the fee payment - even on an account owing 0.00 - became credit.
--
-- Per account (suspended accounts excluded: their fee lands when the
-- suspension ends and the counter quote already nets the credit):
--   unmatched = reconnection receipts (net of voids) - fee debits on ledger
--   post a `reconnection_fee` = the smaller of unmatched and the credit.
-- Only credit that traces back to reconnection receipts is touched; a
-- genuine prepayment of next month stays. Nobody goes into debt.
--
-- Idempotent via source_key. LAST LINE IS `ROLLBACK` - rehearsal. Back up,
-- then change ROLLBACK -> COMMIT:
--   docker exec -it spcl-backup sh /opt/spcl-deploy/backup.sh   # before COMMIT
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '10s';
LOCK TABLE public.customers, public.payments, public.account_ledger_entries
    IN SHARE ROW EXCLUSIVE MODE;

CREATE TEMP TABLE actor ON COMMIT DROP AS
SELECT e.employee_id, e.first_name || ' ' || e.last_name AS actor_name
FROM public.employees e WHERE e.employee_id = 2;

DO $g$
BEGIN
    IF (SELECT count(*) FROM actor) <> 1 THEN
        RAISE EXCEPTION 'employee_id 2 not found. Nothing changed.';
    END IF;
END $g$;

SELECT public.spcl_generate_monthly_charges((CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE);

CREATE TEMP TABLE plan ON COMMIT DROP AS
WITH per AS (
    SELECT e.customer_id,
        -COALESCE(SUM(e.amount) FILTER (
            WHERE e.entry_type IN ('reconnection_payment', 'payment_void')
              AND p.payment_type = 'Reconnection Fee'), 0) AS reconnection_paid,
        COALESCE(SUM(e.amount) FILTER (
            WHERE e.entry_type IN ('reconnection_fee', 'suspension_reconnection_fee')), 0) AS fees_on_ledger,
        MAX(p.payment_date) FILTER (WHERE p.payment_type = 'Reconnection Fee') AS last_reconnection_payment
    FROM public.account_ledger_entries e
    LEFT JOIN public.payments p ON p.payment_id = e.payment_id
    GROUP BY e.customer_id
)
SELECT c.customer_id, c.name, c.status, b.balance AS balance_before,
       per.reconnection_paid, per.fees_on_ledger, per.last_reconnection_payment,
       LEAST(per.reconnection_paid - per.fees_on_ledger, -b.balance) AS fee_to_post
FROM per
JOIN public.customers c USING (customer_id)
JOIN public.customer_billing_status b USING (customer_id)
WHERE b.balance < 0
  AND c.status <> 'suspended'
  AND per.reconnection_paid - per.fees_on_ledger > 0;

SELECT '1. PLAN' AS block, * FROM plan ORDER BY fee_to_post DESC, customer_id;

INSERT INTO public.account_ledger_entries (
    customer_id, entry_type, amount, effective_date, due_date, grace_end_date,
    description, created_by_employee_id, reason, source_key
)
SELECT p.customer_id, 'reconnection_fee', p.fee_to_post,
       (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
       (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
       (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
       'Reconnection fee', a.employee_id,
       'Billing correction: the reconnection fee was paid but never charged, so the payment sat as credit.',
       'fix-2026-09-27:reconnection-credit:' || p.customer_id::TEXT
FROM plan p CROSS JOIN actor a
WHERE p.fee_to_post > 0
ON CONFLICT (source_key) DO NOTHING;

INSERT INTO public.audit_logs (
    employee_id, actor_name, action, entity_type, entity_id, field_name,
    old_value, new_value, reason, occurred_at
)
SELECT a.employee_id, a.actor_name, 'Billing correction', 'customer', p.customer_id::TEXT,
       'balance', p.balance_before::TEXT, (p.balance_before + p.fee_to_post)::TEXT,
       'Reconnection fee payment had no fee charged against it; fee posted so it is not credit.',
       CURRENT_TIMESTAMP
FROM plan p CROSS JOIN actor a
WHERE p.fee_to_post > 0;

DO $g$
BEGIN
    IF EXISTS (
        SELECT 1 FROM plan p JOIN public.customer_billing_status b USING (customer_id)
        WHERE b.balance > 0
    ) THEN
        RAISE EXCEPTION 'An account would be pushed into debt. Nothing changed.';
    END IF;
END $g$;

SELECT '2. SUMMARY' AS block, COUNT(*) AS accounts, SUM(fee_to_post) AS credit_removed
FROM plan;

ROLLBACK;
