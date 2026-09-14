-- September 12, 2026 erroneous-disconnection billing correction (PostgreSQL).
-- Run the WHOLE file in one session. ROLLBACK at the end is a preview;
-- replace it with COMMIT to save the displayed discounts.
--
-- Qualifies by immutable status history, even if subsequently reconnected:
--   * transitioned to disconnected effective 2026-09-12;
--   * Date Joined (activation_date) falls on day 1 of any month/year;
--   * non-void Monthly Fee payments received in August 2026 FOR August 2026.
-- Sum all matching payments once per customer, including imported payments.
-- Compare that sum to CURRENT outstanding minus fees linked to the Sept 12
-- disconnections. If lower, discount only that sum; otherwise clear CURRENT
-- outstanding inclusive of fees. Never create an overpayment credit.
-- This is an additional corrective discount, not a reposting of receipts.
-- Earlier/unrelated charges remain part of the bill used for comparison.
-- Cleared accounts enter the reconnection queue; configured automation may
-- reconnect them after COMMIT.
-- A stable source_key prevents a second discount on rerun, even if reversed.

BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

-- Keep receipt edits, balance changes, and status transitions from racing the
-- preview/write. These locks briefly block writes; run during a quiet period.
LOCK TABLE public.customers, public.payments, public.account_status_history,
           public.account_ledger_entries, public.waiver_requests, public.reconnection_requests
    IN SHARE ROW EXCLUSIVE MODE;

CREATE TEMP TABLE sept12_discounts ON COMMIT DROP AS
WITH disconnections AS (
    SELECT customer_id,
           array_agg(account_status_history_id ORDER BY account_status_history_id) AS history_ids
    FROM public.account_status_history
    WHERE to_status = 'disconnected'
      AND from_status IS NOT NULL
      AND from_status <> 'disconnected'
      AND effective_date = DATE '2026-09-12'
    GROUP BY customer_id
), august_payments AS (
    SELECT customer_id, SUM(amount_paid)::NUMERIC(14,2) AS august_paid,
           array_agg(payment_id ORDER BY payment_id) AS payment_ids
    FROM public.payments
    WHERE voided_at IS NULL
      AND COALESCE(NULLIF(BTRIM(payment_type), ''), BTRIM(legacy_payment_type)) = 'Monthly Fee'
      AND payment_date >= DATE '2026-08-01'
      AND payment_date < DATE '2026-09-01'
      AND month_paid >= DATE '2026-08-01'
      AND month_paid < DATE '2026-09-01'
    GROUP BY customer_id
    HAVING SUM(amount_paid) > 0
), amounts AS (
    SELECT c.customer_id, c.name, c.status, c.activation_date,
           d.history_ids, p.payment_ids, p.august_paid,
           b.outstanding_balance,
           COALESCE(f.incident_fees, 0)::NUMERIC(14,2) AS incident_reconnection_fees,
           GREATEST(b.outstanding_balance - COALESCE(f.incident_fees, 0), 0)::NUMERIC(14,2)
               AS bill_excluding_incident_fees,
           'sept12-2026-august-discount:' || c.customer_id::TEXT AS correction_key
    FROM disconnections d
    JOIN public.customers c USING (customer_id)
    JOIN august_payments p USING (customer_id)
    JOIN public.customer_billing_status b USING (customer_id)
    LEFT JOIN LATERAL (
        SELECT SUM(e.amount) AS incident_fees
        FROM public.account_ledger_entries e
        WHERE e.customer_id = c.customer_id
          AND e.entry_type = 'reconnection_fee'
          AND e.source_key IN (
              SELECT 'reconnection-fee:status-history:' || h::TEXT
              FROM unnest(d.history_ids) AS ids(h)
          )
    ) f ON TRUE
    WHERE EXTRACT(DAY FROM c.activation_date) = 1
), calculated AS (
    SELECT *,
           CASE WHEN august_paid < bill_excluding_incident_fees
                THEN LEAST(august_paid, outstanding_balance)
                ELSE outstanding_balance END::NUMERIC(14,2) AS discount_amount,
           CASE WHEN august_paid < bill_excluding_incident_fees
                THEN 'Partial: subtract August payment total'
                ELSE 'Full: clear outstanding including reconnection fee' END AS decision
    FROM amounts
)
SELECT x.*,
       (outstanding_balance - discount_amount)::NUMERIC(14,2) AS expected_outstanding,
       EXISTS (SELECT 1 FROM public.account_ledger_entries e
               WHERE e.source_key = x.correction_key) AS already_corrected,
       'Billing correction'::TEXT AS correction_reason
FROM calculated x;

SELECT customer_id, name, status, activation_date, history_ids, payment_ids,
       august_paid, outstanding_balance, incident_reconnection_fees,
       bill_excluding_incident_fees, discount_amount, expected_outstanding,
       decision, already_corrected
FROM sept12_discounts ORDER BY customer_id;

CREATE TEMP TABLE sept12_applied ON COMMIT DROP AS
WITH inserted AS (
    INSERT INTO public.account_ledger_entries (
        customer_id, entry_type, amount, effective_date, description,
        reason, is_verified, source_key
    )
    SELECT customer_id, 'waiver', -discount_amount,
           (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
           'Billing correction',
           correction_reason, TRUE, correction_key
    FROM sept12_discounts
    WHERE discount_amount > 0 AND NOT already_corrected
    RETURNING account_ledger_entry_id, customer_id, amount, source_key
)
SELECT * FROM inserted;

INSERT INTO public.waiver_requests (
    customer_id, amount, reason, status, reviewed_at, review_note,
    waiver_ledger_entry_id, is_credit
)
SELECT a.customer_id, -a.amount, d.correction_reason, 'approved',
       CURRENT_TIMESTAMP, 'Billing correction',
       a.account_ledger_entry_id, FALSE
FROM sept12_applied a JOIN sept12_discounts d USING (customer_id);

-- No employee identity is invented for this maintenance script.
INSERT INTO public.audit_logs (
    actor_name, action, entity_type, entity_id, field_name,
    old_value, new_value, reason, source_key
)
SELECT 'SQL maintenance (management-requested)', 'Applied balance discount',
       'customer', a.customer_id::TEXT, 'outstanding_balance',
       d.outstanding_balance::TEXT, d.expected_outstanding::TEXT,
       d.correction_reason, a.source_key
FROM sept12_applied a JOIN sept12_discounts d USING (customer_id);

DO $verify$
BEGIN
    IF EXISTS (
        SELECT 1 FROM sept12_applied a
        JOIN sept12_discounts d USING (customer_id)
        JOIN public.customer_billing_status b USING (customer_id)
        WHERE b.balance <> d.expected_outstanding
    ) THEN
        RAISE EXCEPTION 'Balance verification failed; roll back this transaction.';
    END IF;
END $verify$;

SELECT a.customer_id, d.name, -a.amount AS discount_applied,
       b.outstanding_balance AS outstanding_after, b.ready_for_reconnection
FROM sept12_applied a
JOIN sept12_discounts d USING (customer_id)
JOIN public.customer_billing_status b USING (customer_id)
ORDER BY a.customer_id;

SELECT COUNT(*) AS accounts_adjusted, COALESCE(-SUM(amount), 0) AS total_discount
FROM sept12_applied;

-- Shorten only messages written by this correction, including prior runs.
UPDATE public.account_ledger_entries
SET description = 'Billing correction', reason = 'Billing correction'
WHERE source_key = 'sept12-2026-august-discount:' || customer_id::TEXT;

UPDATE public.waiver_requests w
SET reason = 'Billing correction', review_note = 'Billing correction'
FROM public.account_ledger_entries e
WHERE e.account_ledger_entry_id = w.waiver_ledger_entry_id
  AND e.source_key = 'sept12-2026-august-discount:' || e.customer_id::TEXT;

UPDATE public.audit_logs a
SET reason = 'Billing correction'
FROM public.account_ledger_entries e
WHERE a.source_key = e.source_key
  AND e.source_key = 'sept12-2026-august-discount:' || e.customer_id::TEXT;

-- Include discounts committed by the earlier script. Never apply money twice.
-- Match the app's approved-waiver flow: cleared balance -> reconnection queue.
CREATE TEMP TABLE sept12_queued ON COMMIT DROP AS
WITH moved AS (
    UPDATE public.customers c
    SET status = 'pending_reconnection'
    FROM public.customer_billing_status b
    WHERE b.customer_id = c.customer_id
      AND c.status = 'disconnected'
      AND b.ready_for_reconnection
      AND EXISTS (
          SELECT 1 FROM public.account_ledger_entries e
          JOIN public.waiver_requests w
            ON w.waiver_ledger_entry_id = e.account_ledger_entry_id
          WHERE e.customer_id = c.customer_id
            AND e.source_key = 'sept12-2026-august-discount:' || c.customer_id::TEXT
            AND w.status = 'approved'
      )
      -- Do not revive a subsequent, unrelated disconnection on a later rerun.
      AND (SELECT h.effective_date
           FROM public.account_status_history h
           WHERE h.customer_id = c.customer_id
           ORDER BY h.changed_at DESC, h.account_status_history_id DESC
           LIMIT 1) = DATE '2026-09-12'
      AND NOT EXISTS (
          SELECT 1 FROM public.account_status_history h
          WHERE h.source_key = 'sept12-2026-reconnection:' || c.customer_id::TEXT
      )
    RETURNING c.customer_id
), recorded AS (
    INSERT INTO public.account_status_history (
        customer_id, from_status, to_status, reason, source_key
    )
    SELECT customer_id, 'disconnected', 'pending_reconnection',
           'Balance cleared; awaiting reconnection',
           'sept12-2026-reconnection:' || customer_id::TEXT
    FROM moved
    RETURNING customer_id, account_status_history_id
)
SELECT * FROM recorded;

UPDATE public.reconnection_requests r
SET status = 'approved', reviewed_at = CURRENT_TIMESTAMP,
    review_note = 'Balance cleared',
    account_status_history_id = q.account_status_history_id
FROM sept12_queued q
WHERE r.customer_id = q.customer_id AND r.status = 'pending';

INSERT INTO public.audit_logs (
    actor_name, action, entity_type, entity_id, field_name,
    old_value, new_value, reason, source_key
)
SELECT 'SQL maintenance (management-requested)', 'Queued reconnection',
       'customer', customer_id::TEXT, 'status',
       'disconnected', 'pending_reconnection', 'Balance cleared',
       'sept12-2026-reconnection:' || customer_id::TEXT
FROM sept12_queued;

SELECT q.customer_id, c.name, c.status, b.outstanding_balance
FROM sept12_queued q
JOIN public.customers c USING (customer_id)
JOIN public.customer_billing_status b USING (customer_id)
ORDER BY q.customer_id;

-- Show all previously corrected accounts, including any still owing money.
SELECT c.customer_id, c.name, c.status, b.outstanding_balance
FROM public.customers c
JOIN public.customer_billing_status b USING (customer_id)
WHERE EXISTS (
    SELECT 1 FROM public.account_ledger_entries e
    WHERE e.customer_id = c.customer_id
      AND e.source_key = 'sept12-2026-august-discount:' || c.customer_id::TEXT
)
ORDER BY c.customer_id;

ROLLBACK;
