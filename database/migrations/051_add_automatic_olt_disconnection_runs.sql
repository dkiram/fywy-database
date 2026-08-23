-- Durable record of every scheduled delinquency-disconnection run, including
-- candidates that were safely skipped before any Huawei command was sent.
CREATE TABLE public.olt_automation_runs (
    olt_automation_run_id BIGSERIAL PRIMARY KEY,
    billing_date DATE NOT NULL,
    status TEXT NOT NULL DEFAULT 'running'
        CHECK (status IN ('running', 'completed', 'failed')),
    candidate_count INTEGER NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
    selected_count INTEGER NOT NULL DEFAULT 0 CHECK (selected_count >= 0),
    disconnected_count INTEGER NOT NULL DEFAULT 0 CHECK (disconnected_count >= 0),
    skipped_count INTEGER NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
    failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
    remaining_count INTEGER NOT NULL DEFAULT 0 CHECK (remaining_count >= 0),
    error_message TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMPTZ,
    CHECK (
        (status = 'running' AND completed_at IS NULL)
        OR (status <> 'running' AND completed_at IS NOT NULL)
    )
);

CREATE INDEX idx_olt_automation_runs_started
ON public.olt_automation_runs (started_at DESC);

CREATE TABLE public.olt_automation_run_items (
    olt_automation_run_item_id BIGSERIAL PRIMARY KEY,
    olt_automation_run_id BIGINT NOT NULL
        REFERENCES public.olt_automation_runs(olt_automation_run_id)
        ON DELETE RESTRICT,
    customer_id INTEGER NOT NULL
        REFERENCES public.customers(customer_id)
        ON DELETE RESTRICT,
    customer_ont_assignment_id BIGINT
        REFERENCES public.customer_ont_assignments(customer_ont_assignment_id)
        ON DELETE RESTRICT,
    olt_action_attempt_id BIGINT
        REFERENCES public.olt_action_attempts(olt_action_attempt_id)
        ON DELETE RESTRICT,
    outcome TEXT NOT NULL DEFAULT 'pending'
        CHECK (outcome IN (
            'pending', 'disconnected', 'already_deactivated',
            'skipped_mapping', 'skipped_not_eligible', 'skipped_unresolved',
            'failed', 'uncertain'
        )),
    outstanding_balance NUMERIC(14,2),
    scheduled_disconnection_date DATE,
    message TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMPTZ,
    UNIQUE (olt_automation_run_id, customer_id),
    CHECK (
        (outcome = 'pending' AND completed_at IS NULL)
        OR (outcome <> 'pending' AND completed_at IS NOT NULL)
    )
);

CREATE INDEX idx_olt_automation_items_customer
ON public.olt_automation_run_items (customer_id, started_at DESC);

COMMENT ON TABLE public.olt_automation_runs IS
  'One durable summary per scheduled automatic delinquent-customer OLT disconnection run.';
COMMENT ON TABLE public.olt_automation_run_items IS
  'Per-customer result, including safe skips where no Huawei write was attempted.';
