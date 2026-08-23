-- Keeps Gmail's own words when a receipt email fails.
--
-- last_error holds the sentence shown to the cashier, which is deliberately
-- vague - "Gmail could not send the receipt" is all a counter can act on. But
-- that sanitised sentence was also the only thing written to the row and to
-- the server log, so nobody could tell a rejected From address from a disabled
-- Gmail API from an expired refresh token. All three produced identical
-- evidence, and the only way to investigate was to guess.
--
-- last_error_detail keeps the raw provider response beside it: status code,
-- message and reason, exactly as Google returned them. It is never shown to
-- the cashier; it is here so an admin can read it in TablePlus, or so a future
-- admin screen can surface it, without changing what the counter sees.
ALTER TABLE public.receipt_email_deliveries
ADD COLUMN IF NOT EXISTS last_error_detail TEXT;

COMMENT ON COLUMN public.receipt_email_deliveries.last_error IS
    'Cashier-facing failure message. Safe to display at a counter.';

COMMENT ON COLUMN public.receipt_email_deliveries.last_error_detail IS
    'Raw Gmail/provider error (status, message, reason). Admin diagnostics only - never display to customers or counter staff.';

-- Recent failures, newest first, with the real reason:
--   SELECT receipt_email_delivery_id, payment_id, recipient_email,
--          attempt_count, last_attempted_at, last_error_detail
--     FROM public.receipt_email_deliveries
--    WHERE status = 'failed'
--    ORDER BY receipt_email_delivery_id DESC
--    LIMIT 20;
CREATE INDEX IF NOT EXISTS idx_receipt_email_deliveries_failed
ON public.receipt_email_deliveries (receipt_email_delivery_id DESC)
WHERE status = 'failed';
