CREATE TABLE IF NOT EXISTS public.packages (
    package_id SMALLINT PRIMARY KEY,

    name TEXT NOT NULL,

    installation_fee NUMERIC(10,2),
    default_monthly_charge NUMERIC(10,2),
    reconnection_fee NUMERIC(10,2),

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);