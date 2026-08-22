-- Durable journal for every requested Huawei ONT activation/deactivation.
-- A row is committed before the OLT is contacted, so a process crash cannot
-- erase the fact that a potentially state-changing operation was attempted.
CREATE TABLE IF NOT EXISTS public.olt_action_attempts (
    olt_action_attempt_id BIGSERIAL PRIMARY KEY,

    customer_id INTEGER NOT NULL
        REFERENCES public.customers(customer_id)
        ON DELETE RESTRICT,
    customer_ont_assignment_id BIGINT NOT NULL
        REFERENCES public.customer_ont_assignments(customer_ont_assignment_id)
        ON DELETE RESTRICT,
    requested_by_employee_id BIGINT
        REFERENCES public.employees(employee_id)
        ON DELETE SET NULL,

    action TEXT NOT NULL CHECK (action IN ('deactivate', 'activate')),
    outcome TEXT NOT NULL DEFAULT 'requested'
        CHECK (outcome IN (
            'requested', 'succeeded', 'no_change', 'blocked', 'failed', 'uncertain'
        )),
    reason TEXT NOT NULL CHECK (LENGTH(TRIM(reason)) BETWEEN 3 AND 500),

    -- Snapshot the exact safety identity and location used for this attempt.
    management_ip INET NOT NULL,
    frame_number SMALLINT NOT NULL CHECK (frame_number BETWEEN 0 AND 255),
    slot_number SMALLINT NOT NULL CHECK (slot_number BETWEEN 0 AND 255),
    pon_port_number SMALLINT NOT NULL CHECK (pon_port_number BETWEEN 0 AND 255),
    ont_id INTEGER NOT NULL CHECK (ont_id BETWEEN 0 AND 4095),
    expected_ont_serial TEXT NOT NULL,

    before_control_flag TEXT,
    before_run_state TEXT,
    after_control_flag TEXT,
    after_run_state TEXT,
    result_message TEXT,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMPTZ,

    CHECK (
        (outcome = 'requested' AND completed_at IS NULL)
        OR (outcome <> 'requested' AND completed_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_olt_action_attempts_customer
ON public.olt_action_attempts (customer_id, requested_at DESC);

CREATE INDEX IF NOT EXISTS idx_olt_action_attempts_unresolved
ON public.olt_action_attempts (requested_at)
WHERE outcome IN ('requested', 'uncertain');

-- Prevent two API processes from starting the same ONT action concurrently.
CREATE UNIQUE INDEX IF NOT EXISTS uq_olt_action_attempts_one_requested
ON public.olt_action_attempts (customer_ont_assignment_id)
WHERE outcome = 'requested';
