-- Lets a technician hand a job back to the office.
--
-- The cases this is for: the technician ran out of day, the job needs a
-- ladder or a skill they do not have, they are off sick tomorrow. Until now
-- the only ways a job left their phone were Done, Unresolved, or the office
-- noticing and moving it - and Unresolved means something specific (the
-- technician got there and the customer was not), which is the wrong thing to
-- record for "I cannot do this one".
--
-- Handing back puts the ticket back to 'open' with nobody assigned, which is
-- exactly where a job waiting for a technician already lives. That choice is
-- what keeps this small: the office's Open view (its landing view), the cap
-- trigger, both phone queries and the one-open-install index all already
-- understand 'open' + unassigned, so none of them needs to learn a new word.
-- The three columns below are only the label on it - who handed it back, when,
-- and why - so the office can see the difference between a job nobody has been
-- sent to yet and one that came back.

ALTER TABLE public.service_tickets
    ADD COLUMN IF NOT EXISTS handed_back_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS handed_back_by_employee_id BIGINT
        REFERENCES public.employees(employee_id)
        ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS handback_reason TEXT;

-- A hand-back without a reason tells the next person nothing, and the reason
-- is the whole point of the label. Same rule the database already applies to
-- unresolved (migration 074).
ALTER TABLE public.service_tickets
    DROP CONSTRAINT IF EXISTS service_tickets_handback_has_reason;

ALTER TABLE public.service_tickets
    ADD CONSTRAINT service_tickets_handback_has_reason
    CHECK (
        (handed_back_at IS NULL AND handback_reason IS NULL)
        OR
        (handed_back_at IS NOT NULL AND LENGTH(TRIM(COALESCE(handback_reason, ''))) >= 3)
    );


-- The label comes off the moment somebody is given the job again.
--
-- On the table rather than in each route, because a ticket gets a technician
-- from three places - the office edit form, the applications dispatch, and any
-- correction run by hand - and a stale "handed back by Andre" sitting on a job
-- Devon is now doing would be worse than no label at all.
CREATE OR REPLACE FUNCTION public.clear_handback_on_assignment()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.assigned_employee_id IS NOT NULL
       AND NEW.handed_back_at IS NOT NULL
    THEN
        NEW.handed_back_at := NULL;
        NEW.handed_back_by_employee_id := NULL;
        NEW.handback_reason := NULL;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS service_tickets_clear_handback ON public.service_tickets;

CREATE TRIGGER service_tickets_clear_handback
BEFORE INSERT OR UPDATE OF assigned_employee_id
ON public.service_tickets
FOR EACH ROW
EXECUTE FUNCTION public.clear_handback_on_assignment();
