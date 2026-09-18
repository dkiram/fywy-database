-- ============================================================================
-- The accounts from the 2026-09-16/17 credit list whose target is stated
-- outright and needs no interpretation.
--
--   11210 Dishawn Crawford  "Should Have A Credit Of $3500"
--                           holds 8,500 -> remove 5,000, leaving 3,500
--    9836 Simone Adams      "Clear credit"
--                           holds 2,500 -> remove 2,500, leaving 0
--   11438 Anthony Smith     "8500 credit / Should not have credit"
--                           holds 8,500 -> remove 8,500, leaving 0
--   13429 Gawayne Knight    "2500 credit / Should not have credit"
--                           holds 2,500 -> remove 2,500, leaving 0
--   11625 Demmo Sloley      "4500 credit / Should not have credit"
--                           holds 2,000 -> remove 2,000, leaving 0
--
-- On Demmo Sloley: the message quoted 4,500 on 2026-09-16 and the account now
-- holds 2,000. His monthly fee is exactly 2,500, so the September charge has
-- since consumed the difference - the figure was right when it was written.
-- Taking the remaining 2,000 satisfies "should not have credit" WITHOUT
-- putting him in debt. Note the stricter reading: if the 4,500 was never his,
-- then September was paid with credit he should not have had, and he would
-- owe 2,500 (the Sandra Ferguson case). That needs a separate decision and is
-- deliberately NOT done here.
--
-- Also NOT here, still awaiting an answer:
--   10045 Joseph Richards   "should not have credit" - already at 0.00.
--                           Nothing to do; left out rather than posting a
--                           zero adjustment.
--   10613 Dwayne Edmond     quoted 2,500 (= what he holds), no target given
--     760 Cermepth Maxwell  quoted 2,500 (= what he holds), no target given
--    3709 Alfred A Brown    should end up OWING for August - amount needed
--   13566 Andrea Williams-Green Street  would INCREASE credit by 1,500
--    5000 Rochelle Thompson "2500 credit for August" - target unclear
--
-- Note on identification: "Dishawn Crawford" matched 49 customers named
-- Crawford and "Cermepth Maxwell" matched 22 named Maxwell, but each list
-- contained one exact-name match. This script pins 11210 and 9836 by id AND
-- verifies the name on file, so a wrong id cannot go through quietly.
--
-- Guards: name must match, live credit must equal the figure verified
-- 2026-09-17, and neither account may end up owing money. Idempotent via
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
    customer_id     INTEGER PRIMARY KEY,
    expected_name   TEXT,
    expected_credit NUMERIC(14,2),  -- verified live 2026-09-17
    target_credit   NUMERIC(14,2)
) ON COMMIT DROP;

INSERT INTO requested VALUES
(11210, 'Dishawn Crawford', 8500.00, 3500.00),
(11438, 'Anthony Smith',    8500.00,    0.00),
( 9836, 'Simone Adams',     2500.00,    0.00),
(13429, 'Gawayne Knight',   2500.00,    0.00),
(11625, 'Demmo Sloley',     2000.00,    0.00);

CREATE TEMP TABLE resolved ON COMMIT DROP AS
SELECT r.customer_id,
       r.expected_name,
       c.name                              AS name_on_file,
       r.expected_credit,
       r.target_credit,
       b.credit_balance                    AS live_credit,
       (b.credit_balance - r.target_credit) AS adjustment,
       CASE
           WHEN c.customer_id IS NULL                  THEN 'customer id not found'
           WHEN LOWER(TRIM(c.name)) <> LOWER(TRIM(r.expected_name))
                                                       THEN 'name on file does not match'
           WHEN b.customer_id IS NULL                  THEN 'no billing status row'
           WHEN b.credit_balance <> r.expected_credit  THEN 'live credit changed since it was verified on 2026-09-17'
           WHEN b.credit_balance - r.target_credit <= 0 THEN 'would not reduce credit'
           ELSE NULL
       END AS skip_reason
FROM requested r
LEFT JOIN public.customers c               ON c.customer_id = r.customer_id
LEFT JOIN public.customer_billing_status b ON b.customer_id = r.customer_id;

-- BEFORE
SELECT 'WILL APPLY' AS outcome, customer_id, name_on_file,
       live_credit AS credit_now, target_credit, adjustment AS removing
FROM resolved WHERE skip_reason IS NULL
ORDER BY adjustment DESC;

SELECT 'SKIPPED' AS outcome, customer_id, expected_name, name_on_file,
       expected_credit AS verified_as, live_credit AS credit_now, skip_reason
FROM resolved WHERE skip_reason IS NOT NULL
ORDER BY customer_id;

INSERT INTO public.account_ledger_entries (
    customer_id, entry_type, amount, effective_date, description,
    created_by_employee_id, reason, is_verified, source_key
)
SELECT r.customer_id, 'adjustment', r.adjustment,
       (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
       'Credit corrected to the reviewed amount (account review 2026-09-17).',
       2,
       'Account review 2026-09-17 found the credit on this account higher than the amount it should carry. Reduced to the reviewed figure; the underlying payments are untouched.',
       TRUE,
       'father-credit-fix-20260917:' || r.customer_id::TEXT
FROM resolved r
WHERE r.skip_reason IS NULL
ON CONFLICT (source_key) DO NOTHING;

-- Guard: landed on target, and nobody owes money.
DO $g$
DECLARE bad INTEGER;
BEGIN
    SELECT count(*) INTO bad
    FROM resolved r
    JOIN public.customer_billing_status b USING (customer_id)
    WHERE r.skip_reason IS NULL
      AND (b.balance <> -r.target_credit OR b.balance > 0);
    IF bad > 0 THEN
        RAISE EXCEPTION '% account(s) did not land on target. Nothing committed.', bad;
    END IF;
END $g$;

INSERT INTO public.audit_logs (
    employee_id, actor_name, action, entity_type, entity_id,
    field_name, old_value, new_value, reason, occurred_at, source_key
)
SELECT (SELECT employee_id FROM actor), (SELECT actor_name FROM actor),
       'Adjusted account balance', 'customer', r.customer_id::TEXT,
       'balance', (-r.live_credit)::TEXT, (-r.target_credit)::TEXT,
       'Credit reduced to the reviewed amount for this account (review 2026-09-17).',
       CURRENT_TIMESTAMP, 'father-credit-fix-20260917:' || r.customer_id::TEXT
FROM resolved r
WHERE r.skip_reason IS NULL
ON CONFLICT (source_key) DO NOTHING;

-- AFTER
SELECT r.customer_id, r.name_on_file, b.balance AS balance_now,
       -r.target_credit AS expected
FROM resolved r
JOIN public.customer_billing_status b USING (customer_id)
WHERE r.skip_reason IS NULL
ORDER BY r.customer_id;

-- ----------------------------------------------------------------------------
-- ROLLBACK = rehearsal.  COMMIT = for real (back up first).
-- ----------------------------------------------------------------------------
ROLLBACK;
