-- Clear account 13856's existing credit, as explicitly requested by management.
-- Separate from the month-correction batch; safe to run after that batch.
-- Adds a positive adjustment equal to the negative ledger balance only.
-- Keeps payment 442069, its receipt, and all existing ledger entries intact.
-- A zero balance or outstanding debt is unchanged. Other accounts are untouched.
-- Uses employee 2 (Admin), matching the other correction scripts.
-- Run the whole file. This script COMMITS the correction.
-- A repeat run cannot clear any later credit using this same correction key.

BEGIN;
SET LOCAL lock_timeout = '10s';
LOCK TABLE public.customers, public.account_ledger_entries IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.customers WHERE customer_id = 13856) THEN
        RAISE EXCEPTION 'Account 13856 does not exist; nothing changed.';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.employees WHERE employee_id = 2 AND role = 'admin') THEN
        RAISE EXCEPTION 'Expected employee 2 to be Admin; set the correct audit actor.';
    END IF;
END $$;

CREATE TEMP TABLE credit_13856_before ON COMMIT DROP AS
SELECT COALESCE(SUM(amount), 0)::NUMERIC(14,2) AS balance
FROM public.account_ledger_entries WHERE customer_id = 13856;

WITH correction AS (
    INSERT INTO public.account_ledger_entries (
        customer_id, entry_type, amount, effective_date, description,
        created_by_employee_id, reason, is_verified, source_key
    )
    SELECT 13856, 'adjustment', -balance,
           (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
           'Clear incorrect account credit per management request', 2,
           'Management confirmed account 13856 should have no credit after the September payment was corrected to August. Clear existing credit without changing receipts or outstanding debt.',
           TRUE, 'clear-credit-13856-2026-09-14'
    FROM credit_13856_before WHERE balance < 0
    ON CONFLICT (source_key) DO NOTHING
    RETURNING account_ledger_entry_id, amount
)
INSERT INTO public.audit_logs (
    employee_id, actor_name, action, entity_type, entity_id,
    field_name, old_value, new_value, reason, occurred_at, source_key
)
SELECT e.employee_id, e.first_name || ' ' || e.last_name,
       'Cleared incorrect account credit', 'customer', '13856',
       'credit_balance', correction.amount::TEXT, '0.00',
       'Management requested removal of existing credit. Positive ledger adjustment ' ||
       correction.account_ledger_entry_id::TEXT || '; payment records preserved.',
       CURRENT_TIMESTAMP, 'clear-credit-13856-2026-09-14'
FROM correction CROSS JOIN public.employees e WHERE e.employee_id = 2;

SELECT c.customer_id, c.name, b.balance AS balance_before,
       totals.balance AS balance_after,
       GREATEST(-totals.balance, 0) AS credit_remaining,
       GREATEST(totals.balance, 0) AS outstanding_balance
FROM public.customers c CROSS JOIN credit_13856_before b
CROSS JOIN (
    SELECT COALESCE(SUM(amount), 0)::NUMERIC(14,2) AS balance
    FROM public.account_ledger_entries WHERE customer_id = 13856
) totals
WHERE c.customer_id = 13856;

COMMIT;
