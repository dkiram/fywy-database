-- A small number of legacy Huawei ONTs have descriptions that intentionally
-- differ from the customer name in SPCL. An administrator may pin the exact
-- live description after re-checking the location and serial. Live controls
-- must continue matching this pinned value; this is not a fuzzy-name bypass.
ALTER TABLE public.customer_ont_assignments
ADD COLUMN IF NOT EXISTS ont_description_override TEXT,
ADD COLUMN IF NOT EXISTS description_override_reason TEXT,
ADD COLUMN IF NOT EXISTS description_overridden_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS description_overridden_by_employee_id BIGINT
    REFERENCES public.employees(employee_id)
    ON DELETE SET NULL;

ALTER TABLE public.customer_ont_assignments
DROP CONSTRAINT IF EXISTS chk_customer_ont_description_override;

ALTER TABLE public.customer_ont_assignments
ADD CONSTRAINT chk_customer_ont_description_override CHECK (
    (
        ont_description_override IS NULL
        AND description_override_reason IS NULL
        AND description_overridden_at IS NULL
        AND description_overridden_by_employee_id IS NULL
    )
    OR
    (
        ont_description_override IS NOT NULL
        AND LENGTH(TRIM(ont_description_override)) BETWEEN 1 AND 500
        AND description_override_reason IS NOT NULL
        AND LENGTH(TRIM(description_override_reason)) BETWEEN 3 AND 500
        AND description_overridden_at IS NOT NULL
    )
);

COMMENT ON COLUMN public.customer_ont_assignments.ont_description_override IS
'Exact live Huawei ONT description accepted after serial/location verification; never a fuzzy-name bypass.';

COMMENT ON COLUMN public.customer_ont_assignments.description_override_reason IS
'Required staff or controlled-batch justification for accepting a differing Huawei description.';
