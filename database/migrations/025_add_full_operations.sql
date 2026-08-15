-- This migration introduces managed pole-box inventory and end-to-end service tickets.
-- MVP 4: operational pole-box inventory and service-ticket workflow.
-- Existing customer pole/port text remains intact so legacy assignments are
-- preserved exactly; pole_boxes adds manageable metadata around those values.

CREATE TABLE IF NOT EXISTS public.pole_boxes (
    pole_box_id BIGSERIAL PRIMARY KEY,
    box_number TEXT NOT NULL CHECK (LENGTH(TRIM(box_number)) >= 1),
    normalized_box_number TEXT GENERATED ALWAYS AS (
        UPPER(TRIM(box_number))
    ) STORED UNIQUE,
    location_description TEXT,
    capacity INTEGER CHECK (capacity IS NULL OR capacity BETWEEN 1 AND 512),
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'maintenance', 'retired')),
    notes TEXT,
    created_by_employee_id BIGINT
        REFERENCES public.employees(employee_id)
        ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Create inventory shells for boxes already referenced by customer accounts.
-- Capacity is intentionally unknown rather than guessed from legacy usage.
INSERT INTO public.pole_boxes (box_number, notes)
SELECT DISTINCT ON (UPPER(TRIM(c.pole_box_number)))
    TRIM(c.pole_box_number),
    'Imported from existing customer pole-box assignments'
FROM public.customers c
WHERE NULLIF(TRIM(c.pole_box_number), '') IS NOT NULL
ORDER BY UPPER(TRIM(c.pole_box_number)), c.customer_id
ON CONFLICT (normalized_box_number) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.service_tickets (
    service_ticket_id BIGSERIAL PRIMARY KEY,
    customer_id INTEGER NOT NULL
        REFERENCES public.customers(customer_id)
        ON DELETE RESTRICT,
    issue_summary TEXT NOT NULL CHECK (LENGTH(TRIM(issue_summary)) >= 3),
    description TEXT,
    priority TEXT NOT NULL DEFAULT 'normal'
        CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
    status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'assigned', 'in_progress', 'completed', 'cancelled')),
    reported_date DATE NOT NULL DEFAULT
        ((CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE),
    assigned_employee_id BIGINT
        REFERENCES public.employees(employee_id)
        ON DELETE SET NULL,
    pole_box_number TEXT,
    port_number TEXT,
    service_date DATE,
    resolution_notes TEXT,
    created_by_employee_id BIGINT
        REFERENCES public.employees(employee_id)
        ON DELETE SET NULL,
    updated_by_employee_id BIGINT
        REFERENCES public.employees(employee_id)
        ON DELETE SET NULL,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    legacy_service_id TEXT,
    legacy_source TEXT,
    source_key TEXT UNIQUE,
    CHECK (
        status <> 'completed'
        OR (
            service_date IS NOT NULL
            AND LENGTH(TRIM(COALESCE(resolution_notes, ''))) >= 3
        )
    )
);

CREATE INDEX IF NOT EXISTS idx_service_tickets_customer
ON public.service_tickets (customer_id, reported_date DESC, service_ticket_id DESC);

CREATE INDEX IF NOT EXISTS idx_service_tickets_work_queue
ON public.service_tickets (status, priority, reported_date, service_ticket_id);

CREATE INDEX IF NOT EXISTS idx_service_tickets_assignee
ON public.service_tickets (assigned_employee_id, status);

-- Ticket history is append-only. It explains who created/changed a ticket and
-- preserves technician notes even as the current ticket snapshot evolves.
CREATE TABLE IF NOT EXISTS public.service_ticket_history (
    service_ticket_history_id BIGSERIAL PRIMARY KEY,
    service_ticket_id BIGINT NOT NULL
        REFERENCES public.service_tickets(service_ticket_id)
        ON DELETE CASCADE,
    event_type TEXT NOT NULL
        CHECK (event_type IN ('created', 'updated', 'status_changed')),
    from_status TEXT,
    to_status TEXT,
    note TEXT NOT NULL CHECK (LENGTH(TRIM(note)) >= 3),
    changed_by_employee_id BIGINT
        REFERENCES public.employees(employee_id)
        ON DELETE SET NULL,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_service_ticket_history_ticket
ON public.service_ticket_history (service_ticket_id, changed_at DESC);

-- Reusable live pole-box usage view for reports and dashboard summaries.
CREATE OR REPLACE VIEW public.pole_box_usage AS
WITH assignment_groups AS (
    SELECT
        UPPER(TRIM(pole_box_number)) AS normalized_box_number,
        UPPER(TRIM(port_number)) AS normalized_port_number,
        COUNT(*)::INTEGER AS assignment_count
    FROM public.customers
    WHERE NULLIF(TRIM(pole_box_number), '') IS NOT NULL
      AND NULLIF(TRIM(port_number), '') IS NOT NULL
    GROUP BY 1, 2
),
assignment_stats AS (
    SELECT
        UPPER(TRIM(pole_box_number)) AS normalized_box_number,
        COUNT(*)::INTEGER AS connected_customers,
        COUNT(*) FILTER (WHERE status = 'active')::INTEGER AS active_connections,
        COUNT(DISTINCT NULLIF(UPPER(TRIM(port_number)), ''))::INTEGER AS occupied_ports
    FROM public.customers
    WHERE NULLIF(TRIM(pole_box_number), '') IS NOT NULL
    GROUP BY 1
),
duplicate_stats AS (
    SELECT
        normalized_box_number,
        COALESCE(SUM(assignment_count - 1), 0)::INTEGER AS duplicate_assignments
    FROM assignment_groups
    WHERE assignment_count > 1
    GROUP BY normalized_box_number
)
SELECT
    pb.pole_box_id,
    pb.box_number,
    pb.location_description,
    pb.capacity,
    pb.status,
    pb.notes,
    COALESCE(a.connected_customers, 0)::INTEGER AS connected_customers,
    COALESCE(a.active_connections, 0)::INTEGER AS active_connections,
    COALESCE(a.occupied_ports, 0)::INTEGER AS occupied_ports,
    COALESCE(d.duplicate_assignments, 0)::INTEGER AS duplicate_assignments,
    CASE
        WHEN pb.capacity IS NULL THEN NULL
        ELSE GREATEST(pb.capacity - COALESCE(a.occupied_ports, 0), 0)
    END::INTEGER AS available_ports,
    (
        pb.capacity IS NOT NULL
        AND COALESCE(a.occupied_ports, 0) > pb.capacity
    ) AS over_capacity
FROM public.pole_boxes pb
LEFT JOIN assignment_stats a USING (normalized_box_number)
LEFT JOIN duplicate_stats d USING (normalized_box_number);
