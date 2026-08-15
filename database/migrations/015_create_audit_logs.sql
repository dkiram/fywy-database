-- Creates the immutable activity trail and seeds one representative legacy action.
CREATE TABLE IF NOT EXISTS public.audit_logs (
    audit_log_id BIGSERIAL PRIMARY KEY,

    employee_id BIGINT
        REFERENCES public.employees(employee_id)
        ON DELETE SET NULL,

    -- Keep a snapshot so old audit records remain understandable even if an
    -- employee's name changes later.
    actor_name TEXT NOT NULL,
    action TEXT NOT NULL,

    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    field_name TEXT,

    old_value TEXT,
    new_value TEXT,

    occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- Optional stable identifier for imported or seeded audit entries.
    source_key TEXT UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_occurred_at
ON public.audit_logs (occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_entity
ON public.audit_logs (entity_type, entity_id);

INSERT INTO public.audit_logs (
    employee_id,
    actor_name,
    action,
    entity_type,
    entity_id,
    field_name,
    old_value,
    new_value,
    occurred_at,
    source_key
)
VALUES (
    (
        SELECT employee_id
        FROM public.employees
        WHERE LOWER(username) = 'headoffice'
        LIMIT 1
    ),
    'Dev Head Office',
    'Changed customer monthly rate',
    'customer',
    '1500',
    'monthly_fee',
    '2500',
    '3000',
    TIMESTAMPTZ '2026-08-14 18:44:00-04',
    'seed-customer-1500-monthly-rate-2026-08-14'
)
ON CONFLICT (source_key) DO NOTHING;
