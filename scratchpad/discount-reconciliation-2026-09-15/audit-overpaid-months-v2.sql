-- ============================================================================
-- READ ONLY. Months paid for more than they cost - with the rate-change false
-- positives suppressed.
--
-- v1 of this query compared receipts against the rate in force on the 1st of
-- the paid month. That flags a customer whose rate went UP mid-month: the
-- lookup finds the OLD rate, the customer paid the NEW one, and a perfectly
-- normal split payment looks like an overpayment. It produced three such
-- false alarms (Neville Christopher, Laticia Barnes, Nessado Reid) - in each
-- the total paid equalled the CURRENT fee exactly.
--
-- So a month is only suspicious when the receipts exceed BOTH the rate in
-- force for that month AND the customer's current fee.
--
-- Reading the result - the important distinction is not duplicate-or-not, it
-- is DUPLICATE MONEY vs MIS-TAGGED MONTH:
--   * receipts marching forward a month at a time, then one repeat  -> almost
--     certainly the next month keyed with the previous month's tag. RE-TAG it;
--     voiding would destroy a real payment.
--   * the same amount keyed twice within seconds, no sequence       -> likely
--     a genuine duplicate. VOID the extra receipt in the app so the credit
--     reverses and the receipt trail survives.
-- Confirm with the named cashier before doing either.
--
-- Writes nothing.
--
-- Run on the NAS:
--   ssh -p 9222 SPCNAS@100.98.108.77 \
--     'docker exec -i spcl-postgres psql -U spcl_user -d spcl_db' \
--     < scratchpad/discount-reconciliation-2026-09-15/audit-overpaid-months-v2.sql
-- ============================================================================

WITH paid_months AS (
    SELECT p.customer_id,
           p.month_paid,
           COUNT(*)           AS receipts,
           SUM(p.amount_paid) AS total_paid,
           MIN(p.recorded_at) AS first_keyed,
           MAX(p.recorded_at) AS last_keyed,
           STRING_AGG(p.payment_id::TEXT, ', ' ORDER BY p.payment_id)   AS payment_ids,
           STRING_AGG(DISTINCT p.cashier_name, ', ')                    AS cashiers
    FROM public.payments p
    WHERE p.voided_at IS NULL
      AND p.month_paid IS NOT NULL
      AND p.payment_type = 'Monthly Fee'
      AND p.recorded_at >= TIMESTAMP '2026-09-01 00:00:00'
    GROUP BY p.customer_id, p.month_paid
    HAVING COUNT(*) > 1
),
scored AS (
    SELECT pm.*,
           c.name,
           c.status,
           c.monthly_fee AS fee_today,
           rate.monthly_fee AS rate_that_month,
           GREATEST(COALESCE(rate.monthly_fee, 0), COALESCE(c.monthly_fee, 0)) AS fee_to_beat
    FROM paid_months pm
    JOIN public.customers c USING (customer_id)
    LEFT JOIN LATERAL (
        SELECT r.monthly_fee
        FROM public.customer_rate_history r
        WHERE r.customer_id = pm.customer_id
          AND r.effective_date <= pm.month_paid
        ORDER BY r.effective_date DESC, r.customer_rate_history_id DESC
        LIMIT 1
    ) rate ON TRUE
)
SELECT customer_id, name, status, month_paid, receipts,
       total_paid, rate_that_month, fee_today,
       (total_paid - fee_to_beat) AS excess,
       last_keyed - first_keyed   AS spread,
       CASE
           WHEN last_keyed - first_keyed < INTERVAL '2 minutes' THEN 'keyed back to back - check for a duplicate'
           WHEN last_keyed - first_keyed > INTERVAL '1 day'     THEN 'days apart - more likely a wrong month tag'
           ELSE                                                      'same session - ask the cashier'
       END AS shape,
       payment_ids, cashiers
FROM scored
WHERE total_paid > fee_to_beat
ORDER BY (total_paid - fee_to_beat) DESC;
