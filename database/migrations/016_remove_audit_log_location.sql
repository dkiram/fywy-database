-- Removes redundant location snapshots from audit entries after the audit model was simplified.
ALTER TABLE IF EXISTS public.audit_logs
DROP COLUMN IF EXISTS location_id,
DROP COLUMN IF EXISTS location_name;
