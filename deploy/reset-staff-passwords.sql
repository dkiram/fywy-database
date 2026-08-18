-- ============================================================================
-- Sets one shared temporary password for branch and head office staff.
--
-- Plain SQL — TablePlus (Run All) or piped through psql. Run on BOTH databases
-- if you keep a local one in step.
--
-- Technicians are untouched: they have no username and no password_hash at
-- all, so there is nothing here to set. The two admins are excluded by name
-- below, so somebody always holds a password nobody else knows.
--
-- ABOUT THE PASSWORD
-- ------------------
-- 'spcl7334' is 9 characters. createEmployees.ts requires 12 and the admin
-- reset endpoint requires 12, so this deliberately goes around both. That is
-- a reasonable trade for a first-day handover, and a bad one to leave in
-- place — see the note at the bottom about what does NOT happen automatically.
--
-- Each row gets its own salt (gen_salt is evaluated per row), so the stored
-- hashes differ even though the password is shared. Anyone reading the table
-- cannot tell from the hashes that these accounts match.
--
-- Verified: pgcrypto produces $2a$12$ hashes, and the app's bcrypt library
-- accepts them — compare() returns true for the password and false otherwise.
--
-- The last line is ROLLBACK. Read the output, then change it to COMMIT.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

BEGIN;

-- ---------------------------------------------------------------------------
-- The only things you edit.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE reset_settings ON COMMIT DROP AS
SELECT 'spcl7334'::TEXT AS new_password;

-- People who keep their own password. Matched on name rather than username so
-- this still works after a username has been changed.
CREATE TEMP TABLE excluded_people (first_name TEXT, last_name TEXT) ON COMMIT DROP;
INSERT INTO excluded_people VALUES
    ('Kimone', 'Dunn'),
    ('Peter',  'Dunn');

-- ---------------------------------------------------------------------------
-- Work out who is affected.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE targets ON COMMIT DROP AS
SELECT e.employee_id, e.first_name, e.last_name, e.username, e.role
FROM public.employees e
WHERE e.is_active = TRUE
  AND e.username IS NOT NULL          -- excludes technicians by definition
  AND e.role IN ('branch', 'head_office')
  AND NOT EXISTS (
      SELECT 1 FROM excluded_people x
      WHERE LOWER(x.first_name) = LOWER(e.first_name)
        AND LOWER(x.last_name)  = LOWER(e.last_name)
  );

-- ---------------------------------------------------------------------------
-- Guard 1: an admin must never be caught by this, whatever the role filter
-- above says. Belt and braces — the one account that can undo a mistake here
-- must not be the account the mistake locks you out of.
-- ---------------------------------------------------------------------------
DO $guard$
DECLARE
    admins INTEGER;
BEGIN
    SELECT count(*) INTO admins FROM targets WHERE role = 'admin';

    IF admins > 0 THEN
        RAISE EXCEPTION 'An administrator is in the target list. Nothing changed.';
    END IF;
END
$guard$;

-- ---------------------------------------------------------------------------
-- Guard 2: the exclusions actually matched somebody. A typo in a name would
-- otherwise silently reset a password you meant to keep.
-- ---------------------------------------------------------------------------
DO $guard$
DECLARE
    missing TEXT;
BEGIN
    SELECT string_agg(x.first_name || ' ' || x.last_name, ', ') INTO missing
    FROM excluded_people x
    WHERE NOT EXISTS (
        SELECT 1 FROM public.employees e
        WHERE LOWER(e.first_name) = LOWER(x.first_name)
          AND LOWER(e.last_name)  = LOWER(x.last_name)
    );

    IF missing IS NOT NULL THEN
        RAISE EXCEPTION
            'These people are on the exclusion list but do not exist: %. Check the spelling — nothing changed.',
            missing;
    END IF;
END
$guard$;

-- ---------------------------------------------------------------------------
-- Guard 3: there is somebody to change.
-- ---------------------------------------------------------------------------
DO $guard$
DECLARE
    n INTEGER;
BEGIN
    SELECT count(*) INTO n FROM targets;
    IF n = 0 THEN
        RAISE EXCEPTION 'No staff matched. Nothing changed.';
    END IF;
END
$guard$;

-- ---------------------------------------------------------------------------
-- Who is about to get the shared password, and who is deliberately spared.
-- ---------------------------------------------------------------------------
SELECT 'WILL BE RESET' AS check, employee_id, first_name, last_name, username, role
FROM targets ORDER BY role, last_name;

SELECT 'KEEPS OWN PASSWORD' AS check, e.employee_id, e.first_name, e.last_name, e.username, e.role
FROM public.employees e
WHERE e.username IS NOT NULL
  AND e.employee_id NOT IN (SELECT employee_id FROM targets)
ORDER BY e.role, e.last_name;

-- ---------------------------------------------------------------------------
-- Set it. gen_salt runs per row, so every hash is different.
-- ---------------------------------------------------------------------------
UPDATE public.employees e
SET password_hash = crypt((SELECT new_password FROM reset_settings), gen_salt('bf', 12)),
    updated_at    = CURRENT_TIMESTAMP
WHERE e.employee_id IN (SELECT employee_id FROM targets);

-- The trail records that it happened, never the password itself.
INSERT INTO public.audit_logs
    (employee_id, actor_name, action, entity_type, entity_id, field_name, reason)
SELECT t.employee_id,
       'Administrator',
       'Password reset in bulk for first-day handover',
       'employee',
       t.employee_id::TEXT,
       'password',
       'Shared temporary password issued; staff to change at first login'
FROM targets t;

-- ---------------------------------------------------------------------------
-- Prove it worked, without printing anything secret. Every row must say true.
-- ---------------------------------------------------------------------------
SELECT 'VERIFY' AS check,
       e.first_name, e.last_name, e.username,
       (e.password_hash = crypt((SELECT new_password FROM reset_settings), e.password_hash)) AS password_works,
       left(e.password_hash, 7) AS hash_prefix
FROM public.employees e
WHERE e.employee_id IN (SELECT employee_id FROM targets)
ORDER BY e.last_name;

-- Distinct salts: this count must equal the number of people reset.
SELECT 'DISTINCT HASHES' AS check, count(DISTINCT password_hash) AS n
FROM public.employees WHERE employee_id IN (SELECT employee_id FROM targets);

-- ---------------------------------------------------------------------------
-- ROLLBACK = rehearsal. COMMIT = for real.
--
-- AFTERWARDS: nothing in SPCL forces anyone to change this. There is no
-- must-change-password flag and no expiry — the change-password screen is
-- entirely voluntary. Until that exists, "they will change it immediately"
-- is a thing you have to chase, not a thing the system does.
-- ---------------------------------------------------------------------------
ROLLBACK;
