-- READ ONLY. Winston Thorpe: 4362, 14643, 14715.
--
-- Answers the question the office actually needs to decide, which is not
-- "which record looks right in the app" but "which record is holding the
-- customer's payment history".
--
-- In all three merges so far, the OLD low-numbered record held nearly all the
-- payments and the new high-numbered one held almost none. If that holds here,
-- deleting 4362 would destroy the history rather than tidy it up.
--
-- To reuse for another set: change the three ids in the IN lists below.

-- ===========================================================================
-- 1. The three records side by side
-- ===========================================================================
SELECT
    c.customer_id, c.name, c.address, c.telephone, c.status,
    c.package_id, c.monthly_fee,
    c.application_date, c.activation_date, c.deactivation_date, c.reactivation_date,
    c.pole_box_number, c.port_number, c.hidden_from_app
FROM public.customers c
WHERE c.customer_id IN (4362, 14643, 14715)
ORDER BY c.customer_id;

-- ===========================================================================
-- 2. Where the money actually is. This is the deciding column.
--
--    recorded_in_new_system counts payments taken since go-live - the record
--    staff have actually been using at the counter.
-- ===========================================================================
SELECT
    c.customer_id,
    c.status,
    (SELECT COUNT(*) FROM public.payments p
      WHERE p.customer_id = c.customer_id)                                  AS payments,
    (SELECT COUNT(*) FROM public.payments p
      WHERE p.customer_id = c.customer_id AND p.legacy_payment_id IS NOT NULL) AS from_access,
    (SELECT COUNT(*) FROM public.payments p
      WHERE p.customer_id = c.customer_id AND p.recorded_by_employee_id IS NOT NULL) AS recorded_in_new_system,
    (SELECT COALESCE(SUM(p.amount_paid), 0) FROM public.payments p
      WHERE p.customer_id = c.customer_id AND p.voided_at IS NULL)          AS live_total,
    (SELECT MIN(p.payment_date) FROM public.payments p
      WHERE p.customer_id = c.customer_id)                                  AS first_payment,
    (SELECT MAX(p.payment_date) FROM public.payments p
      WHERE p.customer_id = c.customer_id)                                  AS last_payment
FROM public.customers c
WHERE c.customer_id IN (4362, 14643, 14715)
ORDER BY c.customer_id;

-- ===========================================================================
-- 3. Balances and billing floors
-- ===========================================================================
SELECT
    c.customer_id,
    (SELECT COALESCE(SUM(l.amount), 0) FROM public.account_ledger_entries l
      WHERE l.customer_id = c.customer_id)                        AS ledger_net,
    (SELECT COUNT(*) FROM public.account_ledger_entries l
      WHERE l.customer_id = c.customer_id
        AND l.entry_type = 'reconnection_fee'
        AND l.source_key LIKE 'legacy-reconnection-fee:%')        AS synthetic_reconnection_fees,
    (SELECT b.billing_start_date FROM public.customer_billing_start b
      WHERE b.customer_id = c.customer_id)                        AS billing_starts,
    (SELECT s.outstanding_balance FROM public.customer_billing_status s
      WHERE s.customer_id = c.customer_id)                        AS outstanding_balance
FROM public.customers c
WHERE c.customer_id IN (4362, 14643, 14715)
ORDER BY c.customer_id;

-- ===========================================================================
-- 4. Everything else in the database attached to any of the three
-- ===========================================================================
WITH referencing_columns AS (
    SELECT con.conrelid::REGCLASS::TEXT AS child_table,
           att.attname::TEXT            AS child_column
    FROM pg_constraint con
    JOIN LATERAL UNNEST(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON TRUE
    JOIN pg_attribute att
      ON att.attrelid = con.conrelid AND att.attnum = k.attnum
    WHERE con.contype = 'f'
      AND con.confrelid = 'public.customers'::REGCLASS
)
SELECT
    child_table, child_column,
    (XPATH('/row/cnt/text()', QUERY_TO_XML(
        FORMAT('SELECT COUNT(*) AS cnt FROM %s WHERE %I = 4362', child_table, child_column),
        FALSE, TRUE, '')))[1]::TEXT::INT AS rows_4362,
    (XPATH('/row/cnt/text()', QUERY_TO_XML(
        FORMAT('SELECT COUNT(*) AS cnt FROM %s WHERE %I = 14643', child_table, child_column),
        FALSE, TRUE, '')))[1]::TEXT::INT AS rows_14643,
    (XPATH('/row/cnt/text()', QUERY_TO_XML(
        FORMAT('SELECT COUNT(*) AS cnt FROM %s WHERE %I = 14715', child_table, child_column),
        FALSE, TRUE, '')))[1]::TEXT::INT AS rows_14715
FROM referencing_columns
ORDER BY rows_4362 DESC, rows_14715 DESC, child_table, child_column;
