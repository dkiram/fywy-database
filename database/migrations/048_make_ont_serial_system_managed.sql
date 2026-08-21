-- Staff only need the Huawei location tuple when entering a customer mapping.
-- The ONT serial is still useful as a safety check, but it will be populated
-- later by the U2000 importer or live CLI verification instead of by hand.
ALTER TABLE public.customer_ont_assignments
ALTER COLUMN ont_serial DROP NOT NULL;

-- PostgreSQL normally permits multiple NULLs in a unique index. Making the
-- condition explicit documents that uniqueness applies only after a serial
-- has been discovered by an import or verification.
DROP INDEX IF EXISTS public.uq_customer_ont_assignments_current_serial;

CREATE UNIQUE INDEX uq_customer_ont_assignments_current_serial
ON public.customer_ont_assignments (UPPER(TRIM(ont_serial)))
WHERE ended_at IS NULL AND ont_serial IS NOT NULL;

COMMENT ON COLUMN public.customer_ont_assignments.ont_serial IS
'System-managed safety identifier populated by U2000 import or CLI verification; not entered by staff.';
