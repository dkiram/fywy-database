-- ============================================================================
-- READ-ONLY. August 1-18 2026 joiners who show a balance after one month.
--
-- Cause found 2026-09-27: a charge dated ON the activation day. The nightly
-- generator never bills the activation day - the first bill is the first
-- anniversary after it. Two things raised one anyway when the customer paid
-- "August" at the counter:
--   * the payment screen, 11-18 Sept (commit 30074e0): it dated August's
--     charge on the anniversary inside August, which for an August joiner IS
--     the activation day. From 18 Sept it still did this for anyone
--     activated on the 16th-31st.
--   * Pass B of fix-phantom-credits-2026-09.sql (10 Sept), same date rule,
--     for August-tagged receipts taken before then.
-- The customer then also gets the real September anniversary charge: two
-- bills after one month of service, grace runs out, disconnected.
--
-- The J$0 "Monthly Fee" rows Access used to activate customers are NOT the
-- cause: every August joiner has one, but a J$0 row can never reach the
-- ledger (amount <> 0 check) and 041 / the billing views all filter them out.
-- Block 4 proves that on the live data.
--
-- Discounts/waivers/adjustments are shown per account, because many of these
-- were already cleared by the Sept 15 current-charge relief or by hand.
-- ============================================================================

-- 1. One row per August 1-18 joiner.
WITH scope AS (
    SELECT c.customer_id, c.name, c.status, c.monthly_fee, c.activation_date
    FROM public.customers c
    WHERE c.activation_date BETWEEN DATE '2026-08-01' AND DATE '2026-08-18'
),
ledger AS (
    SELECT s.customer_id,
        COALESCE(SUM(e.amount) FILTER (WHERE e.entry_type = 'monthly_charge'
            AND e.due_date <= s.activation_date), 0) AS activation_day_charges,
        COUNT(*) FILTER (WHERE e.entry_type = 'monthly_charge'
            AND e.due_date <= s.activation_date) AS activation_day_charge_rows,
        STRING_AGG(e.due_date::TEXT || ' (' || COALESCE(e.created_by_employee_id::TEXT, 'script') || ')', ', ')
            FILTER (WHERE e.entry_type = 'monthly_charge' AND e.due_date <= s.activation_date) AS activation_day_due,
        COALESCE(SUM(e.amount) FILTER (WHERE e.entry_type = 'monthly_charge'
            AND e.due_date > s.activation_date), 0) AS regular_charges,
        COALESCE(SUM(e.amount) FILTER (WHERE e.entry_type IN ('monthly_payment', 'reconnection_payment', 'payment_void')), 0) AS payment_credits,
        COALESCE(SUM(e.amount) FILTER (WHERE e.entry_type = 'waiver'), 0) AS discounts_and_waivers,
        COALESCE(SUM(e.amount) FILTER (WHERE e.entry_type = 'adjustment'), 0) AS adjustments,
        COALESCE(SUM(e.amount) FILTER (WHERE e.entry_type IN ('reconnection_fee', 'suspension_reconnection_fee')), 0) AS reconnection_fees,
        BOOL_OR(e.entry_type = 'adjustment' AND e.amount > 0 AND e.created_at >= TIMESTAMPTZ '2026-09-16 00:00 America/Jamaica') AS recent_manual_debit
    FROM scope s
    LEFT JOIN public.account_ledger_entries e ON e.customer_id = s.customer_id
    GROUP BY s.customer_id
),
receipts AS (
    SELECT s.customer_id,
        COALESCE(SUM(p.amount_paid) FILTER (WHERE p.amount_paid > 0), 0) AS receipts_total,
        COUNT(*) FILTER (WHERE p.amount_paid = 0) AS zero_receipts,
        -- Receipts whose ledger credit is short (the 14-15 Sept capped build).
        COALESCE(SUM(p.amount_paid - COALESCE(-credit.amount, 0)) FILTER (
            WHERE p.amount_paid > 0 AND p.receipt_number IS NOT NULL
              AND p.payment_type IN ('Monthly Fee', 'Reconnection Fee')
              AND COALESCE(-credit.amount, 0) < p.amount_paid), 0) AS receipt_shortfall,
        STRING_AGG(p.payment_date::TEXT || ' J$' || p.amount_paid::TEXT
            || COALESCE(' for ' || TO_CHAR(p.month_paid, 'Mon'), ''), ', ' ORDER BY p.payment_date)
            FILTER (WHERE p.amount_paid > 0) AS receipts
    FROM scope s
    LEFT JOIN public.payments p ON p.customer_id = s.customer_id AND p.voided_at IS NULL
    LEFT JOIN LATERAL (
        SELECT SUM(e.amount) AS amount FROM public.account_ledger_entries e
        WHERE e.payment_id = p.payment_id AND e.entry_type IN ('monthly_payment', 'reconnection_payment')
    ) credit ON TRUE
    GROUP BY s.customer_id
)
SELECT
    CASE
        WHEN l.recent_manual_debit THEN 'REVIEW - manual debit since Sept 16'
        WHEN l.activation_day_charges > 0 AND b.balance > 0 THEN 'FIX - activation-day charge'
        WHEN l.activation_day_charges > 0 THEN 'already cleared (discount/relief)'
        WHEN r.receipt_shortfall > 0 AND b.balance > 0 THEN 'REVIEW - receipt not fully credited'
        WHEN b.balance > 0 THEN 'owes a regular bill'
        ELSE 'clear'
    END AS verdict,
    s.customer_id, s.name, s.status, s.activation_date, s.monthly_fee,
    b.balance, b.oldest_unpaid_due_date, b.grace_end_date, b.eligible_for_disconnection,
    l.activation_day_charges, l.activation_day_due, l.regular_charges,
    r.receipts_total, l.payment_credits, r.receipt_shortfall,
    l.discounts_and_waivers, l.adjustments, l.reconnection_fees,
    r.zero_receipts, r.receipts
FROM scope s
JOIN public.customer_billing_status b USING (customer_id)
JOIN ledger l USING (customer_id)
JOIN receipts r USING (customer_id)
ORDER BY 1, s.activation_date, s.customer_id;

-- 2. Counts by verdict (same rules as above).
WITH scope AS (
    SELECT c.customer_id, c.activation_date FROM public.customers c
    WHERE c.activation_date BETWEEN DATE '2026-08-01' AND DATE '2026-08-18'
), x AS (
    SELECT s.customer_id, b.balance, b.eligible_for_disconnection, c.status,
        COALESCE(SUM(e.amount) FILTER (WHERE e.entry_type = 'monthly_charge' AND e.due_date <= s.activation_date), 0) AS bad
    FROM scope s JOIN public.customers c USING (customer_id)
    JOIN public.customer_billing_status b USING (customer_id)
    LEFT JOIN public.account_ledger_entries e ON e.customer_id = s.customer_id
    GROUP BY s.customer_id, b.balance, b.eligible_for_disconnection, c.status
)
SELECT
    COUNT(*) AS joiners,
    COUNT(*) FILTER (WHERE balance > 0) AS showing_a_balance,
    COUNT(*) FILTER (WHERE bad > 0) AS with_activation_day_charge,
    COUNT(*) FILTER (WHERE bad > 0 AND balance > 0) AS to_fix,
    SUM(LEAST(bad, GREATEST(balance, 0))) AS relief_total,
    COUNT(*) FILTER (WHERE bad > 0 AND balance <= 0) AS already_cleared_by_discount,
    COUNT(*) FILTER (WHERE bad > 0 AND status IN ('disconnected', 'pending_reconnection')) AS cut_off_with_bad_charge,
    COUNT(*) FILTER (WHERE bad > 0 AND eligible_for_disconnection) AS on_disconnection_list_with_bad_charge
FROM x;

-- 3. Same pattern OUTSIDE Aug 1-18 (not touched by the fix - for scale only).
SELECT DATE_TRUNC('month', c.activation_date)::DATE AS joined_month,
       COUNT(DISTINCT c.customer_id) AS accounts, SUM(e.amount) AS charged
FROM public.customers c
JOIN public.account_ledger_entries e
  ON e.customer_id = c.customer_id AND e.entry_type = 'monthly_charge'
 AND e.due_date <= c.activation_date
WHERE c.activation_date NOT BETWEEN DATE '2026-08-01' AND DATE '2026-08-18'
GROUP BY 1 ORDER BY 1 DESC LIMIT 12;

-- 4. The J$0 activation rows never touch money.
SELECT COUNT(*) AS zero_rows,
       COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.account_ledger_entries e
                                      WHERE e.payment_id = p.payment_id)) AS zero_rows_on_ledger
FROM public.payments p
JOIN public.customers c USING (customer_id)
WHERE p.amount_paid = 0
  AND c.activation_date BETWEEN DATE '2026-08-01' AND DATE '2026-08-18';
