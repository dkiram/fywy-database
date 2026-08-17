-- Preserve accidental payments for audit while removing them from balances and
-- collection totals. A void is an immutable reversal, never a destructive delete.

ALTER TABLE public.payments
ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS voided_by_employee_id BIGINT
    REFERENCES public.employees(employee_id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS void_reason TEXT;

-- A payment is either fully active or has all required void evidence.
ALTER TABLE public.payments
DROP CONSTRAINT IF EXISTS payments_void_evidence_check;

ALTER TABLE public.payments
ADD CONSTRAINT payments_void_evidence_check CHECK (
    (voided_at IS NULL AND voided_by_employee_id IS NULL AND void_reason IS NULL)
    OR
    (voided_at IS NOT NULL AND voided_by_employee_id IS NOT NULL
        AND LENGTH(TRIM(COALESCE(void_reason, ''))) >= 3)
);

-- Active-only indexes keep daily totals fast even as voided audit rows remain.
CREATE INDEX IF NOT EXISTS idx_payments_active_daily
ON public.payments (payment_date DESC, location_id, payment_id DESC)
WHERE voided_at IS NULL;

-- Add an explicit ledger type so payment reversals are understandable without
-- deleting or mutating the original negative payment entry.
ALTER TABLE public.account_ledger_entries
DROP CONSTRAINT IF EXISTS account_ledger_entries_entry_type_check;

ALTER TABLE public.account_ledger_entries
ADD CONSTRAINT account_ledger_entries_entry_type_check CHECK (entry_type IN (
    'opening_balance', 'monthly_charge', 'monthly_payment',
    'reconnection_fee', 'reconnection_payment', 'payment_void',
    'waiver', 'adjustment'
));
