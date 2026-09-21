-- ============================================================================
-- READ ONLY. Melodie OConnor (8571) - the WHOLE ledger this time, plus her
-- status history and every tagged month, to pin down exactly which paid month
-- has no charge behind it.
--
-- Working theory: she owed 2,500 in monthly charges + 1,500 reconnection fee
-- before the 18th, then paid July (1,500) and August (2,500) at the counter.
-- Only one of those months has a charge. The other is 1,500 of credit with
-- nothing to absorb it. July at 1,500 is the obvious suspect.
--
-- Writes nothing.
-- ============================================================================

-- 1. Every ledger entry, oldest first, with a running balance.
SELECT l.account_ledger_entry_id,
       l.created_at,
       l.effective_date,
       l.due_date,
       l.entry_type,
       l.amount,
       SUM(l.amount) OVER (ORDER BY l.effective_date, l.created_at, l.account_ledger_entry_id) AS running_balance,
       l.source_key,
       LEFT(l.description, 60) AS description
FROM public.account_ledger_entries l
WHERE l.customer_id = 8571
ORDER BY l.effective_date, l.created_at, l.account_ledger_entry_id;

-- 2. Status history - when was she off, and when did she come back?
SELECT h.effective_date, h.changed_at, h.from_status, h.to_status, LEFT(h.reason, 70) AS reason
FROM public.account_status_history h
WHERE h.customer_id = 8571
ORDER BY h.effective_date, h.changed_at;

-- 3. Every Monthly Fee payment with its tagged month, and whether a charge
--    exists for that month. A row with has_charge = false is the phantom.
SELECT p.payment_id,
       p.recorded_at,
       p.amount_paid,
       p.month_paid,
       p.voided_at,
       EXISTS (
           SELECT 1 FROM public.account_ledger_entries ch
           WHERE ch.customer_id = p.customer_id
             AND ch.entry_type = 'monthly_charge'
             AND DATE_TRUNC('month', COALESCE(ch.due_date, ch.effective_date)) = DATE_TRUNC('month', p.month_paid)
       ) AS has_charge,
       public.spcl_customer_service_active_on(p.customer_id, p.month_paid) AS service_on_that_month
FROM public.payments p
WHERE p.customer_id = 8571
  AND p.payment_type = 'Monthly Fee'
  AND p.month_paid IS NOT NULL
ORDER BY p.month_paid, p.recorded_at;

-- 4. Totals by type - the fee should net to zero.
SELECT l.entry_type, COUNT(*) AS entries, SUM(l.amount) AS total
FROM public.account_ledger_entries l
WHERE l.customer_id = 8571
GROUP BY l.entry_type
ORDER BY l.entry_type;
