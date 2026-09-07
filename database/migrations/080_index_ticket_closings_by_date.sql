-- Indexes for the technician report: "what did each technician close, and when".
--
-- The report counts closing events out of service_ticket_history rather than
-- off the ticket, for the same reason the service queue's close-date filter
-- does (migration note in 66990ee): completed_at is set only for 'completed'
-- and is NULL for cancelled and unresolved, service_date is usually NULL on an
-- unresolved job because nobody got through the gate, and updated_at moves
-- again every time somebody edits a note months later. The history is
-- append-only and records the moment each status was actually set.
--
-- Neither index changes what any query returns. Both exist because the report
-- sweeps a date range across every technician at once, which is a different
-- shape of question from anything asked of these tables before.

-- 1. The closing events themselves.
--
-- The existing index on this table is (service_ticket_id, changed_at DESC),
-- which answers "show me one ticket's history" and is the wrong way round for
-- "show me every closing in September". This one leads on the date.
--
-- The predicate is written to match the report's WHERE clause exactly, so the
-- planner can prove the index covers it. `from_status IS DISTINCT FROM
-- to_status` is not decoration: a note-only edit writes a history row whose
-- to_status is the status the ticket already had, so without that test a note
-- typed on a completed job in December would read as a job closed in December.
CREATE INDEX IF NOT EXISTS idx_service_ticket_history_closings
ON public.service_ticket_history (changed_at, service_ticket_id)
WHERE to_status IN ('completed', 'unresolved', 'cancelled')
  AND from_status IS DISTINCT FROM to_status;

-- 2. Every ticket belonging to a technician, not just the live ones.
--
-- Migration 076 indexed (assigned_employee_id) WHERE status IN ('assigned',
-- 'in_progress') to keep the queue cap cheap, and that partial index still
-- serves the report's "open now" column. But the closed counts have to reach
-- tickets in every status, including the finished ones the partial index
-- deliberately excludes, so they need an unfiltered one.
CREATE INDEX IF NOT EXISTS idx_service_tickets_assigned_employee
ON public.service_tickets (assigned_employee_id)
WHERE assigned_employee_id IS NOT NULL;
