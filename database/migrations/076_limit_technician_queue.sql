-- Caps a technician's queue at seven jobs, and keeps it shut until it clears.
--
-- The rule is a latch, not a ceiling. A technician is given up to seven jobs;
-- once they are holding seven, no more are added until they are holding none.
-- Finishing three of seven does NOT free three slots. The next batch goes out
-- when the last of the current one is done, whether that is this afternoon or
-- Thursday.
--
-- That gap between one and six open jobs is the entire point. A plain cap of
-- seven would let the office top the queue up every time a job closed, which
-- is the same trickle of work all day that the cap was meant to stop - a
-- technician would never see the end of their list.
--
-- One thing gets through a shut gate: an urgent ticket. The cap exists to
-- stop work being trickled at somebody all day, and a genuine emergency is
-- not that. An urgent job lands on top of the seven rather than replacing
-- one, and the latch stays shut behind it, so the exception cannot be used to
-- keep feeding a technician ordinary work. That rule lives in the API, which
-- is what decides whether an assignment is allowed; everything here only
-- keeps the record of where each technician stands.
--
-- What counts as open is 'assigned' and 'in_progress'. 'unresolved' does not:
-- it already leaves the technician's queue and goes back to the office to be
-- rescheduled (migration 074), and counting it here would mean a technician
-- who found nobody home at all seven addresses stops being given work
-- entirely, through no fault of their own.

-- The cap lives in one place so the trigger below and the API agree on it by
-- construction rather than by both remembering. Changing it is a one-line
-- migration, not a hunt through the server.
CREATE OR REPLACE FUNCTION public.technician_queue_limit()
RETURNS INTEGER
LANGUAGE SQL
IMMUTABLE
AS $$ SELECT 7; $$;


-- When the latch closed. NULL means the technician can be given work.
--
-- Kept as a timestamp rather than a boolean because "since when" is the first
-- thing anyone asks when a technician says they have not been given anything.
ALTER TABLE public.employees
    ADD COLUMN IF NOT EXISTS field_queue_locked_at TIMESTAMPTZ;

COMMENT ON COLUMN public.employees.field_queue_locked_at IS
    'Set when this technician''s open queue reached technician_queue_limit(); '
    'cleared when it empties. Maintained by trigger, never written by hand.';


/**
 * Recomputes one technician's latch from their tickets.
 *
 * Deliberately derives everything from the tickets themselves rather than
 * counting up and down as they change, so it cannot drift. Run it against
 * anybody at any time and the answer is correct.
 */
CREATE OR REPLACE FUNCTION public.refresh_technician_queue_lock(
    target_employee_id BIGINT
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    open_jobs INTEGER;
    cap INTEGER := public.technician_queue_limit();
BEGIN
    IF target_employee_id IS NULL THEN
        RETURN;
    END IF;

    SELECT COUNT(*) INTO open_jobs
    FROM public.service_tickets
    WHERE assigned_employee_id = target_employee_id
      AND status IN ('assigned', 'in_progress');

    IF open_jobs = 0 THEN
        -- Batch cleared. The gate reopens.
        UPDATE public.employees
        SET field_queue_locked_at = NULL
        WHERE employee_id = target_employee_id
          AND field_queue_locked_at IS NOT NULL;

    ELSIF open_jobs >= cap THEN
        -- Full. The gate shuts, and the timestamp is left alone if it is
        -- already set so the "since when" survives jobs moving around.
        UPDATE public.employees
        SET field_queue_locked_at = CURRENT_TIMESTAMP
        WHERE employee_id = target_employee_id
          AND field_queue_locked_at IS NULL;
    END IF;

    -- Between 1 and cap-1 the latch is left exactly as it is. Either it is
    -- NULL and this is a batch still being filled, or it is set and this is a
    -- batch being worked through. Both are correct, and telling them apart is
    -- precisely what the stored timestamp is for.
END;
$$;


CREATE OR REPLACE FUNCTION public.sync_technician_queue_lock()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM public.refresh_technician_queue_lock(OLD.assigned_employee_id);
        RETURN OLD;
    END IF;

    -- A reassignment changes two queues, and the one losing the job is the
    -- one that might now be empty.
    IF TG_OP = 'UPDATE'
       AND OLD.assigned_employee_id IS DISTINCT FROM NEW.assigned_employee_id
    THEN
        PERFORM public.refresh_technician_queue_lock(OLD.assigned_employee_id);
    END IF;

    PERFORM public.refresh_technician_queue_lock(NEW.assigned_employee_id);
    RETURN NEW;
END;
$$;


-- On the table rather than in the API, so the latch is right no matter what
-- moved the ticket: the office screen, the technician's phone, a correction
-- run by hand at the database. The API decides whether an assignment is
-- ALLOWED; this only keeps the record of where each technician stands.
DROP TRIGGER IF EXISTS service_tickets_sync_queue_lock ON public.service_tickets;

CREATE TRIGGER service_tickets_sync_queue_lock
AFTER INSERT OR DELETE OR UPDATE OF assigned_employee_id, status
ON public.service_tickets
FOR EACH ROW
EXECUTE FUNCTION public.sync_technician_queue_lock();


-- Technicians already holding a full load start out latched, rather than the
-- rule only applying to whoever happens to fill up after today.
UPDATE public.employees e
SET field_queue_locked_at = CURRENT_TIMESTAMP
WHERE e.field_queue_locked_at IS NULL
  AND (
    SELECT COUNT(*)
    FROM public.service_tickets t
    WHERE t.assigned_employee_id = e.employee_id
      AND t.status IN ('assigned', 'in_progress')
  ) >= public.technician_queue_limit();


-- The assignee dropdown and every capacity check read this.
CREATE INDEX IF NOT EXISTS idx_service_tickets_open_by_assignee
ON public.service_tickets (assigned_employee_id)
WHERE status IN ('assigned', 'in_progress');
