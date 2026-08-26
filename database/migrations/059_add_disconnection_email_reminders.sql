-- Durable queue for the five-day email warning. Queue creation and delivery
-- are separate so an API restart or Gmail outage never loses the reminder,
-- and the unique key prevents duplicate warnings for the same disconnect date.
CREATE TABLE public.customer_email_notification_runs (
    customer_email_notification_run_id BIGSERIAL PRIMARY KEY,
    notification_type TEXT NOT NULL
        CHECK (notification_type IN ('disconnection_5_day')),
    billing_date DATE NOT NULL,
    status TEXT NOT NULL DEFAULT 'running'
        CHECK (status IN ('running', 'completed', 'failed')),
    candidate_count INTEGER NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
    queued_count INTEGER NOT NULL DEFAULT 0 CHECK (queued_count >= 0),
    skipped_count INTEGER NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
    error_message TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMPTZ,
    UNIQUE (notification_type, billing_date),
    CHECK (
        (status = 'running' AND completed_at IS NULL)
        OR (status <> 'running' AND completed_at IS NOT NULL)
    )
);

CREATE TABLE public.customer_email_notifications (
    customer_email_notification_id BIGSERIAL PRIMARY KEY,
    customer_email_notification_run_id BIGINT NOT NULL
        REFERENCES public.customer_email_notification_runs(customer_email_notification_run_id)
        ON DELETE RESTRICT,
    customer_id INTEGER NOT NULL
        REFERENCES public.customers(customer_id)
        ON DELETE RESTRICT,
    notification_type TEXT NOT NULL
        CHECK (notification_type IN ('disconnection_5_day')),
    deduplication_key TEXT NOT NULL UNIQUE,
    recipient_email TEXT,
    scheduled_disconnection_date DATE NOT NULL,
    outstanding_balance NUMERIC(14,2) NOT NULL CHECK (outstanding_balance > 0),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN (
            'pending', 'sending', 'sent', 'failed',
            'skipped_no_email', 'skipped_no_longer_eligible'
        )),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    provider_message_id TEXT,
    last_error TEXT,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    queued_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_attempted_at TIMESTAMPTZ,
    sent_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
);

CREATE INDEX idx_customer_email_notifications_queue
ON public.customer_email_notifications (next_attempt_at, customer_email_notification_id)
WHERE status = 'pending';

CREATE INDEX idx_customer_email_notifications_customer
ON public.customer_email_notifications (customer_id, queued_at DESC);

CREATE INDEX idx_customer_email_notifications_sent
ON public.customer_email_notifications (sent_at)
WHERE status = 'sent';

COMMENT ON TABLE public.customer_email_notifications IS
  'Auditable, idempotent email queue for billing and service notifications.';
