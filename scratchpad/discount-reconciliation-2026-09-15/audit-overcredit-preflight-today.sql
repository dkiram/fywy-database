-- ============================================================================
-- READ ONLY. Where do the 28 over-credit accounts stand RIGHT NOW?
--
-- Rehearsal output goes stale overnight: the generator raises each customer's
-- monthly charge on their own anniversary, which consumes credit and moves an
-- account from the APPLY list to the SKIPPED list. This shows today's picture
-- and, for each account, which script now handles it.
--
-- Note a charge does NOT cancel the over-credit. Being billed J$2,500 against
-- an excess of J$2,000 leaves the excess in the balance - it just looks
-- smaller. Those accounts move to the addendum route, not off the list.
--
-- Writes nothing.
--
-- Run on the NAS:
--   ssh -p 9222 SPCNAS@100.98.108.77 \
--     'docker exec -i spcl-postgres psql -U spcl_user -d spcl_db' \
--     < scratchpad/discount-reconciliation-2026-09-15/audit-overcredit-preflight-today.sql
-- ============================================================================

WITH overcredit(customer_id, expected_name, proposed_credit, committed_credit, overcredit) AS (VALUES
    ( 12438, 'Vashty Thompson',              2000.00::NUMERIC, 12000.00::NUMERIC, 10000.00::NUMERIC),
    (  6554, 'Yvonne Stiff',                 4000.00, 12000.00,  8000.00),
    (   963, 'Hortense Daley',               4000.00,  8000.00,  4000.00),
    (  8753, 'Denise Davis',                 4500.00,  7500.00,  3000.00),
    (  5810, 'Jerome Young',                 4000.00,  7000.00,  3000.00),
    (  9474, 'Althea Francis',               2500.00,  5000.00,  2500.00),
    (  2528, 'Maureen Bryan',                1000.00,  3500.00,  2500.00),
    (  4866, 'Jodi-ann Williams',            1000.00,  3500.00,  2500.00),
    ( 15064, 'Sandra Ferguson',               500.00,  3000.00,  2500.00),
    (  7532, 'Pearline Bailey',              2500.00,  5000.00,  2500.00),
    (  6301, 'Cynthia Elaine Griffiths',     2600.00,  5000.00,  2400.00),
    ( 10235, 'Najah Beckford-White',         3000.00,  5000.00,  2000.00),
    ( 10482, 'Everol Dwyer',                  500.00,  2500.00,  2000.00),
    ( 11179, 'Rochelle Smith',               3000.00,  5000.00,  2000.00),
    (  5597, 'Grace Lawson',                 2500.00,  4500.00,  2000.00),
    ( 14199, 'Paul Rumble',                  4000.00,  6000.00,  2000.00),
    (  4673, 'Chrystine Barbara Rodrigues1', 1750.00,  3500.00,  1750.00),
    ( 12832, 'Tanyalee Campbell',            1000.00,  2500.00,  1500.00),
    (  4662, 'Nigel Morgan',                 2000.00,  3500.00,  1500.00),
    (  7569, 'Dwayne Morris',                3500.00,  5000.00,  1500.00),
    (   498, 'Chuthild Spencer',             4000.00,  5000.00,  1000.00),
    ( 11423, 'Rudolph Rose #2',              1500.00,  2500.00,  1000.00),
    (  3334, 'Tashia Brown #2',              4150.00,  5000.00,   850.00),
    ( 12121, 'Yanique Smith',                2000.00,  2500.00,   500.00),
    (  4890, 'Enid Lowe',                    2000.00,  2500.00,   500.00),
    ( 13421, 'Marjorie Wilk #2',             4500.00,  5000.00,   500.00),
    (  5682, 'Annmarie Lamothe',             4500.00,  5000.00,   500.00),
    (  4198, 'Jerome Lyle 2',                4750.00,  5000.00,   250.00)
),
state AS (
    SELECT o.*,
           c.name        AS name_on_file,
           c.status,
           c.activation_date,
           EXTRACT(DAY FROM c.activation_date)::INT AS due_day,
           b.balance,
           b.credit_balance AS live_credit,
           -- Charges raised since the reconciliation: normal credit consumption.
           COALESCE((SELECT SUM(l.amount) FROM public.account_ledger_entries l
                     WHERE l.customer_id = o.customer_id
                       AND l.entry_type IN ('monthly_charge','suspension_charge')
                       AND l.created_at >= TIMESTAMP '2026-09-15 00:00:00'), 0) AS charges_since,
           -- Did a charge land in the last two days? This is the drift.
           EXISTS (SELECT 1 FROM public.account_ledger_entries l
                   WHERE l.customer_id = o.customer_id
                     AND l.entry_type IN ('monthly_charge','suspension_charge')
                     AND l.created_at >= (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE - 1) AS charged_last_2_days,
           -- A real correction by another batch: means hands off.
           EXISTS (SELECT 1 FROM public.account_ledger_entries l
                   WHERE l.customer_id = o.customer_id
                     AND l.entry_type = 'adjustment'
                     AND l.created_at >= TIMESTAMP '2026-09-15 00:00:00'
                     AND COALESCE(l.source_key, '') NOT LIKE 'final-reconciliation-20260915:%') AS already_corrected,
           EXISTS (SELECT 1 FROM public.account_ledger_entries l
                   WHERE l.customer_id = o.customer_id
                     AND l.source_key = 'reconciliation-overcredit-fix:' || o.customer_id::TEXT) AS overcredit_fix_done
    FROM overcredit o
    LEFT JOIN public.customers c               ON c.customer_id = o.customer_id
    LEFT JOIN public.customer_billing_status b ON b.customer_id = o.customer_id
)
SELECT customer_id,
       name_on_file,
       status,
       due_day,
       live_credit,
       committed_credit AS target_sep15,
       overcredit,
       charges_since,
       charged_last_2_days,
       (live_credit - overcredit) AS credit_after_fix,
       CASE
           WHEN overcredit_fix_done              THEN 'DONE - already corrected by this fix'
           WHEN already_corrected                THEN 'LEAVE ALONE - another batch corrected it'
           WHEN live_credit IS NULL              THEN 'CHECK - no billing status row'
           WHEN live_credit - overcredit < 0     THEN 'HOLD - correcting flips them into debt'
           WHEN live_credit >= committed_credit  THEN 'MAIN SCRIPT - untouched since 2026-09-15'
           ELSE                                       'ADDENDUM - charge consumed credit, excess remains'
       END AS route
FROM state
ORDER BY CASE
           WHEN overcredit_fix_done THEN 4
           WHEN already_corrected THEN 5
           WHEN live_credit IS NULL THEN 6
           WHEN live_credit - overcredit < 0 THEN 3
           WHEN live_credit >= committed_credit THEN 1
           ELSE 2 END,
         overcredit DESC;
