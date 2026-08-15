CREATE TABLE IF NOT EXISTS public.applications (
    application_id BIGSERIAL PRIMARY KEY,

    name TEXT NOT NULL,
    alias TEXT,
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

    application_date DATE NOT NULL,
    activation_date DATE,
    adult_channel BOOLEAN NOT NULL DEFAULT FALSE,
    additional_box SMALLINT,
    pole_box_number TEXT,
    port_number TEXT,

    status TEXT NOT NULL
        CHECK (
            status IN (
                'pending',
                'serviced',
                'cancelled',
                'declined',
                'legacy_unresolved',
                'match_review'
            )
        ),

    customer_id INTEGER
        REFERENCES public.customers(customer_id)
        ON DELETE SET NULL,

    suggested_customer_id INTEGER
        REFERENCES public.customers(customer_id)
        ON DELETE SET NULL,

    match_method TEXT
        CHECK (
            match_method IS NULL
            OR match_method IN (
                'corroborated_match',
                'unique_id_number_only',
                'unique_name_phone_only',
                'unique_name_address_only',
                'ambiguous_or_conflicting',
                'no_match'
            )
        ),

    submitted_by_employee_id BIGINT
        REFERENCES public.employees(employee_id)
        ON DELETE SET NULL,

    serviced_by_employee_id BIGINT
        REFERENCES public.employees(employee_id)
        ON DELETE SET NULL,

    closed_by_employee_id BIGINT
        REFERENCES public.employees(employee_id)
        ON DELETE SET NULL,

    serviced_at TIMESTAMPTZ,
    closed_at TIMESTAMPTZ,
    closure_reason TEXT,

    legacy_source TEXT
        CHECK (
            legacy_source IS NULL
            OR legacy_source IN (
                'ApplicationTBL',
                'Copy of ApplicationTBL'
            )
        ),
    legacy_application_id INTEGER,
    source_staging_id BIGINT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CHECK (
        status <> 'serviced'
        OR customer_id IS NOT NULL
    ),

    CHECK (
        (
            legacy_source IS NULL
            AND legacy_application_id IS NULL
            AND source_staging_id IS NULL
        )
        OR
        (
            legacy_source IS NOT NULL
            AND legacy_application_id IS NOT NULL
            AND source_staging_id IS NOT NULL
        )
    ),

    UNIQUE (legacy_source, legacy_application_id),
    UNIQUE (legacy_source, source_staging_id)
);

CREATE INDEX IF NOT EXISTS idx_applications_status_date
ON public.applications (status, application_date DESC);

CREATE INDEX IF NOT EXISTS idx_applications_customer
ON public.applications (customer_id)
WHERE customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_applications_suggested_customer
ON public.applications (suggested_customer_id)
WHERE suggested_customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_applications_name
ON public.applications (LOWER(name));
