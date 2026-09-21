-- ============================================================================
-- READ ONLY. Months settled twice: how many accounts, and how much?
--
-- On 2026-08-28 a "clean-slate" run posted a negative adjustment on 732
-- accounts to zero balances believed paid up (source_key clean-slate:<id>),
-- and ~150 more got an individually approved balance discount for the same
-- belief. Where the customer has SINCE come to the counter and paid the very
-- month that had been wiped, that month is settled twice - once by
-- forgiveness, once by cash - and the second settlement sits as credit that
-- will silently absorb future real charges.
--
-- Melodie OConnor (8571) is the reference case from 2026-09-18: July service
-- charged Aug 4, forgiven Aug 28, paid again Sep 18 -> 1,500 phantom credit.
--
-- This is pass D of scratchpad/fix-phantom-credits-2026-09.sql, lifted
-- verbatim and made read-only. Same scope, same wipe definition, same cap
-- (never more than the payment-driven credit, so Add Credits SPCL gave on
-- purpose are sheltered and nobody goes above zero), same exclusion of
-- "gift" waivers (a customer told a month was free and who then paid it is
-- legitimately a month ahead).
--
-- Section 0 answers a question the September memory left open: did pass D
-- ever actually run on the NAS? If it did, the accounts here are ones that
-- have accumulated SINCE.
--
-- Ends in ROLLBACK - the only objects created are TEMP tables.
--
-- Run on the NAS:
--   ssh -p 9222 SPCNAS@100.98.108.77 \
--     'docker exec -i spcl-postgres psql -U spcl_user -d spcl_db' \
--     < scratchpad/discount-reconciliation-2026-09-15/audit-settled-twice-sweep.sql
-- Or paste into TablePlus and "Run All".
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 0. Has pass D been run before? And how big was the clean-slate?
-- ----------------------------------------------------------------------------
SELECT 'PASS D HISTORY' AS check,
       COUNT(*)      AS settled_twice_fixes_on_ledger,
       SUM(l.amount) AS total_already_corrected,
       MIN(l.effective_date) AS first_run,
       MAX(l.effective_date) AS last_run
FROM public.account_ledger_entries l
WHERE l.source_key LIKE 'fix-2026-09:phantom-credit:settled-twice:%';

SELECT 'CLEAN-SLATE' AS check,
       COUNT(*)       AS accounts_wiped,
       SUM(-l.amount) AS total_forgiven,
       MIN(l.effective_date) AS wiped_on
FROM public.account_ledger_entries l
WHERE l.source_key LIKE 'clean-slate:%';

-- ----------------------------------------------------------------------------
-- Scope: every account in credit right now, and how much of that credit came
-- from payments rather than from an Add Credit SPCL chose to give.
-- ----------------------------------------------------------------------------
CREATE TEMP TABLE scope ON COMMIT DROP AS
SELECT b.customer_id, c.name, c.status, c.activation_date, c.monthly_fee,
       b.balance AS balance_now,
       b.credit_balance,
       adm.admin_credit,
       GREATEST(b.credit_balance - adm.admin_credit, 0)::NUMERIC(14,2) AS remaining_credit
FROM public.customer_billing_status b
JOIN public.customers c USING (customer_id)
JOIN LATERAL (
    SELECT COALESCE(SUM(w.amount), 0)::NUMERIC(14,2) AS admin_credit
    FROM public.waiver_requests w
    WHERE w.customer_id = b.customer_id
      AND w.status = 'approved'
      AND w.is_credit = TRUE
) adm ON TRUE
WHERE b.balance < 0;

-- ----------------------------------------------------------------------------
-- Wipes: the clean-slate adjustment, or an approved balance discount. A
-- discount worded as a one-time gift is a wipe of a different kind - kept.
-- ----------------------------------------------------------------------------
CREATE TEMP TABLE wipes ON COMMIT DROP AS
SELECT l.customer_id,
       l.account_ledger_entry_id  AS wipe_entry_id,
       l.effective_date           AS wiped_on,
       (-l.amount)::NUMERIC(14,2) AS wiped,
       CASE
         WHEN l.source_key LIKE 'clean-slate:%'     THEN 'clean_slate'
         WHEN w.reason ~* '(one|1)[ -]*(time|itme)' THEN 'gift'
         ELSE 'discount'
       END AS kind,
       w.waiver_request_id,
       w.reason
FROM public.account_ledger_entries l
JOIN scope s USING (customer_id)
LEFT JOIN public.waiver_requests w ON w.waiver_ledger_entry_id = l.account_ledger_entry_id
WHERE l.amount < 0
  AND (
        l.source_key LIKE 'clean-slate:%'
     OR (l.entry_type = 'waiver' AND w.status = 'approved' AND w.is_credit = FALSE)
  );

-- ----------------------------------------------------------------------------
-- Paid again: counter money that arrived AFTER the wipe, for a month whose
-- charge was already on the ledger when the wipe happened.
-- ----------------------------------------------------------------------------
CREATE TEMP TABLE paid_again ON COMMIT DROP AS
SELECT wp.customer_id,
       SUM(p.amount_paid) AS paid_again,
       MAX(p.payment_date) AS last_paid_again_on,
       STRING_AGG(DISTINCT TO_CHAR(p.month_paid, 'Mon YYYY'), ', ' ORDER BY TO_CHAR(p.month_paid, 'Mon YYYY')) AS months,
       COALESCE(STRING_AGG(DISTINCT p.receipt_number, ', '), 'receipt numbers not recorded') AS receipts
FROM (
    SELECT customer_id, MIN(wipe_entry_id) AS first_wipe_entry, MAX(wiped_on) AS last_wiped_on
    FROM wipes WHERE kind <> 'gift' GROUP BY customer_id
) wp
JOIN public.payments p ON p.customer_id = wp.customer_id
JOIN public.account_ledger_entries pl ON pl.payment_id = p.payment_id AND pl.entry_type = 'monthly_payment'
WHERE p.payment_type = 'Monthly Fee'
  AND p.legacy_payment_id IS NULL
  AND p.voided_at IS NULL
  AND p.month_paid IS NOT NULL
  AND pl.account_ledger_entry_id > wp.first_wipe_entry
  AND EXISTS (
      SELECT 1 FROM public.account_ledger_entries ch
      WHERE ch.customer_id = p.customer_id
        AND ch.entry_type = 'monthly_charge'
        AND DATE_TRUNC('month', COALESCE(ch.due_date, ch.effective_date)) = DATE_TRUNC('month', p.month_paid)
        AND COALESCE(ch.due_date, ch.effective_date) <= wp.last_wiped_on
  )
GROUP BY wp.customer_id;

-- ----------------------------------------------------------------------------
-- What pass D would post: the duplicate, capped at the wipe, the money paid
-- again, and the payment-driven credit - whichever is smallest.
-- ----------------------------------------------------------------------------
CREATE TEMP TABLE plan_twice ON COMMIT DROP AS
SELECT pa.customer_id,
       s.name, s.status, s.monthly_fee,
       s.balance_now, s.credit_balance, s.admin_credit, s.remaining_credit,
       LEAST(wt.wiped_total, pa.paid_again, s.remaining_credit)::NUMERIC(14,2) AS would_post,
       wt.wiped_total, wt.kinds, wt.wiped_on,
       pa.paid_again, pa.last_paid_again_on, pa.months, pa.receipts,
       EXISTS (SELECT 1 FROM public.account_ledger_entries l
               WHERE l.customer_id = pa.customer_id
                 AND l.source_key LIKE 'fix-2026-09:phantom-credit:settled-twice:%') AS pass_d_ran_before,
       EXISTS (SELECT 1 FROM public.account_ledger_entries l
               WHERE l.customer_id = pa.customer_id
                 AND l.entry_type = 'adjustment' AND l.amount > 0
                 AND l.created_at >= TIMESTAMP '2026-09-15 00:00:00'
                 AND COALESCE(l.source_key, '') NOT LIKE 'final-reconciliation-20260915:%') AS other_correction_since_sep15
FROM paid_again pa
JOIN scope s USING (customer_id)
JOIN (
    SELECT customer_id, SUM(wiped) AS wiped_total,
           STRING_AGG(DISTINCT kind, '+') AS kinds,
           MAX(wiped_on) AS wiped_on
    FROM wipes WHERE kind <> 'gift' GROUP BY customer_id
) wt USING (customer_id)
WHERE s.remaining_credit > 0;

DELETE FROM plan_twice WHERE would_post <= 0;

-- ----------------------------------------------------------------------------
-- 1. Headline: this is the number.
-- ----------------------------------------------------------------------------
SELECT 'SETTLED TWICE' AS check,
       kinds,
       COUNT(*)          AS accounts,
       SUM(would_post)   AS credit_to_remove,
       SUM(wiped_total)  AS forgiven_total,
       SUM(paid_again)   AS paid_again_total,
       COUNT(*) FILTER (WHERE pass_d_ran_before)            AS already_hit_by_pass_d,
       COUNT(*) FILTER (WHERE other_correction_since_sep15) AS touched_by_another_fix
FROM plan_twice
GROUP BY ROLLUP (kinds)
ORDER BY kinds NULLS LAST;

-- ----------------------------------------------------------------------------
-- 2. By month the second payment was made - is this still happening?
-- ----------------------------------------------------------------------------
SELECT DATE_TRUNC('month', last_paid_again_on)::DATE AS paid_again_month,
       COUNT(*) AS accounts, SUM(would_post) AS credit_to_remove
FROM plan_twice
GROUP BY 1
ORDER BY 1 DESC;

-- ----------------------------------------------------------------------------
-- 3. Every account, largest first. would_post is what pass D would take.
--    Read the two flags: pass_d_ran_before means this account already had a
--    settled-twice correction and has accumulated more since;
--    other_correction_since_sep15 means one of this week's fixes touched it -
--    look before stacking another adjustment on top.
-- ----------------------------------------------------------------------------
SELECT customer_id, name, status, monthly_fee,
       credit_balance AS credit_now, admin_credit, remaining_credit,
       would_post, wiped_total, kinds, wiped_on,
       paid_again, last_paid_again_on, months, receipts,
       pass_d_ran_before, other_correction_since_sep15
FROM plan_twice
ORDER BY would_post DESC, customer_id;

-- ----------------------------------------------------------------------------
-- 4. Gift waivers that were then paid - kept on purpose, listed for the record.
-- ----------------------------------------------------------------------------
SELECT 'GIFT THEN PAID (kept)' AS check, w.customer_id, s.name, w.waiver_request_id,
       w.wiped AS gift, LEFT(w.reason, 50) AS reason, s.credit_balance
FROM wipes w JOIN scope s USING (customer_id)
WHERE w.kind = 'gift'
ORDER BY w.wiped DESC, w.customer_id;

ROLLBACK;
