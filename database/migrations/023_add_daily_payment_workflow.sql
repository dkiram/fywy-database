-- Extends legacy payments with cashier ownership, branch scope, receipts, and daily indexes.
ALTER TABLE public.payments
ADD COLUMN IF NOT EXISTS recorded_by_employee_id BIGINT
    REFERENCES public.employees(employee_id)
    ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS location_id SMALLINT
    REFERENCES public.locations(location_id)
    ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS receipt_number TEXT,
ADD COLUMN IF NOT EXISTS note TEXT,
ADD COLUMN IF NOT EXISTS recorded_at TIMESTAMPTZ;

-- Only newly recorded payments receive an application-issued receipt number.
CREATE UNIQUE INDEX IF NOT EXISTS payments_receipt_number_unique
ON public.payments (receipt_number)
WHERE receipt_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payments_daily_operations
ON public.payments (payment_date DESC, location_id, recorded_at DESC)
WHERE recorded_by_employee_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payments_recorded_by_employee
ON public.payments (recorded_by_employee_id, recorded_at DESC)
WHERE recorded_by_employee_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payments_daily_ledger
ON public.payments (payment_date DESC, payment_id DESC);
