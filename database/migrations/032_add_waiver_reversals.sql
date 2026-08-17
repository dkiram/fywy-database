-- Admins may reverse an approved discount without deleting financial or audit
-- history. A positive adjustment restores the exact amount previously waived.
ALTER TABLE public.waiver_requests
ADD COLUMN IF NOT EXISTS reversed_by_employee_id BIGINT
    REFERENCES public.employees(employee_id)
    ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS reversal_note TEXT,
ADD COLUMN IF NOT EXISTS reversal_ledger_entry_id BIGINT
    REFERENCES public.account_ledger_entries(account_ledger_entry_id)
    ON DELETE RESTRICT;

ALTER TABLE public.waiver_requests
DROP CONSTRAINT IF EXISTS waiver_requests_status_check,
DROP CONSTRAINT IF EXISTS waiver_requests_check;

ALTER TABLE public.waiver_requests
ADD CONSTRAINT waiver_requests_status_check
CHECK (status IN ('pending', 'approved', 'rejected', 'reversed')),
ADD CONSTRAINT waiver_requests_reversal_note_check
CHECK (
    reversal_note IS NULL
    OR LENGTH(TRIM(reversal_note)) BETWEEN 3 AND 500
),
ADD CONSTRAINT waiver_requests_state_check
CHECK (
    (status = 'pending'
        AND reviewed_at IS NULL
        AND waiver_ledger_entry_id IS NULL
        AND reversed_at IS NULL
        AND reversal_ledger_entry_id IS NULL)
    OR (status = 'approved'
        AND reviewed_at IS NOT NULL
        AND waiver_ledger_entry_id IS NOT NULL
        AND reversed_at IS NULL
        AND reversal_ledger_entry_id IS NULL)
    OR (status = 'rejected'
        AND reviewed_at IS NOT NULL
        AND waiver_ledger_entry_id IS NULL
        AND reversed_at IS NULL
        AND reversal_ledger_entry_id IS NULL)
    OR (status = 'reversed'
        AND reviewed_at IS NOT NULL
        AND waiver_ledger_entry_id IS NOT NULL
        AND reversed_at IS NOT NULL
        AND reversal_ledger_entry_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_waiver_requests_reversible
ON public.waiver_requests (customer_id, reviewed_at DESC)
WHERE status = 'approved';
