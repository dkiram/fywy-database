-- Keeps staff review focused on 2026 imports and returns older uncertain matches to unresolved.
UPDATE public.applications
SET
    status = 'legacy_unresolved',
    updated_at = CURRENT_TIMESTAMP
WHERE legacy_source IS NOT NULL
  AND status = 'match_review'
  AND EXTRACT(YEAR FROM application_date) <> 2026;
