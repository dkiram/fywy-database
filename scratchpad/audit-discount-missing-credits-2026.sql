-- PostgreSQL / TablePlus: run the entire file. No persistent changes.
-- Confirmed window: discount APPROVALS Aug 18 through Sep 1 inclusive, Jamaica time.
-- This finds evidence, not proof that every discount needs another correction.
-- Management policy: confirmed paid-up accounts have their full debt cleared;
-- disconnected accounts then enter pending_reconnection.
BEGIN;
SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;

CREATE TEMP TABLE credit_audit_window ON COMMIT DROP AS
SELECT TIMESTAMPTZ '2026-08-18 00:00:00-05' AS starts_at,
       TIMESTAMPTZ '2026-09-02 00:00:00-05' AS ends_at;

CREATE TEMP TABLE discount_cohort ON COMMIT DROP AS
SELECT w.customer_id, MIN(w.reviewed_at) AS first_discount_at,
       SUM(w.amount) AS discount_total,
       ARRAY_AGG(w.waiver_request_id ORDER BY w.reviewed_at) AS discount_ids
FROM public.waiver_requests w CROSS JOIN credit_audit_window x
JOIN public.account_ledger_entries l
  ON l.account_ledger_entry_id = w.waiver_ledger_entry_id
 AND l.customer_id = w.customer_id
WHERE w.status = 'approved' AND NOT w.is_credit
  AND w.reviewed_at >= x.starts_at AND w.reviewed_at < x.ends_at
  AND l.entry_type = 'waiver' AND l.amount < 0
GROUP BY w.customer_id;

-- Candidate count, not a confirmed adjustment count. Review payment evidence
-- before adding customer IDs to the correction script.
SELECT COUNT(*) AS accounts_with_discounts_in_window,
       COUNT(*) FILTER (WHERE b.outstanding_balance > 0) AS accounts_currently_owing,
       COUNT(*) FILTER (WHERE b.outstanding_balance > 0
         AND c.status IN ('active', 'disconnected', 'pending_reconnection')
         AND NOT EXISTS (SELECT 1 FROM public.account_ledger_entries done
           WHERE done.source_key = 'discount-missing-credit-2026-08-18:' || d.customer_id::TEXT)
       ) AS owing_accounts_to_review,
       COUNT(*) FILTER (WHERE c.status = 'disconnected') AS disconnected_accounts_to_review
FROM discount_cohort d JOIN public.customers c USING (customer_id)
JOIN public.customer_billing_status b USING (customer_id);

CREATE TEMP TABLE receipt_evidence ON COMMIT DROP AS
SELECT p.customer_id, p.payment_id, p.payment_date, p.recorded_at,
       p.month_paid, p.amount_paid, p.note,
       COALESCE(l.ledger_deduction, 0) AS ledger_deduction,
       GREATEST(p.amount_paid - COALESCE(l.ledger_deduction, 0), 0) AS receipt_gap,
       COALESCE(l.other_linked_entries, 0) AS other_linked_entries,
       p.recorded_at >= d.first_discount_at AS recorded_after_discount
FROM public.payments p JOIN discount_cohort d USING (customer_id)
CROSS JOIN credit_audit_window x
LEFT JOIN LATERAL (
  SELECT -SUM(e.amount) FILTER (WHERE e.entry_type = 'monthly_payment') AS ledger_deduction,
         COUNT(*) FILTER (WHERE e.entry_type <> 'monthly_payment') AS other_linked_entries
  FROM public.account_ledger_entries e WHERE e.payment_id = p.payment_id
) l ON TRUE
WHERE COALESCE(p.payment_type, p.legacy_payment_type) = 'Monthly Fee'
  AND p.voided_at IS NULL
  AND (p.payment_date >= (x.starts_at AT TIME ZONE 'America/Jamaica')::DATE
       OR p.recorded_at >= x.starts_at);

-- 1. ALL affected accounts, including those with no debt yet or future credit.
-- Six distinct month labels are supporting evidence, not six fully paid bills.
SELECT c.customer_id, c.name, c.status, c.monthly_fee, c.activation_date,
       public.spcl_anniversary_date(c.activation_date, DATE '2026-09-01') AS september_due_date,
       CASE WHEN EXTRACT(DAY FROM c.activation_date) <= 15
            THEN 'August (user rule; verify receipt month)'
            ELSE 'September (user rule; verify receipt month)' END AS expected_september_bill_label,
       b.balance, b.outstanding_balance, b.credit_balance,
       b.outstanding_balance AS proposed_debt_to_clear_if_confirmed_paid_up,
       LEAST(b.balance, 0) AS balance_after_clearing_debt,
       b.credit_balance AS existing_credit_preserved,
       CASE WHEN c.status = 'disconnected' THEN 'pending_reconnection'
            ELSE c.status END AS proposed_status_after_correction,
       b.oldest_unpaid_due_date, b.grace_end_date,
       b.eligible_for_disconnection, b.is_on_hold, b.ready_for_reconnection,
       b.unverified_entries, d.discount_total, d.discount_ids,
       COALESCE(g.gap_total, 0) AS receipt_gap_to_investigate,
       COALESCE(h.month_labels, 0) AS distinct_month_labels_march_through_august,
       h.latest_month_label,
       COALESCE(a.later_corrections, '[]'::JSONB) AS later_credits_adjustments_or_voids,
       EXISTS (SELECT 1 FROM public.account_ledger_entries done
         WHERE done.source_key = 'discount-missing-credit-2026-08-18:' || d.customer_id::TEXT
       ) AS this_correction_already_applied
FROM discount_cohort d JOIN public.customers c USING (customer_id)
JOIN public.customer_billing_status b USING (customer_id)
LEFT JOIN LATERAL (
  SELECT SUM(receipt_gap) AS gap_total FROM receipt_evidence r
  WHERE r.customer_id = d.customer_id
) g ON TRUE
LEFT JOIN LATERAL (
  SELECT COUNT(DISTINCT DATE_TRUNC('month', p.month_paid)) FILTER (
           WHERE p.month_paid >= DATE '2026-03-01' AND p.month_paid < DATE '2026-09-01') AS month_labels,
         MAX(p.month_paid) AS latest_month_label
  FROM public.payments p WHERE p.customer_id = d.customer_id
    AND p.voided_at IS NULL
    AND COALESCE(p.payment_type, p.legacy_payment_type) = 'Monthly Fee'
) h ON TRUE
LEFT JOIN LATERAL (
  SELECT JSONB_AGG(JSONB_BUILD_OBJECT('id', l.account_ledger_entry_id,
           'amount', l.amount, 'type', l.entry_type, 'reason', l.reason,
           'source_key', l.source_key, 'created_at', l.created_at)
           ORDER BY l.created_at, l.account_ledger_entry_id) AS later_corrections
  FROM public.account_ledger_entries l
  WHERE l.customer_id = d.customer_id AND l.created_at >= d.first_discount_at
    AND l.entry_type IN ('waiver', 'adjustment', 'payment_void')
) a ON TRUE
ORDER BY b.eligible_for_disconnection DESC NULLS LAST,
         COALESCE(g.gap_total, 0) DESC, c.customer_id;

-- 2. Receipts versus actual ledger deductions. A gap may already have been
-- repaired by an UNLINKED adjustment/credit: inspect outputs 1 and 4 first.
SELECT r.*, c.name FROM receipt_evidence r
JOIN public.customers c USING (customer_id)
ORDER BY r.receipt_gap DESC, r.customer_id, r.payment_date, r.payment_id;

-- 3. Payment history: actual dates, amounts and months, not guessed allocation.
SELECT p.customer_id, p.payment_id, p.payment_date, p.recorded_at,
       p.month_paid, p.amount_paid, p.voided_at, p.note
FROM public.payments p JOIN discount_cohort d USING (customer_id)
WHERE COALESCE(p.payment_type, p.legacy_payment_type) = 'Monthly Fee'
  AND (p.payment_date >= DATE '2026-01-01' OR p.month_paid >= DATE '2026-01-01')
ORDER BY p.customer_id, p.payment_date, p.payment_id;

-- 4. Complete ledger, including opening balance and previous manual fixes.
SELECT l.customer_id, l.account_ledger_entry_id, l.entry_type, l.amount,
       l.effective_date, l.due_date, l.grace_end_date, l.created_at,
       l.payment_id, l.description, l.reason, l.source_key,
       SUM(l.amount) OVER (PARTITION BY l.customer_id
         ORDER BY l.created_at, l.account_ledger_entry_id) AS running_posted_balance
FROM public.account_ledger_entries l JOIN discount_cohort d USING (customer_id)
ORDER BY l.customer_id, l.created_at, l.account_ledger_entry_id;

-- 5. Actual status changes: compare disconnections with payment/grace dates.
SELECT h.* FROM public.account_status_history h
JOIN discount_cohort d USING (customer_id)
WHERE h.effective_date >= DATE '2026-08-18'
ORDER BY h.customer_id, h.effective_date, h.changed_at;
ROLLBACK;
