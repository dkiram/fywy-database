-- Adds optional human context for sensitive changes recorded in the audit trail.
ALTER TABLE IF EXISTS public.audit_logs
ADD COLUMN IF NOT EXISTS reason TEXT;
