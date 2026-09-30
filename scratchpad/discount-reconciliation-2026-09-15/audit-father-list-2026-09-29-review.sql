-- ============================================================================
-- READ ONLY. The five items from the 2026-09-29 list that are NOT credit
-- removals, and should not be scripted until the numbers are on the table.
--
--   Michel Bryan York  "remove 76,100 balance"     FORGIVING A DEBT
--   Ryan Morris        "add 1950 to balance"       CREATING A DEBT
--   Dekano King  8509  "change credit to 5000"     direction unknown
--   Curtis Davy   740  "should have a $2000 credit" direction unknown
--   Beverley           first name only             cannot be identified
--
-- WHY THESE ARE SEPARATE
--
-- Michel Bryan York is the one to look at hardest. "Remove 76,100 balance"
-- is not a phantom-credit cleanup at all - it writes off J$76,100 the
-- customer OWES. Every other item in three weeks of these lists has been
-- around J$2,500 of credit coming off; this is thirty times larger and in the
-- opposite direction. It also does not say whether 76,100 is the whole
-- balance or an amount to subtract from a larger one. Section 1 shows what he
-- actually owes and how it was built up, so the decision can be made on real
-- figures.
--
-- Dekano King and Curtis Davy are stated as target credits, not amounts to
-- remove, so until the live balance is known we cannot tell whether each is a
-- reduction or a GIFT of credit. Curtis Davy is interesting: the 2026-09-15
-- reconciliation already targeted him at exactly -2,000, which is the figure
-- your father is now asking for.
--
-- Beverley has no surname. Section 4 lists every account whose name starts
-- with it so the right one can be picked - "add 2500 credit" gives money away,
-- so this is the last one to guess at.
--
-- Writes nothing.
--
-- Run on the NAS:
--   ssh -p 9222 SPCNAS@100.98.108.77 \
--     'docker exec -i spcl-postgres psql -U spcl_user -d spcl_db' \
--     < scratchpad/discount-reconciliation-2026-09-15/audit-father-list-2026-09-29-review.sql
-- Or paste into TablePlus and "Run All".
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Michel Bryan York - who is it, and what is the 76,100 made of?
-- ----------------------------------------------------------------------------
SELECT 'MICHEL BRYAN YORK - candidates' AS check,
       c.customer_id, c.name, c.status, c.monthly_fee, c.activation_date,
       b.balance, b.outstanding_balance, b.credit_balance
FROM public.customers c
LEFT JOIN public.customer_billing_status b ON b.customer_id = c.customer_id
WHERE c.name ILIKE '%york%'
   OR c.name ILIKE '%michel%bryan%'
ORDER BY b.balance DESC NULLS LAST, c.customer_id;

-- How the balance was built, for whichever account that is. If the debt is
-- mostly unpaid monthly_charge rows the customer genuinely owes it; if it is
-- opening_balance from the legacy import it may be a migration artefact.
SELECT 'MICHEL BRYAN YORK - balance by entry type' AS check,
       c.customer_id, c.name, l.entry_type,
       COUNT(*) AS entries, SUM(l.amount) AS total,
       MIN(COALESCE(l.due_date, l.effective_date)) AS earliest,
       MAX(COALESCE(l.due_date, l.effective_date)) AS latest
FROM public.account_ledger_entries l
JOIN public.customers c USING (customer_id)
WHERE (c.name ILIKE '%york%' OR c.name ILIKE '%michel%bryan%')
GROUP BY c.customer_id, c.name, l.entry_type
ORDER BY c.customer_id, SUM(l.amount) DESC;

-- Has this customer ever actually paid anything?
SELECT 'MICHEL BRYAN YORK - payments' AS check,
       c.customer_id, c.name,
       COUNT(*) AS receipts,
       SUM(p.amount_paid) AS total_paid,
       MIN(p.payment_date) AS first_payment,
       MAX(p.payment_date) AS last_payment
FROM public.payments p
JOIN public.customers c USING (customer_id)
WHERE (c.name ILIKE '%york%' OR c.name ILIKE '%michel%bryan%')
  AND p.voided_at IS NULL
GROUP BY c.customer_id, c.name
ORDER BY c.customer_id;

-- ----------------------------------------------------------------------------
-- 2. Ryan Morris - "add 1950 to balance"
-- ----------------------------------------------------------------------------
SELECT 'RYAN MORRIS' AS check,
       c.customer_id, c.name, c.status, c.monthly_fee,
       b.balance AS balance_now,
       (b.balance + 1950.00) AS balance_after_adding_1950,
       b.credit_balance,
       (LOWER(TRIM(c.name)) = 'ryan morris') AS exact_match
FROM public.customers c
LEFT JOIN public.customer_billing_status b ON b.customer_id = c.customer_id
WHERE c.name ILIKE '%ryan%morris%'
ORDER BY (LOWER(TRIM(c.name)) = 'ryan morris') DESC, c.customer_id;

-- ----------------------------------------------------------------------------
-- 3. Dekano King (8509) and Curtis Davy (740) - stated TARGETS, so the
--    direction depends on where they are now. A negative adjustment means
--    giving the customer credit.
-- ----------------------------------------------------------------------------
WITH targets(customer_id, expected_name, target_balance, instruction) AS (VALUES
    (8509, 'Dekano King', -5000.00::NUMERIC, 'change credit to 5000'),
    ( 740, 'Curtis Davy', -2000.00,          'should have a $2000 credit')
)
SELECT 'STATED TARGET' AS check,
       t.customer_id, t.expected_name, c.name AS name_on_file, c.status,
       c.monthly_fee, b.balance AS balance_now, b.credit_balance AS credit_now,
       t.target_balance, (t.target_balance - b.balance) AS adjustment,
       CASE
           WHEN c.customer_id IS NULL                  THEN 'id not found'
           WHEN LOWER(TRIM(c.name)) <> LOWER(TRIM(t.expected_name))
                                                       THEN 'NAME MISMATCH - check the id'
           WHEN b.balance = t.target_balance           THEN 'already at target - nothing to do'
           WHEN t.target_balance < b.balance           THEN 'ADDS CREDIT - giving money, confirm first'
           ELSE                                             'removes credit'
       END AS direction,
       t.instruction
FROM targets t
LEFT JOIN public.customers c               ON c.customer_id = t.customer_id
LEFT JOIN public.customer_billing_status b ON b.customer_id = t.customer_id;

-- ----------------------------------------------------------------------------
-- 4. "Beverley" - first name only. Which one? Only accounts IN CREDIT or at
--    zero are plausible for "add 2500 credit", but all are listed.
-- ----------------------------------------------------------------------------
SELECT 'BEVERLEY - candidates' AS check,
       c.customer_id, c.name, c.status, c.monthly_fee,
       b.balance, b.credit_balance
FROM public.customers c
LEFT JOIN public.customer_billing_status b ON b.customer_id = c.customer_id
WHERE c.name ILIKE '%beverley%' OR c.name ILIKE '%beverly%'
ORDER BY b.balance NULLS LAST, c.customer_id;
