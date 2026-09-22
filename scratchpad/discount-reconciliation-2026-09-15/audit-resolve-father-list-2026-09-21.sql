-- ============================================================================
-- READ ONLY. Resolve the 2026-09-21 list and show live balances next to what
-- was asked, so each correction can be pinned to a verified figure.
--
--   9094  Terron Whyte            "$2500 credit should remove"      -> credit DOWN 2,500
--  10410  Jahdae Johnson          "clear the credit, should have a
--                                  balance of 1500"                 -> balance to +1,500
--   1839  Roshelle Johnson        "should have only 2500 credit"    -> balance to -2,500
--   6509  Phillip Trowers         "should have only 4000 credit"    -> balance to -4,000
--   3995  Owen Elliott            "2500 credit only"                -> balance to -2,500
--  10541  Cynthia Bryan Sandy Rv  "clear credit"                    -> balance to 0
--   6429  Javon Colley            "remove 2500 credit"              -> credit DOWN 2,500
--   9544? Robert Murray 2         "remove the credit"               -> balance to 0
--      ?  Tanisha Sibblies        "add 1500 balance"                -> owes 1,500 MORE
--   8420  Nikann Sahadeo          "should have a balance of 2500"   -> balance to +2,500
--
-- Robert Murray 2 was 9544 in the duplicate-receipt review on 2026-09-17;
-- name-checked here rather than assumed. Tanisha Sibblies has no id in the
-- message and is not in the review files - searched by surname.
--
-- Writes nothing.
--
-- Run on the NAS:
--   ssh -p 9222 SPCNAS@100.98.108.77 \
--     'docker exec -i spcl-postgres psql -U spcl_user -d spcl_db' \
--     < scratchpad/discount-reconciliation-2026-09-15/audit-resolve-father-list-2026-09-21.sql
-- Or paste into TablePlus and "Run All".
-- ============================================================================

WITH wanted(label, known_id, pattern, asked, expect_credit_now) AS (VALUES
    ('Terron Whyte',            9094, NULL,          'credit DOWN by 2,500',            2500.00::NUMERIC),
    ('Jahdae Johnson',         10410, NULL,          'clear credit -> +1,500 owing',    NULL),
    ('Roshelle Johnson',        1839, NULL,          'balance to -2,500 (credit 2,500)', NULL),
    ('Phillip Trowers',         6509, NULL,          'balance to -4,000 (credit 4,000)', NULL),
    ('Owen Elliott',            3995, NULL,          'balance to -2,500 (credit 2,500)', NULL),
    ('Cynthia Bryan Sandy River', 10541, NULL,       'clear credit -> 0',               NULL),
    ('Javon Colley',            6429, NULL,          'credit DOWN by 2,500',            NULL),
    ('Robert Murray 2',         9544, NULL,          'clear credit -> 0',               NULL),
    ('Tanisha Sibblies',        NULL, '%sibblies%',  'owes 1,500 MORE',                 NULL),
    ('Nikann Sahadeo',          8420, NULL,          'balance to +2,500 owing',         NULL)
)
SELECT w.label,
       w.asked,
       c.customer_id,
       c.name           AS name_on_file,
       c.status,
       c.monthly_fee,
       b.balance,
       b.credit_balance AS credit_now,
       w.expect_credit_now,
       COUNT(*) OVER (PARTITION BY w.label) AS matches,
       CASE
           WHEN COUNT(*) OVER (PARTITION BY w.label) > 1 THEN 'AMBIGUOUS - pick the right account'
           WHEN b.customer_id IS NULL                    THEN 'no billing status row'
           WHEN w.expect_credit_now IS NOT NULL
            AND b.credit_balance <> w.expect_credit_now  THEN 'credit does not match the figure in the message - check'
           ELSE 'ok'
       END AS reading
FROM wanted w
JOIN public.customers c
  ON (w.known_id IS NOT NULL AND c.customer_id = w.known_id)
  OR (w.known_id IS NULL AND c.name ILIKE w.pattern)
LEFT JOIN public.customer_billing_status b ON b.customer_id = c.customer_id
ORDER BY w.label, c.customer_id;

WITH wanted(label, known_id, pattern) AS (VALUES
    ('Terron Whyte',              9094, NULL),
    ('Jahdae Johnson',           10410, NULL),
    ('Roshelle Johnson',          1839, NULL),
    ('Phillip Trowers',           6509, NULL),
    ('Owen Elliott',              3995, NULL),
    ('Cynthia Bryan Sandy River', 10541, NULL),
    ('Javon Colley',              6429, NULL),
    ('Robert Murray 2',           9544, NULL),
    ('Tanisha Sibblies',          NULL, '%sibblies%'),
    ('Nikann Sahadeo',            8420, NULL)
)
SELECT w.label, COUNT(c.customer_id) AS matches,
       CASE WHEN COUNT(c.customer_id) = 0 THEN 'NOT FOUND - need the customer id'
            WHEN COUNT(c.customer_id) = 1 THEN 'ok' ELSE 'ambiguous' END AS status
FROM wanted w
LEFT JOIN public.customers c
  ON (w.known_id IS NOT NULL AND c.customer_id = w.known_id)
  OR (w.known_id IS NULL AND c.name ILIKE w.pattern)
GROUP BY w.label
ORDER BY COUNT(c.customer_id), w.label;
