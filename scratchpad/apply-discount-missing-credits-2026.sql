-- Run AFTER reviewing audit-discount-missing-credits-2026.sql.
-- Management instruction: clear the ENTIRE outstanding balance for affected
-- accounts confirmed paid up to date from the previous six months' history.
-- Discount approval window: Aug 18 through Sep 1 inclusive, Jamaica time.
-- Select verified IDs after reviewing receipts, covered months and prior fixes.
-- Six month labels or six receipts alone do not establish full payment.
-- This creates a reversible balance waiver; existing credits are preserved.
-- Disconnected accounts with cleared balances move to pending_reconnection,
-- with status history, audit records, and pending request resolution.
-- Configured reconnection automation may process them after COMMIT.
-- Defaults to ROLLBACK. Review BEFORE/AFTER; change final line to COMMIT to save.
BEGIN;
SET LOCAL lock_timeout = '10s';
LOCK TABLE public.customers, public.payments, public.account_ledger_entries,
           public.waiver_requests, public.account_status_history,
           public.reconnection_requests IN SHARE ROW EXCLUSIVE MODE;

CREATE TEMP TABLE credit_actor (employee_id BIGINT PRIMARY KEY) ON COMMIT DROP;
-- Management confirmed employee ID 2; validated as an admin below.
INSERT INTO credit_actor VALUES (2);

CREATE TEMP TABLE reviewed_accounts (
  customer_id INTEGER PRIMARY KEY,
  expected_balance NUMERIC(14,2) NOT NULL,
  evidence TEXT NOT NULL CHECK (LENGTH(TRIM(evidence)) BETWEEN 3 AND 500)
) ON COMMIT DROP;
-- Populate with affected IDs, audit balances and supporting receipt/charge IDs:
-- INSERT INTO reviewed_accounts VALUES
--   (<customer_id>, <balance_from_audit>, '<receipt evidence: paid up to date; clear erroneous debt>');

CREATE TEMP TABLE reviewed_credits ON COMMIT DROP AS
SELECT r.*, GREATEST(b.balance, 0)::NUMERIC(14,2) AS credit_to_add,
       c.status AS status_before
FROM reviewed_accounts r LEFT JOIN public.customers c USING (customer_id)
LEFT JOIN public.customer_billing_status b USING (customer_id);

DO $$
BEGIN
  IF (SELECT COUNT(*) FROM credit_actor a JOIN public.employees e USING (employee_id)
      WHERE e.role = 'admin') <> 1 THEN
    RAISE EXCEPTION 'Enter one valid admin employee_id in credit_actor.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM reviewed_credits) THEN
    RAISE EXCEPTION 'No affected accounts entered. Run the audit first.';
  END IF;
  IF EXISTS (SELECT 1 FROM reviewed_credits
             WHERE status_before NOT IN ('active', 'disconnected', 'pending_reconnection')) THEN
    RAISE EXCEPTION 'An account is closed, suspended, offline or otherwise outside this correction workflow. Review separately.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM reviewed_credits r
    LEFT JOIN public.customer_billing_status b USING (customer_id)
    WHERE b.customer_id IS NULL OR b.balance IS DISTINCT FROM r.expected_balance
  ) THEN
    RAISE EXCEPTION 'An account is missing or its balance changed. Re-audit before applying.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM reviewed_credits r WHERE NOT EXISTS (
      SELECT 1 FROM public.waiver_requests w
      JOIN public.account_ledger_entries l
        ON l.account_ledger_entry_id = w.waiver_ledger_entry_id
       AND l.customer_id = w.customer_id
      WHERE w.customer_id = r.customer_id AND w.status = 'approved'
        AND NOT w.is_credit AND l.entry_type = 'waiver' AND l.amount < 0
        AND w.reviewed_at >= TIMESTAMPTZ '2026-08-18 00:00:00-05'
        AND w.reviewed_at < TIMESTAMPTZ '2026-09-02 00:00:00-05'
    )
  ) THEN
    RAISE EXCEPTION 'A reviewed customer does not have an approved discount in the audit window.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM reviewed_credits r JOIN public.account_ledger_entries l
      ON l.source_key = 'discount-missing-credit-2026-08-18:' || r.customer_id::TEXT
  ) THEN
    RAISE EXCEPTION 'A credit in this batch was already applied. No duplicate credits posted.';
  END IF;
END $$;

SELECT 'BEFORE' AS stage, c.name, r.*, b.eligible_for_disconnection
FROM reviewed_credits r JOIN public.customers c USING (customer_id)
JOIN public.customer_billing_status b USING (customer_id);

INSERT INTO public.account_ledger_entries (
  customer_id, entry_type, amount, effective_date, description,
  created_by_employee_id, reason, is_verified, source_key
)
SELECT r.customer_id, 'waiver', -r.credit_to_add,
       (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
       'Billing correction: cleared erroneous outstanding balance', a.employee_id, r.evidence, TRUE,
       'discount-missing-credit-2026-08-18:' || r.customer_id::TEXT
FROM reviewed_credits r CROSS JOIN credit_actor a
WHERE r.credit_to_add > 0;

INSERT INTO public.waiver_requests (
  customer_id, amount, reason, status, requested_by_employee_id,
  reviewed_by_employee_id, reviewed_at, review_note, waiver_ledger_entry_id, is_credit
)
SELECT r.customer_id, r.credit_to_add, r.evidence, 'approved',
       a.employee_id, a.employee_id, CURRENT_TIMESTAMP,
       'Paid up to date verified; erroneous outstanding balance cleared.', l.account_ledger_entry_id, FALSE
FROM reviewed_credits r CROSS JOIN credit_actor a
JOIN public.account_ledger_entries l
  ON l.source_key = 'discount-missing-credit-2026-08-18:' || r.customer_id::TEXT;

INSERT INTO public.audit_logs (
  employee_id, actor_name, action, entity_type, entity_id, field_name,
  old_value, new_value, reason, source_key
)
SELECT a.employee_id, CONCAT_WS(' ', e.first_name, e.last_name),
       'Cleared erroneous debt after payment reconciliation',
       'customer', r.customer_id::TEXT, 'balance', r.expected_balance::TEXT,
       (r.expected_balance - r.credit_to_add)::TEXT, r.evidence,
       'discount-missing-credit-2026-08-18:' || r.customer_id::TEXT
FROM reviewed_credits r CROSS JOIN credit_actor a
JOIN public.employees e USING (employee_id)
WHERE r.credit_to_add > 0;

-- Follow the app's approved-waiver reconnection workflow.
CREATE TEMP TABLE queued_reconnections ON COMMIT DROP AS
WITH moved AS (
  UPDATE public.customers c SET status = 'pending_reconnection'
  FROM reviewed_credits r, public.customer_billing_status b
  WHERE c.customer_id = r.customer_id AND b.customer_id = c.customer_id
    AND c.status = 'disconnected' AND b.ready_for_reconnection
  RETURNING c.customer_id
), recorded AS (
  INSERT INTO public.account_status_history (
    customer_id, from_status, to_status, reason, changed_by_employee_id, source_key
  )
  SELECT m.customer_id, 'disconnected', 'pending_reconnection',
         'Billing correction: balance cleared; awaiting reconnection', a.employee_id,
         'discount-missing-credit-2026-08-18:reconnect:' || m.customer_id::TEXT
  FROM moved m CROSS JOIN credit_actor a
  RETURNING customer_id, account_status_history_id
)
SELECT * FROM recorded;

UPDATE public.reconnection_requests r
SET status = 'approved', reviewed_at = CURRENT_TIMESTAMP,
    reviewed_by_employee_id = (SELECT employee_id FROM credit_actor),
    review_note = 'Billing correction cleared the balance; queued for reconnection.',
    account_status_history_id = q.account_status_history_id
FROM queued_reconnections q
WHERE r.customer_id = q.customer_id AND r.status = 'pending';

INSERT INTO public.audit_logs (
  employee_id, actor_name, action, entity_type, entity_id, field_name,
  old_value, new_value, reason, source_key
)
SELECT a.employee_id, CONCAT_WS(' ', e.first_name, e.last_name),
       'Queued reconnection after billing correction', 'customer', q.customer_id::TEXT,
       'status', 'disconnected', 'pending_reconnection',
       'Billing correction: balance cleared; awaiting reconnection',
       'discount-missing-credit-2026-08-18:reconnect:' || q.customer_id::TEXT
FROM queued_reconnections q CROSS JOIN credit_actor a
JOIN public.employees e USING (employee_id);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM reviewed_credits r JOIN public.customer_billing_status b USING (customer_id)
    WHERE b.balance <> r.expected_balance - r.credit_to_add
  ) THEN
    RAISE EXCEPTION 'Credit verification failed; transaction must be rolled back.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM reviewed_credits r JOIN public.customers c USING (customer_id)
    WHERE r.status_before IN ('disconnected', 'pending_reconnection')
      AND c.status <> 'pending_reconnection'
  ) THEN
    RAISE EXCEPTION 'A cleared disconnected account was not queued; transaction must be rolled back.';
  END IF;
END $$;

SELECT 'AFTER' AS stage, c.name, b.customer_id, b.balance, b.outstanding_balance,
       b.credit_balance, b.oldest_unpaid_due_date, b.grace_end_date,
       b.eligible_for_disconnection, b.ready_for_reconnection, c.status,
       CASE WHEN c.status = 'pending_reconnection'
            THEN 'Queued for reconnection; configured automation may process after COMMIT'
            ELSE 'Balance corrected; account remains active' END AS follow_up
FROM reviewed_credits r JOIN public.customers c USING (customer_id)
JOIN public.customer_billing_status b USING (customer_id);

ROLLBACK;
