-- ============================================================================
-- READ ONLY. Resolve the 2026-10-12 credit list and show live balances.
--
-- This batch is phrased as AMOUNTS TO REMOVE, not target balances:
--
--    8753 Denise Davis                      "clear of 2500"            -> remove 2,500
--   15293 Cereta Vaughn                     "Clear credit please"      -> target 0
--       ? Sheneika Ellis                    "remove 4000 credit"       -> remove 4,000
--   12868 Tommeco Bennett /Michella Haye    "remove 1000 from credit"  -> remove 1,000
--       ? Shelly-Ann Larmond/Carmenta Bell  "remove 1000 credit"       -> remove 1,000
--
-- Where the live credit EQUALS the amount named, the two readings agree and
-- removing it lands on zero. Where live credit is HIGHER, the delta reading
-- leaves credit behind - confirm that is intended before writing. Where it is
-- LOWER, the amount cannot come off without putting the customer in debt.
-- The `reading` column calls each case.
--
-- The September review files are three weeks stale now, so they were used only
-- to recover ids (8753 and 12868 came from there; note 12868's name on file has
-- a space before the slash). Every figure below is live.
--
-- Writes nothing.
--
-- Run on the NAS:
--   ssh -p 9222 SPCNAS@100.98.108.77 \
--     'docker exec -i spcl-postgres psql -U spcl_user -d spcl_db' \
--     < scratchpad/discount-reconciliation-2026-09-15/audit-resolve-father-list-2026-10-12.sql
-- Or paste into TablePlus and "Run All".
-- ============================================================================

WITH wanted(label, known_id, pattern, remove_amount, clear_all) AS (VALUES
    ('Denise Davis',                     8753, NULL,            2500.00::NUMERIC, FALSE),
    ('Cereta Vaughn',                   15293, NULL,                        NULL, TRUE),
    ('Sheneika Ellis',                   NULL, '%sheneika%',         4000.00,     FALSE),
    ('Tommeco Bennett /Michella Haye',  12868, NULL,                 1000.00,     FALSE),
    ('Shelly-Ann Larmond/Carmenta Bell', NULL, '%carmenta%',         1000.00,     FALSE)
),
matched AS (
    SELECT w.label, w.remove_amount, w.clear_all,
           c.customer_id, c.name AS name_on_file, c.status, c.monthly_fee,
           b.balance, b.credit_balance,
           COUNT(*) OVER (PARTITION BY w.label) AS matches
    FROM wanted w
    JOIN public.customers c
      ON (w.known_id IS NOT NULL AND c.customer_id = w.known_id)
      OR (w.known_id IS NULL AND c.name ILIKE w.pattern)
    LEFT JOIN public.customer_billing_status b ON b.customer_id = c.customer_id
)
SELECT label, matches, customer_id, name_on_file, status, monthly_fee,
       balance, credit_balance AS credit_now,
       remove_amount,
       CASE WHEN clear_all THEN 0.00 ELSE credit_balance - remove_amount END AS credit_after,
       CASE
           WHEN matches > 1                            THEN 'AMBIGUOUS - pick the right account first'
           WHEN credit_balance IS NULL                 THEN 'no billing status row'
           WHEN COALESCE(credit_balance, 0) <= 0       THEN 'NOT IN CREDIT - nothing to remove, check'
           WHEN clear_all                              THEN 'clear all of it -> 0'
           WHEN credit_balance = remove_amount         THEN 'amount matches the credit exactly -> lands on 0'
           WHEN credit_balance > remove_amount         THEN 'credit is HIGHER - removing the stated amount leaves credit behind, confirm'
           ELSE                                             'credit is LOWER than the amount - cannot remove it all without creating debt'
       END AS reading
FROM matched
ORDER BY label, customer_id;

-- Names that matched nothing come back empty above; make the gaps obvious.
WITH wanted(label, known_id, pattern) AS (VALUES
    ('Denise Davis',                     8753, NULL),
    ('Cereta Vaughn',                   15293, NULL),
    ('Sheneika Ellis',                   NULL, '%sheneika%'),
    ('Tommeco Bennett /Michella Haye',  12868, NULL),
    ('Shelly-Ann Larmond/Carmenta Bell', NULL, '%carmenta%')
)
SELECT w.label, COUNT(c.customer_id) AS matches,
       CASE WHEN COUNT(c.customer_id) = 0 THEN 'NOT FOUND - need the customer id or spelling'
            WHEN COUNT(c.customer_id) = 1 THEN 'ok' ELSE 'ambiguous' END AS status
FROM wanted w
LEFT JOIN public.customers c
  ON (w.known_id IS NOT NULL AND c.customer_id = w.known_id)
  OR (w.known_id IS NULL AND c.name ILIKE w.pattern)
GROUP BY w.label
ORDER BY COUNT(c.customer_id), w.label;

-- Fallback searches for the two with no id, in case the patterns above miss.
SELECT 'ellis search' AS search, customer_id, name, status, monthly_fee,
       (SELECT credit_balance FROM public.customer_billing_status b WHERE b.customer_id = c.customer_id) AS credit_now
FROM public.customers c
WHERE c.name ILIKE '%ellis%'
  AND EXISTS (SELECT 1 FROM public.customer_billing_status b WHERE b.customer_id = c.customer_id AND b.balance < 0)
ORDER BY customer_id;

SELECT 'larmond/bell search' AS search, customer_id, name, status, monthly_fee,
       (SELECT credit_balance FROM public.customer_billing_status b WHERE b.customer_id = c.customer_id) AS credit_now
FROM public.customers c
WHERE (c.name ILIKE '%larmond%' OR c.name ILIKE '%shelly%ann%')
  AND EXISTS (SELECT 1 FROM public.customer_billing_status b WHERE b.customer_id = c.customer_id AND b.balance < 0)
ORDER BY customer_id;
