-- Adds permanent, dated notes to a customer's account timeline.
--
-- The note date is separate from created_at: staff sometimes enter a request
-- after the day it was received, while created_at still preserves when the
-- system entry was actually made.
CREATE TABLE IF NOT EXISTS public.customer_notes (
    customer_note_id BIGSERIAL PRIMARY KEY,

    customer_id INTEGER NOT NULL
        REFERENCES public.customers(customer_id)
        ON DELETE RESTRICT,

    note_date DATE NOT NULL DEFAULT
        ((CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE),

    note TEXT NOT NULL,

    created_by_employee_id BIGINT
        REFERENCES public.employees(employee_id)
        ON DELETE SET NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CHECK (LENGTH(TRIM(note)) BETWEEN 3 AND 2000)
);

CREATE INDEX IF NOT EXISTS idx_customer_notes_customer_timeline
ON public.customer_notes (customer_id, note_date DESC, created_at DESC);
