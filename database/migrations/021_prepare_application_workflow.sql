-- Adds workflow prerequisites, backfills legacy card data, and prepares customer ID generation.
ALTER TABLE public.applications
ADD COLUMN IF NOT EXISTS legacy_card_number TEXT;

-- Recover card numbers from the exact staging row that produced each application.
UPDATE public.applications a
SET legacy_card_number = NULLIF(TRIM(source.card_number), '')
FROM (
    SELECT
        'ApplicationTBL'::TEXT AS legacy_source,
        staging_id AS source_staging_id,
        card_number
    FROM staging.applications_current

    UNION ALL

    SELECT
        'Copy of ApplicationTBL'::TEXT AS legacy_source,
        staging_id AS source_staging_id,
        card_number
    FROM staging.applications_copy
) source
WHERE a.legacy_source = source.legacy_source
  AND a.source_staging_id = source.source_staging_id
  AND a.legacy_card_number IS NULL;

CREATE SEQUENCE IF NOT EXISTS public.customer_id_seq AS INTEGER;

-- Continue above the highest migrated customer ID when servicing a new application.
SELECT SETVAL(
    'public.customer_id_seq',
    GREATEST(
        (SELECT COALESCE(MAX(customer_id), 1) FROM public.customers),
        (SELECT last_value FROM public.customer_id_seq)
    ),
    TRUE
);

CREATE INDEX IF NOT EXISTS idx_applications_legacy_source
ON public.applications (legacy_source, legacy_application_id);
