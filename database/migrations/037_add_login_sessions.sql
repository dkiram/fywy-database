-- Records who signed in, when, from where, and when the session ended.
--
-- Nothing in the system kept this before. `employees.last_login_at` is
-- overwritten on every login, so it only ever answers "most recently", and
-- `user_sessions` holds live sessions only — no employee column, no start
-- time, and rows vanish on expiry. There was no way to ask "was Lidia signed
-- in on Tuesday afternoon".
--
-- Failed attempts live in the same table rather than a separate one. The
-- question an admin actually asks is "what happened on this account", and a
-- run of failures followed by a success is one story told in one place.
--
-- Names and office are snapshotted alongside the foreign keys. An employee
-- can be renamed or moved, and a login record should keep saying what was
-- true at the time — the same reason audit_logs snapshots actor_name.

CREATE TABLE IF NOT EXISTS public.login_sessions (
    login_session_id BIGSERIAL PRIMARY KEY,

    -- Null for a failed attempt on a username that does not exist. Keeping
    -- the row anyway is the point: someone guessing at usernames is exactly
    -- what this should surface.
    employee_id BIGINT
        REFERENCES public.employees(employee_id)
        ON DELETE SET NULL,

    username_attempted TEXT NOT NULL,
    actor_name TEXT,

    outcome TEXT NOT NULL
        CHECK (outcome IN ('success', 'failed')),

    -- Only set on failures. Deliberately coarse: a precise reason handed back
    -- to the browser would tell an attacker which half they got right, and
    -- there is no reason to keep more detail here than the login response
    -- itself gives out.
    failure_reason TEXT
        CHECK (failure_reason IN ('unknown_username', 'wrong_password', 'inactive_account', 'rate_limited')),

    location_id SMALLINT
        REFERENCES public.locations(location_id)
        ON DELETE SET NULL,
    location_name TEXT,

    -- Links to user_sessions.sid so "is this session still live" can be
    -- answered by looking, rather than guessed from timestamps.
    session_sid TEXT,

    started_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- Touched at most once a minute while the session is in use. This is what
    -- makes a closed browser readable: without it, a session nobody logged
    -- out of has a start time and nothing else.
    last_seen_at TIMESTAMPTZ,

    ended_at   TIMESTAMPTZ,
    end_reason TEXT
        CHECK (end_reason IN ('logout', 'expired')),

    -- A failed attempt is a moment, not a session: it can never be open, and
    -- never has a session to end.
    CONSTRAINT login_sessions_failures_have_no_session CHECK (
        outcome = 'success'
        OR (session_sid IS NULL AND last_seen_at IS NULL AND ended_at IS NULL AND end_reason IS NULL)
    ),

    CONSTRAINT login_sessions_ended_has_reason CHECK (
        (ended_at IS NULL AND end_reason IS NULL)
        OR (ended_at IS NOT NULL AND end_reason IS NOT NULL)
    ),

    CONSTRAINT login_sessions_failures_have_a_reason CHECK (
        (outcome = 'failed' AND failure_reason IS NOT NULL)
        OR (outcome = 'success' AND failure_reason IS NULL)
    )
);

-- The per-employee panel reads newest-first for one person.
CREATE INDEX IF NOT EXISTS idx_login_sessions_employee
ON public.login_sessions (employee_id, started_at DESC);

-- Resolving "which sessions are still open" joins on this.
CREATE INDEX IF NOT EXISTS idx_login_sessions_open
ON public.login_sessions (session_sid)
WHERE ended_at IS NULL AND outcome = 'success';

-- Scanning recent failures across everyone.
CREATE INDEX IF NOT EXISTS idx_login_sessions_failures
ON public.login_sessions (started_at DESC)
WHERE outcome = 'failed';
