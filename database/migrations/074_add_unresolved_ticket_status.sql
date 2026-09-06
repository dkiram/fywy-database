-- Adds 'unresolved' to the service-ticket lifecycle.
--
-- Until now a technician who drove out and found nobody home had two bad
-- choices: leave the ticket in progress, where it sits forever looking like
-- live work, or mark it cancelled, which reads as "we decided not to do this"
-- and hides a customer who still has a fault. Neither says what happened.
--
-- 'unresolved' is the third ending: the visit happened, the work did not.
-- Customer not at home, nobody answering the phone, gate locked. It is a
-- closed state like completed and cancelled — it leaves the technician's
-- queue — but it means the job still needs re-scheduling, which is why the
-- attention view below now counts it.

ALTER TABLE public.service_tickets
    DROP CONSTRAINT IF EXISTS service_tickets_status_check;

ALTER TABLE public.service_tickets
    ADD CONSTRAINT service_tickets_status_check
    CHECK (
        status IN (
            'open',
            'assigned',
            'in_progress',
            'completed',
            'unresolved',
            'cancelled'
        )
    );

-- An unresolved ticket without a reason is worse than no ticket at all: the
-- next person to pick it up learns only that somebody gave up. The note is
-- the entire value of the state, so the database insists on one.
--
-- Deliberately weaker than the rule for 'completed', which also demands a
-- service_date. A technician who never got through the gate has nothing
-- useful to put in a "work performed on" field, and forcing a date would
-- just get today's date typed in to clear the error.
ALTER TABLE public.service_tickets
    DROP CONSTRAINT IF EXISTS service_tickets_unresolved_needs_reason;

ALTER TABLE public.service_tickets
    ADD CONSTRAINT service_tickets_unresolved_needs_reason
    CHECK (
        status <> 'unresolved'
        OR LENGTH(TRIM(COALESCE(resolution_notes, ''))) >= 3
    );
