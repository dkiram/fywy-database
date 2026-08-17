-- Replace relayed PINs with an in-app, two-person discount approval workflow.
CREATE TABLE IF NOT EXISTS public.waiver_requests (
    waiver_request_id BIGSERIAL PRIMARY KEY,

    customer_id INTEGER NOT NULL
        REFERENCES public.customers(customer_id)
        ON DELETE RESTRICT,
    amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
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

    waiver_ledger_entry_id BIGINT
        REFERENCES public.account_ledger_entries(account_ledger_entry_id)
        ON DELETE RESTRICT,

    CHECK (review_note IS NULL OR LENGTH(TRIM(review_note)) BETWEEN 3 AND 500),
    CHECK (
        (status = 'pending' AND reviewed_at IS NULL AND waiver_ledger_entry_id IS NULL)
        OR (status = 'approved' AND reviewed_at IS NOT NULL AND waiver_ledger_entry_id IS NOT NULL)
        OR (status = 'rejected' AND reviewed_at IS NOT NULL AND waiver_ledger_entry_id IS NULL)
    )
);

-- Only one unresolved request is needed per customer. A new request can be
-- submitted after the existing one is approved or rejected.
CREATE UNIQUE INDEX IF NOT EXISTS waiver_requests_one_pending_per_customer
ON public.waiver_requests (customer_id)
WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_waiver_requests_admin_queue
ON public.waiver_requests (status, requested_at);

-- Migration 029 was deployed locally but no approval codes were issued. Code
-- approvals are intentionally invalidated when this queue-based policy lands.
DROP TABLE IF EXISTS public.waiver_approval_codes;
