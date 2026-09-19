-- Lets a technician reschedule a visit from the phone.
--
-- The customer says "come back tomorrow at nine". Until now the technician's
-- choices were to leave the job sitting as assigned with nothing on it saying
-- why, or to mark it unresolved and hand it back to the office to re-send -
-- neither of which records the one fact that matters, which is when to turn
-- up.
--
-- This is a time on the ticket, NOT a new status, and that is the important
-- decision in this file. A rescheduled job is still the technician's: it is
-- still on their phone, it still counts against their cap, and they still have
-- to go. 'assigned' with rescheduled_for set IS rescheduled. Making it a
-- status instead would have meant the latch trigger (076/079), both queue
-- queries, the one-open-install index and every IN ('assigned','in_progress')
-- in the codebase learning a new word, and any one of them missed would have
-- quietly dropped rescheduled jobs out of the cap or off the phone.
--
-- The value is meaningful only while the job is waiting. Starting it,
-- finishing it, or failing it clears the time (the API does this on every
-- status change), so a job that is re-opened weeks later does not arrive
-- carrying a stale appointment from a previous life.

ALTER TABLE public.service_tickets
    ADD COLUMN IF NOT EXISTS rescheduled_for TIMESTAMPTZ;

COMMENT ON COLUMN public.service_tickets.rescheduled_for IS
    'When the technician agreed to come back. Set from the phone; cleared by '
    'the API whenever the status changes. Only meaningful while assigned.';

-- The office's Rescheduled tab, soonest first.
CREATE INDEX IF NOT EXISTS idx_service_tickets_rescheduled
ON public.service_tickets (rescheduled_for)
WHERE rescheduled_for IS NOT NULL
  AND status = 'assigned';
