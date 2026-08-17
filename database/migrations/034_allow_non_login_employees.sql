-- Lets technicians exist as people without existing as logins.
--
-- Service tickets are assigned to employees, and the assignee dropdown lists
-- every active employee. Technicians need to appear there. But until now
-- `employees` demanded a username and a password hash from every row, so the
-- only way to make a technician assignable was to give them a working
-- account - a login for someone who should never have one, with a hash
-- sitting in the table waiting to be guessed or reset.
--
-- After this, a row in `employees` is one of two things, and the database
-- enforces which:
--
--   a system user  - has a username AND a password hash, role admin /
--                    head_office / branch
--   a person       - has neither, role technician; can be assigned work,
--                    can never log in
--
-- The constraints matter more than the nullable columns. Without them, a
-- technician row could quietly acquire a password later and nobody would
-- notice; with them, the database refuses.

-- 1. A login is now optional at the column level...
ALTER TABLE public.employees
    ALTER COLUMN username      DROP NOT NULL,
    ALTER COLUMN password_hash DROP NOT NULL;

-- 2. ...and 'technician' becomes a role.
ALTER TABLE public.employees
    DROP CONSTRAINT IF EXISTS employees_role_check;

ALTER TABLE public.employees
    ADD CONSTRAINT employees_role_check
    CHECK (
        role IN (
            'admin',
            'head_office',
            'branch',
            'technician'
        )
    );

-- 3. Credentials arrive together or not at all. A username with no hash is an
--    account nobody can use; a hash with no username is a password with no
--    door. Both are mistakes rather than states worth supporting.
ALTER TABLE public.employees
    DROP CONSTRAINT IF EXISTS employees_credentials_complete;

ALTER TABLE public.employees
    ADD CONSTRAINT employees_credentials_complete
    CHECK (
        (username IS NULL     AND password_hash IS NULL)
        OR
        (username IS NOT NULL AND password_hash IS NOT NULL)
    );

-- 4. Technicians never have credentials, and everyone else always does. This
--    is the constraint that stops a technician being handed a login by
--    accident - promoting one to a system user means deliberately changing
--    their role in the same statement.
ALTER TABLE public.employees
    DROP CONSTRAINT IF EXISTS employees_technicians_cannot_log_in;

ALTER TABLE public.employees
    ADD CONSTRAINT employees_technicians_cannot_log_in
    CHECK (
        (role = 'technician' AND username IS NULL)
        OR
        (role <> 'technician' AND username IS NOT NULL)
    );

-- 5. The existing unique index already tolerates several NULL usernames,
--    since NULLs are distinct to a unique index. Make that explicit rather
--    than incidental, so it survives someone rewriting the index later.
DROP INDEX IF EXISTS employees_username_lower_unique;

CREATE UNIQUE INDEX IF NOT EXISTS employees_username_lower_unique
ON public.employees (LOWER(username))
WHERE username IS NOT NULL;
