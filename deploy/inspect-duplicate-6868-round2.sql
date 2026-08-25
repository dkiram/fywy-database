-- READ ONLY. Round two. The first pass showed the payments; this one shows the
-- six small tables that BOTH 6868 and 14586 have a row in.
--
-- Those are the ones that cannot simply be re-pointed: if customer_billing_start
-- or legacy_balance_rebuild is keyed one-row-per-customer, moving 6868's row
-- onto 14586 collides with the row already there. I need to see the contents and
-- the constraints to write the merge correctly rather than guess.

-- ---------------------------------------------------------------------------
-- 1. Corrected balance query. customer_billing_status has no status column of
--    its own - that lives on customers - which is what broke query 5.
-- ---------------------------------------------------------------------------
SELECT b.*
FROM public.customer_billing_status b
WHERE b.customer_id IN (6868, 14586)
ORDER BY b.customer_id;

-- ---------------------------------------------------------------------------
-- 2. The single ledger entry on each. 6868 nets +1500 and 14586 nets 0, so
--    moving 6868's row would hand the surviving record a 1,500 balance. Need
--    to see what that entry actually is before deciding whether it should
--    follow the customer or be written off with the duplicate.
-- ---------------------------------------------------------------------------
SELECT *
FROM public.account_ledger_entries
WHERE customer_id IN (6868, 14586)
ORDER BY customer_id, effective_date, account_ledger_entry_id;

-- ---------------------------------------------------------------------------
-- 3. The other shared tables, in full. Small enough to just look at.
-- ---------------------------------------------------------------------------
SELECT * FROM public.account_status_history
WHERE customer_id IN (6868, 14586) ORDER BY customer_id;

SELECT * FROM public.customer_billing_start
WHERE customer_id IN (6868, 14586) ORDER BY customer_id;

SELECT * FROM public.customer_rate_history
WHERE customer_id IN (6868, 14586) ORDER BY customer_id;

SELECT * FROM public.legacy_balance_rebuild
WHERE customer_id IN (6868, 14586) ORDER BY customer_id;

-- ---------------------------------------------------------------------------
-- 4. Which of those tables would REFUSE a customer_id swap, and why.
--    Any unique or primary key containing customer_id means 6868's row cannot
--    move onto 14586 while 14586 already has one.
-- ---------------------------------------------------------------------------
SELECT
    con.conrelid::REGCLASS::TEXT AS table_name,
    con.conname                  AS constraint_name,
    CASE con.contype WHEN 'p' THEN 'PRIMARY KEY'
                     WHEN 'u' THEN 'UNIQUE'
                     ELSE con.contype::TEXT END AS kind,
    PG_GET_CONSTRAINTDEF(con.oid) AS definition
FROM pg_constraint con
WHERE con.contype IN ('p', 'u')
  AND con.conrelid IN (
        'public.account_ledger_entries'::REGCLASS,
        'public.account_status_history'::REGCLASS,
        'public.customer_billing_start'::REGCLASS,
        'public.customer_rate_history'::REGCLASS,
        'public.legacy_balance_rebuild'::REGCLASS,
        'public.payments'::REGCLASS)
ORDER BY table_name, kind;

-- Unique INDEXES too - a partial unique index is not a constraint and would
-- not show above, but it blocks an update just the same.
SELECT
    tab.relname::TEXT  AS table_name,
    idx.relname::TEXT  AS index_name,
    PG_GET_INDEXDEF(idx.oid) AS definition
FROM pg_index i
JOIN pg_class idx ON idx.oid = i.indexrelid
JOIN pg_class tab ON tab.oid = i.indrelid
WHERE i.indisunique
  AND tab.relnamespace = 'public'::REGNAMESPACE
  AND tab.relname IN ('account_ledger_entries', 'account_status_history',
                      'customer_billing_start', 'customer_rate_history',
                      'legacy_balance_rebuild', 'payments')
ORDER BY table_name, index_name;

-- ---------------------------------------------------------------------------
-- 5. Sanity check on the merged result: what the combined payment history
--    would look like, and whether any two payments would collide on the same
--    Access id (which would mean the SAME payment was imported twice, once
--    under each customer - worth knowing before merging).
-- ---------------------------------------------------------------------------
SELECT legacy_payment_id, COUNT(*) AS copies,
       ARRAY_AGG(payment_id ORDER BY payment_id)   AS payment_ids,
       ARRAY_AGG(customer_id ORDER BY payment_id)  AS customers,
       ARRAY_AGG(amount_paid ORDER BY payment_id)  AS amounts
FROM public.payments
WHERE customer_id IN (6868, 14586)
  AND legacy_payment_id IS NOT NULL
GROUP BY legacy_payment_id
HAVING COUNT(*) > 1
ORDER BY legacy_payment_id;

-- The 6 payments on 14586, for comparison with the 39 on 6868.
SELECT payment_id, payment_type, amount_paid, month_paid, payment_date,
       receipt_number, (voided_at IS NOT NULL) AS is_voided,
       recorded_by_employee_id, legacy_payment_id
FROM public.payments
WHERE customer_id = 14586
ORDER BY payment_date NULLS FIRST, payment_id;
