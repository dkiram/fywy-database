-- Persists one delayed configuration-save job per automatic run and affected
-- OLT. A process restart therefore cannot silently lose the two-hour save.
CREATE TABLE public.olt_automation_save_jobs (
    olt_automation_save_job_id BIGSERIAL PRIMARY KEY,
    olt_automation_run_id BIGINT NOT NULL
        REFERENCES public.olt_automation_runs(olt_automation_run_id)
        ON DELETE RESTRICT,
    management_ip INET NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'succeeded', 'failed')),
    attempt_count INTEGER NOT NULL DEFAULT 0
        CHECK (attempt_count BETWEEN 0 AND 3),
    next_attempt_at TIMESTAMPTZ NOT NULL,
    last_attempt_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (olt_automation_run_id, management_ip),
    CHECK (
        (status = 'pending' AND completed_at IS NULL)
        OR (status <> 'pending' AND completed_at IS NOT NULL)
    )
);

CREATE INDEX idx_olt_automation_save_jobs_due
ON public.olt_automation_save_jobs (next_attempt_at)
WHERE status = 'pending';

COMMENT ON TABLE public.olt_automation_save_jobs IS
  'One durable, delayed Huawei save per automatic run and affected OLT; retries are bounded to three attempts.';
