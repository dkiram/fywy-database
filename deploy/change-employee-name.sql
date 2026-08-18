-- ============================================================================
-- Corrects an employee's name.
--
-- Plain SQL — TablePlus (Run All) or piped through psql. Run on BOTH databases.
--
-- Set up for Lydia Cohall -> Lidia Lewis Cohall. Edit the four values below for
-- anyone else.
--
-- The username is deliberately left alone: it is what the person types to log
-- in, and changing it silently while correcting a spelling would lock them out
-- with no explanation. Use deploy/rename-username.sql if it should change too.
--
-- Old ticket and payment history is unaffected. Receipts store cashier_name as
-- a snapshot taken at the time, so past receipts keep the name that was
-- printed on them, which is what an audit of those receipts should show.
--
-- The last line is ROLLBACK. Read the output, then change it to COMMIT.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- The only lines you edit. Match on the name as it is stored NOW.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE name_change ON COMMIT DROP AS
SELECT 'Lydia'::TEXT        AS old_first_name,
       'Cohall'::TEXT       AS old_last_name,
       'Lidia'::TEXT        AS new_first_name,
       'Lewis Cohall'::TEXT AS new_last_name;

-- ---------------------------------------------------------------------------
-- Guard: exactly one person matches.
-- ---------------------------------------------------------------------------
DO $guard$
DECLARE
    found INTEGER;
    c     RECORD;
BEGIN
    SELECT * INTO c FROM name_change;

    SELECT count(*) INTO found
    FROM public.employees
    WHERE LOWER(first_name) = LOWER(c.old_first_name)
      AND LOWER(last_name)  = LOWER(c.old_last_name);

    IF found <> 1 THEN
        RAISE EXCEPTION
            'Expected exactly 1 employee named % %, found %. Nothing changed.',
            c.old_first_name, c.old_last_name, found;
    END IF;
END
$guard$;

SELECT 'RENAMING' AS check, e.employee_id, e.username, e.role,
       e.first_name || ' ' || e.last_name AS from_name,
       c.new_first_name || ' ' || c.new_last_name AS to_name
FROM public.employees e, name_change c
WHERE LOWER(e.first_name) = LOWER(c.old_first_name)
  AND LOWER(e.last_name)  = LOWER(c.old_last_name);

UPDATE public.employees e
SET first_name = c.new_first_name,
    last_name  = c.new_last_name,
    updated_at = CURRENT_TIMESTAMP
FROM name_change c
WHERE LOWER(e.first_name) = LOWER(c.old_first_name)
  AND LOWER(e.last_name)  = LOWER(c.old_last_name);

INSERT INTO public.audit_logs
    (employee_id, actor_name, action, entity_type, entity_id,
     field_name, old_value, new_value, reason)
SELECT e.employee_id,
       'Administrator',
       'Corrected employee name',
       'employee',
       e.employee_id::TEXT,
       'name',
       c.old_first_name || ' ' || c.old_last_name,
       c.new_first_name || ' ' || c.new_last_name,
       'Name correction requested by the employee'
FROM public.employees e, name_change c
WHERE LOWER(e.first_name) = LOWER(c.new_first_name)
  AND LOWER(e.last_name)  = LOWER(c.new_last_name);

SELECT 'RESULT' AS check, employee_id, first_name, last_name, username, role
FROM public.employees e, name_change c
WHERE LOWER(e.first_name) = LOWER(c.new_first_name)
  AND LOWER(e.last_name)  = LOWER(c.new_last_name);

-- ---------------------------------------------------------------------------
-- ROLLBACK = rehearsal. COMMIT = for real.
-- ---------------------------------------------------------------------------
ROLLBACK;
