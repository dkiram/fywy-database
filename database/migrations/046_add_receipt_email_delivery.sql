-- Records how each newly issued receipt was handed to the customer and keeps
-- every email attempt for audit/retry purposes. Email delivery is deliberately
-- separate from the payment transaction: money remains recorded if Gmail is
-- unavailable, and the failed attempt becomes the cashier's print fallback.
ALTER TABLE public.payments
ADD COLUMN IF NOT EXISTS receipt_delivery_method TEXT NOT NULL DEFAULT 'physical';

ALTER TABLE public.payments
DROP CONSTRAINT IF EXISTS payments_receipt_delivery_method_check;

ALTER TABLE public.payments
ADD CONSTRAINT payments_receipt_delivery_method_check
CHECK (receipt_delivery_method IN ('physical', 'email'));

CREATE TABLE IF NOT EXISTS public.receipt_email_deliveries (
    receipt_email_delivery_id BIGSERIAL PRIMARY KEY,
    payment_id BIGINT NOT NULL
        REFERENCES public.payments(payment_id)
        ON DELETE CASCADE,
    recipient_email TEXT NOT NULL,
    requested_by_employee_id BIGINT
        REFERENCES public.employees(employee_id)
        ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
    attempt_count INTEGER NOT NULL DEFAULT 0
        CHECK (attempt_count >= 0),
    provider_message_id TEXT,
    last_error TEXT,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_attempted_at TIMESTAMPTZ,
    sent_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_receipt_email_deliveries_payment
ON public.receipt_email_deliveries
    (payment_id, receipt_email_delivery_id DESC);

CREATE INDEX IF NOT EXISTS idx_receipt_email_deliveries_pending
ON public.receipt_email_deliveries
    (requested_at, receipt_email_delivery_id)
WHERE status IN ('pending', 'sending');
