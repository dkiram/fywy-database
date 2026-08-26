-- Kymani Bruce: merge customer 9307 into 14777, then delete 9307.
--
-- Every statement is guarded by name: 9307 is only touched if its name matches
-- 14777's. A transposed digit therefore does nothing at all rather than
-- merging a stranger's account - the same protection used on the Winston
-- Thorpe merge, where two different ids were quoted for the same record.
--
-- Run the whole file. Nothing to edit.
--
-- One transaction: if any statement fails, nothing changes and COMMIT reports
-- ROLLBACK. Paste me the first red error if that happens.


-- ===========================================================================
-- BEFORE - every customer sharing this name, and what each is holding.
-- Check the count matches what the office said (three records total).
-- ===========================================================================
SELECT
    c.customer_id, c.name, c.address, c.status,
    CASE WHEN c.customer_id = 14777 THEN 'KEEP'
         WHEN c.customer_id IN (9307) THEN 'merge + delete'
         ELSE 'SAME NAME BUT NOT LISTED - leave alone' END                    AS plan,
    (SELECT COUNT(*) FROM public.payments p WHERE p.customer_id = c.customer_id) AS payments,
    (SELECT COUNT(*) FROM public.payments p
      WHERE p.customer_id = c.customer_id AND p.recorded_by_employee_id IS NOT NULL) AS taken_at_counter,
    (SELECT COALESCE(SUM(amount_paid), 0) FROM public.payments p
      WHERE p.customer_id = c.customer_id AND p.voided_at IS NULL)            AS live_total,
    (SELECT COALESCE(SUM(amount), 0) FROM public.account_ledger_entries l
      WHERE l.customer_id = c.customer_id)                                    AS ledger_net,
    (SELECT b.billing_start_date FROM public.customer_billing_start b
      WHERE b.customer_id = c.customer_id)                                    AS billing_starts
FROM public.customers c
WHERE LOWER(TRIM(c.name)) = (SELECT LOWER(TRIM(name)) FROM public.customers WHERE customer_id = 14777)
   OR c.customer_id IN (9307)
ORDER BY c.customer_id;


-- ===========================================================================
-- THE MERGE
--
-- Every statement below selects its targets the same way:
--   "id is one of the ones the office named, AND is not the survivor,
--    AND has the same name as the survivor"
-- so a mistyped id simply matches nothing.
-- ===========================================================================
BEGIN;

-- 1. Payments and status history move to 14777.
UPDATE public.payments
   SET customer_id = 14777
 WHERE customer_id IN (
       SELECT d.customer_id FROM public.customers d
        WHERE d.customer_id IN (9307)
          AND d.customer_id <> 14777
          AND LOWER(TRIM(d.name)) = (SELECT LOWER(TRIM(name)) FROM public.customers WHERE customer_id = 14777));

UPDATE public.account_status_history
   SET customer_id = 14777
 WHERE customer_id IN (
       SELECT d.customer_id FROM public.customers d
        WHERE d.customer_id IN (9307)
          AND d.customer_id <> 14777
          AND LOWER(TRIM(d.name)) = (SELECT LOWER(TRIM(name)) FROM public.customers WHERE customer_id = 14777));

-- 2. Drop the synthetic "reconnection fee required for disconnected legacy
--    account" charge. It is a cutover artefact, not money anybody was
--    invoiced; carried onto an active record it invents a debt and puts a
--    paid-up customer on the delinquent list.
DELETE FROM public.account_ledger_entries
 WHERE entry_type = 'reconnection_fee'
   AND source_key LIKE 'legacy-reconnection-fee:%'
   AND customer_id IN (
       SELECT d.customer_id FROM public.customers d
        WHERE d.customer_id IN (9307)
          AND d.customer_id <> 14777
          AND LOWER(TRIM(d.name)) = (SELECT LOWER(TRIM(name)) FROM public.customers WHERE customer_id = 14777));

-- 3. Any REAL ledger entry still moves.
UPDATE public.account_ledger_entries
   SET customer_id = 14777
 WHERE customer_id IN (
       SELECT d.customer_id FROM public.customers d
        WHERE d.customer_id IN (9307)
          AND d.customer_id <> 14777
          AND LOWER(TRIM(d.name)) = (SELECT LOWER(TRIM(name)) FROM public.customers WHERE customer_id = 14777));

-- 4. Release ledger rows pointing at a duplicate's rate history, or step 5
--    hits a foreign key.
UPDATE public.account_ledger_entries
   SET customer_rate_history_id = NULL
 WHERE customer_rate_history_id IN (
       SELECT r.customer_rate_history_id FROM public.customer_rate_history r
        WHERE r.customer_id IN (
              SELECT d.customer_id FROM public.customers d
               WHERE d.customer_id IN (9307)
                 AND d.customer_id <> 14777
                 AND LOWER(TRIM(d.name)) = (SELECT LOWER(TRIM(name)) FROM public.customers WHERE customer_id = 14777)));

-- 5. The one-row-per-customer tables. The duplicates' rows cannot move onto
--    14777 because it already has its own, so they go. Keeping 14777's billing
--    floor is deliberate - it is the floor live billing already uses, and the
--    BEFORE output above shows how they compared.
DELETE FROM public.customer_billing_start
 WHERE customer_id IN (
       SELECT d.customer_id FROM public.customers d
        WHERE d.customer_id IN (9307)
          AND d.customer_id <> 14777
          AND LOWER(TRIM(d.name)) = (SELECT LOWER(TRIM(name)) FROM public.customers WHERE customer_id = 14777));

DELETE FROM public.legacy_balance_rebuild
 WHERE customer_id IN (
       SELECT d.customer_id FROM public.customers d
        WHERE d.customer_id IN (9307)
          AND d.customer_id <> 14777
          AND LOWER(TRIM(d.name)) = (SELECT LOWER(TRIM(name)) FROM public.customers WHERE customer_id = 14777));

DELETE FROM public.customer_rate_history
 WHERE customer_id IN (
       SELECT d.customer_id FROM public.customers d
        WHERE d.customer_id IN (9307)
          AND d.customer_id <> 14777
          AND LOWER(TRIM(d.name)) = (SELECT LOWER(TRIM(name)) FROM public.customers WHERE customer_id = 14777));

-- 6. Audit row, so the history landing on 14777 is explainable later.
INSERT INTO public.audit_logs (
    employee_id, actor_name, action, entity_type, entity_id,
    field_name, old_value, new_value, occurred_at)
SELECT
    NULL, 'Manual merge (admin, via SQL)',
    'Merged duplicate customer and deleted the duplicate',
    'customer', '14777', 'customer_id',
    d.customer_id::TEXT, '14777', CURRENT_TIMESTAMP
FROM public.customers d
WHERE d.customer_id IN (9307)
  AND d.customer_id <> 14777
  AND LOWER(TRIM(d.name)) = (SELECT LOWER(TRIM(name)) FROM public.customers WHERE customer_id = 14777);

-- 7. Remove the duplicate. Fails loudly if anything still references them,
--    which is the safety net - the transaction aborts and nothing is kept.
DELETE FROM public.customers
 WHERE customer_id IN (9307)
   AND customer_id <> 14777
   AND LOWER(TRIM(name)) = (SELECT LOWER(TRIM(name)) FROM public.customers WHERE customer_id = 14777);

COMMIT;


-- ===========================================================================
-- AFTER - the answer
-- ===========================================================================
SELECT
    (SELECT COUNT(*) FROM public.customers
      WHERE customer_id IN (9307))                     AS duplicate_remaining,
    (SELECT COUNT(*) FROM public.payments WHERE customer_id = 14777) AS payments_on_14777,
    (SELECT COALESCE(SUM(amount_paid), 0) FROM public.payments
      WHERE customer_id = 14777 AND voided_at IS NULL)               AS live_total_14777,
    (SELECT COALESCE(SUM(amount), 0) FROM public.account_ledger_entries
      WHERE customer_id = 14777)                                     AS ledger_net_14777;

-- Anything still listed here was NOT merged - check its name against 14777's.
SELECT customer_id, name, status, 'still present' AS note
FROM public.customers
WHERE customer_id IN (9307)
ORDER BY customer_id;
