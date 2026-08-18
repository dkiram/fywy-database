-- ============================================================================
-- Adds the technicians so they appear in the service-ticket assignee dropdown.
--
-- Plain SQL — paste into a TablePlus SQL tab. Run it on BOTH databases (local
-- and NAS); `git push` moves code, not rows.
--
-- Technicians are the one kind of staff you can safely add by hand. Migration
-- 034 made username and password_hash nullable for exactly this case, and the
-- constraints enforce it: role 'technician' must have NO username and NO
-- password. Everyone who logs in needs a bcrypt hash, which you cannot type
-- into a grid — those still go through createEmployees.ts.
--
-- Safe to re-run: the NOT EXISTS matches on name + role, so anyone already
-- present is skipped rather than duplicated. Same rule createEmployees.ts uses.
-- Verified: 1 technician already present, first run inserted 6, second run
-- inserted 0.
-- ============================================================================

INSERT INTO public.employees (first_name, last_name, role, location_id)
SELECT v.first_name, v.last_name, 'technician', NULL
FROM (VALUES
    ('Travis',  'Pitter'),
    ('Adari',   'Roberts'),
    ('Roheim',  'Daley'),
    ('Juvoni',  'Jones'),
    ('Kevin',   'Suckoo'),
    ('Raymore', 'Johnson'),
    ('Tafari',  'Wint')
) AS v(first_name, last_name)
WHERE NOT EXISTS (
    SELECT 1 FROM public.employees e
    WHERE LOWER(e.first_name) = LOWER(v.first_name)
      AND LOWER(e.last_name)  = LOWER(v.last_name)
      AND e.role = 'technician'
);
