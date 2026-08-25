-- READ ONLY. Nothing here changes anything. Run it all in TablePlus and send
-- me the output; the results decide whether 6868 can simply go, or whether
-- something has to be moved onto 14586 first.
--
-- Why this step exists: a customer row is the anchor for payments, ledger
-- entries, tickets, notes and billing history. Deleting one without knowing
-- what hangs off it either fails on a foreign key or quietly takes real
-- financial records with it.

-- ---------------------------------------------------------------------------
-- 1. The two records side by side. Confirms 14586 really is the active one,
--    and shows just how identical the duplicate is.
-- ---------------------------------------------------------------------------
SELECT
    customer_id, name, address, telephone, status, hidden_from_app,
    package_id, monthly_fee,
    application_date, activation_date, deactivation_date, reactivation_date,
    pole_box_number, port_number, created_at
FROM public.customers
WHERE customer_id IN (6868, 14586)
ORDER BY customer_id;

-- ---------------------------------------------------------------------------
-- 2. EVERY table in the database that points at either customer, with a row
--    count for each. Discovered from the live foreign keys rather than from a
--    list I maintain by hand, so nothing can be forgotten.
--
--    Any table showing rows_for_6868 > 0 is something that must be moved or
--    removed before 6868 could ever be deleted.
-- ---------------------------------------------------------------------------
WITH referencing_columns AS (
    SELECT
        con.conrelid::regclass::TEXT AS child_table,
        att.attname::TEXT            AS child_column
    FROM pg_constraint con
    JOIN LATERAL UNNEST(con.conkey) WITH ORDINALITY AS key(attnum, ord) ON TRUE
    JOIN pg_attribute att
      ON att.attrelid = con.conrelid
     AND att.attnum   = key.attnum
    WHERE con.contype  = 'f'
      AND con.confrelid = 'public.customers'::REGCLASS
)
SELECT
    child_table,
    child_column,
    (XPATH('/row/cnt/text()', QUERY_TO_XML(
        FORMAT('SELECT COUNT(*) AS cnt FROM %s WHERE %I = 6868',
               child_table, child_column),
        FALSE, TRUE, '')))[1]::TEXT::INT AS rows_for_6868,
    (XPATH('/row/cnt/text()', QUERY_TO_XML(
        FORMAT('SELECT COUNT(*) AS cnt FROM %s WHERE %I = 14586',
               child_table, child_column),
        FALSE, TRUE, '')))[1]::TEXT::INT AS rows_for_14586
FROM referencing_columns
ORDER BY rows_for_6868 DESC, child_table, child_column;

-- ---------------------------------------------------------------------------
-- 3. The money. Every payment ever recorded against 6868.
--    If this returns rows, 6868 cannot be deleted without destroying receipts
--    that were issued to a real person.
-- ---------------------------------------------------------------------------
SELECT
    payment_id, payment_type, amount_paid, month_paid, payment_date,
    receipt_number, (voided_at IS NOT NULL) AS is_voided,
    cashier_name, location, legacy_payment_id
FROM public.payments
WHERE customer_id = 6868
ORDER BY payment_date NULLS FIRST, payment_id;

SELECT
    'customer 6868' AS record,
    COUNT(*)                                            AS payment_rows,
    COUNT(*) FILTER (WHERE voided_at IS NULL)           AS live_payments,
    COUNT(*) FILTER (WHERE legacy_payment_id IS NOT NULL) AS from_access,
    COALESCE(SUM(amount_paid) FILTER (WHERE voided_at IS NULL), 0) AS live_total
FROM public.payments WHERE customer_id = 6868
UNION ALL
SELECT
    'customer 14586',
    COUNT(*),
    COUNT(*) FILTER (WHERE voided_at IS NULL),
    COUNT(*) FILTER (WHERE legacy_payment_id IS NOT NULL),
    COALESCE(SUM(amount_paid) FILTER (WHERE voided_at IS NULL), 0)
FROM public.payments WHERE customer_id = 14586;

-- ---------------------------------------------------------------------------
-- 4. What each record currently owes. A duplicate that is still "active" and
--    still accruing monthly charges is billing somebody twice, which matters
--    more than the tidiness of the list.
-- ---------------------------------------------------------------------------
SELECT customer_id, status, outstanding_balance, is_delinquent
FROM public.customer_billing_status
WHERE customer_id IN (6868, 14586)
ORDER BY customer_id;

-- ---------------------------------------------------------------------------
-- 5. Is 6868 still being charged? Monthly charges are generated from the
--    ledger, so this is what a duplicate quietly does to the arrears report.
-- ---------------------------------------------------------------------------
SELECT
    customer_id,
    COUNT(*)                                                  AS ledger_rows,
    COUNT(*) FILTER (WHERE entry_type = 'monthly_charge')      AS monthly_charges,
    MAX(effective_date) FILTER (WHERE entry_type = 'monthly_charge') AS newest_charge,
    COALESCE(SUM(amount), 0)                                   AS net_amount
FROM public.account_ledger_entries
WHERE customer_id IN (6868, 14586)
GROUP BY customer_id
ORDER BY customer_id;

-- ---------------------------------------------------------------------------
-- 6. Does anything ELSE reference 6868 by number rather than by foreign key?
--    Applications keep both a customer_id and a suggested_customer_id, and a
--    stale suggestion would resurrect the duplicate in the review queue.
-- ---------------------------------------------------------------------------
SELECT application_id, name, status, customer_id, suggested_customer_id,
       application_date
FROM public.applications
WHERE customer_id IN (6868, 14586)
   OR suggested_customer_id IN (6868, 14586)
ORDER BY application_id;
