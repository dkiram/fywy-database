-- ============================================================================

-- STEP 2 of 2 — deletes specific test customers and everything attached.
--
-- Plain SQL. No psql-only syntax, so this runs in a TablePlus SQL tab as well
-- as through psql. In TablePlus use Run All (or select everything and run) —
-- running one statement at a time breaks the transaction.
--
-- Run it on BOTH databases, with that database's own IDs. Local and NAS are
-- separate Postgres instances; deleting in one does nothing to the other, and
-- `git push` does not move data — only code.
--
-- AS SHIPPED THE LAST LINE IS `ROLLBACK`, so this is a rehearsal: it does the
-- work, prints what it did, then throws it away. Read the output. Only if it
-- is exactly right, change the last line to COMMIT and run again.
--
-- WHY THIS IS NOT ONE `DELETE FROM customers`
-- -------------------------------------------
-- Ten foreign keys point at customers and eight are ON DELETE RESTRICT, so a
-- single-row delete errors instead of cascading:
--
--   ERROR: update or delete on table "customers" violates foreign key
--   constraint "payments_customer_id_fkey" on table "payments"
--
-- Two more sit a level deeper: account_ledger_entries -> payments, and
-- waiver_requests -> account_ledger_entries, both RESTRICT as well. The ten
-- statements below, in this order, are the minimum that works — not extra
-- ceremony. Doing it by hand in a grid means running the same ten anyway.
--
-- Verified against Postgres built from migrations 001-036, with test customers
-- populated in all ten dependent tables, including the abort paths.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- EDIT THESE TWO THINGS AND NOTHING ELSE.
-- ---------------------------------------------------------------------------

-- How many customers you expect to delete, and how much history a target is
-- allowed to have before this refuses. A test record has almost nothing
-- attached; a real account has payments and a ledger. Either check failing
-- aborts the whole transaction and deletes nothing.
CREATE TEMP TABLE guard_settings ON COMMIT DROP AS
SELECT 1  AS expected_count,
       25 AS max_attached_rows;

-- The exact customer_id values from step 1. IDs, not names: a name pattern
-- will eventually match a real customer who happens to share a name, and that
-- is a mistake you only make once.
CREATE TEMP TABLE doomed_customers ON COMMIT DROP AS
SELECT
    c.customer_id,
    c.name,
    c.status,
    c.created_at,
      (SELECT count(*) FROM public.payments               x WHERE x.customer_id = c.customer_id)
    + (SELECT count(*) FROM public.account_ledger_entries x WHERE x.customer_id = c.customer_id)
    + (SELECT count(*) FROM public.service_tickets        x WHERE x.customer_id = c.customer_id)
    + (SELECT count(*) FROM public.account_status_history x WHERE x.customer_id = c.customer_id)
    + (SELECT count(*) FROM public.customer_rate_history  x WHERE x.customer_id = c.customer_id)
    + (SELECT count(*) FROM public.waiver_requests        x WHERE x.customer_id = c.customer_id)
    + (SELECT count(*) FROM public.reconnection_requests  x WHERE x.customer_id = c.customer_id)
    + (SELECT count(*) FROM public.disconnection_holds    x WHERE x.customer_id = c.customer_id)
    + (SELECT count(*) FROM public.applications           x WHERE x.customer_id = c.customer_id
                                                                OR x.suggested_customer_id = c.customer_id)
      AS attached_rows
FROM public.customers c
WHERE c.customer_id IN (14517);     -- <-- YOUR IDS HERE

-- ---------------------------------------------------------------------------
-- Guard 1: the IDs resolve to exactly the number of customers you expected.
-- Catches a typo'd ID, and a copy-paste that dropped or added an entry.
-- ---------------------------------------------------------------------------
DO $guard$
DECLARE
    found    INTEGER;
    expected INTEGER;
BEGIN
    SELECT count(*)       INTO found    FROM doomed_customers;
    SELECT expected_count INTO expected FROM guard_settings;

    IF found <> expected THEN
        RAISE EXCEPTION
            'Expected % customer(s) but the IDs matched %. Nothing deleted - check the IDs against step 1.',
            expected, found;
    END IF;
END
$guard$;

-- ---------------------------------------------------------------------------
-- Guard 2: none of the targets looks like a real account.
-- ---------------------------------------------------------------------------
DO $guard$
DECLARE
    busiest RECORD;
    limit_  INTEGER;
BEGIN
    SELECT max_attached_rows INTO limit_ FROM guard_settings;

    SELECT customer_id, name, attached_rows INTO busiest
    FROM doomed_customers ORDER BY attached_rows DESC LIMIT 1;

    IF busiest.attached_rows > limit_ THEN
        RAISE EXCEPTION
            'Customer % (%) has % attached rows, over the limit of %. That is too much history for a test record. Nothing deleted.',
            busiest.customer_id, busiest.name, busiest.attached_rows, limit_;
    END IF;
END
$guard$;

-- ---------------------------------------------------------------------------
-- What is about to go. Check the names.
-- ---------------------------------------------------------------------------
SELECT 'ABOUT TO DELETE' AS check, customer_id, name, status, attached_rows, created_at
FROM doomed_customers
ORDER BY customer_id;

-- ---------------------------------------------------------------------------
-- Delete, children first. Every statement is scoped to the same fixed list of
-- IDs captured above, so none of them can reach a row belonging to anyone else.
-- ---------------------------------------------------------------------------
DELETE FROM public.waiver_requests        WHERE customer_id IN (SELECT customer_id FROM doomed_customers);
DELETE FROM public.reconnection_requests  WHERE customer_id IN (SELECT customer_id FROM doomed_customers);
DELETE FROM public.account_ledger_entries WHERE customer_id IN (SELECT customer_id FROM doomed_customers);
DELETE FROM public.payments               WHERE customer_id IN (SELECT customer_id FROM doomed_customers);
DELETE FROM public.disconnection_holds    WHERE customer_id IN (SELECT customer_id FROM doomed_customers);
DELETE FROM public.customer_rate_history  WHERE customer_id IN (SELECT customer_id FROM doomed_customers);
DELETE FROM public.account_status_history WHERE customer_id IN (SELECT customer_id FROM doomed_customers);
DELETE FROM public.service_tickets        WHERE customer_id IN (SELECT customer_id FROM doomed_customers);
DELETE FROM public.applications           WHERE customer_id IN (SELECT customer_id FROM doomed_customers)
                                             OR suggested_customer_id IN (SELECT customer_id FROM doomed_customers);
DELETE FROM public.customers              WHERE customer_id IN (SELECT customer_id FROM doomed_customers);

-- ---------------------------------------------------------------------------
-- Both counts must be 0, and the customer total must have dropped by exactly
-- the number of targets and no more.
-- ---------------------------------------------------------------------------
SELECT 'REMAINING TARGET CUSTOMERS' AS check, count(*) AS n
FROM public.customers WHERE customer_id IN (SELECT customer_id FROM doomed_customers);

SELECT 'REMAINING ATTACHED ROWS' AS check, count(*) AS n
FROM (
  SELECT customer_id FROM public.waiver_requests        WHERE customer_id IN (SELECT customer_id FROM doomed_customers)
  UNION ALL SELECT customer_id FROM public.reconnection_requests  WHERE customer_id IN (SELECT customer_id FROM doomed_customers)
  UNION ALL SELECT customer_id FROM public.account_ledger_entries WHERE customer_id IN (SELECT customer_id FROM doomed_customers)
  UNION ALL SELECT customer_id FROM public.payments               WHERE customer_id IN (SELECT customer_id FROM doomed_customers)
  UNION ALL SELECT customer_id FROM public.disconnection_holds    WHERE customer_id IN (SELECT customer_id FROM doomed_customers)
  UNION ALL SELECT customer_id FROM public.customer_rate_history  WHERE customer_id IN (SELECT customer_id FROM doomed_customers)
  UNION ALL SELECT customer_id FROM public.account_status_history WHERE customer_id IN (SELECT customer_id FROM doomed_customers)
  UNION ALL SELECT customer_id FROM public.service_tickets        WHERE customer_id IN (SELECT customer_id FROM doomed_customers)
  UNION ALL SELECT customer_id FROM public.applications           WHERE customer_id IN (SELECT customer_id FROM doomed_customers)
) leftovers;

SELECT 'TOTAL CUSTOMERS LEFT IN TABLE' AS check, count(*) AS n FROM public.customers;

-- ---------------------------------------------------------------------------
-- ROLLBACK = rehearsal, changes nothing.
-- COMMIT   = for real, no undo. Take a backup before you swap this line.
-- ---------------------------------------------------------------------------
ROLLBACK;
