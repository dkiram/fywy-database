-- Read-only checks for import totals, match outcomes, aging, duplicates, and unsafe links.
SELECT
    -- Distribution by source and matching outcome.
    legacy_source,
    status,
    match_method,
    COUNT(*) AS application_count
FROM public.applications
WHERE legacy_source IS NOT NULL
GROUP BY legacy_source, status, match_method
ORDER BY legacy_source, status, match_method;

SELECT
    -- Overall reconciliation totals.
    COUNT(*) AS total_legacy_applications,
    COUNT(*) FILTER (
        WHERE legacy_source = 'ApplicationTBL'
    ) AS current_table_applications,
    COUNT(*) FILTER (
        WHERE legacy_source = 'Copy of ApplicationTBL'
    ) AS copied_table_applications,
    COUNT(*) FILTER (
        WHERE status = 'serviced'
          AND customer_id IS NOT NULL
    ) AS serviced_and_linked,
    COUNT(*) FILTER (
        WHERE status = 'match_review'
    ) AS awaiting_match_review,
    COUNT(*) FILTER (
        WHERE status = 'legacy_unresolved'
    ) AS legacy_unresolved
FROM public.applications
WHERE legacy_source IS NOT NULL;

SELECT
    COUNT(*) FILTER (
        WHERE application_date >= CURRENT_DATE - 14
    ) AS zero_to_14_days,
    COUNT(*) FILTER (
        WHERE application_date < CURRENT_DATE - 14
          AND application_date >= CURRENT_DATE - 30
    ) AS fifteen_to_30_days,
    COUNT(*) FILTER (
        WHERE application_date < CURRENT_DATE - 30
    ) AS over_30_days
FROM public.applications
WHERE legacy_source = 'ApplicationTBL';
