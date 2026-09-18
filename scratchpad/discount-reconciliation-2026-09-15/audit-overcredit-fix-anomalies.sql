-- ============================================================================
-- READ ONLY. Two accounts hold MORE credit than the over-credit fix should
-- have left them with, and no charge has posted since:
--
--   11423 Rudolph Rose #2     expected 1,500 after fix, holding 11,500 (+10,000)
--   12832 Tanyalee Campbell   expected 1,000 after fix, holding  4,000 (+3,000)
--
-- Most likely a payment taken after the correction, which is fine. Worth
-- confirming, because a J$10,000 receipt is also what a mistyped J$1,000
-- looks like. This shows every entry on both accounts since the 2026-09-15
-- reconciliation, plus the receipts behind any payment.
--
-- Writes nothing.
--
-- Run on the NAS:
--   ssh -p 9222 SPCNAS@100.98.108.77 \
--     'docker exec -i spcl-postgres psql -U spcl_user -d spcl_db' \
--     < scratchpad/discount-reconciliation-2026-09-15/audit-overcredit-fix-anomalies.sql
-- ============================================================================

-- 1. Full ledger since the reconciliation.
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
WHERE l.customer_id IN (11423, 12832)
  AND l.created_at >= TIMESTAMP '2026-09-15 00:00:00'
ORDER BY l.customer_id, l.created_at, l.account_ledger_entry_id;

-- 2. The receipts themselves - amount, month tagged, who took it.
SELECT p.customer_id,
       c.name,
       p.payment_id,
       p.receipt_number,
       p.payment_date,
       p.payment_type,
       p.amount_paid,
       p.month_paid,
       p.voided_at,
       e.first_name || ' ' || e.last_name AS taken_by
FROM public.payments p
JOIN public.customers c USING (customer_id)
LEFT JOIN public.employees e ON e.employee_id = p.created_by_employee_id
WHERE p.customer_id IN (11423, 12832)
  AND p.payment_date >= DATE '2026-09-15'
ORDER BY p.customer_id, p.payment_date, p.payment_id;

-- 3. Their normal monthly fee, for scale - is a J$10,000 receipt in character
--    for this account, or four months out of line?
SELECT c.customer_id, c.name, c.status, c.monthly_fee, b.balance, b.credit_balance
FROM public.customers c
JOIN public.customer_billing_status b USING (customer_id)
WHERE c.customer_id IN (11423, 12832);
