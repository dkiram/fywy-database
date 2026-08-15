-- Creates locations and employee identities used for login, roles, and branch scoping.
CREATE TABLE IF NOT EXISTS public.locations (
    location_id SMALLSERIAL PRIMARY KEY,

    name TEXT NOT NULL,
    code TEXT UNIQUE,

    is_head_office BOOLEAN NOT NULL DEFAULT FALSE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);


CREATE TABLE IF NOT EXISTS public.employees (
    employee_id BIGSERIAL PRIMARY KEY,

    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,

    username TEXT NOT NULL,

    password_hash TEXT NOT NULL,

    role TEXT NOT NULL
        CHECK (
            role IN (
                'admin',
                'head_office',
                'branch'
            )
        ),

    location_id SMALLINT
        REFERENCES public.locations(location_id),

    is_active BOOLEAN NOT NULL DEFAULT TRUE,

    last_login_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);


CREATE UNIQUE INDEX IF NOT EXISTS employees_username_lower_unique
ON public.employees (LOWER(username));

INSERT INTO public.locations (
    name,
    code,
    is_head_office
)
VALUES
    ('Head Office', 'HO', TRUE),
    ('Development Branch', 'DEV', FALSE)
ON CONFLICT (code) DO NOTHING;
