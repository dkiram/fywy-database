-- Unpaid accounts require an explicit Admin decision before they can enter the
-- pending-reconnection queue. Approval never bypasses the final balance check.
CREATE TABLE IF NOT EXISTS public.reconnection_requests (
    reconnection_request_id BIGSERIAL PRIMARY KEY,

    customer_id INTEGER NOT NULL
        REFERENCES public.customers(customer_id)
        ON DELETE RESTRICT,
    outstanding_balance_snapshot NUMERIC(14,2) NOT NULL
        CHECK (outstanding_balance_snapshot > 0),
    reason TEXT NOT NULL CHECK (LENGTH(TRIM(reason)) BETWEEN 3 AND 500),

    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'rejected')),

    requested_by_employee_id BIGINT
        REFERENCES public.employees(employee_id)
        ON DELETE SET NULL,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    reviewed_by_employee_id BIGINT
        REFERENCES public.employees(employee_id)
        ON DELETE SET NULL,
    reviewed_at TIMESTAMPTZ,
    review_note TEXT,

    account_status_history_id BIGINT
        REFERENCES public.account_status_history(account_status_history_id)
        ON DELETE RESTRICT,

    CHECK (review_note IS NULL OR LENGTH(TRIM(review_note)) BETWEEN 3 AND 500),
    CHECK (
        (status = 'pending' AND reviewed_at IS NULL AND account_status_history_id IS NULL)
        OR (status = 'approved' AND reviewed_at IS NOT NULL AND account_status_history_id IS NOT NULL)
        OR (status = 'rejected' AND reviewed_at IS NOT NULL AND account_status_history_id IS NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS reconnection_requests_one_pending_per_customer
ON public.reconnection_requests (customer_id)
WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_reconnection_requests_admin_queue
ON public.reconnection_requests (status, requested_at);
