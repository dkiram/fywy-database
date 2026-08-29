-- 068_add_terminated_account_status.sql
--
-- A terminated customer remains in the database with their complete payment,
-- package, service, OLT-assignment and audit history. Only the current
-- subscription ends: the account can no longer be billed or assigned an OLT.

-- Widen the current-status and immutable-history constraints. Discover the
-- constraints by definition because older installations may still carry the
-- generated names from migrations 007/024 rather than the later named ones.
DO $$
DECLARE
    target RECORD;
BEGIN
    FOR target IN
        SELECT conrelid::regclass AS table_name, conname
        FROM pg_constraint
        WHERE contype = 'c'
          AND conrelid IN (
              'public.customers'::regclass,
              'public.account_status_history'::regclass
          )
          AND pg_get_constraintdef(oid) ILIKE '%status%'
          AND pg_get_constraintdef(oid) ILIKE '%active%'
    LOOP
        EXECUTE format(
            'ALTER TABLE %s DROP CONSTRAINT %I',
            target.table_name,
            target.conname
        );
    END LOOP;
END $$;

ALTER TABLE public.customers
    ADD CONSTRAINT customers_status_check
    CHECK (status IN (
        'active',
        'disconnected',
        'pending_reconnection',
        'closed',
        'archived',
        'offline',
        'suspended',
        'terminated'
    ));

ALTER TABLE public.account_status_history
    ADD CONSTRAINT account_status_history_from_status_check
    CHECK (
        from_status IS NULL
        OR from_status IN (
            'active',
            'disconnected',
            'pending_reconnection',
            'closed',
            'archived',
            'offline',
            'suspended',
            'terminated'
        )
    );

ALTER TABLE public.account_status_history
    ADD CONSTRAINT account_status_history_to_status_check
    CHECK (
        to_status IN (
            'active',
            'disconnected',
            'pending_reconnection',
            'closed',
            'archived',
            'offline',
            'suspended',
            'terminated'
        )
    );

-- Keep the OLT action journal's status vocabulary complete even though the
-- termination workflow releases the mapping without issuing a live command.
ALTER TABLE public.olt_action_attempts
    DROP CONSTRAINT IF EXISTS olt_action_attempts_account_status_before_check,
    DROP CONSTRAINT IF EXISTS olt_action_attempts_account_status_after_check;

ALTER TABLE public.olt_action_attempts
    ADD CONSTRAINT olt_action_attempts_account_status_before_check
    CHECK (
        account_status_before IS NULL
        OR account_status_before IN (
            'active', 'disconnected', 'pending_reconnection', 'closed',
            'archived', 'offline', 'suspended', 'terminated'
        )
    ),
    ADD CONSTRAINT olt_action_attempts_account_status_after_check
    CHECK (
        account_status_after IS NULL
        OR account_status_after IN (
            'active', 'disconnected', 'pending_reconnection', 'closed',
            'archived', 'offline', 'suspended', 'terminated'
        )
    );

-- The effective-dated ledger guard installed by migrations 054 and 067 reads
-- account_status_history before inserting a monthly or suspension charge. The
-- termination endpoint writes that history row in the same transaction as the
-- customer snapshot, so dates before termination remain reconstructable while
-- the termination date and every date after it are permanently non-billable.
