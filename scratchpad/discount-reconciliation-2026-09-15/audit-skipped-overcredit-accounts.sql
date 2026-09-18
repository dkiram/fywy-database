-- ============================================================================
-- READ ONLY. Why did these 6 accounts' credit drop since 2026-09-15?
--
-- They were skipped by FIX-reconciliation-overcredit-remaining.sql because
-- their live credit is below the target the 2026-09-15 reconciliation set.
-- Two very different causes, and they need opposite treatment:
--
--   a monthly_charge posted   -> normal. The credit was consumed by a real
--                                bill. The over-credit is still in there and
--                                the correction is still owed.
--   an adjustment posted      -> something already corrected this account
--                                (the August-2026 sweep zeroes credit
--                                outright; the current-charge batch restores
--                                charges). Correcting again double-charges
--                                the customer. Leave alone.
--
-- Writes nothing.
--
-- Run on the NAS:
--   ssh -p 9222 SPCNAS@100.98.108.77 \
--     'docker exec -i spcl-postgres psql -U spcl_user -d spcl_db' \
--     < scratchpad/discount-reconciliation-2026-09-15/audit-skipped-overcredit-accounts.sql
-- ============================================================================

-- 1. Summary: what moved on each account since the reconciliation, by type.
SELECT l.customer_id,
       c.name,
       b.balance                                   AS balance_now,
       b.credit_balance                            AS credit_now,
       l.entry_type,
       COUNT(*)                                    AS entries,
       SUM(l.amount)                               AS total_amount
FROM public.account_ledger_entries l
JOIN public.customers c                USING (customer_id)
JOIN public.customer_billing_status b  USING (customer_id)
WHERE l.customer_id IN (3334, 5810, 6301, 6554, 12121, 15064)
  AND l.created_at >= TIMESTAMP '2026-09-15 00:00:00'
GROUP BY l.customer_id, c.name, b.balance, b.credit_balance, l.entry_type
ORDER BY l.customer_id, l.entry_type;

-- 2. Every entry since the reconciliation, in order. source_key names the
--    batch that wrote it:
--      final-reconciliation-20260915:*   the reconciliation itself
--      clear-credit-latest-aug-2026:*    the August-2026 credit sweep
--      staff-credit-fix-20260916:*       the 2026-09-16 staff corrections
--      monthly-charge:*                  the normal generator
--      payment:*                         a real receipt
SELECT l.customer_id,
       c.name,
       l.created_at,
       l.effective_date,
       l.entry_type,
       l.amount,
       l.source_key,
       LEFT(l.description, 60) AS description
FROM public.account_ledger_entries l
JOIN public.customers c USING (customer_id)
WHERE l.customer_id IN (3334, 5810, 6301, 6554, 12121, 15064)
  AND l.created_at >= TIMESTAMP '2026-09-15 00:00:00'
ORDER BY l.customer_id, l.created_at, l.account_ledger_entry_id;

-- 3. Blunt version of the question: does each account carry a non-reconciliation
--    adjustment since 2026-09-15? YES = already corrected, leave it alone.
SELECT o.customer_id,
       c.name,
       b.credit_balance AS credit_now,
       EXISTS (
           SELECT 1 FROM public.account_ledger_entries l
           WHERE l.customer_id = o.customer_id
             AND l.entry_type = 'adjustment'
             AND l.created_at >= TIMESTAMP '2026-09-15 00:00:00'
             AND COALESCE(l.source_key, '') NOT LIKE 'final-reconciliation-20260915:%'
       ) AS already_corrected,
       COALESCE((
           SELECT SUM(l.amount) FROM public.account_ledger_entries l
           WHERE l.customer_id = o.customer_id
             AND l.entry_type = 'monthly_charge'
             AND l.created_at >= TIMESTAMP '2026-09-15 00:00:00'
       ), 0) AS charges_since
FROM (VALUES (3334), (5810), (6301), (6554), (12121), (15064)) AS o(customer_id)
JOIN public.customers c                USING (customer_id)
JOIN public.customer_billing_status b  USING (customer_id)
ORDER BY o.customer_id;
