-- Read-only complete reconciliation evidence. Export result as JSON/CSV.
WITH payload AS (
SELECT 'accounts' AS kind, JSONB_AGG(JSONB_BUILD_ARRAY(c.customer_id, c.name,
 c.status, c.monthly_fee, c.activation_date, c.hidden_from_app,
 b.balance, b.oldest_unpaid_due_date, b.grace_end_date, b.is_on_hold,
 b.eligible_for_disconnection, c.reactivation_date, c.deactivation_date)) AS data
FROM public.customers c JOIN public.customer_billing_status b USING(customer_id)
UNION ALL
SELECT 'payments', JSONB_AGG(JSONB_BUILD_ARRAY(payment_id, customer_id, amount_paid,
 payment_date, month_paid, recorded_at, voided_at, legacy_payment_id, note))
FROM public.payments
WHERE COALESCE(payment_type, legacy_payment_type) = 'Monthly Fee'
 AND (payment_date >= DATE '2026-01-01' OR month_paid >= DATE '2026-01-01')
UNION ALL
SELECT 'ledger', JSONB_AGG(JSONB_BUILD_ARRAY(account_ledger_entry_id, customer_id,
 entry_type, amount, effective_date, due_date, grace_end_date, payment_id,
 source_key, reason, created_at)) FROM public.account_ledger_entries
UNION ALL
SELECT 'rates', JSONB_AGG(JSONB_BUILD_ARRAY(customer_id, effective_date, monthly_fee,
 customer_rate_history_id)) FROM public.customer_rate_history
UNION ALL
SELECT 'history', JSONB_AGG(JSONB_BUILD_ARRAY(customer_id, from_status, to_status,
 effective_date, changed_at, account_status_history_id, reason))
FROM public.account_status_history
UNION ALL
SELECT 'meta', JSONB_BUILD_OBJECT('database',current_database(),'user',current_user,
 'snapshot_at',CURRENT_TIMESTAMP,'as_of',(CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE)
)
SELECT kind, data FROM payload;
