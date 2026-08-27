-- Version reminder-run eligibility so a completed empty run can be evaluated
-- once more when a filter changes. Existing runs used version 1. The worker
-- now uses version 2, which allows unverified ledger entries to receive the
-- no-balance reminder while retaining all other eligibility checks.
ALTER TABLE public.customer_email_notification_runs
    ADD COLUMN eligibility_version INTEGER NOT NULL DEFAULT 1
        CHECK (eligibility_version > 0);
