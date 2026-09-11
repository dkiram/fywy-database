-- ============================================================================
-- Read-only audit of every account sitting on a CREDIT (ledger balance < 0).
--
-- Goal: sort the credits into the handful of ways the system can manufacture
-- one, so we know which fix each group needs before touching money.
--
--   admin_credit            credit is explained by Add Credit rows (approved
--                           waiver_requests with is_credit = TRUE). Fine.
--   discount_credit         credit is explained by DISCOUNTS (is_credit =
--                           FALSE). A discount forgives a debt, so ending up
--                           in credit means it was bigger than the debt or the
--                           bill was already paid - see audit-waiver-credits.sql
--   paid_while_off:*        Monthly Fee money was tagged to months the account
--                           timeline says service was NOT active, so migration
--                           054/065 never posted the matching charges (customer
--                           11321 is the reference case). Suffix says which
--                           path created the disconnection:
--                             legacy_backdated  disconnectOverdueLegacyAccounts
--                                               (dated to a 2025 grace end,
--                                               no OLT command, no fee)
--                             automation        nightly delinquency worker
--                             olt_reconcile     reconcileDisconnectedFromOlt /
--                                               Hanover manual scripts
--                             manual            staff action in the app
--   recon_paid_no_fee       a Reconnection Fee payment exists but no
--                           reconnection_fee debit was ever posted.
--   active_not_charged      account is active but has raised no monthly
--                           charge in the last 40 days - the generator is
--                           skipping them (see generator_blocker) while their
--                           payments keep landing.
--   active_prepaid          active, being charged normally, credit is at
--                           most two months' fee. Almost certainly a real
--                           prepayment - leave alone.
--   active_overpaid         active, being charged normally, credit is MORE
--                           than two months' fee. Needs a look.
--   other                   nothing above matched.
--
-- Run on the NAS (the file is under the mounted deploy folder):
--   docker exec -i spcl-postgres psql -U spcl_user -d spcl_db \
--     < /opt/spcl-deploy/audit-account-credits.sql > credit-audit.txt
-- Or paste into TablePlus and "Run All". Writes nothing: the only object it
-- creates is a TEMP table, and the whole thing ends in ROLLBACK. (It is not a
-- READ ONLY transaction only because Postgres refuses CREATE TEMP TABLE in one.)
-- ============================================================================

BEGIN;

SELECT CURRENT_TIMESTAMP AS checked_at,
       (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE AS jamaica_today;

-- ----------------------------------------------------------------------------
-- 1. Headline
-- ----------------------------------------------------------------------------
SELECT c.status,
       COUNT(*)                          AS accounts_in_credit,
       SUM(b.credit_balance)             AS total_credit,
       ROUND(AVG(b.credit_balance), 2)   AS avg_credit,
       MAX(b.credit_balance)             AS largest_credit
FROM public.customer_billing_status b
JOIN public.customers c USING (customer_id)
WHERE b.balance < 0
GROUP BY ROLLUP (c.status)
ORDER BY c.status NULLS LAST;

-- ----------------------------------------------------------------------------
-- 2. Everything below is built from this one classification.
-- ----------------------------------------------------------------------------
CREATE TEMP TABLE credit_audit ON COMMIT DROP AS
WITH today AS (
    SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE AS d
),
in_credit AS (
    SELECT b.customer_id, b.balance, b.credit_balance
    FROM public.customer_billing_status b
    WHERE b.balance < 0
),
ledger AS (
    SELECT l.customer_id,
           COUNT(*) FILTER (WHERE l.entry_type = 'monthly_charge')            AS charge_count,
           COALESCE(SUM(l.amount) FILTER (WHERE l.entry_type = 'monthly_charge'), 0)       AS charge_sum,
           MAX(COALESCE(l.due_date, l.effective_date))
               FILTER (WHERE l.entry_type = 'monthly_charge')                 AS last_charge_due,
           COALESCE(SUM(l.amount) FILTER (WHERE l.entry_type = 'reconnection_fee'), 0)     AS recon_fee_sum,
           COALESCE(SUM(l.amount) FILTER (WHERE l.entry_type IN
               ('opening_balance','suspension_charge','suspension_reconnection_fee',
                'payment_void')), 0)                                          AS other_debit_sum,
           COALESCE(-SUM(l.amount) FILTER (WHERE l.entry_type = 'monthly_payment'), 0)     AS monthly_pay_sum,
           COALESCE(-SUM(l.amount) FILTER (WHERE l.entry_type = 'reconnection_payment'), 0) AS recon_pay_sum,
           COALESCE(-SUM(l.amount) FILTER (WHERE l.entry_type = 'waiver'), 0)              AS waiver_sum,
           COALESCE(-SUM(l.amount) FILTER (WHERE l.entry_type = 'adjustment' AND l.amount < 0), 0) AS adj_credit_sum,
           COALESCE(SUM(l.amount)  FILTER (WHERE l.entry_type = 'adjustment' AND l.amount > 0), 0) AS adj_debit_sum,
           MAX(l.effective_date)
               FILTER (WHERE l.entry_type IN ('monthly_payment','reconnection_payment')) AS last_payment_date
    FROM public.account_ledger_entries l
    JOIN in_credit USING (customer_id)
    GROUP BY l.customer_id
),
-- New-system Monthly Fee payments, month by month. "Month paid for" is what
-- the cashier typed; a charge exists for it or not; and the service timeline
-- (migration 054's function) says whether the account was on or off in that
-- month. Judged on the tagged month, not the payment date, because a
-- reconnection payment is usually taken on the same day the account is
-- switched back on - the payment date looks "active", the months paid do not.
tagged AS (
    SELECT p.customer_id,
           p.month_paid,
           p.amount_paid,
           EXISTS (
               SELECT 1 FROM public.account_ledger_entries ch
               WHERE ch.customer_id = p.customer_id
                 AND ch.entry_type = 'monthly_charge'
                 AND DATE_TRUNC('month', COALESCE(ch.due_date, ch.effective_date)) = DATE_TRUNC('month', p.month_paid)
           ) AS month_has_charge,
           public.spcl_customer_service_active_on(p.customer_id, p.month_paid) AS month_was_active
    FROM public.payments p
    JOIN in_credit USING (customer_id)
    WHERE p.payment_type = 'Monthly Fee'
      AND p.legacy_payment_id IS NULL
      AND p.voided_at IS NULL
      AND p.month_paid IS NOT NULL
),
untagged AS (
    SELECT customer_id,
           COUNT(*)      FILTER (WHERE NOT month_has_charge) AS months_paid_without_charge,
           COALESCE(SUM(amount_paid) FILTER (WHERE NOT month_has_charge), 0) AS amount_paid_without_charge,
           MIN(month_paid) FILTER (WHERE NOT month_has_charge) AS first_uncharged_month,
           MAX(month_paid) FILTER (WHERE NOT month_has_charge) AS last_uncharged_month,
           -- The phantom-credit signature: paid for a month the timeline says
           -- the account was off, and (as 054 guarantees) no charge for it.
           COUNT(*)      FILTER (WHERE NOT month_has_charge AND NOT month_was_active) AS paid_while_off_count,
           COALESCE(SUM(amount_paid) FILTER (WHERE NOT month_has_charge AND NOT month_was_active), 0) AS paid_while_off_sum
    FROM tagged
    GROUP BY customer_id
),
last_off AS (
    SELECT DISTINCT ON (h.customer_id)
           h.customer_id,
           h.to_status       AS off_status,
           h.effective_date  AS off_since,
           h.reason          AS off_reason
    FROM public.account_status_history h
    JOIN in_credit USING (customer_id)
    -- pending_reconnection is the tail of a disconnection, not a new one.
    WHERE h.to_status IN ('disconnected','offline','suspended','closed','archived','terminated')
    ORDER BY h.customer_id, h.effective_date DESC, h.changed_at DESC, h.account_status_history_id DESC
),
last_on AS (
    SELECT DISTINCT ON (h.customer_id)
           h.customer_id, h.effective_date AS reactivated_on
    FROM public.account_status_history h
    JOIN in_credit USING (customer_id)
    WHERE h.to_status = 'active' AND h.from_status IS NOT NULL
    ORDER BY h.customer_id, h.effective_date DESC, h.changed_at DESC, h.account_status_history_id DESC
),
admin AS (
    SELECT w.customer_id,
           COALESCE(SUM(w.amount) FILTER (WHERE w.is_credit), 0)     AS admin_credit,
           COALESCE(SUM(w.amount) FILTER (WHERE NOT w.is_credit), 0) AS discount_sum
    FROM public.waiver_requests w
    JOIN in_credit USING (customer_id)
    WHERE w.status = 'approved'
    GROUP BY w.customer_id
),
rate AS (
    SELECT r.customer_id, COUNT(*) AS rate_rows,
           MAX(r.monthly_fee) FILTER (WHERE r.effective_date <= (SELECT d FROM today)) AS current_rate
    FROM public.customer_rate_history r
    JOIN in_credit USING (customer_id)
    GROUP BY r.customer_id
)
SELECT
    ic.customer_id,
    c.name,
    c.status,
    ic.balance,
    ic.credit_balance,
    c.monthly_fee,
    c.activation_date,
    c.reactivation_date,
    c.deactivation_date,
    bs.billing_start_date,
    bs.paid_through,
    COALESCE(lg.charge_count, 0)     AS charge_count,
    COALESCE(lg.charge_sum, 0)       AS charge_sum,
    lg.last_charge_due,
    COALESCE(lg.recon_fee_sum, 0)    AS recon_fee_sum,
    COALESCE(lg.other_debit_sum, 0)  AS other_debit_sum,
    COALESCE(lg.adj_debit_sum, 0)    AS adj_debit_sum,
    COALESCE(lg.monthly_pay_sum, 0)  AS monthly_pay_sum,
    COALESCE(lg.recon_pay_sum, 0)    AS recon_pay_sum,
    COALESCE(lg.waiver_sum, 0)       AS waiver_sum,
    COALESCE(a.admin_credit, 0)      AS admin_credit,
    COALESCE(a.discount_sum, 0)      AS discount_sum,
    COALESCE(lg.adj_credit_sum, 0)   AS adj_credit_sum,
    lg.last_payment_date,
    COALESCE(u.paid_while_off_sum, 0)    AS paid_while_off_sum,
    COALESCE(u.paid_while_off_count, 0)  AS paid_while_off_count,
    COALESCE(u.months_paid_without_charge, 0) AS months_paid_without_charge,
    COALESCE(u.amount_paid_without_charge, 0) AS amount_paid_without_charge,
    u.first_uncharged_month,
    u.last_uncharged_month,
    lo.off_status,
    lo.off_since,
    lo.off_reason,
    ln.reactivated_on,
    CASE
        WHEN lo.off_reason LIKE 'Bulk cleanup: overdue 2025 disconnection%'  THEN 'legacy_backdated'
        WHEN lo.off_reason LIKE 'Automatic delinquency disconnection%'       THEN 'automation'
        WHEN lo.off_reason LIKE 'Live OLT shows the ONT deactivated%'
          OR lo.off_reason LIKE 'Disconnected on the Hanover OLT%'           THEN 'olt_reconcile'
        WHEN lo.off_reason IS NOT NULL                                       THEN 'manual'
    END AS off_path,
    -- Why the daily generator would skip this account right now.
    CASE
        WHEN c.status NOT IN ('active')                                      THEN 'status ' || c.status
        WHEN c.activation_date IS NULL                                       THEN 'activation_date NULL'
        WHEN c.monthly_fee IS NULL                                           THEN 'customers.monthly_fee NULL'
        WHEN COALESCE(r.rate_rows, 0) = 0                                    THEN 'no customer_rate_history row'
        WHEN COALESCE(r.current_rate, 0) = 0                                 THEN 'rate history says fee 0'
        WHEN bs.billing_start_date > (SELECT d FROM today) - 31              THEN 'billing_start_date ' || bs.billing_start_date::TEXT || ' (future/recent)'
        WHEN COALESCE(c.reactivation_date, c.activation_date) > (SELECT d FROM today) - 31
                                                                              THEN 'reactivated ' || COALESCE(c.reactivation_date, c.activation_date)::TEXT || ', first anniversary not due yet'
        WHEN NOT public.spcl_customer_service_active_on(c.customer_id, (SELECT d FROM today))
                                                                              THEN 'status history says not active today (054 trigger blocks charges)'
        ELSE NULL
    END AS generator_blocker,
    CASE
        WHEN COALESCE(a.admin_credit, 0) >= ic.credit_balance                THEN 'admin_credit'
        WHEN COALESCE(a.admin_credit, 0) + COALESCE(a.discount_sum, 0) >= ic.credit_balance
                                                                              THEN 'discount_credit'
        -- Paid for months the timeline says the account was off, which never
        -- got a charge: the exact signature of customer 11321 (Miriam). A
        -- reconnection payment that merely cleared the pre-disconnection debt
        -- does not match, because those months are charged.
        WHEN COALESCE(u.paid_while_off_sum, 0) > 0
         AND lo.off_reason IS NOT NULL
                                                                              THEN 'paid_while_off:' ||
            CASE
                WHEN lo.off_reason LIKE 'Bulk cleanup: overdue 2025 disconnection%' THEN 'legacy_backdated'
                WHEN lo.off_reason LIKE 'Automatic delinquency disconnection%'      THEN 'automation'
                WHEN lo.off_reason LIKE 'Live OLT shows the ONT deactivated%'
                  OR lo.off_reason LIKE 'Disconnected on the Hanover OLT%'          THEN 'olt_reconcile'
                ELSE 'manual'
            END
        WHEN COALESCE(lg.recon_pay_sum, 0) > 0 AND COALESCE(lg.recon_fee_sum, 0) = 0
                                                                              THEN 'recon_paid_no_fee'
        WHEN c.status = 'active'
         AND (lg.last_charge_due IS NULL OR lg.last_charge_due < (SELECT d FROM today) - 40)
         AND COALESCE(c.reactivation_date, c.activation_date) <= (SELECT d FROM today) - 31
                                                                              THEN 'active_not_charged'
        WHEN c.status = 'active' AND ic.credit_balance <= 2 * COALESCE(c.monthly_fee, 0)
                                                                              THEN 'active_prepaid'
        WHEN c.status = 'active'                                              THEN 'active_overpaid'
        ELSE 'other'
    END AS bucket
FROM in_credit ic
JOIN public.customers c USING (customer_id)
LEFT JOIN ledger lg                       USING (customer_id)
LEFT JOIN untagged u                      USING (customer_id)
LEFT JOIN last_off lo                     USING (customer_id)
LEFT JOIN last_on ln                      USING (customer_id)
LEFT JOIN admin a                         USING (customer_id)
LEFT JOIN rate r                          USING (customer_id)
LEFT JOIN public.customer_billing_start bs USING (customer_id);

-- ----------------------------------------------------------------------------
-- 3. Credits by bucket - THIS is the table that decides the fix.
-- ----------------------------------------------------------------------------
SELECT bucket,
       COUNT(*)                        AS accounts,
       SUM(credit_balance)             AS total_credit,
       ROUND(AVG(credit_balance), 2)   AS avg_credit,
       MAX(credit_balance)             AS largest,
       SUM(paid_while_off_sum)         AS money_taken_while_off,
       SUM(amount_paid_without_charge) AS money_tagged_to_uncharged_months
FROM credit_audit
GROUP BY ROLLUP (bucket)
ORDER BY total_credit DESC NULLS LAST;

-- ----------------------------------------------------------------------------
-- 4. Bucket x current status
-- ----------------------------------------------------------------------------
SELECT bucket, status, COUNT(*) AS accounts, SUM(credit_balance) AS total_credit
FROM credit_audit
GROUP BY bucket, status
ORDER BY bucket, total_credit DESC;

-- ----------------------------------------------------------------------------
-- 5. For the disconnected-path buckets: how the disconnection was recorded
-- ----------------------------------------------------------------------------
SELECT off_path,
       COUNT(*)                                   AS accounts,
       SUM(credit_balance)                        AS total_credit,
       COUNT(*) FILTER (WHERE recon_fee_sum = 0)  AS without_recon_fee_debit,
       COUNT(*) FILTER (WHERE reactivated_on IS NOT NULL AND reactivated_on > off_since) AS since_reconnected,
       MIN(off_since) AS earliest_off_date,
       MAX(off_since) AS latest_off_date
FROM credit_audit
WHERE off_reason IS NOT NULL
GROUP BY off_path
ORDER BY total_credit DESC;

-- ----------------------------------------------------------------------------
-- 6. Active accounts the generator is skipping, by reason
-- ----------------------------------------------------------------------------
SELECT generator_blocker, COUNT(*) AS accounts, SUM(credit_balance) AS total_credit
FROM credit_audit
WHERE bucket = 'active_not_charged'
GROUP BY generator_blocker
ORDER BY accounts DESC;

-- ----------------------------------------------------------------------------
-- 7. Credit size in months of fee - real prepayments cluster at 1-2 months
-- ----------------------------------------------------------------------------
SELECT CASE
         WHEN monthly_fee IS NULL OR monthly_fee = 0 THEN 'no fee on file'
         WHEN credit_balance <= 1 * monthly_fee THEN '<= 1 month'
         WHEN credit_balance <= 2 * monthly_fee THEN '1-2 months'
         WHEN credit_balance <= 4 * monthly_fee THEN '2-4 months'
         WHEN credit_balance <= 8 * monthly_fee THEN '4-8 months'
         ELSE '> 8 months'
       END AS credit_in_months,
       COUNT(*) AS accounts,
       SUM(credit_balance) AS total_credit
FROM credit_audit
GROUP BY 1
ORDER BY MIN(CASE
         WHEN monthly_fee IS NULL OR monthly_fee = 0 THEN 99
         WHEN credit_balance <= 1 * monthly_fee THEN 1
         WHEN credit_balance <= 2 * monthly_fee THEN 2
         WHEN credit_balance <= 4 * monthly_fee THEN 3
         WHEN credit_balance <= 8 * monthly_fee THEN 4
         ELSE 5 END);

-- ----------------------------------------------------------------------------
-- 8. When were the credits created? (month of the last payment)
-- ----------------------------------------------------------------------------
SELECT DATE_TRUNC('month', last_payment_date)::DATE AS last_payment_month,
       COUNT(*) AS accounts, SUM(credit_balance) AS total_credit
FROM credit_audit
GROUP BY 1
ORDER BY 1 DESC NULLS LAST;

-- ----------------------------------------------------------------------------
-- 9. The 60 largest credits, with everything needed to judge each one
-- ----------------------------------------------------------------------------
SELECT customer_id, LEFT(name, 28) AS name, status, bucket,
       credit_balance AS credit, monthly_fee AS fee,
       charge_count AS chg_n, charge_sum AS chg_sum, last_charge_due,
       recon_fee_sum AS fee_debit, monthly_pay_sum AS mpay, recon_pay_sum AS rpay,
       admin_credit AS adm_cr, discount_sum AS disc, adj_credit_sum AS adj_cr, adj_debit_sum AS adj_db,
       paid_while_off_sum AS paid_off, months_paid_without_charge AS uncharged_m,
       first_uncharged_month AS unchg_from, last_uncharged_month AS unchg_to,
       off_path, off_since, reactivated_on, last_payment_date AS last_pay,
       generator_blocker
FROM credit_audit
ORDER BY credit_balance DESC
LIMIT 60;

-- ----------------------------------------------------------------------------
-- 10. Full list (every account in credit), smallest id first, for the spreadsheet
-- ----------------------------------------------------------------------------
SELECT customer_id, name, status, bucket, credit_balance, monthly_fee,
       charge_count, last_charge_due, recon_fee_sum, monthly_pay_sum, recon_pay_sum,
       admin_credit, discount_sum, adj_credit_sum, paid_while_off_sum, months_paid_without_charge,
       amount_paid_without_charge, first_uncharged_month, last_uncharged_month,
       off_path, off_since, reactivated_on, last_payment_date, generator_blocker,
       billing_start_date, paid_through
FROM credit_audit
ORDER BY customer_id;

ROLLBACK;
