-- Merge customer 11023 into 14977 (the record the office is keeping),
-- then delete 11023.
--
-- Run the whole file. Nothing to edit.
--
-- Plain SQL only - no functions, no DO blocks, no dollar quotes - because
-- those are what TablePlus was mis-handling.
--
-- It is one transaction. If any statement fails, the whole thing is abandoned
-- and NOTHING changes; you will see a red error and the COMMIT will report
-- ROLLBACK. If that happens, paste me the FIRST error line.
--
-- For a different pair later: find-and-replace 11023 with the id to delete and
-- 14977 with the id to keep. They appear only inside the transaction below.


-- ===========================================================================
-- BEFORE - check this looks like the right two people
-- ===========================================================================
SELECT
    c.customer_id, c.name, c.address, c.status,
    (SELECT COUNT(*) FROM public.payments p WHERE p.customer_id = c.customer_id) AS payments,
    (SELECT COALESCE(SUM(amount_paid), 0) FROM public.payments p
      WHERE p.customer_id = c.customer_id AND p.voided_at IS NULL)               AS live_total,
    (SELECT COALESCE(SUM(amount), 0) FROM public.account_ledger_entries l
      WHERE l.customer_id = c.customer_id)                                       AS ledger_net,
    (SELECT billing_start_date FROM public.customer_billing_start b
      WHERE b.customer_id = c.customer_id)                                       AS billing_starts
FROM public.customers c
WHERE c.customer_id IN (11023, 14977)
ORDER BY c.customer_id;


-- ===========================================================================
-- THE MERGE
-- ===========================================================================
BEGIN;

-- 1. The money and its history move to the surviving record. Receipt numbers,
--    dates and amounts are untouched.
UPDATE public.payments
   SET customer_id = 14977
 WHERE customer_id = 11023;

UPDATE public.account_status_history
   SET customer_id = 14977
 WHERE customer_id = 11023;

-- 2. Drop the synthetic "reconnection fee required for disconnected legacy
--    account" charge. It is an artefact of the cutover import, not money
--    anybody was invoiced; moving it onto an active record would invent a debt
--    and put a paid-up customer on the delinquent list.
DELETE FROM public.account_ledger_entries
 WHERE customer_id = 11023
   AND entry_type = 'reconnection_fee'
   AND source_key LIKE 'legacy-reconnection-fee:%';

-- 3. Any REAL ledger entry still moves.
UPDATE public.account_ledger_entries
   SET customer_id = 14977
 WHERE customer_id = 11023;

-- 4. Release ledger rows that point at the duplicate's rate history, or the
--    delete in step 5 hits a foreign key.
UPDATE public.account_ledger_entries
   SET customer_rate_history_id = NULL
 WHERE customer_rate_history_id IN (
       SELECT customer_rate_history_id
         FROM public.customer_rate_history
        WHERE customer_id = 11023);

-- 5. The three tables keyed one row per customer. The duplicate's rows cannot
--    move onto 14977 because 14977 already has its own, so they go. Keeping
--    14977's billing floor is deliberate: its floor is later, which charges
--    the customer for fewer months, and it is the floor live billing already
--    uses.
DELETE FROM public.customer_billing_start WHERE customer_id = 11023;
DELETE FROM public.legacy_balance_rebuild WHERE customer_id = 11023;
DELETE FROM public.customer_rate_history  WHERE customer_id = 11023;

-- 6. Record why 14977 suddenly has years of history.
INSERT INTO public.audit_logs (
    employee_id, actor_name, action, entity_type, entity_id,
    field_name, old_value, new_value, occurred_at)
VALUES (
    NULL, 'Manual merge (admin, via SQL)',
    'Merged duplicate customer and deleted the duplicate',
    'customer', '14977', 'customer_id', '11023', '14977', CURRENT_TIMESTAMP);

-- 7. Remove the duplicate. This FAILS LOUDLY if anything still references it,
--    which is the safety net: the transaction aborts and nothing above is kept.
DELETE FROM public.customers WHERE customer_id = 11023;

COMMIT;


-- ===========================================================================
-- AFTER - the answer
-- ===========================================================================
SELECT
    CASE WHEN EXISTS (SELECT 1 FROM public.customers WHERE customer_id = 11023)
         THEN 'NOT MERGED - 11023 still exists. Scroll up for the red error.'
         ELSE 'MERGED - 11023 is gone, its history is on 14977.'
    END                                                              AS outcome,
    (SELECT COUNT(*) FROM public.payments WHERE customer_id = 14977) AS payments_on_14977,
    (SELECT COALESCE(SUM(amount), 0) FROM public.account_ledger_entries
      WHERE customer_id = 14977)                                     AS ledger_net_14977;
