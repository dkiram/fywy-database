-- One-time Admin approval codes prevent undocumented balance discounts.
-- Codes are bound to one customer, exact amount, and reason; only salted
-- hashes are stored, and successful use consumes the approval permanently.
CREATE TABLE IF NOT EXISTS public.waiver_approval_codes (
    waiver_approval_code_id BIGSERIAL PRIMARY KEY,

    customer_id INTEGER NOT NULL
        REFERENCES public.customers(customer_id)
        ON DELETE RESTRICT,

    amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
    reason TEXT NOT NULL CHECK (LENGTH(TRIM(reason)) BETWEEN 3 AND 500),

    code_hash TEXT NOT NULL,
    code_salt TEXT NOT NULL,
    failed_attempts INTEGER NOT NULL DEFAULT 0
        CHECK (failed_attempts BETWEEN 0 AND 5),

    created_by_employee_id BIGINT
        REFERENCES public.employees(employee_id)
        ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMPTZ NOT NULL,

    consumed_by_employee_id BIGINT
        REFERENCES public.employees(employee_id)
        ON DELETE SET NULL,
    consumed_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,

    CHECK (expires_at > created_at),
    CHECK (
        (consumed_at IS NULL AND consumed_by_employee_id IS NULL)
        OR consumed_at IS NOT NULL
    )
);

CREATE INDEX IF NOT EXISTS idx_waiver_approval_codes_active
ON public.waiver_approval_codes (customer_id, amount, expires_at DESC)
WHERE consumed_at IS NULL AND revoked_at IS NULL;
