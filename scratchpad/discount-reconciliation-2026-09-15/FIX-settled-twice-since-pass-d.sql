-- ============================================================================
-- Months settled twice - the NEW cases since pass D ran on 2026-09-10.
--
-- Pass D (scratchpad/fix-phantom-credits-2026-09.sql, run 2026-09-10, 770
-- accounts, J$2.26M) corrected every account that had paid an
-- already-forgiven month up to that date. The read-only sweep on 2026-09-19
-- (audit-settled-twice-sweep.sql) found 182 accounts matching the pattern
-- again - but most of that list is NOT safe to act on, and this script is
-- deliberately narrower than the sweep:
--
--   ONLY the 2026-08-28 clean-slate wipes. The "discount" wipes dated Sept
--     12-15 are this week's reconciliation and current-charge corrections;
--     whether "forgiven Sept 15, paid Sept 17" is settled twice or the
--     correction working as designed needs a person, not a rule.
--
--   ONLY receipts recorded AFTER pass D ran (> 2026-09-10). 47 accounts in
--     the sweep were already corrected by pass D and paid the wiped month
--     BEFORE Sept 10; the credit they hold now arrived after and is almost
--     certainly September paid ahead of their anniversary. Pass D's logic
--     cannot tell that from the old duplicate. Counting only post-Sept-10
--     receipts makes those drop out on their own, while an account that has
--     genuinely paid a forgiven month AGAIN since Sept 10 stays in with the
--     right amount.
--
--   NOTHING touched by another correction this week. 25 accounts in the
--     sweep carry a positive adjustment since Sept 15 - six of them are
--     accounts your father set an explicit target on (Dishawn Crawford 3,500,
--     Rochelle Thompson 2,500, Janet Hall Robinson 1,000, Andrea
--     Williams-Green Street 3,000, Tommy Comire, Justin Morris). A mechanical
--     rule does not outrank a decision made on the named account. Skipped and
--     listed.
--
-- Everything else is pass D verbatim: one 'adjustment' per account for the
-- duplicate, capped at the smallest of the wipe, the money paid again, and
-- the payment-driven credit (credit minus any Add Credit SPCL gave on
-- purpose), so admin credit is sheltered and nobody goes above zero. Melodie
-- OConnor (8571) is the hand-verified reference case for this exact shape.
--
-- Nothing historical is deleted or edited. Idempotent via source_key.
--
-- LAST LINE IS `ROLLBACK` - rehearsal. Read every printed block - especially
-- SKIPPED - back up, THEN change ROLLBACK -> COMMIT and run again:
--   docker exec -it spcl-backup sh /opt/spcl-deploy/backup.sh   # before COMMIT
-- ============================================================================

BEGIN;

CREATE TEMP TABLE actor ON COMMIT DROP AS
SELECT e.employee_id, e.first_name || ' ' || e.last_name AS actor_name
FROM public.employees e WHERE e.employee_id = 2;

DO $g$
DECLARE n INTEGER;
BEGIN
    SELECT count(*) INTO n FROM actor;
    IF n <> 1 THEN RAISE EXCEPTION 'employee_id 2 matched % rows, expected 1. Nothing changed.', n; END IF;
END $g$;

CREATE TEMP TABLE run ON COMMIT DROP AS
SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE AS today,
       TIMESTAMP '2026-09-10 23:59:59' AS pass_d_cutoff;

-- ----------------------------------------------------------------------------
-- Scope: accounts in credit, and how much of it is payment-driven.
-- ----------------------------------------------------------------------------
CREATE TEMP TABLE scope ON COMMIT DROP AS
SELECT b.customer_id, c.name, c.status, c.monthly_fee,
       b.balance AS balance_before,
       b.credit_balance,
       adm.admin_credit,
       GREATEST(b.credit_balance - adm.admin_credit, 0)::NUMERIC(14,2) AS remaining_credit,
       EXISTS (SELECT 1 FROM public.account_ledger_entries l
               WHERE l.customer_id = b.customer_id
                 AND l.entry_type = 'adjustment' AND l.amount > 0
                 AND l.created_at >= TIMESTAMP '2026-09-15 00:00:00'
                 AND COALESCE(l.source_key, '') NOT LIKE 'final-reconciliation-20260915:%') AS touched_this_week
FROM public.customer_billing_status b
JOIN public.customers c USING (customer_id)
JOIN LATERAL (
    SELECT COALESCE(SUM(w.amount), 0)::NUMERIC(14,2) AS admin_credit
    FROM public.waiver_requests w
    WHERE w.customer_id = b.customer_id AND w.status = 'approved' AND w.is_credit = TRUE
) adm ON TRUE
WHERE b.balance < 0;

-- ----------------------------------------------------------------------------
-- Wipes: the 2026-08-28 clean-slate ONLY.
-- ----------------------------------------------------------------------------
CREATE TEMP TABLE wipes ON COMMIT DROP AS
SELECT l.customer_id,
       l.account_ledger_entry_id  AS wipe_entry_id,
       l.effective_date           AS wiped_on,
       (-l.amount)::NUMERIC(14,2) AS wiped
FROM public.account_ledger_entries l
JOIN scope s USING (customer_id)
WHERE l.amount < 0
  AND l.source_key LIKE 'clean-slate:%';

-- ----------------------------------------------------------------------------
-- Paid again SINCE PASS D: counter money recorded after 2026-09-10, for a
-- month whose charge was already on the ledger when the wipe happened.
-- ----------------------------------------------------------------------------
CREATE TEMP TABLE paid_again ON COMMIT DROP AS
SELECT wp.customer_id,
       SUM(p.amount_paid)  AS paid_again,
       MAX(p.payment_date) AS last_paid_again_on,
       STRING_AGG(DISTINCT TO_CHAR(p.month_paid, 'Mon YYYY'), ', ' ORDER BY TO_CHAR(p.month_paid, 'Mon YYYY')) AS months,
       COALESCE(STRING_AGG(DISTINCT p.receipt_number, ', '), 'receipt numbers not recorded') AS receipts
FROM (
    SELECT customer_id, MIN(wipe_entry_id) AS first_wipe_entry, MAX(wiped_on) AS last_wiped_on
    FROM wipes GROUP BY customer_id
) wp
CROSS JOIN run r
JOIN public.payments p ON p.customer_id = wp.customer_id
JOIN public.account_ledger_entries pl ON pl.payment_id = p.payment_id AND pl.entry_type = 'monthly_payment'
WHERE p.payment_type = 'Monthly Fee'
  AND p.legacy_payment_id IS NULL
  AND p.voided_at IS NULL
  AND p.month_paid IS NOT NULL
  AND pl.account_ledger_entry_id > wp.first_wipe_entry
  AND p.recorded_at > r.pass_d_cutoff
  AND EXISTS (
      SELECT 1 FROM public.account_ledger_entries ch
      WHERE ch.customer_id = p.customer_id
        AND ch.entry_type = 'monthly_charge'
        AND DATE_TRUNC('month', COALESCE(ch.due_date, ch.effective_date)) = DATE_TRUNC('month', p.month_paid)
        AND COALESCE(ch.due_date, ch.effective_date) <= wp.last_wiped_on
  )
GROUP BY wp.customer_id;

-- ----------------------------------------------------------------------------
-- Plan: the duplicate, capped three ways. Accounts touched this week are
-- carried through with a skip reason so they show up in the report.
-- ----------------------------------------------------------------------------
CREATE TEMP TABLE plan ON COMMIT DROP AS
SELECT pa.customer_id, s.name, s.status, s.monthly_fee,
       s.balance_before, s.credit_balance, s.admin_credit, s.remaining_credit,
       wt.wiped_total, pa.paid_again, pa.last_paid_again_on, pa.months, pa.receipts,
       LEAST(wt.wiped_total, pa.paid_again, s.remaining_credit)::NUMERIC(14,2) AS amount,
       CASE
           WHEN s.touched_this_week THEN 'another correction touched this account since Sept 15 - a person decided this one'
           WHEN LEAST(wt.wiped_total, pa.paid_again, s.remaining_credit) <= 0 THEN 'nothing left to remove after the cap'
           ELSE NULL
       END AS skip_reason
FROM paid_again pa
JOIN scope s USING (customer_id)
JOIN (SELECT customer_id, SUM(wiped) AS wiped_total FROM wipes GROUP BY customer_id) wt USING (customer_id);

-- BEFORE
SELECT 'WILL APPLY' AS check, COUNT(*) AS accounts, SUM(amount) AS credit_to_remove,
       SUM(wiped_total) AS forgiven_total, SUM(paid_again) AS paid_again_total
FROM plan WHERE skip_reason IS NULL;

SELECT 'WILL APPLY' AS check, customer_id, name, status, monthly_fee,
       credit_balance AS credit_now, admin_credit, amount AS removing,
       (credit_balance - amount) AS credit_after,
       wiped_total AS forgiven_aug28, paid_again, last_paid_again_on, months, receipts
FROM plan WHERE skip_reason IS NULL
ORDER BY amount DESC, customer_id;

SELECT 'SKIPPED' AS check, customer_id, name, credit_balance AS credit_now,
       LEAST(wiped_total, paid_again, remaining_credit) AS would_have_removed,
       months, skip_reason
FROM plan WHERE skip_reason IS NOT NULL
ORDER BY customer_id;

INSERT INTO public.account_ledger_entries (
    customer_id, entry_type, amount, effective_date, description,
    created_by_employee_id, reason, is_verified, source_key
)
SELECT p.customer_id, 'adjustment', p.amount, r.today,
       'Correction: ' || p.months || ' settled twice',
       (SELECT employee_id FROM actor),
       'Cleared as paid up by the 2026-08-28 clean-slate adjustment, then paid again at the counter after 2026-09-10 (' || p.receipts || '). This removes the duplicate credit; the receipts are untouched.',
       TRUE,
       'settled-twice-20260919:' || p.customer_id::TEXT
FROM plan p CROSS JOIN run r
WHERE p.skip_reason IS NULL
ON CONFLICT (source_key) DO NOTHING;

-- Safety: nobody touched may sit above zero, and nobody may have lost admin credit.
DO $g$
DECLARE bad INTEGER;
BEGIN
    SELECT count(*) INTO bad
    FROM plan p
    JOIN public.customer_billing_status b USING (customer_id)
    WHERE p.skip_reason IS NULL
      AND (b.balance > 0 OR b.credit_balance < p.admin_credit);
    IF bad > 0 THEN
        RAISE EXCEPTION '% account(s) went above zero or lost admin-given credit. Nothing committed.', bad;
    END IF;
END $g$;

INSERT INTO public.audit_logs (
    employee_id, actor_name, action, entity_type, entity_id,
    field_name, old_value, new_value, reason, occurred_at, source_key
)
SELECT (SELECT employee_id FROM actor), (SELECT actor_name FROM actor),
       'Adjusted account balance', 'customer', p.customer_id::TEXT,
       'balance', p.balance_before::TEXT, (p.balance_before + p.amount)::TEXT,
       p.months || ' was forgiven by the 2026-08-28 clean-slate and then paid again at the counter; the duplicate settlement was removed as credit.',
       CURRENT_TIMESTAMP, 'settled-twice-20260919:' || p.customer_id::TEXT
FROM plan p
WHERE p.skip_reason IS NULL
ON CONFLICT (source_key) DO NOTHING;

-- AFTER
SELECT 'AFTER' AS check, COUNT(*) AS accounts_corrected, SUM(p.amount) AS total_removed,
       COUNT(*) FILTER (WHERE b.balance = 0) AS now_at_zero,
       COUNT(*) FILTER (WHERE b.balance < 0) AS still_in_credit
FROM plan p
JOIN public.customer_billing_status b USING (customer_id)
WHERE p.skip_reason IS NULL;

-- ----------------------------------------------------------------------------
-- ROLLBACK = rehearsal.  COMMIT = for real (back up first).
-- ----------------------------------------------------------------------------
ROLLBACK;
