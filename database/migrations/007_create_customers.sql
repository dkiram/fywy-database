-- Creates the canonical customer table while retaining fields needed to trace legacy data.
CREATE TABLE IF NOT EXISTS public.customers (
    customer_id INTEGER PRIMARY KEY,

    name TEXT,
    address TEXT,
    occupation TEXT,
    telephone TEXT,
    email TEXT,

    id_type TEXT,
    id_number TEXT,

    package_id SMALLINT
        REFERENCES public.packages(package_id),

    legacy_package_id SMALLINT,

    monthly_fee NUMERIC(14,2),

    application_date DATE,
    activation_date DATE,
    deactivation_date DATE,
    reactivation_date DATE,

    status TEXT NOT NULL
        CHECK (
            status IN (
                'active',
                'disconnected',
                'pending_reconnection',
                'closed',
                'archived'
            )
        ),

    adult_channel BOOLEAN NOT NULL DEFAULT FALSE,

    pole_box_number TEXT,
    port_number TEXT,

    legacy_alias_notes TEXT,
    legacy_card_number TEXT,
    legacy_additional_box_notes TEXT,

    source_staging_id BIGINT UNIQUE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
