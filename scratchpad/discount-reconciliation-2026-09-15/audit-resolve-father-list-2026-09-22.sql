-- ============================================================================
-- READ ONLY. Resolve the 2026-09-22 list and show live balances next to what
-- was asked.
--
--   6855? Kajay Brown       "no credit"                        -> balance to 0
--       ? Vanessa Francis   "only 2500 credit"                 -> balance to -2,500
--       ? Kedda Chaplin     "remove 1000 credit"               -> balance to 0
--       ? Abigail Greaves   "remove 3000 credit"               -> balance to 0
--   2363? Pauline Kennedy   "remove 4000 credit"               -> balance to 0
--       ? Kymani Bruce      "remove 2500 credit add 1000 balance" -> balance to +1,000
--  10704  Annakay Simpson   "clear credit of 5000"             -> balance to 0
--
-- expect_credit_now is the figure in the message. Where it matches the live
-- credit, the account is confirmed. Where it does not, stop and look.
--
-- TWO TO WATCH:
--   Pauline Kennedy 2363 showed credit 0.00 when the Kennedys were resolved
--     on 2026-09-17, yet the message says remove 4,000. Either something
--     moved since, or this is a different Pauline Kennedy. The reading column
--     will say.
--   Kajay Brown 6855 was DISCONNECTED and owing 5,000 in the review files.
--     "no credit" implies he is in credit now - so his position has changed
--     a lot. Worth a look at the row before acting.
--
-- Writes nothing.
--
-- Run on the NAS:
--   ssh -p 9222 SPCNAS@100.98.108.77 \
--     'docker exec -i spcl-postgres psql -U spcl_user -d spcl_db' \
--     < scratchpad/discount-reconciliation-2026-09-15/audit-resolve-father-list-2026-09-22.sql
-- Or paste into TablePlus and "Run All".
-- ============================================================================

WITH wanted(label, known_id, pattern, asked, expect_credit_now) AS (VALUES
    ('Kajay Brown',      6855,  '%kajay%',            'balance to 0',             NULL::NUMERIC),
    ('Vanessa Francis',  NULL,  '%vanessa%francis%',  'balance to -2,500',        NULL),
    ('Kedda Chaplin',    NULL,  '%chaplin%',          'balance to 0',             1000.00),
    ('Abigail Greaves',  NULL,  '%greaves%',          'balance to 0',             3000.00),
    ('Pauline Kennedy',  NULL,  '%pauline%kennedy%',  'balance to 0',             4000.00),
    ('Kymani Bruce',     NULL,  '%kymani%',           'balance to +1,000 owing',  2500.00),
    ('Annakay Simpson',  10704, NULL,                 'balance to 0',             5000.00)
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
           WHEN COALESCE(b.credit_balance, 0) <= 0       THEN 'NOT IN CREDIT - nothing to remove, check this one'
           WHEN w.expect_credit_now IS NOT NULL
            AND b.credit_balance = w.expect_credit_now   THEN '*** matches the figure in the message'
           WHEN w.expect_credit_now IS NOT NULL          THEN 'credit does not match the figure - check'
           ELSE 'in credit (no figure given to check against)'
       END AS reading
FROM wanted w
JOIN public.customers c
  ON (w.known_id IS NOT NULL AND c.customer_id = w.known_id)
  OR (w.known_id IS NULL AND c.name ILIKE w.pattern)
LEFT JOIN public.customer_billing_status b ON b.customer_id = c.customer_id
ORDER BY w.label,
         (b.credit_balance = w.expect_credit_now) DESC NULLS LAST,
         b.credit_balance DESC NULLS LAST,
         c.customer_id;

WITH wanted(label, known_id, pattern) AS (VALUES
    ('Kajay Brown',      6855,  '%kajay%'),
    ('Vanessa Francis',  NULL,  '%vanessa%francis%'),
    ('Kedda Chaplin',    NULL,  '%chaplin%'),
    ('Abigail Greaves',  NULL,  '%greaves%'),
    ('Pauline Kennedy',  NULL,  '%pauline%kennedy%'),
    ('Kymani Bruce',     NULL,  '%kymani%'),
    ('Annakay Simpson',  10704, NULL)
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
