-- ============================================================================
-- READ ONLY. Resolve the 2026-09-16/17 credit list to real accounts and show
-- what each one actually holds right now.
--
-- Two things this settles before any money moves:
--
--  1. WHICH ACCOUNT. Most of these names are not in the 2026-09-15 review
--     files, and several spellings are approximate ("Cermepth Maxwell",
--     "Alfred a brown", "Demmo sloley"). "Anthony smith" will almost
--     certainly match more than one customer. Any name returning 0 or 2+ rows
--     needs a human to pick before it can be corrected.
--
--  2. WHAT THE NUMBER MEANS. The messages mix two forms:
--       "Dishawn Crawford Should Have A Credit Of $3500"  -> 3500 is the TARGET
--       "Dwayne Edmond 2500 credit"                       -> 2500 is probably
--                                                            what is SHOWING
--     If the live credit equals the number in the message, the message is
--     describing the wrong figure on screen, not the target - same convention
--     staff confirmed on 2026-09-16. The `number_in_message` column is here
--     so you can compare the two at a glance.
--
-- Writes nothing.
--
-- Run on the NAS:
--   ssh -p 9222 SPCNAS@100.98.108.77 \
--     'docker exec -i spcl-postgres psql -U spcl_user -d spcl_db' \
--     < scratchpad/discount-reconciliation-2026-09-15/audit-resolve-father-credit-list.sql
-- Or paste into TablePlus and "Run All".
-- ============================================================================

WITH wanted(label, pattern, known_id, number_in_message, note) AS (VALUES
    ('Dwayne Edmond',                '%dwayne%edmond%',   NULL::INT, 2500.00::NUMERIC, 'bare figure - probably what is showing'),
    ('Cermepth Maxwell',             '%maxwell%',         NULL,      2500.00, 'spelling uncertain - check first name'),
    ('Alfred A Brown',               '%alfred%brown%',    NULL,       500.00, '"500 credit should a balance for August" - may need to end up OWING'),
    ('Joseph Richards',              '%joseph%richards%', NULL,      2500.00, 'bare figure'),
    ('Rochelle Thompson',            '%rochelle%thomp%',  NULL,      2500.00, 'bare figure, tied to August'),
    ('Dishawn Crawford',             '%crawford%',        NULL,      3500.00, 'SHOULD HAVE - this is a target'),
    ('Demmo Sloley',                 '%sloley%',          11625,     4500.00, 'id given in the message'),
    ('Andrea Williams-Green Street', '%williams-green%',  13566,     3000.00, 'SHOULD HAVE - this is a target'),
    ('Gawayne Knight',               '%gawayne%',         13429,     2500.00, 'bare figure'),
    ('Anthony Smith',                '%anthony%smith%',   NULL,      8500.00, 'common name - expect several matches'),
    ('Simone Adams',                 '%simone%adam%',      9836,        NULL, '"clear credit" - target is 0')
),
matched AS (
    SELECT w.label,
           w.number_in_message,
           w.note,
           c.customer_id,
           c.name        AS name_on_file,
           c.status,
           c.monthly_fee,
           b.balance,
           b.credit_balance,
           COUNT(*) OVER (PARTITION BY w.label) AS matches_for_this_name
    FROM wanted w
    JOIN public.customers c
      ON (w.known_id IS NOT NULL AND c.customer_id = w.known_id)
      OR (w.known_id IS NULL AND c.name ILIKE w.pattern)
    LEFT JOIN public.customer_billing_status b ON b.customer_id = c.customer_id
)
SELECT label,
       matches_for_this_name AS matches,
       customer_id,
       name_on_file,
       status,
       monthly_fee,
       balance,
       credit_balance AS credit_now,
       number_in_message,
       CASE
           WHEN matches_for_this_name > 1                     THEN 'AMBIGUOUS - pick the right account first'
           WHEN credit_balance IS NULL                        THEN 'no billing status row'
           WHEN number_in_message IS NULL                     THEN 'target is 0 (clear credit)'
           WHEN credit_balance = number_in_message            THEN 'message matches live credit -> it is describing the WRONG figure, need the target'
           WHEN credit_balance > number_in_message            THEN 'live credit is higher than the figure -> figure is probably the target'
           ELSE                                                    'live credit is LOWER than the figure - check before doing anything'
       END AS reading
FROM matched
ORDER BY label, customer_id;

-- Names that matched nothing at all come back empty above, so list the search
-- terms alongside their hit counts to make the gaps obvious.
WITH wanted(label, pattern, known_id) AS (VALUES
    ('Dwayne Edmond',                '%dwayne%edmond%',   NULL::INT),
    ('Cermepth Maxwell',             '%maxwell%',         NULL),
    ('Alfred A Brown',               '%alfred%brown%',    NULL),
    ('Joseph Richards',              '%joseph%richards%', NULL),
    ('Rochelle Thompson',            '%rochelle%thomp%',  NULL),
    ('Dishawn Crawford',             '%crawford%',        NULL),
    ('Demmo Sloley',                 '%sloley%',          11625),
    ('Andrea Williams-Green Street', '%williams-green%',  13566),
    ('Gawayne Knight',               '%gawayne%',         13429),
    ('Anthony Smith',                '%anthony%smith%',   NULL),
    ('Simone Adams',                 '%simone%adam%',      9836)
)
SELECT w.label,
       COUNT(c.customer_id) AS matches,
       CASE WHEN COUNT(c.customer_id) = 0 THEN 'NOT FOUND - need the customer id or correct spelling'
            WHEN COUNT(c.customer_id) = 1 THEN 'ok'
            ELSE 'ambiguous' END AS status
FROM wanted w
LEFT JOIN public.customers c
  ON (w.known_id IS NOT NULL AND c.customer_id = w.known_id)
  OR (w.known_id IS NULL AND c.name ILIKE w.pattern)
GROUP BY w.label
ORDER BY COUNT(c.customer_id), w.label;
