-- ============================================================================
-- READ ONLY. Jodi-Ann Hibbert (8671) - work out the exact credit needed to
-- cover her monthly charges up to and including 21 January 2027.
--
-- Instruction 2026-10-03: "change it from outstanding $4000 to a credit that
-- will last until 21 Jan 2027 for $2500 a month."
--
-- The figure to post depends on three things that must come from the database,
-- not from arithmetic in a message:
--   1. how many charges actually fall between now and 21 Jan 2027, which
--      depends on her activation anniversary (the "21" in the instruction
--      suggests the 21st, but that needs confirming);
--   2. whether her monthly fee really is 2,500;
--   3. whether she really is at 4,000 outstanding right now.
--
-- Section 3 computes the charge dates using the system's OWN anniversary
-- function, so the count is whatever the generator will actually raise rather
-- than a guess about month boundaries.
--
-- The amount is large either way - clearing a 4,000 debt AND granting several
-- months of credit - so nothing is written until the numbers are agreed.
--
-- Writes nothing.
--
-- Run on the NAS:
--   ssh -p 9222 SPCNAS@100.98.108.77 \
--     'docker exec -i spcl-postgres psql -U spcl_user -d spcl_db' \
--     < scratchpad/discount-reconciliation-2026-09-15/audit-jodi-ann-hibbert-8671-credit-to-jan.sql
-- ============================================================================

-- 1. Who she is and where she stands.
SELECT 'ACCOUNT' AS check,
       c.customer_id, c.name, c.status, c.monthly_fee,
       c.activation_date,
       EXTRACT(DAY FROM c.activation_date)::INT AS activation_day,
       c.reactivation_date,
       b.balance, b.outstanding_balance, b.credit_balance,
       b.oldest_unpaid_due_date
FROM public.customers c
LEFT JOIN public.customer_billing_status b ON b.customer_id = c.customer_id
WHERE c.customer_id = 8671;

-- 2. The rate actually in force, in case monthly_fee and rate history differ.
SELECT 'RATE HISTORY' AS check,
       r.customer_rate_history_id, r.effective_date, r.monthly_fee
FROM public.customer_rate_history r
WHERE r.customer_id = 8671
ORDER BY r.effective_date DESC, r.customer_rate_history_id DESC
LIMIT 5;

-- 3. THE IMPORTANT BLOCK: every charge due from today to 21 Jan 2027, by the
--    system's own anniversary calculation, with a running total of what the
--    credit has to absorb.
WITH me AS (
    SELECT c.customer_id, c.activation_date, c.monthly_fee,
           (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE AS today
    FROM public.customers c WHERE c.customer_id = 8671
),
months AS (
    SELECT generate_series(
             DATE_TRUNC('month', (SELECT today FROM me))::DATE,
             DATE '2027-02-01',
             INTERVAL '1 month'
           )::DATE AS month_start
),
due AS (
    SELECT m.month_start,
           public.spcl_anniversary_date(me.activation_date, m.month_start) AS due_date,
           me.monthly_fee,
           rate.monthly_fee AS rate_then
    FROM months m CROSS JOIN me
    LEFT JOIN LATERAL (
        SELECT r.monthly_fee FROM public.customer_rate_history r
        WHERE r.customer_id = me.customer_id
          AND r.effective_date <= public.spcl_anniversary_date(me.activation_date, m.month_start)
        ORDER BY r.effective_date DESC, r.customer_rate_history_id DESC
        LIMIT 1
    ) rate ON TRUE
)
SELECT 'CHARGES TO COVER' AS check,
       d.due_date,
       COALESCE(d.rate_then, d.monthly_fee) AS charge_amount,
       SUM(COALESCE(d.rate_then, d.monthly_fee)) OVER (ORDER BY d.due_date) AS running_total,
       EXISTS (
           SELECT 1 FROM public.account_ledger_entries l
           WHERE l.customer_id = 8671
             AND l.entry_type = 'monthly_charge'
             AND COALESCE(l.due_date, l.effective_date) = d.due_date
       ) AS already_charged
FROM due d
WHERE d.due_date >= (SELECT today FROM me)
  AND d.due_date <= DATE '2027-01-21'
ORDER BY d.due_date;

-- 4. The same total in one line, next to what it means for the balance.
WITH me AS (
    SELECT c.customer_id, c.activation_date, c.monthly_fee,
           (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE AS today
    FROM public.customers c WHERE c.customer_id = 8671
),
months AS (
    SELECT generate_series(
             DATE_TRUNC('month', (SELECT today FROM me))::DATE,
             DATE '2027-02-01',
             INTERVAL '1 month'
           )::DATE AS month_start
),
due AS (
    SELECT public.spcl_anniversary_date(me.activation_date, m.month_start) AS due_date,
           me.monthly_fee
    FROM months m CROSS JOIN me
)
SELECT 'TOTAL' AS check,
       COUNT(*)                                   AS charges_to_cover,
       MIN(d.due_date)                            AS first_charge,
       MAX(d.due_date)                            AS last_charge,
       SUM(d.monthly_fee)                         AS credit_needed,
       b.balance                                  AS balance_now,
       (-SUM(d.monthly_fee)) - b.balance          AS adjustment_required,
       (-SUM(d.monthly_fee))                      AS target_balance
FROM due d
CROSS JOIN public.customer_billing_status b
WHERE b.customer_id = 8671
  AND d.due_date >= (SELECT today FROM me)
  AND d.due_date <= DATE '2027-01-21'
GROUP BY b.balance;

-- 5. Is she already carrying charges nobody has paid? Those are what the
--    4,000 is made of, and they tell you whether the debt is real.
SELECT 'HER LEDGER, LAST 6 MONTHS' AS check,
       l.effective_date, l.due_date, l.entry_type, l.amount, l.source_key
FROM public.account_ledger_entries l
WHERE l.customer_id = 8671
  AND l.effective_date >= ((CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE - 180)
ORDER BY l.effective_date, l.account_ledger_entry_id;
