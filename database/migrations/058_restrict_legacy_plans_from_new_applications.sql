-- Lets a package be active (selectable on an existing customer's Manage
-- Subscription) without being offered on the New Application form. Needed so
-- the Old Internet (5 Mbps) legacy plan from
-- 057_add_legacy_internet_plan.sql stays reachable for long-time customers
-- but isn't handed to new applicants.
ALTER TABLE public.packages
ADD COLUMN IF NOT EXISTS available_for_new_applications BOOLEAN NOT NULL DEFAULT TRUE;

UPDATE public.packages
SET available_for_new_applications = FALSE
WHERE package_id = 10;
