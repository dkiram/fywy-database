-- ============================================================================
-- Change one employee's username.
--
-- Plain SQL — paste into a TablePlus tab (Run All) or pipe through psql.
-- Run it on BOTH databases if you keep a local one in step with the NAS.
--
-- WHY NOT JUST RE-RUN createEmployees.ts
-- --------------------------------------
-- That script only ever CREATES. It decides "have I seen this person before?"
-- by looking up the username, so a changed username matches nobody and it
-- inserts a SECOND account for the same human — old login still working,
-- new login alongside it, both admins. Renaming is an UPDATE, and there is no
-- code path in the app that does it.
--
-- Editing staff.json was still the right move: keep it matching reality so a
-- future run skips him instead of recreating the old username.
--
-- The last line is ROLLBACK. Read the output, then change it to COMMIT.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- The only two lines you edit.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE rename_request ON COMMIT DROP AS
SELECT 'pjdunn'::TEXT AS old_username,      -- <-- the username as it is now
       'papaherby'::TEXT  AS new_username;      -- <-- what it should become

-- ---------------------------------------------------------------------------
-- Guard 1: the person exists, and is exactly one person.
-- ---------------------------------------------------------------------------
DO $guard$
DECLARE
    found INTEGER;
    old_u TEXT;
BEGIN
    SELECT old_username INTO old_u FROM rename_request;
    SELECT count(*) INTO found FROM public.employees WHERE LOWER(username) = LOWER(old_u);

    IF found <> 1 THEN
        RAISE EXCEPTION
            'Expected exactly 1 employee with username "%", found %. Nothing changed.',
            old_u, found;
    END IF;
END
$guard$;

-- ---------------------------------------------------------------------------
-- Guard 2: the new username is free. There is a unique index on
-- LOWER(username), so a clash would fail anyway — this just fails with a
-- sentence instead of a constraint name.
-- ---------------------------------------------------------------------------
DO $guard$
DECLARE
    taken INTEGER;
    new_u TEXT;
BEGIN
    SELECT new_username INTO new_u FROM rename_request;

    IF new_u IS NULL OR length(trim(new_u)) = 0 THEN
        RAISE EXCEPTION 'The new username is empty. Nothing changed.';
    END IF;

    SELECT count(*) INTO taken FROM public.employees WHERE LOWER(username) = LOWER(new_u);

    IF taken > 0 THEN
        RAISE EXCEPTION 'Username "%" is already taken. Nothing changed.', new_u;
    END IF;
END
$guard$;

-- ---------------------------------------------------------------------------
-- Who is about to be renamed. Check it is the right person.
-- ---------------------------------------------------------------------------
SELECT 'RENAMING' AS check, e.employee_id, e.first_name, e.last_name,
       e.username AS from_username, r.new_username AS to_username, e.role
FROM public.employees e, rename_request r
WHERE LOWER(e.username) = LOWER(r.old_username);

UPDATE public.employees e
SET username   = r.new_username,
    updated_at = CURRENT_TIMESTAMP
FROM rename_request r
WHERE LOWER(e.username) = LOWER(r.old_username);

-- The activity trail should show this happened. No password material is
-- involved, so the old and new values are safe to record.
INSERT INTO public.audit_logs
    (employee_id, actor_name, action, entity_type, entity_id,
     field_name, old_value, new_value, reason)
SELECT e.employee_id,
       e.first_name || ' ' || e.last_name,
       'Changed username',
       'employee',
       e.employee_id::TEXT,
       'username',
       r.old_username,
       r.new_username,
       'Requested by the account holder'
FROM public.employees e, rename_request r
WHERE LOWER(e.username) = LOWER(r.new_username);

SELECT 'RESULT' AS check, employee_id, first_name, last_name, username, role
FROM public.employees
WHERE LOWER(username) = LOWER((SELECT new_username FROM rename_request));

-- ---------------------------------------------------------------------------
-- ROLLBACK = rehearsal. COMMIT = for real.
-- ---------------------------------------------------------------------------
ROLLBACK;
