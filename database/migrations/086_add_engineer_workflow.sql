-- Engineers use the field app; their completion returns work to the office.
BEGIN;
ALTER TABLE public.employees DROP CONSTRAINT employees_role_check;
ALTER TABLE public.employees ADD CONSTRAINT employees_role_check
 CHECK (role IN ('admin', 'head_office', 'branch', 'technician', 'engineer'));
ALTER TABLE public.employees DROP CONSTRAINT employees_technicians_cannot_log_in;
ALTER TABLE public.employees ADD CONSTRAINT employees_technicians_cannot_log_in
 CHECK ((role IN ('technician', 'engineer') AND username IS NULL)
 OR (role NOT IN ('technician', 'engineer') AND username IS NOT NULL));
ALTER TABLE public.technician_phone_access DROP CONSTRAINT technician_phone_access_role_check;
ALTER TABLE public.technician_phone_access ADD CONSTRAINT technician_phone_access_role_check
 CHECK (role IN ('technician', 'engineer'));
ALTER TABLE public.technician_phone_access DROP CONSTRAINT technician_phone_access_is_a_technician;
ALTER TABLE public.technician_phone_access ADD CONSTRAINT technician_phone_access_is_a_technician
 FOREIGN KEY (employee_id, role) REFERENCES public.employees(employee_id, role)
 ON UPDATE CASCADE ON DELETE CASCADE;
UPDATE public.employees SET role = 'engineer'
 WHERE role = 'technician' AND
 (LOWER(TRIM(first_name)), LOWER(TRIM(last_name))) IN
 (('andrew', 'morgan'), ('kemoni', 'jones'));
ALTER TABLE public.service_tickets ADD COLUMN field_return_kind TEXT
 CHECK (field_return_kind IN ('technician_sent_back', 'engineer_sent_back', 'engineer_completed'));
UPDATE public.service_tickets t SET field_return_kind = CASE
 WHEN EXISTS (SELECT 1 FROM public.employees e WHERE e.employee_id = t.handed_back_by_employee_id AND e.role = 'engineer')
 THEN 'engineer_sent_back' ELSE 'technician_sent_back' END
 WHERE handed_back_at IS NOT NULL;
CREATE OR REPLACE FUNCTION public.clear_handback_on_assignment()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.assigned_employee_id IS NOT NULL THEN
   NEW.handed_back_at := NULL;
   NEW.handed_back_by_employee_id := NULL;
   NEW.handback_reason := NULL;
   NEW.field_return_kind := NULL;
 END IF;
 RETURN NEW;
END;
$$;
COMMIT;
