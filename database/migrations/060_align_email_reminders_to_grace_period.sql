-- The original reminder queue followed the separate scheduled-disconnection
-- calendar. The business rule is instead exact: notify five days after the
-- due date and five days before the ten-day grace period ends.
ALTER TABLE public.customer_email_notifications
    ADD COLUMN due_date DATE,
    ADD COLUMN grace_end_date DATE;

-- Preserve useful dates for any history already created by migration 059.
-- When the same unpaid charge is still current, use its authoritative ledger
-- dates; otherwise retain a conservative ten-day reconstruction.
UPDATE public.customer_email_notifications notification
SET due_date = billing.oldest_unpaid_due_date,
    grace_end_date = billing.grace_end_date
FROM public.customer_billing_status billing
WHERE billing.customer_id = notification.customer_id
  AND billing.scheduled_disconnection_date = notification.scheduled_disconnection_date
  AND billing.oldest_unpaid_due_date IS NOT NULL
  AND billing.grace_end_date IS NOT NULL;

UPDATE public.customer_email_notifications
SET due_date = COALESCE(due_date, scheduled_disconnection_date - 10),
    grace_end_date = COALESCE(grace_end_date, scheduled_disconnection_date);

-- Do not let rows queued under the superseded date rule send later with new
-- wording. The corrected daily scheduler will create only properly timed rows.
UPDATE public.customer_email_notifications
SET status = 'skipped_no_longer_eligible',
    last_error = 'Superseded by the five-days-before-grace-end reminder rule.',
    completed_at = CURRENT_TIMESTAMP
WHERE status IN ('pending', 'sending');

ALTER TABLE public.customer_email_notifications
    ALTER COLUMN due_date SET NOT NULL,
    ALTER COLUMN grace_end_date SET NOT NULL,
    DROP COLUMN scheduled_disconnection_date;
