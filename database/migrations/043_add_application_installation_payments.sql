-- Lets the counter record an installation fee at the moment an application is
-- taken, before the applicant is a customer.
--
-- The money arrives on application day. Until now there was nowhere to put it:
-- payments hang off customers, and the applicant does not become one until
-- somebody activates them, which can be days later. So an office that collected
-- J$11,000 across the counter either left it out of the day's takings or
-- invented a customer to hold it.
--
-- The fix is one nullable link. A payment may now name an application instead
-- of a customer. Activation re-points that same row at the new customer, so it
-- becomes their first payment without a second row being created and without
-- the day's figures moving. Cancelling the application voids it.

ALTER TABLE public.payments
ADD COLUMN IF NOT EXISTS application_id BIGINT
    REFERENCES public.applications(application_id) ON DELETE RESTRICT;

-- One live installation payment per application. Retrying a submission, or two
-- clerks entering the same walk-in, cannot produce two collections. Voided rows
-- are excluded so the index never blocks a legitimate correction.
CREATE UNIQUE INDEX IF NOT EXISTS payments_application_active_unique
ON public.payments (application_id)
WHERE application_id IS NOT NULL AND voided_at IS NULL;

-- The application drawer and the activation handoff both look a payment up by
-- application, including voided ones.
CREATE INDEX IF NOT EXISTS idx_payments_application
ON public.payments (application_id)
WHERE application_id IS NOT NULL;

-- Deliberately no CHECK requiring every payment to name a customer or an
-- application. The 432,214 imported Access rows were never audited for that,
-- and a constraint they might fail would only surface years from now, on
-- whichever routine UPDATE happened to touch an old row. The application-side
-- rule is enforced in server/src/routes/applications.ts, where the payment is
-- created.
