-- ============================================================================
-- August 1-18 2026 joiners: remove the charge dated on the activation day.
-- Run audit-august-joiners.sql first; this fixes the "FIX" rows from it.
--
-- For each account in scope with a monthly_charge due ON or BEFORE its
-- activation date (see the audit header for how they got there):
--
--   1. One `adjustment` credit = the smaller of those charges and what the
--      account owes right now. So:
--        - an account a discount / the Sept 15 relief already cleared gets
--          NOTHING (no credit is created - policy: someone who only paid
--          what they owed carries no credit);
--        - a partly discounted account comes down to 0, not below it.
--      The charge row itself stays, so the history shows both lines.
--   2. Cut off BECAUSE of that charge: if the account would have owed
--      nothing at the moment it was disconnected without it, the
--      reconnection fee from that disconnection is taken off too (same cap).
--   3. A disconnected account left at 0 moves to pending_reconnection,
--      exactly as the payment screen does when a balance is cleared, so the
--      reconnection automation / staff queue picks it up.
--
-- Skipped and listed: accounts with a positive manual adjustment since
-- Sept 16 (this week's hand decisions - father's lists etc.).
--
-- Idempotent via source_key. LAST LINE IS `ROLLBACK` - rehearsal. Read every
-- block, back up, THEN change ROLLBACK -> COMMIT and run again:
--   docker exec -it spcl-backup sh /opt/spcl-deploy/backup.sh   # before COMMIT
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '10s';
LOCK TABLE public.customers, public.payments, public.account_ledger_entries,
           public.account_status_history, public.reconnection_requests
    IN SHARE ROW EXCLUSIVE MODE;

CREATE TEMP TABLE actor ON COMMIT DROP AS
SELECT e.employee_id, e.first_name || ' ' || e.last_name AS actor_name
FROM public.employees e WHERE e.employee_id = 2;

DO $g$
BEGIN
    IF (SELECT count(*) FROM actor) <> 1 THEN
        RAISE EXCEPTION 'employee_id 2 not found. Nothing changed.';
    END IF;
END $g$;

-- Bring every account's charges up to today first, so "owes right now" is true.
SELECT public.spcl_generate_monthly_charges((CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE);

CREATE TEMP TABLE bad_charge ON COMMIT DROP AS
SELECT e.account_ledger_entry_id, e.customer_id, e.amount, e.due_date, e.created_at
FROM public.account_ledger_entries e
JOIN public.customers c USING (customer_id)
WHERE c.activation_date BETWEEN DATE '2026-08-01' AND DATE '2026-08-18'
  AND e.entry_type = 'monthly_charge'
  AND e.due_date <= c.activation_date;

CREATE TEMP TABLE plan ON COMMIT DROP AS
WITH per AS (
    SELECT customer_id, SUM(amount) AS bad_total, MIN(created_at) AS first_bad_at,
           STRING_AGG(due_date::TEXT, ', ') AS bad_due
    FROM bad_charge GROUP BY customer_id
),
last_cut AS (
    -- Latest disconnection, only if it happened after a bad charge existed.
    SELECT DISTINCT ON (h.customer_id)
        h.customer_id, h.account_status_history_id, h.changed_at
    FROM public.account_status_history h
    JOIN per ON per.customer_id = h.customer_id
    WHERE h.to_status = 'disconnected' AND h.changed_at >= per.first_bad_at
    ORDER BY h.customer_id, h.changed_at DESC, h.account_status_history_id DESC
)
SELECT
    c.customer_id, c.name, c.status, per.bad_due, per.bad_total,
    b.balance AS balance_before,
    EXISTS (
        SELECT 1 FROM public.account_ledger_entries m
        WHERE m.customer_id = c.customer_id AND m.entry_type = 'adjustment'
          AND m.amount > 0 AND m.created_at >= TIMESTAMPTZ '2026-09-16 00:00 America/Jamaica'
          AND COALESCE(m.source_key, '') NOT LIKE 'fix-2026-09-27:august-joiner:%'
    ) AS recent_manual_debit,
    LEAST(per.bad_total, GREATEST(b.balance, 0)) AS charge_relief,
    lc.account_status_history_id AS cut_history_id,
    -- Balance at the moment of the cut, leaving out the bad charges and the
    -- fee that cut posted. <= 0 means the cut only happened because of them.
    (
        SELECT COALESCE(SUM(x.amount), 0) FROM public.account_ledger_entries x
        WHERE x.customer_id = c.customer_id AND x.created_at <= lc.changed_at
          AND x.account_ledger_entry_id NOT IN (SELECT account_ledger_entry_id FROM bad_charge)
          AND COALESCE(x.source_key, '') <> 'reconnection-fee:status-history:' || lc.account_status_history_id::TEXT
    ) AS balance_at_cut_without_bad,
    (
        SELECT COALESCE(SUM(f.amount), 0) FROM public.account_ledger_entries f
        WHERE f.customer_id = c.customer_id
          AND f.source_key = 'reconnection-fee:status-history:' || lc.account_status_history_id::TEXT
    ) AS cut_fee
FROM per
JOIN public.customers c USING (customer_id)
JOIN public.customer_billing_status b USING (customer_id)
LEFT JOIN last_cut lc USING (customer_id);

ALTER TABLE plan ADD COLUMN fee_relief NUMERIC(14,2);
UPDATE plan SET fee_relief = CASE
    WHEN cut_history_id IS NOT NULL AND balance_at_cut_without_bad <= 0
         AND status IN ('disconnected', 'pending_reconnection')
    THEN LEAST(cut_fee, GREATEST(balance_before - charge_relief, 0))
    ELSE 0 END;

SELECT '1. PLAN' AS block, customer_id, name, status, bad_due, bad_total,
       balance_before, charge_relief, fee_relief,
       balance_before - charge_relief - fee_relief AS balance_after,
       CASE WHEN recent_manual_debit THEN 'SKIP - manual debit since Sept 16'
            WHEN charge_relief + fee_relief = 0 THEN 'nothing to do (already cleared)'
            WHEN fee_relief > 0 THEN 'fix + remove wrongful reconnection fee'
            ELSE 'fix' END AS action
FROM plan ORDER BY action, customer_id;

INSERT INTO public.account_ledger_entries (
    customer_id, entry_type, amount, effective_date, description,
    created_by_employee_id, reason, source_key
)
SELECT p.customer_id, 'adjustment', -p.charge_relief,
       (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
       'Billing correction: first month was charged twice',
       a.employee_id,
       'Charge dated on the activation day (' || p.bad_due || ') duplicated the first month. '
       || 'The first bill is the first anniversary after activation.',
       'fix-2026-09-27:august-joiner:activation-day:' || p.customer_id::TEXT
FROM plan p CROSS JOIN actor a
WHERE NOT p.recent_manual_debit AND p.charge_relief > 0
ON CONFLICT (source_key) DO NOTHING;

INSERT INTO public.account_ledger_entries (
    customer_id, entry_type, amount, effective_date, description,
    created_by_employee_id, reason, source_key
)
SELECT p.customer_id, 'adjustment', -p.fee_relief,
       (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
       'Billing correction: reconnection fee removed',
       a.employee_id,
       'Disconnected only because of the duplicated first-month charge.',
       'fix-2026-09-27:august-joiner:wrongful-fee:' || p.customer_id::TEXT
FROM plan p CROSS JOIN actor a
WHERE NOT p.recent_manual_debit AND p.fee_relief > 0
ON CONFLICT (source_key) DO NOTHING;

INSERT INTO public.audit_logs (
    employee_id, actor_name, action, entity_type, entity_id, field_name,
    old_value, new_value, reason, occurred_at
)
SELECT a.employee_id, a.actor_name, 'Billing correction', 'customer', p.customer_id::TEXT,
       'balance', p.balance_before::TEXT,
       (p.balance_before - p.charge_relief - p.fee_relief)::TEXT,
       'August joiner charged twice for the first month (activation-day charge '
       || p.bad_due || ').' || CASE WHEN p.fee_relief > 0
          THEN ' Reconnection fee from the resulting disconnection removed.' ELSE '' END,
       CURRENT_TIMESTAMP
FROM plan p CROSS JOIN actor a
WHERE NOT p.recent_manual_debit AND p.charge_relief + p.fee_relief > 0;

-- 3. Cleared disconnected accounts join the reconnection queue.
CREATE TEMP TABLE queued ON COMMIT DROP AS
WITH moved AS (
    UPDATE public.customers c SET status = 'pending_reconnection'
    FROM plan p, public.customer_billing_status b
    WHERE c.customer_id = p.customer_id AND b.customer_id = c.customer_id
      AND NOT p.recent_manual_debit AND p.charge_relief + p.fee_relief > 0
      AND c.status = 'disconnected' AND b.ready_for_reconnection
    RETURNING c.customer_id
), recorded AS (
    INSERT INTO public.account_status_history (
        customer_id, from_status, to_status, reason, changed_by_employee_id, source_key
    )
    SELECT m.customer_id, 'disconnected', 'pending_reconnection',
           'Billing correction: duplicated first-month charge removed, balance cleared; awaiting reconnection',
           a.employee_id, 'fix-2026-09-27:august-joiner:reconnect:' || m.customer_id::TEXT
    FROM moved m CROSS JOIN actor a
    RETURNING customer_id, account_status_history_id
)
SELECT * FROM recorded;

UPDATE public.reconnection_requests r
SET status = 'approved', reviewed_at = CURRENT_TIMESTAMP,
    reviewed_by_employee_id = (SELECT employee_id FROM actor),
    review_note = 'Billing correction cleared the balance; queued for reconnection.',
    account_status_history_id = q.account_status_history_id
FROM queued q
WHERE r.customer_id = q.customer_id AND r.status = 'pending';

INSERT INTO public.audit_logs (
    employee_id, actor_name, action, entity_type, entity_id, field_name,
    old_value, new_value, reason, occurred_at
)
SELECT a.employee_id, a.actor_name, 'Queued reconnection after billing correction',
       'customer', q.customer_id::TEXT, 'status', 'disconnected', 'pending_reconnection',
       'Duplicated first-month charge removed; balance cleared', CURRENT_TIMESTAMP
FROM queued q CROSS JOIN actor a;

-- 4. Result. Nobody may end up in credit because of this script.
SELECT '4. AFTER' AS block, p.customer_id, p.name, c.status AS status_now,
       p.balance_before, b.balance AS balance_now, b.eligible_for_disconnection,
       (q.customer_id IS NOT NULL) AS queued_for_reconnection
FROM plan p
JOIN public.customers c USING (customer_id)
JOIN public.customer_billing_status b USING (customer_id)
LEFT JOIN queued q USING (customer_id)
WHERE p.charge_relief + p.fee_relief > 0 OR p.recent_manual_debit
ORDER BY p.customer_id;

DO $g$
BEGIN
    IF EXISTS (
        SELECT 1 FROM plan p JOIN public.customer_billing_status b USING (customer_id)
        WHERE p.charge_relief + p.fee_relief > 0
          AND b.balance < LEAST(p.balance_before, 0)
    ) THEN
        RAISE EXCEPTION 'An account would end up with more credit than it started with. Nothing changed.';
    END IF;
END $g$;

SELECT '5. SUMMARY' AS block,
       COUNT(*) FILTER (WHERE charge_relief > 0 AND NOT recent_manual_debit) AS accounts_fixed,
       SUM(charge_relief) FILTER (WHERE NOT recent_manual_debit) AS charge_relief,
       SUM(fee_relief) FILTER (WHERE NOT recent_manual_debit) AS fee_relief,
       COUNT(*) FILTER (WHERE charge_relief = 0) AS already_cleared_by_discount,
       COUNT(*) FILTER (WHERE recent_manual_debit) AS skipped_manual,
       (SELECT COUNT(*) FROM queued) AS queued_for_reconnection
FROM plan;

ROLLBACK;
