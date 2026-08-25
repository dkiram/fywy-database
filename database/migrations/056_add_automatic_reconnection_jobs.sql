-- Durable queue for unattended reconnection of fully cleared accounts. One
-- job belongs to one transition into pending_reconnection, so restarts cannot
-- lose work and a permanently failed attempt is not recreated every minute.
CREATE TABLE public.olt_reconnection_automation_jobs (
    olt_reconnection_automation_job_id BIGSERIAL PRIMARY KEY,
    customer_id INTEGER NOT NULL
        REFERENCES public.customers(customer_id)
        ON DELETE RESTRICT,
    pending_status_history_id BIGINT NOT NULL UNIQUE
        REFERENCES public.account_status_history(account_status_history_id)
        ON DELETE RESTRICT,
    olt_action_attempt_id BIGINT
        REFERENCES public.olt_action_attempts(olt_action_attempt_id)
        ON DELETE RESTRICT,

    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN (
            'pending', 'waiting_balance', 'blocked_mapping', 'blocked_policy',
            'blocked_action', 'blocked_identity', 'succeeded', 'failed',
            'uncertain', 'cancelled'
        )),
    attempt_count INTEGER NOT NULL DEFAULT 0
        CHECK (attempt_count BETWEEN 0 AND 3),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_attempt_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    message TEXT,

    -- A confirmed activation changes running configuration. Saving is delayed
    -- and retried independently so save failure can never undo or block the
    -- already-confirmed customer reconnection.
    management_ip INET,
    save_status TEXT NOT NULL DEFAULT 'not_needed'
        CHECK (save_status IN ('not_needed', 'pending', 'succeeded', 'failed')),
    save_attempt_count INTEGER NOT NULL DEFAULT 0
        CHECK (save_attempt_count BETWEEN 0 AND 3),
    save_next_attempt_at TIMESTAMPTZ,
    save_last_attempt_at TIMESTAMPTZ,
    save_completed_at TIMESTAMPTZ,
    save_error_message TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (
        (status IN ('succeeded', 'failed', 'uncertain', 'cancelled') AND completed_at IS NOT NULL)
        OR (status NOT IN ('succeeded', 'failed', 'uncertain', 'cancelled') AND completed_at IS NULL)
    ),
    CHECK (
        (save_status = 'pending' AND save_next_attempt_at IS NOT NULL AND save_completed_at IS NULL)
        OR (save_status IN ('succeeded', 'failed') AND save_completed_at IS NOT NULL)
        OR (save_status = 'not_needed' AND save_completed_at IS NULL)
    )
);

CREATE INDEX idx_olt_reconnection_automation_jobs_due
ON public.olt_reconnection_automation_jobs (next_attempt_at)
WHERE status = 'pending';

CREATE INDEX idx_olt_reconnection_automation_saves_due
ON public.olt_reconnection_automation_jobs (save_next_attempt_at)
WHERE save_status = 'pending';

CREATE INDEX idx_olt_reconnection_automation_customer
ON public.olt_reconnection_automation_jobs (customer_id, created_at DESC);

COMMENT ON TABLE public.olt_reconnection_automation_jobs IS
  'Durable automatic reconnect queue for fully cleared pending accounts, including independent delayed Huawei saves.';
