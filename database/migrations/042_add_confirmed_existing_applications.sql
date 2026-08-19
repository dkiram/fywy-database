-- 042_add_confirmed_existing_applications.sql
--
-- Adds the outcome Match Review was missing: "this applicant is somebody we
-- already have".
--
-- WHY
-- ---
-- Match Review offers two decisions today. The tick activates the application,
-- which creates a customer and starts billing them monthly. The cross closes it
-- as cancelled or declined. Neither of those is what a reviewer means when they
-- work out that application #412 and customer #3196 are the same human being:
-- nothing needs activating, nobody is being turned away, and the customer is
-- already being billed.
--
-- The activation screen does carry a "link existing customer" radio, but it
-- sits inside a modal titled "Activate customer" behind a button labelled
-- Activate, and it writes an activation date, package and rate onto the
-- application. Reviewers avoid it for exactly that reason, so confirmed matches
-- have been sitting in the queue with no way to clear them.
--
-- WHAT THIS ADDS
-- --------------
-- A sixth application status, 'confirmed_existing', plus the two columns
-- recording who confirmed it and when.
--
-- The row is NOT deleted. It keeps the application's own history, the audit
-- trail, and the ability to undo a confirmation made against the wrong
-- customer. It disappears from the work queue on its own: every view in the
-- applications list is a whitelist of statuses, and this status is in none of
-- the working ones.
--
-- Confirming a match deliberately changes NOTHING about the customer - not
-- their address, package, rate, status or billing. It records an identity, not
-- a transaction.

-- ---------------------------------------------------------------------------
-- 1. Who confirmed it, and when
-- ---------------------------------------------------------------------------
-- Separate from serviced_by/serviced_at on purpose. "Serviced" means an account
-- was activated off this application; reusing those columns would make a
-- confirmation indistinguishable from an activation in the audit trail.

ALTER TABLE public.applications
ADD COLUMN IF NOT EXISTS match_confirmed_by_employee_id BIGINT
    REFERENCES public.employees(employee_id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS match_confirmed_at TIMESTAMPTZ;


-- ---------------------------------------------------------------------------
-- 2. Allow the new status
-- ---------------------------------------------------------------------------
-- Migration 019 wrote the status list as an inline column CHECK, so the
-- constraint carries whatever name Postgres generated. Find it by its
-- definition rather than guessing, so this works whether the database was
-- built by 019 or rebuilt by the 038 cutover.

DO $$
DECLARE
    constraint_name TEXT;
BEGIN
    SELECT con.conname INTO constraint_name
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public'
      AND rel.relname = 'applications'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) LIKE '%match_review%'
      AND pg_get_constraintdef(con.oid) LIKE '%legacy_unresolved%'
    LIMIT 1;

    IF constraint_name IS NULL THEN
        RAISE EXCEPTION
            'could not find the applications status CHECK constraint - '
            'has migration 019 been applied?';
    END IF;

    EXECUTE FORMAT(
        'ALTER TABLE public.applications DROP CONSTRAINT %I',
        constraint_name
    );

    EXECUTE FORMAT(
        'ALTER TABLE public.applications ADD CONSTRAINT %I CHECK (status IN (%L, %L, %L, %L, %L, %L, %L))',
        constraint_name,
        'pending', 'serviced', 'cancelled', 'declined',
        'legacy_unresolved', 'match_review', 'confirmed_existing'
    );
END $$;


-- ---------------------------------------------------------------------------
-- 3. A confirmation must name the customer it confirms
-- ---------------------------------------------------------------------------
-- The same guarantee 019 gives 'serviced'. Without it a confirmed row could
-- lose the only thing that makes it meaningful.

ALTER TABLE public.applications
DROP CONSTRAINT IF EXISTS applications_confirmed_existing_has_customer;

ALTER TABLE public.applications
ADD CONSTRAINT applications_confirmed_existing_has_customer
CHECK (
    status <> 'confirmed_existing'
    OR customer_id IS NOT NULL
);


-- ---------------------------------------------------------------------------
-- 4. Finding them again
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_applications_match_confirmed
ON public.applications (match_confirmed_at DESC)
WHERE status = 'confirmed_existing';

COMMENT ON COLUMN public.applications.match_confirmed_by_employee_id IS
'Who confirmed that this applicant is the customer in customer_id. Set only '
'for status = confirmed_existing. Distinct from serviced_by_employee_id, '
'which means an account was activated from this application.';
