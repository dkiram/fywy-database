-- 063_add_offline_account_status.sql
--
-- Adds a sixth account status: 'offline'.
--
-- 'offline' is for a customer the OLT still lists as active (their ONT was
-- never given a deactivate command) but whose equipment has been dark long
-- enough that they are not receiving service and are not a paying customer
-- right now. It is deliberately distinct from 'disconnected':
--
--   * no OLT command was sent and none is needed,
--   * no reconnection fee is created,
--   * coming back is a plain status change, not a reconnection.
--
-- What this status turns off comes for free from existing structure:
--
--   * Billing stops. Migration 054's BEFORE INSERT trigger on
--     account_ledger_entries calls spcl_customer_service_active_on(), which
--     returns FALSE for every account whose latest account_status_history row
--     is not to_status = 'active'. An 'offline' transition writes such a row,
--     so monthly charges stop with no change to the charge generators. The
--     existing balance is preserved exactly as it is; the debt is not
--     forgiven, it is only frozen.
--   * The delinquency chase list, the dashboard delinquent count and the
--     grace/disconnection reminder emails all already filter status = 'active',
--     so an offline account drops off all of them automatically.
--
-- This migration only widens the CHECK constraints. The state-machine
-- transitions, the payment block and the "no service since" marker live in the
-- application layer.

BEGIN;

-- The status CHECK on public.customers and the two on
-- public.account_status_history were all created inline (migrations 007 and
-- 024) and never named explicitly, so drop them by discovery rather than by a
-- guessed name. The reason-length CHECK on account_status_history is left
-- alone: its definition does not mention the status column.
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
        'offline'
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
            'offline'
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
            'offline'
        )
    );

COMMIT;
