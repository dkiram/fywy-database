-- Merge one duplicate customer into another, then delete the duplicate.
--
-- ONE LINE TO EDIT: the merge_customers(...) call at the bottom.
--   merge_customers(<id to delete>, <id to keep>)
--
-- It either does the merge, or returns the exact reason it could not, AS A
-- RESULT TABLE. Nothing is ever left half-done.
--
-- Why it is built this way: a plain script aborts on the first error, every
-- later statement reports "current transaction is aborted", COMMIT quietly
-- becomes ROLLBACK, and none of that reaches a CSV export. Putting the work in
-- a function with an exception handler means the transaction can never enter
-- the aborted state - so COMMIT really commits, and a failure comes back as a
-- row you can read and send on.
--
-- The function lives in pg_temp: it disappears when the connection closes and
-- is invisible to everyone else. Nothing permanent is added to the database.

CREATE OR REPLACE FUNCTION pg_temp.merge_customers(p_duplicate INT, p_survivor INT)
RETURNS TABLE (
    outcome                 TEXT,
    detail                  TEXT,
    rows_left_on_duplicate  INT,
    payments_on_survivor    INT
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
    dropped_fees     INT := 0;
    moved_ledger     INT := 0;
    moved_payments   INT := 0;
    leftover         TEXT := '';
    reference        RECORD;
    remaining        INT;
    step             TEXT := 'starting';
    billing_note     TEXT := '';
BEGIN
    ------------------------------------------------------------------- guards
    step := 'reading both customer records';
    SELECT name, status INTO duplicate_name, duplicate_status
    FROM public.customers WHERE customer_id = p_duplicate;
    SELECT name, status INTO survivor_name, survivor_status
    FROM public.customers WHERE customer_id = p_survivor;

    IF p_duplicate = p_survivor THEN
        RAISE EXCEPTION 'Both ids are the same (%).', p_duplicate;
    END IF;
    IF duplicate_status IS NULL THEN
        RAISE EXCEPTION 'Customer % does not exist. Already merged?', p_duplicate;
    END IF;
    IF survivor_status IS NULL THEN
        RAISE EXCEPTION 'Customer % does not exist. Nothing to merge into.', p_survivor;
    END IF;

    -- Deleting a live account is a different decision from tidying away a
    -- disconnected duplicate, and not one this tool should make on its own.
    IF duplicate_status = 'active' THEN
        RAISE EXCEPTION
            'Customer % is ACTIVE. Check which record the office really wants '
            'to keep before deleting this one.', p_duplicate;
    END IF;

    IF LOWER(TRIM(duplicate_name)) IS DISTINCT FROM LOWER(TRIM(survivor_name)) THEN
        RAISE EXCEPTION 'Names differ: % is "%", % is "%". Refusing to merge.',
            p_duplicate, duplicate_name, p_survivor, survivor_name;
    END IF;

    -------------------------------------------------------- move the history
    step := 'moving payments';
    UPDATE public.payments SET customer_id = p_survivor WHERE customer_id = p_duplicate;
    GET DIAGNOSTICS moved_payments = ROW_COUNT;

    step := 'moving status history';
    UPDATE public.account_status_history SET customer_id = p_survivor
    WHERE customer_id = p_duplicate;

    -- The synthetic "reconnection fee required for disconnected legacy account"
    -- charge is an artefact of the cutover import, not money anybody was
    -- invoiced. Carrying it onto an active record would invent a debt and put a
    -- paid-up customer on the delinquent list, so it goes with the duplicate.
    -- Any REAL ledger entry still moves.
    step := 'dropping the synthetic legacy reconnection fee';
    DELETE FROM public.account_ledger_entries
    WHERE customer_id = p_duplicate
      AND entry_type = 'reconnection_fee'
      AND source_key LIKE 'legacy-reconnection-fee:%';
    GET DIAGNOSTICS dropped_fees = ROW_COUNT;

    step := 'moving any remaining ledger entries';
    UPDATE public.account_ledger_entries SET customer_id = p_survivor
    WHERE customer_id = p_duplicate;
    GET DIAGNOSTICS moved_ledger = ROW_COUNT;

    -------------------------------------------- one-row-per-customer tables
    step := 'comparing billing start dates';
    SELECT billing_start_date INTO duplicate_start
    FROM public.customer_billing_start WHERE customer_id = p_duplicate;
    SELECT billing_start_date INTO survivor_start
    FROM public.customer_billing_start WHERE customer_id = p_survivor;

    -- The survivor keeps its own floor either way, so the only question is
    -- which direction the disagreement runs.
    --   Survivor floor LATER  -> fewer chargeable months, customer billed less.
    --                            Safe: allowed, and recorded in the detail.
    --   Survivor floor EARLIER -> more chargeable months than the payment
    --                            history supports, i.e. billing for arrears
    --                            that may not be real. That one stops.
    IF duplicate_start IS NOT NULL AND survivor_start IS NOT NULL
       AND survivor_start < duplicate_start THEN
        RAISE EXCEPTION
            'Billing start on % (%) is EARLIER than on % (%), so keeping it would '
            'charge months the payment history does not support. Stopping.',
            p_survivor, survivor_start, p_duplicate, duplicate_start;
    END IF;

    IF duplicate_start IS DISTINCT FROM survivor_start THEN
        billing_note := FORMAT(
            ' Billing floors differed (%s: %s, %s: %s); kept the survivor''s, so charging starts %s.',
            p_duplicate, duplicate_start, p_survivor, survivor_start, survivor_start);
    END IF;

    step := 'removing the duplicate billing-start row';
    DELETE FROM public.customer_billing_start WHERE customer_id = p_duplicate;

    step := 'removing the duplicate legacy-balance-rebuild row';
    DELETE FROM public.legacy_balance_rebuild WHERE customer_id = p_duplicate;

    -- A ledger row can point at a rate-history row. Any still pointing at the
    -- duplicate's must be released first or the delete below raises a foreign
    -- key error. Nulled rather than repointed: it is a weak provenance link and
    -- the survivor has its own rate history.
    step := 'releasing ledger references to the duplicate rate history';
    BEGIN
        UPDATE public.account_ledger_entries
        SET customer_rate_history_id = NULL
        WHERE customer_rate_history_id IN (
            SELECT customer_rate_history_id
            FROM public.customer_rate_history
            WHERE customer_id = p_duplicate);
    EXCEPTION WHEN undefined_column THEN
        NULL;  -- schema has no such link; nothing to release
    END;

    step := 'removing the duplicate rate history';
    DELETE FROM public.customer_rate_history WHERE customer_id = p_duplicate;

    ------------------------------------------------- prove it is unreferenced
    -- Rediscovered from the live foreign keys, so a table added since this was
    -- written cannot be silently orphaned.
    step := 'checking nothing still references the duplicate';
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
        EXECUTE FORMAT('SELECT COUNT(*) FROM %s WHERE %I = $1',
                       reference.child_table, reference.child_column)
        INTO remaining
        USING p_duplicate;

        IF remaining > 0 THEN
            leftover := leftover || FORMAT(' [%s.%s: %s]',
                reference.child_table, reference.child_column, remaining);
        END IF;
    END LOOP;

    IF leftover <> '' THEN
        RAISE EXCEPTION '%', FORMAT('Still referenced, cannot delete %s:%s',
                                    p_duplicate, leftover);
    END IF;

    -------------------------------------------------------------------- finish
    step := 'writing the audit entry';
    INSERT INTO public.audit_logs (
        employee_id, actor_name, action, entity_type, entity_id,
        field_name, old_value, new_value, occurred_at)
    VALUES (
        NULL, 'Manual merge (admin, via SQL)',
        'Merged duplicate customer and deleted the duplicate',
        'customer', p_survivor::TEXT, 'customer_id',
        p_duplicate::TEXT, p_survivor::TEXT, CURRENT_TIMESTAMP);

    step := 'deleting the duplicate customer';
    DELETE FROM public.customers WHERE customer_id = p_duplicate;

    outcome := 'MERGED';
    detail  := FORMAT(
        'Moved %s payments and %s ledger entr(ies); dropped %s legacy reconnection fee(s); deleted customer %s.%s',
        moved_payments, moved_ledger, dropped_fees, p_duplicate, billing_note);
    SELECT COUNT(*) INTO rows_left_on_duplicate
      FROM public.customers WHERE customer_id = p_duplicate;
    SELECT COUNT(*) INTO payments_on_survivor
      FROM public.payments  WHERE customer_id = p_survivor;
    RETURN NEXT;

EXCEPTION WHEN OTHERS THEN
    -- Everything this function did is undone before the handler runs, so the
    -- database is exactly as it was. The error is returned, not raised.
    outcome := 'FAILED - nothing was changed';
    detail  := FORMAT('While %s: [%s] %s', step, SQLSTATE, SQLERRM);
    SELECT COUNT(*) INTO rows_left_on_duplicate
      FROM public.customers WHERE customer_id = p_duplicate;
    SELECT COUNT(*) INTO payments_on_survivor
      FROM public.payments  WHERE customer_id = p_survivor;
    RETURN NEXT;
END;
$fn$;


-- ===========================================================================
--  EDIT THIS LINE ONLY:  merge_customers(<duplicate to delete>, <keep this>)
-- ===========================================================================
BEGIN;
SELECT * FROM pg_temp.merge_customers(6634, 14658);
COMMIT;

-- The returned row is the confirmation: rows_left_on_duplicate = 0 means the
-- duplicate is gone, and payments_on_survivor is the merged total.
