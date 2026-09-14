-- Repair discounts already committed by discount-sept12-disconnections-2026.sql.
-- No new discounts: shorten messages and queue cleared disconnected accounts.
-- Run the whole file. ROLLBACK previews; change to COMMIT to save.
-- Configured reconnection automation may process queued accounts after COMMIT.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';
LOCK TABLE public.customers, public.payments, public.account_status_history,
           public.account_ledger_entries, public.waiver_requests, public.reconnection_requests
    IN SHARE ROW EXCLUSIVE MODE;

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
