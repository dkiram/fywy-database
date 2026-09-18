-- ============================================================================
-- READ ONLY. Resolve the three new names from the 2026-09-17 list.
--
--   Nicola Morgan Thomas   2,500 credit, should not have credit
--   Jermain Kennedy        3,700 credit, should not have credit
--   Jennieve Rudolph       2,500 credit, should not have credit
--
-- Spellings are approximate ("Jermain" is probably "Jermaine"), so the
-- patterns are loose on purpose and the surname is matched on its own as a
-- fallback. Expect several hits per name; the one to use is the exact-name
-- match, and the credit it holds should equal the figure in the message.
--
-- Target for all three is 0 - the instruction is unambiguous this time. What
-- is still needed is the customer id, plus confirmation that the live credit
-- matches, before they can be added to
-- FIX-father-credit-list-clear-cases.sql.
--
-- Writes nothing.
--
-- Run on the NAS:
--   ssh -p 9222 SPCNAS@100.98.108.77 \
--     'docker exec -i spcl-postgres psql -U spcl_user -d spcl_db' \
--     < scratchpad/discount-reconciliation-2026-09-15/audit-resolve-father-credit-list-2.sql
-- Or paste into TablePlus and "Run All".
-- ============================================================================

WITH wanted(label, pattern, figure_in_message) AS (VALUES
    ('Nicola Morgan Thomas', '%nicola%',   2500.00::NUMERIC),
    ('Jermain Kennedy',      '%kennedy%',  3700.00),
    ('Jennieve Rudolph',     '%rudolph%',  2500.00)
)
SELECT w.label,
       c.customer_id,
       c.name AS name_on_file,
       c.status,
       c.monthly_fee,
       b.balance,
       b.credit_balance AS credit_now,
       w.figure_in_message,
       CASE
           WHEN b.credit_balance IS NULL              THEN 'no billing status row'
           WHEN b.credit_balance = w.figure_in_message THEN '*** MATCHES the figure - this is very likely the account'
           WHEN b.credit_balance > 0                  THEN 'in credit, but not the quoted amount'
           ELSE                                            'no credit'
       END AS reading
FROM wanted w
JOIN public.customers c ON c.name ILIKE w.pattern
LEFT JOIN public.customer_billing_status b ON b.customer_id = c.customer_id
-- Accounts holding no credit at all cannot be the ones being complained about,
-- so keep the list readable by showing those last.
ORDER BY w.label,
         (b.credit_balance = w.figure_in_message) DESC NULLS LAST,
         b.credit_balance DESC NULLS LAST,
         c.customer_id;
