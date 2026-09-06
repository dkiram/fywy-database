-- Gives technicians a way onto their own phone app without giving them a
-- staff login.
--
-- Migration 034 drew a hard line: a technician is a person, not an account.
-- No username, no password hash, enforced by
-- `employees_technicians_cannot_log_in`. That line is worth keeping — a
-- technician's phone lives in a van and gets left on counters, and it must
-- never be a door into customer billing, payments or the OLT.
--
-- So phone access is a separate credential in a separate table, and it can
-- only ever open the technician app:
--
--   login_code    a short handle to type, since a technician has no username
--   passcode      six digits, bcrypt hashed, never stored or logged in clear
--
-- Both are handed over on paper by an administrator. Together with the
-- lockout below, that is proportionate to what the app exposes: the names,
-- addresses and phone numbers of the customers on that technician's own
-- queue, and nothing else.

-- The composite key a technician-only foreign key can point at. employee_id
-- is already unique as the primary key, so this adds no new restriction on
-- employees — it exists purely so the reference below can carry the role.
ALTER TABLE public.employees
    DROP CONSTRAINT IF EXISTS employees_id_role_unique;

ALTER TABLE public.employees
    ADD CONSTRAINT employees_id_role_unique UNIQUE (employee_id, role);


CREATE TABLE IF NOT EXISTS public.technician_phone_access (
    employee_id BIGINT PRIMARY KEY,

    -- Pinned to 'technician' and joined back to the employee's actual role by
    -- the foreign key below, so the database — not the route handler — is
    -- what guarantees that only a technician can hold one of these.
    --
    -- The reference is ON DELETE CASCADE but deliberately NOT ON UPDATE
    -- CASCADE: promoting a technician to staff should fail loudly while a
    -- phone credential is still outstanding, rather than quietly leaving a
    -- passcode attached to someone who now has a real login too. Revoke the
    -- phone access first, then change the role.
    role TEXT NOT NULL DEFAULT 'technician'
        CHECK (role = 'technician'),

    -- Typed on a phone keyboard in a van, so the alphabet drops the
    -- letters that get read back as digits off a printed card — I, O and S —
    -- along with the digits 0 and 1. What is left is unambiguous either way
    -- round: a 5 can only be a 5, because there is no S to confuse it with.
    login_code TEXT NOT NULL
        CHECK (login_code ~ '^[A-HJ-NP-RT-Z2-9]{6}$'),

    passcode_hash TEXT NOT NULL,

    issued_by_employee_id BIGINT
        REFERENCES public.employees(employee_id)
        ON DELETE SET NULL,
    issued_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    last_used_at TIMESTAMPTZ,

    -- Guessing defence that survives a container restart, unlike the
    -- in-memory throttle the staff login uses. A six-digit passcode is short
    -- enough that this matters.
    failed_attempts INTEGER NOT NULL DEFAULT 0
        CHECK (failed_attempts >= 0),
    locked_until TIMESTAMPTZ,

    -- Revoking access without deactivating the person: a lost phone should
    -- not also take them off the assignee list or out of ticket history.
    revoked_at TIMESTAMPTZ,
    revoked_by_employee_id BIGINT
        REFERENCES public.employees(employee_id)
        ON DELETE SET NULL,

    CONSTRAINT technician_phone_access_revocation_complete CHECK (
        (revoked_at IS NULL AND revoked_by_employee_id IS NULL)
        OR revoked_at IS NOT NULL
    ),

    CONSTRAINT technician_phone_access_is_a_technician
        FOREIGN KEY (employee_id, role)
        REFERENCES public.employees (employee_id, role)
        ON DELETE CASCADE
);

-- The login lookup. Only live credentials are addressable, so a revoked code
-- can be reissued to somebody else later without colliding.
CREATE UNIQUE INDEX IF NOT EXISTS technician_phone_access_login_code_unique
ON public.technician_phone_access (login_code)
WHERE revoked_at IS NULL;


-- Technician sign-ins belong in the same history as everyone else's, so the
-- admin Sessions panel answers "was Andre signed in on Tuesday" for field
-- staff too. `username_attempted` carries the login code, which is what was
-- actually typed.
ALTER TABLE public.login_sessions
    DROP CONSTRAINT IF EXISTS login_sessions_failure_reason_check;

ALTER TABLE public.login_sessions
    DROP CONSTRAINT IF EXISTS login_sessions_failure_reason_valid;

ALTER TABLE public.login_sessions
    ADD CONSTRAINT login_sessions_failure_reason_valid
    CHECK (
        failure_reason IN (
            'unknown_username',
            'wrong_password',
            'inactive_account',
            'rate_limited',

            -- Phone access specifically: the login code is real and the
            -- person is active, but the credential itself has been revoked
            -- or locked out by failed guesses.
            'access_revoked',
            'access_locked'
        )
    );
