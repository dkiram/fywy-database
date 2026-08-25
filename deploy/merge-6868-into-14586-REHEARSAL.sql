-- Merge duplicate customer 6868 into 14586, then delete 6868.
--
-- Shomorrey Smith exists twice, duplicated in Access down to the activation
-- date; both rows were created by the same cutover import. 14586 is the record
-- the office works with and the one staff have taken a counter payment against.
-- 6868 is the one that holds the HISTORY: 39 imported payments totalling
-- 84,000 against 14586's 6.
--
-- So this is not a delete, it is a move followed by a delete. Deleting 6868
-- outright would destroy 39 receipts that reconcile to Access, and Postgres
-- refuses it anyway while payments still point there.
--
--   *** THIS RUNS AS A REHEARSAL AND CHANGES NOTHING. ***
--   The last line is ROLLBACK. Read the output, and only when the AFTER
--   figures look right, change that single word to COMMIT and run it again.
--
-- Safe to run repeatedly while it ends in ROLLBACK.

BEGIN;

-- ---------------------------------------------------------------------------
-- Guards. Every assumption this script makes is checked before it writes
-- anything, so a surprise stops the whole transaction instead of half-merging.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    duplicate_status TEXT;
    survivor_status  TEXT;
    duplicate_name   TEXT;
    survivor_name    TEXT;
BEGIN
    SELECT status, name INTO duplicate_status, duplicate_name
    FROM public.customers WHERE customer_id = 6868;
    SELECT status, name INTO survivor_status, survivor_name
    FROM public.customers WHERE customer_id = 14586;

    IF duplicate_status IS NULL THEN
        RAISE EXCEPTION 'Customer 6868 does not exist - already merged?';
    END IF;
    IF survivor_status IS NULL THEN
        RAISE EXCEPTION 'Customer 14586 does not exist. Nothing to merge into.';
    END IF;

    -- Names must still match. If they do not, the wrong pair is being merged
    -- and 39 payments would land on a stranger's account.
    IF LOWER(TRIM(duplicate_name)) IS DISTINCT FROM LOWER(TRIM(survivor_name)) THEN
        RAISE EXCEPTION
            'Names differ: 6868 is "%" but 14586 is "%". Refusing to merge.',
            duplicate_name, survivor_name;
    END IF;

    -- 14586 is meant to be the live account. If it is not active any more,
    -- something changed since this was planned and it needs another look.
    IF survivor_status <> 'active' THEN
        RAISE EXCEPTION
            'Customer 14586 is "%", expected "active". Stopping.', survivor_status;
    END IF;

    RAISE NOTICE 'Guards passed: merging % (6868, %) into % (14586, %)',
        duplicate_name, duplicate_status, survivor_name, survivor_status;
END;
$$;

-- ---------------------------------------------------------------------------
-- BEFORE
-- ---------------------------------------------------------------------------
SELECT
    'BEFORE' AS phase, customer_id,
    (SELECT COUNT(*) FROM public.payments p
      WHERE p.customer_id = c.customer_id)                        AS payments,
    (SELECT COALESCE(SUM(amount_paid), 0) FROM public.payments p
      WHERE p.customer_id = c.customer_id AND p.voided_at IS NULL) AS live_total,
    (SELECT COUNT(*) FROM public.account_ledger_entries l
      WHERE l.customer_id = c.customer_id)                        AS ledger_rows,
    (SELECT COALESCE(SUM(amount), 0) FROM public.account_ledger_entries l
      WHERE l.customer_id = c.customer_id)                        AS ledger_net,
    c.status
FROM public.customers c
WHERE c.customer_id IN (6868, 14586)
ORDER BY c.customer_id;

-- The ledger row being moved, shown in full so its effect on the surviving
-- balance is visible rather than implied.
SELECT 'ledger entry moving from 6868' AS note, *
FROM public.account_ledger_entries
WHERE customer_id = 6868;

-- ---------------------------------------------------------------------------
-- 1. The money and its history. payment_id is the primary key and no unique
--    constraint involves customer_id, so these simply re-point. Receipt
--    numbers, dates and amounts are untouched.
-- ---------------------------------------------------------------------------
UPDATE public.payments   SET customer_id = 14586 WHERE customer_id = 6868;
UPDATE public.account_status_history SET customer_id = 14586 WHERE customer_id = 6868;

-- The ledger needs judgement rather than a blanket move.
--
-- 6868's only entry is a 1,500 reconnection_fee with source_key
-- 'legacy-reconnection-fee:6868' and is_verified = false: not money anybody
-- handed over or was invoiced for, but a charge the cutover import generated
-- for every legacy account that arrived disconnected, as the precondition for
-- switching it back on.
--
-- 14586 is active and was never disconnected. Carrying that fee across would
-- invent a 1,500 debt for a customer whose balance is zero, and put them on
-- the delinquent list for a reconnection that is not happening. So the
-- synthetic legacy fee is dropped with the duplicate, and anything else on the
-- ledger - real charges, real payments - still moves.
DO $$
DECLARE
    dropped INT;
    moved   INT;
BEGIN
    DELETE FROM public.account_ledger_entries
    WHERE customer_id = 6868
      AND entry_type = 'reconnection_fee'
      AND source_key LIKE 'legacy-reconnection-fee:%';
    GET DIAGNOSTICS dropped = ROW_COUNT;

    UPDATE public.account_ledger_entries
    SET customer_id = 14586
    WHERE customer_id = 6868;
    GET DIAGNOSTICS moved = ROW_COUNT;

    RAISE NOTICE 'Ledger: dropped % synthetic legacy reconnection fee(s), moved % other entr(ies)',
        dropped, moved;

    -- If anything unexpected moved across, say so loudly: it will change the
    -- surviving balance and somebody should look at it.
    IF moved > 0 THEN
        RAISE NOTICE 'NOTE: % ledger entr(ies) moved onto 14586 and WILL affect its balance. Check the AFTER figures.', moved;
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. The three per-customer rows that CANNOT move: each is keyed one row per
--    customer, so 6868's copy collides with the one 14586 already owns.
--    14586's own rows are correct for the surviving account, so 6868's are
--    dropped rather than merged.
--
--    customer_billing_start is the arrears floor from migration 041. Dropping
--    6868's copy is only safe while 14586's floor is no later than it - if
--    6868's were earlier, the surviving account would lose chargeable months.
--    That is asserted rather than assumed.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    duplicate_start DATE;
    survivor_start  DATE;
BEGIN
    SELECT billing_start_date INTO duplicate_start
    FROM public.customer_billing_start WHERE customer_id = 6868;
    SELECT billing_start_date INTO survivor_start
    FROM public.customer_billing_start WHERE customer_id = 14586;

    IF duplicate_start IS NOT NULL AND survivor_start IS NOT NULL
       AND duplicate_start < survivor_start THEN
        RAISE EXCEPTION
            'Billing start on 6868 (%) is EARLIER than on 14586 (%). Dropping '
            '6868''s row would move the arrears floor forward. Stopping so this '
            'can be decided deliberately.', duplicate_start, survivor_start;
    END IF;

    RAISE NOTICE 'Billing start: 6868=%, 14586=% (keeping 14586''s)',
        duplicate_start, survivor_start;
END;
$$;

-- ---------------------------------------------------------------------------
-- Before touching rate history: account_ledger_entries carries a
-- customer_rate_history_id, so deleting 6868's rate row while any ledger entry
-- still points at it raises a foreign-key error, aborts the transaction, and
-- makes COMMIT report ROLLBACK. Check for it and say so in plain words.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    still_referenced INT;
BEGIN
    SELECT COUNT(*) INTO still_referenced
    FROM public.account_ledger_entries l
    WHERE l.customer_rate_history_id IN (
        SELECT customer_rate_history_id
        FROM public.customer_rate_history
        WHERE customer_id = 6868);

    IF still_referenced > 0 THEN
        RAISE EXCEPTION
            '% ledger entr(ies) still point at 6868''s rate history, so its rate '
            'row cannot be deleted. Tell me this number and I will repoint them '
            'instead of dropping them.', still_referenced;
    END IF;
END;
$$;

DELETE FROM public.customer_billing_start WHERE customer_id = 6868;
DELETE FROM public.legacy_balance_rebuild WHERE customer_id = 6868;
DELETE FROM public.customer_rate_history  WHERE customer_id = 6868;

-- ---------------------------------------------------------------------------
-- 3. Prove nothing anywhere still points at 6868.
--
--    Rediscovered from the live foreign keys rather than from the list above,
--    so a table added since this was written cannot be silently orphaned. If
--    anything remains, the whole transaction aborts and names it.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    leftover TEXT := '';
    reference RECORD;
    remaining INT;
BEGIN
    FOR reference IN
        SELECT con.conrelid::REGCLASS::TEXT AS child_table,
               att.attname::TEXT            AS child_column
        FROM pg_constraint con
        JOIN LATERAL UNNEST(con.conkey) WITH ORDINALITY AS key(attnum, ord) ON TRUE
        JOIN pg_attribute att
          ON att.attrelid = con.conrelid AND att.attnum = key.attnum
        WHERE con.contype = 'f'
          AND con.confrelid = 'public.customers'::REGCLASS
    LOOP
        EXECUTE FORMAT('SELECT COUNT(*) FROM %s WHERE %I = 6868',
                       reference.child_table, reference.child_column)
        INTO remaining;

        IF remaining > 0 THEN
            leftover := leftover || FORMAT(E'\n  %s.%s: %s row(s)',
                reference.child_table, reference.child_column, remaining);
        END IF;
    END LOOP;

    IF leftover <> '' THEN
        RAISE EXCEPTION 'Still referencing 6868, refusing to delete:%', leftover;
    END IF;

    RAISE NOTICE 'Nothing references 6868 any more. Safe to delete.';
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. Record why 14586 suddenly has decades of history, then remove 6868.
--    Without this line the merge is invisible to anyone reading the account
--    later.
-- ---------------------------------------------------------------------------
INSERT INTO public.audit_logs (
    employee_id, actor_name, action, entity_type, entity_id,
    field_name, old_value, new_value, occurred_at
)
SELECT
    NULL,
    'Manual merge (admin, via SQL)',
    'Merged duplicate customer and deleted the duplicate',
    'customer',
    '14586',
    'customer_id',
    '6868',
    '14586',
    CURRENT_TIMESTAMP;

DELETE FROM public.customers WHERE customer_id = 6868;

-- ---------------------------------------------------------------------------
-- AFTER
-- ---------------------------------------------------------------------------
SELECT
    'AFTER' AS phase, customer_id,
    (SELECT COUNT(*) FROM public.payments p
      WHERE p.customer_id = c.customer_id)                        AS payments,
    (SELECT COALESCE(SUM(amount_paid), 0) FROM public.payments p
      WHERE p.customer_id = c.customer_id AND p.voided_at IS NULL) AS live_total,
    (SELECT COUNT(*) FROM public.account_ledger_entries l
      WHERE l.customer_id = c.customer_id)                        AS ledger_rows,
    (SELECT COALESCE(SUM(amount), 0) FROM public.account_ledger_entries l
      WHERE l.customer_id = c.customer_id)                        AS ledger_net,
    c.status
FROM public.customers c
WHERE c.customer_id IN (6868, 14586)
ORDER BY c.customer_id;

-- 6868 must be gone and 14586 must hold 45 payments.
SELECT
    (SELECT COUNT(*) FROM public.customers WHERE customer_id = 6868) AS customer_6868_rows,
    (SELECT COUNT(*) FROM public.payments  WHERE customer_id = 14586) AS payments_on_14586;

-- What the surviving account now owes. This should be UNCHANGED from the
-- BEFORE figure for 14586 - the merge moves history, not debt.
SELECT * FROM public.customer_billing_status WHERE customer_id = 14586;

-- ---------------------------------------------------------------------------
-- Report the simulated outcome while still inside the transaction. This runs
-- only if every statement above succeeded, so seeing it at all is the proof
-- that the merge works. The rollback immediately after undoes it.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    survivor_payments INT;
    duplicate_rows    INT;
BEGIN
    SELECT COUNT(*) INTO survivor_payments FROM public.payments WHERE customer_id = 14586;
    SELECT COUNT(*) INTO duplicate_rows    FROM public.customers WHERE customer_id = 6868;

    RAISE NOTICE '=====================================================';
    RAISE NOTICE 'REHEARSAL SUCCEEDED. Simulated result:';
    RAISE NOTICE '  14586 would hold % payments', survivor_payments;
    RAISE NOTICE '  6868 rows remaining: %', duplicate_rows;
    RAISE NOTICE 'Nothing is being saved - this file always rolls back.';
    RAISE NOTICE 'To apply it for real, run merge-6868-into-14586-COMMIT.sql';
    RAISE NOTICE '=====================================================';
END;
$$;

-- ---------------------------------------------------------------------------
-- REHEARSAL. This file always rolls back - it can never change anything.
-- When the figures look right, run merge-6868-into-14586-COMMIT.sql instead.
-- ---------------------------------------------------------------------------
ROLLBACK;
-- ---------------------------------------------------------------------------
-- Runs in a NEW transaction, after the rollback. These numbers are the live
-- ones, so they SHOULD show 6868 still present - that is the rehearsal doing
-- its job, not a failure.
-- ---------------------------------------------------------------------------
SELECT
    'REHEARSAL - nothing was saved, which is correct for this file. '
    'If the message pane shows "REHEARSAL SUCCEEDED" above, run '
    'merge-6868-into-14586-COMMIT.sql to apply it.'                  AS outcome,
    (SELECT COUNT(*) FROM public.customers WHERE customer_id = 6868)  AS rows_for_6868,
    (SELECT COUNT(*) FROM public.payments  WHERE customer_id = 14586) AS payments_on_14586;

