-- Merge customer 6868 into 14586 and delete 6868. One file. Run the whole thing.
--
-- It either does the merge, or it returns the exact reason it could not, AS A
-- RESULT TABLE. Nothing is left half-done either way.
--
-- Why it is built this way: a plain script aborts on the first error, every
-- later statement reports "current transaction is aborted", COMMIT quietly
-- becomes ROLLBACK, and none of that reaches a CSV export. Wrapping the work in
-- a function with an exception handler means the transaction can never enter
-- the aborted state - so COMMIT really commits, and a failure comes back as a
-- row you can read and send on.
--
-- The function is created in pg_temp: it disappears when the connection closes
-- and is invisible to everyone else. Nothing permanent is added to the database.

CREATE OR REPLACE FUNCTION pg_temp.merge_6868_into_14586()
RETURNS TABLE (
    outcome            TEXT,
    detail             TEXT,
    rows_for_6868      INT,
    payments_on_14586  INT
)
LANGUAGE plpgsql
AS $fn$
DECLARE
    duplicate_name   TEXT;
    survivor_name    TEXT;
    duplicate_status TEXT;
    survivor_status  TEXT;
    duplicate_start  DATE;
    survivor_start   DATE;
    dropped_fees     INT;
    moved_ledger     INT;
    moved_payments   INT;
    leftover         TEXT := '';
    reference        RECORD;
    remaining        INT;
    step             TEXT := 'starting';
    billing_note     TEXT := '';
BEGIN
    ------------------------------------------------------------------ guards
    step := 'reading both customer records';
    SELECT name, status INTO duplicate_name, duplicate_status
    FROM public.customers WHERE customer_id = 6868;
    SELECT name, status INTO survivor_name, survivor_status
    FROM public.customers WHERE customer_id = 14586;

    IF duplicate_status IS NULL THEN
        RAISE EXCEPTION 'Customer 6868 does not exist. Already merged?';
    END IF;
    IF survivor_status IS NULL THEN
        RAISE EXCEPTION 'Customer 14586 does not exist. Nothing to merge into.';
    END IF;
    IF LOWER(TRIM(duplicate_name)) IS DISTINCT FROM LOWER(TRIM(survivor_name)) THEN
        RAISE EXCEPTION 'Names differ: 6868 is "%", 14586 is "%".',
            duplicate_name, survivor_name;
    END IF;

    ------------------------------------------------------- move the history
    step := 'moving payments';
    UPDATE public.payments SET customer_id = 14586 WHERE customer_id = 6868;
    GET DIAGNOSTICS moved_payments = ROW_COUNT;

    step := 'moving status history';
    UPDATE public.account_status_history SET customer_id = 14586 WHERE customer_id = 6868;

    -- The synthetic "reconnection fee required for disconnected legacy account"
    -- charge is dropped rather than carried onto an active record; any real
    -- ledger entry still moves.
    step := 'dropping the synthetic legacy reconnection fee';
    DELETE FROM public.account_ledger_entries
    WHERE customer_id = 6868
      AND entry_type = 'reconnection_fee'
      AND source_key LIKE 'legacy-reconnection-fee:%';
    GET DIAGNOSTICS dropped_fees = ROW_COUNT;

    step := 'moving any remaining ledger entries';
    UPDATE public.account_ledger_entries SET customer_id = 14586 WHERE customer_id = 6868;
    GET DIAGNOSTICS moved_ledger = ROW_COUNT;

    ------------------------------------------- the one-row-per-customer tables
    step := 'comparing billing start dates';
    SELECT billing_start_date INTO duplicate_start
    FROM public.customer_billing_start WHERE customer_id = 6868;
    SELECT billing_start_date INTO survivor_start
    FROM public.customer_billing_start WHERE customer_id = 14586;

    -- The surviving record keeps its own floor either way, so the only question
    -- is which direction the disagreement runs.
    --
    -- Survivor floor LATER than the duplicate's  -> fewer chargeable months, the
    --   customer is billed less. Safe: allowed, and recorded in the detail so
    --   the decision is visible afterwards.
    -- Survivor floor EARLIER than the duplicate's -> MORE chargeable months than
    --   the duplicate's own payment history justifies, i.e. billing somebody for
    --   arrears that may not be real. That one stops.
    --
    -- The first version of this guard had the test inverted: it blocked the safe
    -- direction and would have waved the overcharging one straight through.
    IF duplicate_start IS NOT NULL AND survivor_start IS NOT NULL
       AND survivor_start < duplicate_start THEN
        RAISE EXCEPTION
            'Billing start on 14586 (%) is EARLIER than on 6868 (%), so keeping it '
            'would charge months the payment history does not support. Stopping.',
            survivor_start, duplicate_start;
    END IF;

    IF duplicate_start IS DISTINCT FROM survivor_start THEN
        billing_note := FORMAT(' Billing floors differed (6868 %s, 14586 %s); kept 14586''s, so charging starts %s.',
                               duplicate_start, survivor_start, survivor_start);
    END IF;

    step := 'removing 6868 billing start row';
    DELETE FROM public.customer_billing_start WHERE customer_id = 6868;

    step := 'removing 6868 legacy balance rebuild row';
    DELETE FROM public.legacy_balance_rebuild WHERE customer_id = 6868;

    -- Ledger rows can point at a rate-history row. Any that still point at
    -- 6868's are released first, otherwise deleting it raises a foreign-key
    -- error. Set to NULL rather than repointed: it is a weak provenance link,
    -- and the surviving account has its own rate history.
    step := 'releasing ledger references to 6868 rate history';
    BEGIN
        EXECUTE $sql$
            UPDATE public.account_ledger_entries
            SET customer_rate_history_id = NULL
            WHERE customer_rate_history_id IN (
                SELECT customer_rate_history_id
                FROM public.customer_rate_history
                WHERE customer_id = 6868)
        $sql$;
    EXCEPTION WHEN undefined_column THEN
        -- Column is named differently or absent in this schema; nothing to release.
        NULL;
    END;

    step := 'removing 6868 rate history';
    DELETE FROM public.customer_rate_history WHERE customer_id = 6868;

    ----------------------------------------------------- prove it is unreferenced
    step := 'checking nothing still references 6868';
    FOR reference IN
        SELECT con.conrelid::REGCLASS::TEXT AS child_table,
               att.attname::TEXT            AS child_column
        FROM pg_constraint con
        JOIN LATERAL UNNEST(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON TRUE
        JOIN pg_attribute att
          ON att.attrelid = con.conrelid AND att.attnum = k.attnum
        WHERE con.contype = 'f'
          AND con.confrelid = 'public.customers'::REGCLASS
    LOOP
        EXECUTE FORMAT('SELECT COUNT(*) FROM %s WHERE %I = 6868',
                       reference.child_table, reference.child_column)
        INTO remaining;
        IF remaining > 0 THEN
            leftover := leftover || FORMAT(' [%s.%s: %s]',
                reference.child_table, reference.child_column, remaining);
        END IF;
    END LOOP;

    IF leftover <> '' THEN
        RAISE EXCEPTION 'Still referenced, cannot delete 6868:%', leftover;
    END IF;

    ------------------------------------------------------------------- finish
    step := 'writing the audit entry';
    INSERT INTO public.audit_logs (
        employee_id, actor_name, action, entity_type, entity_id,
        field_name, old_value, new_value, occurred_at)
    VALUES (
        NULL, 'Manual merge (admin, via SQL)',
        'Merged duplicate customer and deleted the duplicate',
        'customer', '14586', 'customer_id', '6868', '14586', CURRENT_TIMESTAMP);

    step := 'deleting customer 6868';
    DELETE FROM public.customers WHERE customer_id = 6868;

    outcome := 'MERGED';
    detail  := FORMAT('Moved %s payments and %s ledger entr(ies); dropped %s legacy reconnection fee(s); deleted customer 6868.%s',
                      moved_payments, moved_ledger, dropped_fees, billing_note);
    SELECT COUNT(*) INTO rows_for_6868     FROM public.customers WHERE customer_id = 6868;
    SELECT COUNT(*) INTO payments_on_14586 FROM public.payments  WHERE customer_id = 14586;
    RETURN NEXT;

EXCEPTION WHEN OTHERS THEN
    -- Everything the function did is undone before this runs, so the database
    -- is exactly as it was. The error is returned instead of aborting.
    outcome := 'FAILED - nothing was changed';
    detail  := FORMAT('While %s: [%s] %s', step, SQLSTATE, SQLERRM);
    SELECT COUNT(*) INTO rows_for_6868     FROM public.customers WHERE customer_id = 6868;
    SELECT COUNT(*) INTO payments_on_14586 FROM public.payments  WHERE customer_id = 14586;
    RETURN NEXT;
END;
$fn$;

-- Run it. The transaction cannot abort, so COMMIT means COMMIT.
BEGIN;
SELECT * FROM pg_temp.merge_6868_into_14586();
COMMIT;

-- Independent confirmation, in a fresh transaction.
SELECT
    CASE WHEN EXISTS (SELECT 1 FROM public.customers WHERE customer_id = 6868)
         THEN '6868 STILL EXISTS - see the detail column above'
         ELSE '6868 IS GONE - merge complete'
    END                                                               AS final_state,
    (SELECT COUNT(*) FROM public.payments WHERE customer_id = 14586)  AS payments_on_14586;
