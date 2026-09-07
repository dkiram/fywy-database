-- Lets an applicant's installation be sent to a technician's phone.
--
-- An installation is not a service ticket in the everyday sense - the person
-- waiting at the address is an applicant, not a customer, and will not become
-- one until the office services the application. But it is the same THING to
-- the technician: an address, a name, a phone number, and a job that ends in
-- done or not done.
--
-- So it rides the rail that already exists rather than getting one of its own.
-- service_tickets.customer_id has been nullable since migration 026 (legacy
-- tickets whose customers no longer exist), so pointing a row at an
-- application instead costs nothing structural, and the queue query, the
-- latch, the history table, 'unresolved' and the whole phone app keep working
-- with no second implementation of any of them.
--
-- The alternative - a separate installations table - would have meant the
-- phone queue becoming a union, the latch trigger firing on two tables, and
-- 'unresolved' written twice. Two of everything, for one extra word on a card.

-- ---------------------------------------------------------------------------
-- 1. What kind of job this is
-- ---------------------------------------------------------------------------

ALTER TABLE public.service_tickets
    ADD COLUMN IF NOT EXISTS job_type TEXT NOT NULL DEFAULT 'repair'
        CHECK (job_type IN ('repair', 'installation'));

ALTER TABLE public.service_tickets
    ADD COLUMN IF NOT EXISTS application_id BIGINT
        REFERENCES public.applications(application_id)
        ON DELETE RESTRICT;

-- An installation names the application it is installing; a repair never does.
--
-- Deliberately says nothing about customer_id. A repair usually names a
-- customer, but the two legacy tickets from migration 026 name neither - they
-- carry a legacy_customer_id for a customer row that no longer exists - and a
-- rule written today should not invalidate history that was preserved on
-- purpose.
ALTER TABLE public.service_tickets
    DROP CONSTRAINT IF EXISTS service_tickets_installation_names_application;

ALTER TABLE public.service_tickets
    ADD CONSTRAINT service_tickets_installation_names_application
    CHECK (
        (job_type = 'installation' AND application_id IS NOT NULL)
        OR
        (job_type = 'repair' AND application_id IS NULL)
    );

-- One live installation job per application. An application that comes back
-- from an unsuccessful visit is dispatched again, and the old row stays as
-- history, so this only bites on genuine double-sends.
CREATE UNIQUE INDEX IF NOT EXISTS service_tickets_one_open_install_per_application
ON public.service_tickets (application_id)
WHERE job_type = 'installation'
  AND status IN ('assigned', 'in_progress');

CREATE INDEX IF NOT EXISTS idx_service_tickets_application
ON public.service_tickets (application_id)
WHERE application_id IS NOT NULL;


-- ---------------------------------------------------------------------------
-- 2. Two caps, counted separately
-- ---------------------------------------------------------------------------
-- Ten repairs AND ten installations, not ten jobs. They are different days'
-- work drawn from different queues, and a technician full of repairs should
-- still be able to be sent out to install.
--
-- The latch from migration 076 was a single timestamp on the employee, which
-- can only hold one gate. Two independent gates need it keyed by job type as
-- well, so it becomes a table: a row means that gate is shut.

CREATE TABLE IF NOT EXISTS public.technician_queue_state (
    employee_id BIGINT NOT NULL
        REFERENCES public.employees(employee_id)
        ON DELETE CASCADE,

    job_type TEXT NOT NULL
        CHECK (job_type IN ('repair', 'installation')),

    -- Presence is the state; the value answers "since when", which is the
    -- first thing asked when a technician says they have had nothing.
    locked_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (employee_id, job_type)
);

-- Carry over whoever was latched under the single-gate version. Everything
-- that existed before this migration is a repair.
INSERT INTO public.technician_queue_state (employee_id, job_type, locked_at)
SELECT e.employee_id, 'repair', e.field_queue_locked_at
FROM public.employees e
WHERE e.field_queue_locked_at IS NOT NULL
ON CONFLICT (employee_id, job_type) DO NOTHING;

ALTER TABLE public.employees
    DROP COLUMN IF EXISTS field_queue_locked_at;


-- ---------------------------------------------------------------------------
-- 3. The latch, now per job type
-- ---------------------------------------------------------------------------
-- The rule is unchanged from migration 076 and worth restating, because it is
-- the part that looks like a bug when read quickly: filling to the cap shuts
-- the gate, and only an EMPTY queue reopens it. Finishing four of ten frees
-- nothing. The gap between one and cap-1 is left untouched on purpose.

-- The one-argument version is gone; drop it rather than leaving an overload
-- that silently keeps the old single-gate behaviour alive.
DROP FUNCTION IF EXISTS public.refresh_technician_queue_lock(BIGINT);

CREATE OR REPLACE FUNCTION public.refresh_technician_queue_lock(
    target_employee_id BIGINT,
    target_job_type TEXT
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    open_jobs INTEGER;
    cap INTEGER := public.technician_queue_limit();
BEGIN
    IF target_employee_id IS NULL OR target_job_type IS NULL THEN
        RETURN;
    END IF;

    SELECT COUNT(*) INTO open_jobs
    FROM public.service_tickets
    WHERE assigned_employee_id = target_employee_id
      AND job_type = target_job_type
      AND status IN ('assigned', 'in_progress');

    IF open_jobs = 0 THEN
        DELETE FROM public.technician_queue_state
        WHERE employee_id = target_employee_id
          AND job_type = target_job_type;

    ELSIF open_jobs >= cap THEN
        INSERT INTO public.technician_queue_state (employee_id, job_type)
        VALUES (target_employee_id, target_job_type)
        ON CONFLICT (employee_id, job_type) DO NOTHING;
    END IF;
END;
$$;


CREATE OR REPLACE FUNCTION public.sync_technician_queue_lock()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM public.refresh_technician_queue_lock(
            OLD.assigned_employee_id, OLD.job_type
        );
        RETURN OLD;
    END IF;

    -- A reassignment changes two queues, and the one losing the job is the one
    -- that might now be empty.
    IF TG_OP = 'UPDATE'
       AND OLD.assigned_employee_id IS DISTINCT FROM NEW.assigned_employee_id
    THEN
        PERFORM public.refresh_technician_queue_lock(
            OLD.assigned_employee_id, OLD.job_type
        );
    END IF;

    PERFORM public.refresh_technician_queue_lock(
        NEW.assigned_employee_id, NEW.job_type
    );
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS service_tickets_sync_queue_lock ON public.service_tickets;

CREATE TRIGGER service_tickets_sync_queue_lock
AFTER INSERT OR DELETE OR UPDATE OF assigned_employee_id, status, job_type
ON public.service_tickets
FOR EACH ROW
EXECUTE FUNCTION public.sync_technician_queue_lock();


-- The counts both gates are read from.
CREATE INDEX IF NOT EXISTS idx_service_tickets_open_by_assignee_type
ON public.service_tickets (assigned_employee_id, job_type)
WHERE status IN ('assigned', 'in_progress');
