-- Payment corrections requested 2026-09-14. Run the entire file together.
-- Exact payment IDs verified against the diagnostic results supplied by user:
-- 11826 Zhanay Williams: 441994 July -> August; 441995 July -> September.
-- 13856: 442069 September -> August.
-- 13976 Lorriean Ewan: void 65129, J$4,000 collected August 18 for August.
-- Shanice Johnson (6461) is EXCLUDED at the user's request.
--
-- Month corrections change labels only: no new payment, charge, or credit.
-- The void reverses the actual ledger deduction, which may be less than the
-- receipt amount or absent. Original ledger entries remain as audit evidence.
-- Audit actor follows the existing scratchpad convention: employee 2 (Admin).
-- Each ID must still match its verified customer, date, amount, and old month.
-- Re-running after a committed run aborts without selecting other payments.
--
-- DEFAULT: rehearsal, ending in ROLLBACK. Review BEFORE/AFTER output, then
-- change only the final ROLLBACK to COMMIT to apply the corrections.

BEGIN;
SET LOCAL lock_timeout = '10s';
-- Keep selection, rerun checks, balances, and updates consistent with cashiers.
LOCK TABLE public.customers, public.payments, public.account_ledger_entries,
           public.audit_logs IN SHARE ROW EXCLUSIVE MODE;

CREATE TEMP TABLE correction_actor ON COMMIT DROP AS
SELECT employee_id, first_name || ' ' || last_name AS actor_name
FROM public.employees WHERE employee_id = 2 AND role = 'admin';

DO $$
BEGIN
    IF (SELECT COUNT(*) FROM correction_actor) <> 1 THEN
        RAISE EXCEPTION 'Expected employee 2 to be Admin. Set the correct audit actor before running.';
    END IF;
    IF EXISTS (SELECT 1 FROM public.audit_logs
               WHERE source_key LIKE 'fix-payment-months-2026-09-14:%') THEN
        RAISE EXCEPTION 'This correction batch has already been applied. No further payments selected.';
    END IF;
END $$;

CREATE TEMP TABLE correction_targets (
    payment_id BIGINT PRIMARY KEY,
    customer_id INTEGER NOT NULL,
    old_month DATE NOT NULL,
    new_month DATE,
    operation TEXT NOT NULL,
    reason TEXT NOT NULL
) ON COMMIT DROP;

CREATE TEMP TABLE correction_expected (
    payment_id BIGINT PRIMARY KEY,
    customer_id INTEGER NOT NULL,
    payment_date DATE NOT NULL,
    amount_paid NUMERIC NOT NULL,
    old_month DATE NOT NULL,
    new_month DATE,
    operation TEXT NOT NULL,
    reason TEXT NOT NULL
) ON COMMIT DROP;

INSERT INTO correction_expected VALUES
    (441994, 11826, DATE '2026-09-14', 2500.00, DATE '2026-07-01', DATE '2026-08-01', 'relabel',
     'Management request: Zhanay Williams July payment 441994 covers August 2026.'),
    (441995, 11826, DATE '2026-09-14', 2500.00, DATE '2026-07-01', DATE '2026-09-01', 'relabel',
     'Management request: Zhanay Williams July payment 441995 covers September 2026.'),
    (442069, 13856, DATE '2026-09-14', 3000.00, DATE '2026-09-01', DATE '2026-08-01', 'relabel',
     'Management request: account 13856 September payment should cover August 2026.'),
    (65129, 13976, DATE '2026-08-18', 4000.00, DATE '2026-08-18', NULL, 'void',
     'Management request: void the August payment collected on 2026-08-18 for account 13976.');

INSERT INTO correction_targets
SELECT p.payment_id, p.customer_id, p.month_paid, e.new_month, e.operation, e.reason
FROM correction_expected e JOIN public.payments p USING (payment_id)
WHERE p.customer_id = e.customer_id
  AND p.payment_date = e.payment_date
  AND p.amount_paid = e.amount_paid
  AND p.month_paid = e.old_month
  AND COALESCE(p.payment_type, p.legacy_payment_type) = 'Monthly Fee'
  AND p.voided_at IS NULL;

-- Any mismatch is visible by exact ID before the guard runs.
SELECT 'MATCH CHECK' AS review, e.payment_id, e.customer_id AS expected_customer,
       p.customer_id AS actual_customer, p.payment_date, p.amount_paid, p.month_paid,
       p.voided_at, (t.payment_id IS NOT NULL) AS matches_verified_payment
FROM correction_expected e LEFT JOIN public.payments p USING (payment_id)
LEFT JOIN correction_targets t USING (payment_id)
ORDER BY e.payment_id;

-- Show candidate identities even if the following guard aborts the batch.
SELECT 'BEFORE' AS review, c.name, p.customer_id, p.payment_id,
       p.payment_date, p.recorded_at, p.amount_paid, p.location, p.cashier_name,
       t.old_month, t.new_month, t.operation
FROM correction_targets t JOIN public.payments p USING (payment_id)
JOIN public.customers c ON c.customer_id = p.customer_id
ORDER BY p.customer_id, p.payment_date, p.payment_id;

DO $$
BEGIN
    IF (SELECT COUNT(*) FROM correction_targets) <> 4 THEN
        RAISE EXCEPTION 'Verified payment IDs no longer match: %. Review MATCH CHECK; nothing changed.',
            (SELECT STRING_AGG(e.payment_id::TEXT, ', ' ORDER BY e.payment_id)
             FROM correction_expected e LEFT JOIN correction_targets t USING (payment_id)
             WHERE t.payment_id IS NULL);
    END IF;
    IF EXISTS (
        SELECT 1 FROM public.account_ledger_entries e
        JOIN correction_targets t USING (payment_id)
        WHERE t.operation = 'void'
          AND (e.customer_id <> t.customer_id OR e.entry_type <> 'monthly_payment' OR e.amount >= 0)
    ) THEN
        RAISE EXCEPTION 'Void target has unexpected ledger entries or a prior reversal; inspect before correcting.';
    END IF;
END $$;

CREATE TEMP TABLE correction_balances_before ON COMMIT DROP AS
SELECT c.customer_id, COALESCE(SUM(e.amount), 0) AS balance
FROM public.customers c LEFT JOIN public.account_ledger_entries e USING (customer_id)
WHERE c.customer_id IN (SELECT customer_id FROM correction_targets)
GROUP BY c.customer_id;

UPDATE public.payments p SET month_paid = t.new_month
FROM correction_targets t WHERE p.payment_id = t.payment_id AND t.operation = 'relabel';

UPDATE public.payments p SET voided_at = CURRENT_TIMESTAMP,
    voided_by_employee_id = (SELECT employee_id FROM correction_actor), void_reason = t.reason
FROM correction_targets t WHERE p.payment_id = t.payment_id AND t.operation = 'void';

-- Aggregate all original deductions; never reverse the receipt amount blindly.
INSERT INTO public.account_ledger_entries (
    customer_id, entry_type, amount, effective_date, description,
    payment_id, created_by_employee_id, reason, source_key
)
SELECT t.customer_id, 'payment_void', -SUM(e.amount),
       (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
       'Voided payment reversal', t.payment_id,
       (SELECT employee_id FROM correction_actor), t.reason, 'payment-void:' || t.payment_id::TEXT
FROM correction_targets t JOIN public.account_ledger_entries e USING (payment_id)
WHERE t.operation = 'void' AND e.entry_type = 'monthly_payment' AND e.amount < 0
GROUP BY t.customer_id, t.payment_id, t.reason;

-- Match the app's void behavior if the payment had cleared a reconnection queue.
CREATE TEMP TABLE correction_status ON COMMIT DROP AS
SELECT c.customer_id FROM public.customers c
JOIN public.customer_billing_status b USING (customer_id)
WHERE c.customer_id = 13976 AND c.status = 'pending_reconnection' AND b.outstanding_balance > 0;

UPDATE public.customers SET status = 'disconnected'
WHERE customer_id IN (SELECT customer_id FROM correction_status);

INSERT INTO public.account_status_history (
    customer_id, from_status, to_status, reason, changed_by_employee_id, source_key
)
SELECT customer_id, 'pending_reconnection', 'disconnected',
       'August 18 payment voided by management; account balance is unpaid again.',
       (SELECT employee_id FROM correction_actor),
       'fix-payment-months-2026-09-14:status:' || customer_id::TEXT
FROM correction_status;

INSERT INTO public.audit_logs (
    employee_id, actor_name, action, entity_type, entity_id,
    field_name, old_value, new_value, reason, occurred_at, source_key
)
SELECT a.employee_id, a.actor_name,
       CASE WHEN t.operation = 'void' THEN 'Voided payment' ELSE 'Corrected payment month' END,
       'payment', t.payment_id::TEXT,
       CASE WHEN t.operation = 'void' THEN 'payment_status' ELSE 'month_paid' END,
       CASE WHEN t.operation = 'void' THEN 'active' ELSE t.old_month::TEXT END,
       CASE WHEN t.operation = 'void' THEN 'voided' ELSE t.new_month::TEXT END,
       t.reason, CURRENT_TIMESTAMP, 'fix-payment-months-2026-09-14:payment:' || t.payment_id::TEXT
FROM correction_targets t CROSS JOIN correction_actor a;

INSERT INTO public.audit_logs (
    employee_id, actor_name, action, entity_type, entity_id,
    field_name, old_value, new_value, reason, occurred_at, source_key
)
SELECT a.employee_id, a.actor_name, 'Returned account to disconnected after payment void',
       'customer', s.customer_id::TEXT, 'status', 'pending_reconnection', 'disconnected',
       'August 18 payment voided by management; account balance is unpaid again.', CURRENT_TIMESTAMP,
       'fix-payment-months-2026-09-14:status:' || s.customer_id::TEXT
FROM correction_status s CROSS JOIN correction_actor a;

SELECT 'AFTER' AS review, c.name, p.customer_id, p.payment_id, p.payment_date,
       p.amount_paid, p.month_paid, p.voided_at, p.void_reason
FROM correction_targets t JOIN public.payments p USING (payment_id)
JOIN public.customers c ON c.customer_id = p.customer_id
ORDER BY p.customer_id, p.payment_id;

SELECT 'BALANCE CHECK' AS review, b.customer_id, b.balance AS before_balance,
       COALESCE(SUM(e.amount), 0) AS after_balance,
       COALESCE(SUM(e.amount), 0) - b.balance AS increase_from_void
FROM correction_balances_before b
LEFT JOIN public.account_ledger_entries e USING (customer_id)
GROUP BY b.customer_id, b.balance ORDER BY b.customer_id;

-- Rehearsal only. Change to COMMIT after reviewing the matched payments.
ROLLBACK;
