-- The first live reminder run could not read its embedded logo because the NAS
-- checkout's restrictive umask reached the Docker image. No affected message
-- reached Gmail. Retry today's unsent queue after the corrected image starts;
-- sent and skipped rows are deliberately untouched.
UPDATE public.customer_email_notifications notification
SET status = 'pending',
    attempt_count = 0,
    provider_message_id = NULL,
    last_error = NULL,
    next_attempt_at = CURRENT_TIMESTAMP + INTERVAL '2 minutes',
    last_attempted_at = NULL,
    completed_at = NULL
FROM public.customer_email_notification_runs run
WHERE run.customer_email_notification_run_id =
      notification.customer_email_notification_run_id
  AND run.notification_type = 'disconnection_5_day'
  AND run.billing_date =
      (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE
  AND notification.sent_at IS NULL
  AND notification.status IN ('pending', 'sending', 'failed');
