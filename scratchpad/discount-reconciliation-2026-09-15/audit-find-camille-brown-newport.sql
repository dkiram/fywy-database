-- ============================================================================
-- READ ONLY. Find the third Camille Brown account - "Newport Square".
--
-- The 2026-09-30 script searched for '%camille%brown%newport%' and matched
-- nothing, so at least one of those three words is spelled differently on
-- file. The other two accounts are "Camille Brown/Boose and Games" (14298)
-- and "Camille Brown\Di Imerial Entertainment" (14356) - both already show
-- that the names on file carry typos, so expect one here too.
--
-- Writes nothing.
-- ============================================================================

-- 1. Anything resembling the first name, however the surname is spelled.
SELECT 'CAMILLE-ish' AS check, c.customer_id, c.name, c.status, c.monthly_fee,
       b.balance, b.credit_balance
FROM public.customers c
LEFT JOIN public.customer_billing_status b ON b.customer_id = c.customer_id
WHERE c.name ILIKE '%camille%'
   OR c.name ILIKE '%camile%'
   OR c.name ILIKE '%cammil%'
   OR c.name ILIKE '%camill%'
ORDER BY c.name, c.customer_id;

-- 2. Anything at Newport, whoever it belongs to - the suffix may be the only
--    reliable part, and it may be "New Port", "Newprt", "Npt Sq" etc.
SELECT 'NEWPORT-ish' AS check, c.customer_id, c.name, c.status, c.monthly_fee,
       b.balance, b.credit_balance
FROM public.customers c
LEFT JOIN public.customer_billing_status b ON b.customer_id = c.customer_id
WHERE c.name ILIKE '%newport%'
   OR c.name ILIKE '%new port%'
   OR c.name ILIKE '%newprt%'
   OR c.name ILIKE '%npt%'
ORDER BY c.name, c.customer_id;

-- 3. Every Brown holding exactly the J$2,500 your father quoted. If the first
--    name is mangled beyond the patterns above, the amount should find her.
SELECT 'BROWN HOLDING 2500 CREDIT' AS check, c.customer_id, c.name, c.status,
       c.monthly_fee, b.balance, b.credit_balance
FROM public.customers c
JOIN public.customer_billing_status b USING (customer_id)
WHERE c.name ILIKE '%brown%'
  AND b.credit_balance = 2500.00
ORDER BY c.name, c.customer_id;
