-- Raises the technician job cap from seven to ten.
--
-- A judgement call about how much work fits in a day, not a change to how the
-- rule works: ten still latches shut the moment it is reached, and still only
-- reopens when the queue is empty. Migration 076 has the reasoning.

CREATE OR REPLACE FUNCTION public.technician_queue_limit()
RETURNS INTEGER
LANGUAGE SQL
IMMUTABLE
AS $$ SELECT 10; $$;


-- Anyone latched under the old cap is reconsidered against the new one.
--
-- Without this, a technician holding seven jobs stays shut out until they
-- clear all seven, because the latch only reopens at zero - so raising the
-- cap would have no effect on the very people it was raised for, and would
-- look like it simply had not worked. Clearing the latch below the new cap
-- lets them be topped up to ten today.
--
-- This is a one-off correction that belongs to the cap CHANGE, not to the
-- rule. It is deliberately not part of refresh_technician_queue_lock: doing
-- it there would turn the latch into a plain ceiling and undo migration 076
-- entirely.
UPDATE public.employees e
SET field_queue_locked_at = NULL
WHERE e.field_queue_locked_at IS NOT NULL
  AND (
    SELECT COUNT(*)
    FROM public.service_tickets t
    WHERE t.assigned_employee_id = e.employee_id
      AND t.status IN ('assigned', 'in_progress')
  ) < public.technician_queue_limit();


-- And anyone already at or over ten is latched, in case the cap ever moves
-- downwards in a later migration.
UPDATE public.employees e
SET field_queue_locked_at = CURRENT_TIMESTAMP
WHERE e.field_queue_locked_at IS NULL
  AND (
    SELECT COUNT(*)
    FROM public.service_tickets t
    WHERE t.assigned_employee_id = e.employee_id
      AND t.status IN ('assigned', 'in_progress')
  ) >= public.technician_queue_limit();
