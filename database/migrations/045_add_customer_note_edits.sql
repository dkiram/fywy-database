-- Records who last edited a customer note without changing its original
-- author or creation timestamp. The audit log keeps the full before/after
-- values for every edit; these columns provide the current edit metadata.
ALTER TABLE public.customer_notes
ADD COLUMN IF NOT EXISTS updated_by_employee_id BIGINT
    REFERENCES public.employees(employee_id)
    ON DELETE SET NULL;

ALTER TABLE public.customer_notes
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
