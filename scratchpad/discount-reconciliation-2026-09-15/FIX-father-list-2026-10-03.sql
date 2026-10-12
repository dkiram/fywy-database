-- ============================================================================
-- Corrections from the 2026-10-03 list. All three clear a credit to 0.00.
--
--   9449  Latoya Grant #2        "clear credit of 2500"   -2,500 -> 0
--  11547  Barrington Williams    "clear credit of 7500"   -7,500 -> 0
--  13259  Tamaim Richards Mckay  "clear BALANCE on 4000"  -4,000 -> 0
--
-- 13259 was first written as a DEBT write-off: the message says "balance" and
-- the 2026-09-15 review files had her at +4,000 outstanding. She is actually
-- at -4,000 - holding the credit, not owing it - and her position flipped some
-- time in the last three weeks. The expected-balance guard skipped the row
-- instead of acting on the stale premise, and it is corrected below. Nothing
-- in this script forgives a debt; all three take back credit.
--
-- The script still handles both directions (it zeroes whatever is there and
-- labels which way it went), so if one of these flips again before you run it
-- the wording and the audit entry follow the live balance rather than the
-- comment above.
--
-- Cross-checks against the 2026-09-15 review files:
--   11547 held 2,500 credit then and your father now reports 7,500, so it has
--     grown by 5,000 - consistent with two more months of credit accruing.
--   13259 was +4,000 outstanding then, and the reconciliation had targeted it
--     at 0.00. It has since gone past zero into credit.
--   9449 is not in those files at all.
--
-- Each row is pinned to its verified balance, so an account that moves again
-- is SKIPPED and listed rather than zeroed on a stale figure.
--
-- Guards: account id and name on file must agree, live balance must equal the
-- expected figure, and each must land on EXACTLY 0.00. Idempotent via
-- source_key.
--
-- LAST LINE IS `ROLLBACK` - rehearsal. Read APPLIED and SKIPPED, back up,
-- THEN change ROLLBACK -> COMMIT and run again:
--   docker exec -it spcl-backup sh /opt/spcl-deploy/backup.sh   # before COMMIT
-- ============================================================================

BEGIN;

CREATE TEMP TABLE actor ON COMMIT DROP AS
SELECT e.employee_id, e.first_name || ' ' || e.last_name AS actor_name
FROM public.employees e
WHERE e.employee_id = 2;

DO $g$
DECLARE n INTEGER;
BEGIN
    SELECT count(*) INTO n FROM actor;
    IF n <> 1 THEN RAISE EXCEPTION 'employee_id 2 matched % rows, expected 1. Nothing changed.', n; END IF;
END $g$;

CREATE TEMP TABLE requested (
    customer_id      INTEGER PRIMARY KEY,
    expected_name    TEXT,
    expected_balance NUMERIC(14,2),
    instruction      TEXT
) ON COMMIT DROP;

INSERT INTO requested VALUES
( 9449, 'Latoya Grant #2',       -2500.00, 'clear the 2,500 credit'),
(11547, 'Barrington Williams',   -7500.00, 'clear the 7,500 credit'),
-- Corrected 2026-10-04: she is at -4,000, i.e. HOLDING a 4,000 credit, not
-- owing it. The 2026-09-15 review files had her at +4,000 outstanding and the
-- message said "balance", so this was first written as a debt write-off - the
-- expected-balance guard caught it and skipped the row rather than acting on
-- the wrong premise. "Clear balance on 4000" means clear the 4,000 showing,
-- which is a credit, so this is the same operation as the other two.
(13259, 'Tamaim Richards Mckay', -4000.00, 'clear the 4,000 credit');

CREATE TEMP TABLE resolved ON COMMIT DROP AS
SELECT r.customer_id,
       r.expected_name,
       c.name           AS name_on_file,
       c.status,
       c.monthly_fee,
       r.expected_balance,
       b.balance        AS live_balance,
       (-b.balance)     AS adjustment,
       r.instruction,
       CASE
           WHEN c.customer_id IS NULL           THEN 'customer id not found'
           WHEN LOWER(TRIM(c.name)) <> LOWER(TRIM(r.expected_name))
                                                THEN 'name on file does not match - WRONG ACCOUNT, do not force'
           WHEN b.customer_id IS NULL           THEN 'no billing status row'
           WHEN b.balance <> r.expected_balance THEN 'live balance is not the figure in the message - check before zeroing'
           WHEN b.balance = 0                   THEN 'already at zero'
           ELSE NULL
       END AS skip_reason
FROM requested r
LEFT JOIN public.customers c               ON c.customer_id = r.customer_id
LEFT JOIN public.customer_billing_status b ON b.customer_id = r.customer_id;

-- BEFORE
SELECT 'WILL APPLY' AS check, customer_id, name_on_file, status, monthly_fee,
       live_balance AS balance_now, adjustment, 0.00 AS balance_after,
       CASE WHEN live_balance < 0 THEN 'removes credit'
            ELSE                      'FORGIVES DEBT - gives money away' END AS direction,
       instruction
FROM resolved WHERE skip_reason IS NULL
ORDER BY customer_id;

SELECT 'SKIPPED' AS check, customer_id, expected_name, name_on_file,
       expected_balance AS message_said, live_balance AS balance_now, skip_reason
FROM resolved WHERE skip_reason IS NOT NULL
ORDER BY customer_id;

INSERT INTO public.account_ledger_entries (
    customer_id, entry_type, amount, effective_date, description,
    created_by_employee_id, reason, is_verified, source_key
)
SELECT r.customer_id, 'adjustment', r.adjustment,
       (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
       CASE WHEN r.live_balance > 0
            THEN 'Outstanding balance cleared at management instruction (account review 2026-10-03).'
            ELSE 'Credit removed on review: the account should not be carrying a credit (account review 2026-10-03).' END,
       2,
       CASE WHEN r.live_balance > 0
            THEN 'Management instruction 2026-10-03: ' || r.instruction || '. This forgives money owed. The underlying charges and payments are left on the ledger.'
            ELSE 'Account review 2026-10-03: ' || r.instruction || '. The underlying payments are untouched.' END,
       TRUE,
       'father-credit-fix-20261003:' || r.customer_id::TEXT
FROM resolved r
WHERE r.skip_reason IS NULL
ON CONFLICT (source_key) DO NOTHING;

-- Guard: everyone landed on exactly zero.
DO $g$
DECLARE bad INTEGER;
BEGIN
    SELECT count(*) INTO bad
    FROM resolved r
    JOIN public.customer_billing_status b USING (customer_id)
    WHERE r.skip_reason IS NULL
      AND b.balance <> 0.00;
    IF bad > 0 THEN
        RAISE EXCEPTION '% account(s) did not land on 0.00. Nothing committed.', bad;
    END IF;
END $g$;

INSERT INTO public.audit_logs (
    employee_id, actor_name, action, entity_type, entity_id,
    field_name, old_value, new_value, reason, occurred_at, source_key
)
SELECT (SELECT employee_id FROM actor), (SELECT actor_name FROM actor),
       CASE WHEN r.live_balance > 0 THEN 'Wrote off account balance'
            ELSE                         'Adjusted account balance' END,
       'customer', r.customer_id::TEXT,
       'balance', r.live_balance::TEXT, '0.00',
       CASE WHEN r.live_balance > 0
            THEN 'Management instruction 2026-10-03: outstanding balance of J$' || r.live_balance::TEXT || ' cleared. Money owed was forgiven.'
            ELSE 'Account review 2026-10-03: credit removed, the account should not be carrying one.' END,
       CURRENT_TIMESTAMP, 'father-credit-fix-20261003:' || r.customer_id::TEXT
FROM resolved r
WHERE r.skip_reason IS NULL
ON CONFLICT (source_key) DO NOTHING;

SELECT 'AFTER' AS check, r.customer_id, r.name_on_file, b.balance AS balance_now
FROM resolved r
JOIN public.customer_billing_status b USING (customer_id)
WHERE r.skip_reason IS NULL
ORDER BY r.customer_id;

-- ----------------------------------------------------------------------------
-- ROLLBACK = rehearsal.  COMMIT = for real (back up first).
-- ----------------------------------------------------------------------------
ROLLBACK;
