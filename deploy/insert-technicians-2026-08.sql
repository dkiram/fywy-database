-- ============================================================================
-- Adds the second batch of technicians (August 2026) to the service-ticket
-- assignee dropdown.
--
-- Plain SQL — paste into a TablePlus SQL tab. Run it on BOTH databases (local
-- and NAS); `git push` moves code, not rows.
--
-- Same rules as deploy/insert-technicians.sql: migration 034 made username and
-- password_hash nullable so role 'technician' can exist with NO username and
-- NO password. Technicians do not log in; they only need a name so a ticket
-- can be assigned to them. Anyone who logs in needs a bcrypt hash, which you
-- cannot type into a grid — those still go through createEmployees.ts.
--
-- Names are stored Title Case regardless of how they were written down, so the
-- dropdown does not read "lester Smith" next to "Anthony Jones".
--
-- Safe to re-run: the NOT EXISTS matches on name + role, so anyone already
-- present is skipped rather than duplicated.
--
-- Note there is already a technician called Juvoni Jones. Anthony Jones and
-- Kemoni Jones are separate people; the match is on first AND last name, so
-- none of the three collide.
-- ============================================================================

INSERT INTO public.employees (first_name, last_name, role, location_id)
SELECT v.first_name, v.last_name, 'technician', NULL
FROM (VALUES
    ('Anthony',  'Jones'),
    ('Lester',   'Smith'),
    ('Carlos',   'Angel'),
    ('Gifferd',  'Russell'),
    ('Francois', 'Simpson'),
    ('Alex',     'Burrell'),
    ('Kemoni',   'Jones'),
    ('Andrew',   'Morgan')
) AS v(first_name, last_name)
WHERE NOT EXISTS (
    SELECT 1 FROM public.employees e
    WHERE LOWER(e.first_name) = LOWER(v.first_name)
      AND LOWER(e.last_name)  = LOWER(v.last_name)
      AND e.role = 'technician'
);

-- Confirm: should list all eight new names plus the seven already there.
SELECT employee_id, first_name, last_name, role
FROM public.employees
WHERE role = 'technician'
ORDER BY first_name, last_name;
