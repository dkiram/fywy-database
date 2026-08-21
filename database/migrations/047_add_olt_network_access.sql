-- Stores the physical OLT once and links customers to their current ONT
-- location. These values deliberately do not live on customers: an OLT is
-- shared by many customers, and an ONT assignment must retain history when a
-- customer moves, changes ports, or receives replacement equipment.
CREATE TABLE IF NOT EXISTS public.olts (
    olt_id BIGSERIAL PRIMARY KEY,

    name TEXT NOT NULL,
    normalized_name TEXT GENERATED ALWAYS AS (UPPER(TRIM(name))) STORED,
    management_ip INET NOT NULL,
    model TEXT NOT NULL DEFAULT 'MA5680T',
    site TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,

    created_by_employee_id BIGINT
        REFERENCES public.employees(employee_id)
        ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CHECK (LENGTH(TRIM(name)) BETWEEN 2 AND 120),
    CHECK (LENGTH(TRIM(model)) BETWEEN 2 AND 120),
    CHECK (site IS NULL OR LENGTH(TRIM(site)) BETWEEN 2 AND 160),
    UNIQUE (normalized_name),
    UNIQUE (management_ip)
);

CREATE TABLE IF NOT EXISTS public.customer_ont_assignments (
    customer_ont_assignment_id BIGSERIAL PRIMARY KEY,

    customer_id INTEGER NOT NULL
        REFERENCES public.customers(customer_id)
        ON DELETE RESTRICT,
    olt_id BIGINT NOT NULL
        REFERENCES public.olts(olt_id)
        ON DELETE RESTRICT,

    -- Huawei displays the location as Frame/Card-or-Slot/PON-Port/ONT-ID.
    -- Keeping each part numeric lets the server build and validate commands
    -- without parsing an ambiguous free-text "port" value.
    frame_number SMALLINT NOT NULL,
    slot_number SMALLINT NOT NULL,
    pon_port_number SMALLINT NOT NULL,
    ont_id INTEGER NOT NULL,

    -- Huawei service-port is a separate logical identifier. It is optional
    -- because not every U2000 export or installation worksheet includes it.
    service_port_id BIGINT,

    ont_serial TEXT NOT NULL,
    ont_model TEXT,

    source TEXT NOT NULL DEFAULT 'manual'
        CHECK (source IN ('manual', 'u2000_import', 'api_sync')),
    mapping_status TEXT NOT NULL DEFAULT 'unverified'
        CHECK (mapping_status IN ('unverified', 'verified', 'mismatch')),
    verified_at TIMESTAMPTZ,
    verified_by_employee_id BIGINT
        REFERENCES public.employees(employee_id)
        ON DELETE SET NULL,

    active_from TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ended_at TIMESTAMPTZ,
    created_by_employee_id BIGINT
        REFERENCES public.employees(employee_id)
        ON DELETE SET NULL,
    updated_by_employee_id BIGINT
        REFERENCES public.employees(employee_id)
        ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CHECK (frame_number BETWEEN 0 AND 255),
    CHECK (slot_number BETWEEN 0 AND 255),
    CHECK (pon_port_number BETWEEN 0 AND 255),
    CHECK (ont_id BETWEEN 0 AND 4095),
    CHECK (service_port_id IS NULL OR service_port_id >= 0),
    CHECK (LENGTH(TRIM(ont_serial)) BETWEEN 4 AND 120),
    CHECK (ont_model IS NULL OR LENGTH(TRIM(ont_model)) <= 120),
    CHECK (ended_at IS NULL OR ended_at >= active_from),
    CHECK (
        (mapping_status = 'verified' AND verified_at IS NOT NULL)
        OR mapping_status <> 'verified'
    )
);

-- A customer can have historical assignments, but only one current one.
CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_ont_assignments_current_customer
ON public.customer_ont_assignments (customer_id)
WHERE ended_at IS NULL;

-- Never allow two current customer records to target the same OLT location.
CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_ont_assignments_current_location
ON public.customer_ont_assignments (
    olt_id,
    frame_number,
    slot_number,
    pon_port_number,
    ont_id
)
WHERE ended_at IS NULL;

-- Serial numbers are the safety check before a future deactivate command.
CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_ont_assignments_current_serial
ON public.customer_ont_assignments (UPPER(TRIM(ont_serial)))
WHERE ended_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_customer_ont_assignments_history
ON public.customer_ont_assignments (customer_id, active_from DESC);

