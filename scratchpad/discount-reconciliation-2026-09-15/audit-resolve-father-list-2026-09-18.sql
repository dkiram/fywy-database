-- ============================================================================
-- READ ONLY. Resolve the 2026-09-18 list and show live balances next to what
-- was asked, so each correction can be pinned to a verified figure.
--
-- This batch goes in every direction, so read the `asked` column carefully:
--
--   7848 Yvonne Shields        "add 1000 credit for September"   -> credit UP by 1,000
--    525 Kemar Levy            "Should Have A Credit Of $5000"   -> balance to -5,000
--      ? Kade Meeks            "add 2500 balance"                -> owes 2,500 MORE
--   8571 Melodie OConnor       "clear the credit of 500 and she
--                               should have a balance of 1000"   -> -500 to +1,000
--   6268 Janet Hall Robinson   "remove 2500 credit" then "she paid
--                               the 1000 so just clear the credit
--                               of 1500"                         -> credit DOWN by 1,500
--      ? Rochelle Baker        "remove 3500 credit"              -> credit DOWN by 3,500
--
-- Writes nothing.
--
-- Run on the NAS:
--   ssh -p 9222 SPCNAS@100.98.108.77 \
--     'docker exec -i spcl-postgres psql -U spcl_user -d spcl_db' \
--     < scratchpad/discount-reconciliation-2026-09-15/audit-resolve-father-list-2026-09-18.sql
-- Or paste into TablePlus and "Run All".
-- ============================================================================

WITH wanted(label, known_id, pattern, asked, expect_credit_now) AS (VALUES
    ('Yvonne Shields',      7848, NULL,               'credit UP by 1,000 (September)',   NULL::NUMERIC),
    ('Kemar Levy',           525, NULL,               'balance to -5,000 (credit 5,000)', NULL),
    ('Kade Meeks',          NULL, '%meeks%',          'owes 2,500 MORE',                  NULL),
    ('Melodie OConnor',     8571, NULL,               '-500 credit -> +1,000 owing',      500.00),
    ('Janet Hall Robinson', 6268, NULL,               'credit DOWN by 1,500',             NULL),
    ('Rochelle Baker',      NULL, '%rochelle%baker%', 'credit DOWN by 3,500',             3500.00)
)
SELECT w.label,
       w.asked,
       c.customer_id,
       c.name          AS name_on_file,
       c.status,
       c.monthly_fee,
       b.balance,
       b.credit_balance AS credit_now,
       w.expect_credit_now,
       COUNT(*) OVER (PARTITION BY w.label) AS matches,
       CASE
           WHEN COUNT(*) OVER (PARTITION BY w.label) > 1     THEN 'AMBIGUOUS - pick the right account'
           WHEN b.customer_id IS NULL                        THEN 'no billing status row'
           WHEN w.expect_credit_now IS NOT NULL
            AND b.credit_balance <> w.expect_credit_now      THEN 'credit does not match the figure in the message - check'
           ELSE 'ok'
       END AS reading
FROM wanted w
JOIN public.customers c
  ON (w.known_id IS NOT NULL AND c.customer_id = w.known_id)
  OR (w.known_id IS NULL AND c.name ILIKE w.pattern)
LEFT JOIN public.customer_billing_status b ON b.customer_id = c.customer_id
ORDER BY w.label, c.customer_id;

-- Names that matched nothing come back empty above; make gaps visible.
WITH wanted(label, known_id, pattern) AS (VALUES
    ('Yvonne Shields',      7848, NULL),
    ('Kemar Levy',           525, NULL),
    ('Kade Meeks',          NULL, '%meeks%'),
    ('Melodie OConnor',     8571, NULL),
    ('Janet Hall Robinson', 6268, NULL),
    ('Rochelle Baker',      NULL, '%rochelle%baker%')
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
