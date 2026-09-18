-- ============================================================================
-- Third batch from the 2026-09-17/18 credit list - reductions to a credit
-- target. Nobody here ends up owing money.
--
--   10613 Dwayne Edmond          "clear that credit"
--                                holds 2,500 -> remove 2,500, leaving 0
--     760 Cermepth Maxwell       "clear the credit"
--                                holds 2,500 -> remove 2,500, leaving 0
--    5000 Rochelle Thompson      "only should have 2500 credit"
--                                holds 5,000 -> remove 2,500, leaving 2,500
--   11782 Oneil Reid-Grove Town  "clear that accounts credit too"
--                                holds ? -> remove all of it, leaving 0
--
-- On 11782: the account number came straight from the message but the credit
-- has not been verified, so there is no pinned figure to check against - the
-- rule is simply "whatever credit is there, take it to 0". The BEFORE output
-- prints the name and the amount. READ THAT LINE and confirm it is the right
-- Oneil Reid before you commit, because unlike the other three there is no
-- name guard standing behind it.
--
-- NOT here, handled separately:
--    3709 Alfred A Brown  should end up OWING 500 -> see
--                         FIX-alfred-brown-3709-owes-august.sql
--   13566 Andrea Williams-Green Street  the instruction contradicts itself
--                         ("should have a credit of 3000" vs "should owe
--                         3000"). Untouched until that is settled.
--
-- Guards: name must match where a name was verified, live credit must equal
-- the verified figure where there is one, every account must still be in
-- credit, and none may end up owing money. Idempotent via source_key.
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

-- expected_name NULL  = identified by account number only, no name guard.
-- expected_credit NULL = no verified figure, take whatever credit is there to
--                        the target.
CREATE TEMP TABLE requested (
    customer_id     INTEGER PRIMARY KEY,
    expected_name   TEXT,
    expected_credit NUMERIC(14,2),
    target_credit   NUMERIC(14,2)
) ON COMMIT DROP;

INSERT INTO requested VALUES
(10613, 'Dwayne Edmond',    2500.00,    0.00),
(  760, 'Cermepth Maxwell', 2500.00,    0.00),
( 5000, 'Rochelle Thompson',5000.00, 2500.00),
(11782, NULL,                  NULL,    0.00);

CREATE TEMP TABLE resolved ON COMMIT DROP AS
SELECT r.customer_id,
       r.expected_name,
       c.name                               AS name_on_file,
       c.status,
       r.expected_credit,
       r.target_credit,
       b.credit_balance                     AS live_credit,
       (b.credit_balance - r.target_credit) AS adjustment,
       CASE
           WHEN c.customer_id IS NULL                   THEN 'customer id not found'
           WHEN r.expected_name IS NOT NULL
            AND LOWER(TRIM(c.name)) <> LOWER(TRIM(r.expected_name))
                                                        THEN 'name on file does not match - WRONG ACCOUNT, do not force'
           WHEN b.customer_id IS NULL                   THEN 'no billing status row'
           WHEN r.expected_credit IS NOT NULL
            AND b.credit_balance <> r.expected_credit   THEN 'live credit changed since it was verified on 2026-09-17'
           WHEN COALESCE(b.credit_balance, 0) <= 0      THEN 'not in credit - nothing to remove'
           WHEN b.credit_balance - r.target_credit <= 0 THEN 'would not reduce credit'
           ELSE NULL
       END AS skip_reason
FROM requested r
LEFT JOIN public.customers c               ON c.customer_id = r.customer_id
LEFT JOIN public.customer_billing_status b ON b.customer_id = r.customer_id;

-- BEFORE. For 11782 this is the only check on identity - read the name.
SELECT 'WILL APPLY' AS outcome, customer_id, name_on_file, status,
       live_credit AS credit_now, target_credit, adjustment AS removing,
       CASE WHEN expected_name IS NULL THEN 'id only - CONFIRM THIS NAME' ELSE 'name verified' END AS identity
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
       'Credit corrected to the reviewed amount (account review 2026-09-18).',
       2,
       'Account review 2026-09-18 confirmed the credit on this account was higher than it should be. Reduced to the reviewed figure; the underlying payments are untouched.',
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
       'Credit reduced to the reviewed amount for this account (review 2026-09-18).',
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
