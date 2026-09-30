-- 10413 Kashana Kimberlie Richards: remove the third reconnection fee.
--
-- 29 Sept: auto-disconnected 00:28 -> fee 2529055 (J$1,500). She paid the
-- September bill (447600) and the fee (447603). The fee payment settled that
-- disconnection fee, but ALSO posted its own fee 2634921
-- (reconnection-fee:payment:447603) -> J$1,500 owing that she does not owe.
--
-- Reverses exactly that one line. Guards: it must still exist, unreversed,
-- and her balance must be exactly 1,500 so she lands on 0.00.
-- LAST LINE IS ROLLBACK - rehearse, then change to COMMIT.
BEGIN;

DO $g$
DECLARE bal NUMERIC;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.account_ledger_entries
                   WHERE account_ledger_entry_id = 2634921 AND customer_id = 10413
                     AND source_key = 'reconnection-fee:payment:447603' AND amount = 1500) THEN
        RAISE EXCEPTION 'Fee 2634921 not found as expected. Nothing changed.';
    END IF;
    SELECT balance INTO bal FROM public.customer_billing_status WHERE customer_id = 10413;
    IF bal <> 1500 THEN
        RAISE EXCEPTION 'Balance is % not 1500 - something changed since the audit. Nothing changed.', bal;
    END IF;
END $g$;

INSERT INTO public.account_ledger_entries (
    customer_id, entry_type, amount, effective_date, description,
    payment_id, created_by_employee_id, reason, source_key
) VALUES (
    10413, 'reconnection_fee', -1500,
    (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
    'Billing correction: duplicate reconnection fee removed', 447603, 2,
    'Fee 2634921 duplicated the 29 Sept disconnection fee (2529055), which payment 447603 already paid.',
    'fix-2026-09-29:duplicate-reconnection-fee:447603'
) ON CONFLICT (source_key) DO NOTHING;

INSERT INTO public.audit_logs (employee_id, actor_name, action, entity_type, entity_id,
    field_name, old_value, new_value, reason, occurred_at)
SELECT e.employee_id, e.first_name || ' ' || e.last_name, 'Billing correction', 'customer', '10413',
       'balance', '1500.00', '0.00',
       'Duplicate reconnection fee 2634921 removed; the 29 Sept disconnection fee was already paid by 447603.',
       CURRENT_TIMESTAMP
FROM public.employees e WHERE e.employee_id = 2;

SELECT customer_id, balance, outstanding_balance FROM public.customer_billing_status WHERE customer_id = 10413;

ROLLBACK;
