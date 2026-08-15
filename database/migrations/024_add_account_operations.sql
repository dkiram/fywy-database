-- This migration introduces the durable account lifecycle used by the operations queue.
-- MVP 3: durable customer account-status history.
-- The customers.status column remains the current snapshot; this table keeps
-- the immutable timeline needed for account operations and audit review.
CREATE TABLE IF NOT EXISTS public.account_status_history (
    account_status_history_id BIGSERIAL PRIMARY KEY,

    -- RESTRICT protects history from accidental customer deletion.
    customer_id INTEGER NOT NULL
        REFERENCES public.customers(customer_id)
        ON DELETE RESTRICT,

    from_status TEXT,
    to_status TEXT NOT NULL,

    reason TEXT NOT NULL,
    effective_date DATE NOT NULL DEFAULT
        ((CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE),

    -- Employee/application links may become NULL later without removing the
    -- historical event itself.
    changed_by_employee_id BIGINT
        REFERENCES public.employees(employee_id)
        ON DELETE SET NULL,

    application_id BIGINT
        REFERENCES public.applications(application_id)
        ON DELETE SET NULL,

    changed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Used by the idempotent legacy backfill below.
    source_key TEXT UNIQUE,

    CHECK (
        from_status IS NULL
        OR from_status IN (
            'active',
            'disconnected',
            'pending_reconnection',
            'closed',
            'archived'
        )
    ),

    CHECK (
        to_status IN (
            'active',
            'disconnected',
            'pending_reconnection',
            'closed',
            'archived'
        )
    ),

    CHECK (LENGTH(TRIM(reason)) >= 3)
);

CREATE INDEX IF NOT EXISTS idx_account_status_history_customer
ON public.account_status_history (customer_id, changed_at DESC);

-- Supports status/date reporting without scanning the whole history table.
CREATE INDEX IF NOT EXISTS idx_account_status_history_status
ON public.account_status_history (to_status, effective_date DESC);

-- Seed one clearly labelled snapshot for every imported customer. This does
-- not invent past transitions; it records only the status known at migration
-- time. ON CONFLICT makes the migration safe to run more than once.
INSERT INTO public.account_status_history (
    customer_id,
    from_status,
    to_status,
    reason,
    effective_date,
    changed_by_employee_id,
    application_id,
    changed_at,
    source_key
)
SELECT
    c.customer_id,
    NULL,
    c.status,
    'Imported legacy current account status',
    COALESCE(
        CASE
            WHEN c.status = 'disconnected' THEN c.deactivation_date
            WHEN c.status = 'active' THEN c.reactivation_date
            ELSE NULL
        END,
        c.activation_date,
        c.application_date,
        c.created_at::DATE
    ),
    NULL,
    NULL,
    c.created_at,
    'legacy-current-status:' || c.customer_id::TEXT
FROM public.customers c
ON CONFLICT (source_key) DO NOTHING;
