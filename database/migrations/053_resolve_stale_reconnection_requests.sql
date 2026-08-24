-- Older unpaid reconnection requests could remain pending after a payment,
-- waiver, or confirmed reconnection moved the customer out of disconnected.
-- Link those requests to the status transition that made Admin review moot.
WITH stale_requests AS (
    SELECT
        request.reconnection_request_id,
        history.account_status_history_id,
        history.changed_by_employee_id,
        history.changed_at
    FROM public.reconnection_requests request
    JOIN public.customers customer
      ON customer.customer_id = request.customer_id
    JOIN LATERAL (
        SELECT
            status_history.account_status_history_id,
            status_history.changed_by_employee_id,
            status_history.changed_at
        FROM public.account_status_history status_history
        WHERE status_history.customer_id = request.customer_id
          AND status_history.to_status IN ('pending_reconnection', 'active')
        ORDER BY
            status_history.changed_at DESC,
            status_history.account_status_history_id DESC
        LIMIT 1
    ) history ON TRUE
    WHERE request.status = 'pending'
      AND customer.status IN ('pending_reconnection', 'active')
)
UPDATE public.reconnection_requests request
SET status = 'approved',
    reviewed_by_employee_id = stale.changed_by_employee_id,
    reviewed_at = stale.changed_at,
    review_note = 'Automatically resolved because the account had already left disconnected status.',
    account_status_history_id = stale.account_status_history_id
FROM stale_requests stale
WHERE request.reconnection_request_id = stale.reconnection_request_id;

-- Any non-disconnected orphan without a usable transition row should never
-- remain actionable. Close it instead of allowing it to block a future request.
UPDATE public.reconnection_requests request
SET status = 'rejected',
    reviewed_at = CURRENT_TIMESTAMP,
    review_note = 'Automatically closed because the account is no longer disconnected.'
FROM public.customers customer
WHERE customer.customer_id = request.customer_id
  AND request.status = 'pending'
  AND customer.status <> 'disconnected';
