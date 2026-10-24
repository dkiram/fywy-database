-- ============================================================================
-- READ ONLY. Nigel Morgan (13330) - a J$3,500.00 receipt tagged October 2026
-- that should be tagged August 2026.
--
-- Re-tagging a month is NOT a balance correction: the money is a
-- monthly_payment credit of 3,500 either way and the balance does not move.
-- What the tag changes is which CHARGE the receipt is understood to pay, and
-- that has consequences worth seeing before anything is written:
--
--   * At payment time, paymentMonthCharge.ts raises a charge for a PAST month
--     that was never billed. A receipt tagged October (current month) raises
--     nothing. So if August was never charged, re-tagging to August should
--     also post the August charge - otherwise the money stays as credit and
--     the month still reads unpaid.
--   * If August IS already charged and settled, re-tagging makes this a
--     second settlement of August, which is the settled-twice shape that has
--     been causing the phantom credits all month.
--   * Due days 1-15 bill a month's service in the FOLLOWING month, so check
--     the activation day before assuming which charge "August" means.
--
-- There are two Nigel Morgans - 4662 (in the September over-credit batch) and
-- 13330 (this one). Query 1 confirms which account this is.
--
-- Writes nothing.
--
-- Run on the NAS:
--   ssh -p 9222 SPCNAS@100.98.108.77 \
--     'docker exec -i spcl-postgres psql -U spcl_user -d spcl_db' \
--     < scratchpad/discount-reconciliation-2026-09-15/audit-nigel-morgan-13330-retag.sql
-- ============================================================================

-- 1. Which account, and where does it stand?
SELECT c.customer_id, c.name, c.status, c.monthly_fee, c.activation_date,
       EXTRACT(DAY FROM c.activation_date)::INT AS due_day,
       CASE WHEN EXTRACT(DAY FROM c.activation_date) <= 15
            THEN 'days 1-15: a month bills the FOLLOWING month'
            ELSE 'days 16-31: a month bills the SAME month' END AS billing_map,
       b.balance, b.credit_balance, b.outstanding_balance, b.oldest_unpaid_due_date
FROM public.customers c
LEFT JOIN public.customer_billing_status b USING (customer_id)
WHERE c.customer_id = 13330;

-- 2. The receipt in question, and every other payment on the account this year.
--    Confirm there is exactly ONE 3,500 receipt tagged October 2026.
SELECT p.payment_id, p.receipt_number, p.recorded_at, p.payment_date,
       p.payment_type, p.amount_paid, p.month_paid, p.voided_at,
       p.cashier_name, p.location, p.note,
       (p.amount_paid = 3500.00 AND p.month_paid = DATE '2026-10-01'
        AND p.payment_type = 'Monthly Fee' AND p.voided_at IS NULL) AS is_the_one
FROM public.payments p
WHERE p.customer_id = 13330
  AND p.payment_date >= DATE '2026-01-01'
ORDER BY p.recorded_at, p.payment_id;

-- 3. Full ledger for the second half of 2026, with a running balance.
SELECT l.account_ledger_entry_id, l.created_at, l.effective_date, l.due_date,
       l.entry_type, l.amount,
       SUM(l.amount) OVER (ORDER BY l.effective_date, l.created_at, l.account_ledger_entry_id) AS running_balance,
       l.source_key, LEFT(l.description, 55) AS description
FROM public.account_ledger_entries l
WHERE l.customer_id = 13330
ORDER BY l.effective_date, l.created_at, l.account_ledger_entry_id;

-- 4. The decisive question: does each month have a charge, and is it still open?
--    A charge whose due date is before oldest_unpaid_due_date is already
--    covered - re-tagging onto it would settle it twice.
WITH me AS (
    SELECT c.customer_id, c.activation_date,
           (SELECT oldest_unpaid_due_date FROM public.customer_billing_status b WHERE b.customer_id = c.customer_id) AS owing_from
    FROM public.customers c WHERE c.customer_id = 13330
),
months AS (
    SELECT m.*, s.service_month,
           public.spcl_anniversary_date(m.activation_date,
             (s.service_month + CASE WHEN EXTRACT(DAY FROM m.activation_date) <= 15
                THEN INTERVAL '1 month' ELSE INTERVAL '0 months' END)::DATE) AS mapped_due
    FROM me m
    CROSS JOIN (VALUES (DATE '2026-07-01'), (DATE '2026-08-01'), (DATE '2026-09-01'), (DATE '2026-10-01')) AS s(service_month)
)
SELECT TO_CHAR(mo.service_month, 'Mon YYYY') AS service_month,
       mo.mapped_due AS charge_due_date,
       ch.account_ledger_entry_id AS charge_id,
       ch.amount AS charge_amount,
       (ch.account_ledger_entry_id IS NOT NULL) AS has_charge,
       CASE WHEN ch.account_ledger_entry_id IS NULL THEN 'no charge for this month'
            WHEN mo.owing_from IS NULL             THEN 'charged and fully settled (nothing owing on the account)'
            WHEN ch.due_date < mo.owing_from       THEN 'charged and ALREADY SETTLED - re-tagging here settles it twice'
            ELSE                                        'charged and still open - safe target for the receipt'
       END AS verdict,
       public.spcl_customer_service_active_on(mo.customer_id, mo.mapped_due) AS service_on
FROM months mo
LEFT JOIN public.account_ledger_entries ch
       ON ch.customer_id = mo.customer_id
      AND ch.entry_type = 'monthly_charge'
      AND COALESCE(ch.due_date, ch.effective_date) = mo.mapped_due
ORDER BY mo.service_month;
