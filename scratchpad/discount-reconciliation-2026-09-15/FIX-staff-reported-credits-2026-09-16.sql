-- ============================================================================
-- Corrections for the credit discrepancies staff reported on WhatsApp
-- 2026-09-16. One 'adjustment' per account, reducing credit to the figure
-- staff described. Never increases anyone's credit.
--
-- TARGETS AND WHERE THEY COME FROM (staff's own words):
--   14056 Tommy Comire          showing 9,000 -> 6,000   paid Sep+Oct 6,000
--    6344 Andrew Chambers       showing 10,000 -> 4,000  Sep 2,500 + Oct 1,500
--    9165 Natoy Baker           showing 10,500 -> 8,500  Sep/Oct/Nov 2,500 ea + Dec 1,000
--    2840 Gregory L Pullen      showing 11,000 -> 7,000  Sep 5,500 + Oct 1,500
--    6380 Dorothy Richard       showing 11,000 -> 10,000 stated outright
--    3975 Yvonne Joyce Malcolm  showing 12,000 -> 10,000 stated outright
--    4954 Suzette McCalla       showing 12,000 -> 10,000 stated outright
--    5850 Janice Ellis-Simpson  showing 15,000 -> 5,000  paid up to September 5,000
--     389 Oshauna M Sappleton   showing 17,000 -> 10,000 stated outright
--   10476 Julin Barrett Bell    showing 20,000 -> 5,000  stated outright
--    9844 Cardell McLean-Mont.  showing 8,000 -> 6,500   Sep 4,000 + part Oct 2,500
--    4050 Andre mclean/T G-B    showing 9,000 -> 0       last payment August, no credit due
--    5424 Shayann Johnson       (no figure given) -> 6,450  Sep 4,000 + 2,450 toward Oct
--
-- DELIBERATELY NOT INCLUDED - both need a decision from you first:
--   8881 Augustus Bailey  staff said "should only be showing $500" but ALSO
--        "under query tho cause some months are missing". Staff themselves
--        have not settled it. Left alone.
--    963 Hortense Daley   staff gave no credit figure - they described a
--        J$4,000 September payment against a J$4,500 monthly bill, which
--        reads as a J$500 SHORTFALL, not a credit target. Guessing a number
--        here could take money that is genuinely owed to the customer.
--
-- SAFETY - every row is guarded, and a row that fails a guard is SKIPPED and
-- listed, not forced through:
--   * the customer's name on file must match the name staff used;
--   * where staff quoted a "credit showing" figure, live credit must equal it
--     exactly (this is what catches an account already corrected by another
--     batch, or changed by a payment since the message was sent);
--   * the adjustment must be a REDUCTION - a row that would increase credit
--     is skipped.
-- Idempotent via source_key: running twice inserts nothing the second time.
--
-- LAST LINE IS `ROLLBACK` - rehearsal. Read the APPLIED and SKIPPED tables,
-- back up, THEN change ROLLBACK -> COMMIT and run again:
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

-- expected_credit NULL = staff did not quote a current figure, so only the
-- "must be a reduction" guard applies to that row.
CREATE TEMP TABLE staff_reported (
    customer_id     INTEGER PRIMARY KEY,
    expected_name   TEXT,
    expected_credit NUMERIC(14,2),
    target_credit   NUMERIC(14,2)
) ON COMMIT DROP;

INSERT INTO staff_reported VALUES
(14056, 'Tommy Comire',                       9000.00,  6000.00),
( 6344, 'Andrew Chambers',                   10000.00,  4000.00),
( 9165, 'Natoy Baker',                       10500.00,  8500.00),
( 2840, 'Gregory Lancelot Pullen',           11000.00,  7000.00),
( 6380, 'Dorothy Richard',                   11000.00, 10000.00),
( 3975, 'Yvonne Joyce Malcolm',              12000.00, 10000.00),
( 4954, 'Suzette McCalla',                   12000.00, 10000.00),
( 5850, 'Janice Ellis-Simpson',              15000.00,  5000.00),
(  389, 'Oshauna Mcknight Sappleton',        17000.00, 10000.00),
(10476, 'Julin Barrett Bell',                20000.00,  5000.00),
( 9844, 'Cardell McLean-Montaque',            8000.00,  6500.00),
( 4050, 'Andre mclean/Tanisha Gordon-Beadle', 9000.00,     0.00),
( 5424, 'Shayann Johnson',                        NULL,  6450.00);

CREATE TEMP TABLE resolved ON COMMIT DROP AS
SELECT s.customer_id,
       s.expected_name,
       c.name                          AS name_on_file,
       s.expected_credit,
       s.target_credit,
       b.balance                       AS live_balance,
       b.credit_balance                AS live_credit,
       (b.credit_balance - s.target_credit) AS adjustment,
       CASE
           WHEN c.customer_id IS NULL                       THEN 'customer id not found'
           WHEN LOWER(TRIM(c.name)) <> LOWER(TRIM(s.expected_name))
                                                            THEN 'name on file does not match staff name'
           WHEN b.customer_id IS NULL                       THEN 'no billing status row'
           WHEN s.expected_credit IS NOT NULL
            AND b.credit_balance <> s.expected_credit       THEN 'live credit is not the figure staff quoted'
           WHEN COALESCE(b.credit_balance, 0) - s.target_credit <= 0
                                                            THEN 'would not reduce credit'
           ELSE NULL
       END AS skip_reason
FROM staff_reported s
LEFT JOIN public.customers c              ON c.customer_id = s.customer_id
LEFT JOIN public.customer_billing_status b ON b.customer_id = s.customer_id;

-- BEFORE: what will be applied, and what will be skipped and why.
SELECT 'WILL APPLY' AS outcome, customer_id, name_on_file,
       live_credit AS credit_now, target_credit, adjustment
FROM resolved WHERE skip_reason IS NULL
ORDER BY adjustment DESC;

SELECT 'SKIPPED' AS outcome, customer_id, expected_name, name_on_file,
       expected_credit AS staff_said, live_credit AS credit_now, skip_reason
FROM resolved WHERE skip_reason IS NOT NULL
ORDER BY customer_id;

INSERT INTO public.account_ledger_entries (
    customer_id, entry_type, amount, effective_date, description,
    created_by_employee_id, reason, is_verified, source_key
)
SELECT r.customer_id, 'adjustment', r.adjustment,
       (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
       'Credit corrected to the amount the customer actually paid ahead for (staff review 2026-09-16).',
       2,
       'Staff review 2026-09-16 found the credit larger than the months the customer paid for. Reduced to the paid-ahead value staff confirmed; the underlying payments are untouched.',
       TRUE,
       'staff-credit-fix-20260916:' || r.customer_id::TEXT
FROM resolved r
WHERE r.skip_reason IS NULL
ON CONFLICT (source_key) DO NOTHING;

-- Guard: every applied account landed exactly on its target.
DO $g$
DECLARE bad INTEGER;
BEGIN
    SELECT count(*) INTO bad
    FROM resolved r
    JOIN public.customer_billing_status b USING (customer_id)
    WHERE r.skip_reason IS NULL
      AND b.balance <> -r.target_credit;
    IF bad > 0 THEN
        RAISE EXCEPTION '% account(s) did not land on their target balance. Nothing committed.', bad;
    END IF;
END $g$;

INSERT INTO public.audit_logs (
    employee_id, actor_name, action, entity_type, entity_id,
    field_name, old_value, new_value, reason, occurred_at, source_key
)
SELECT (SELECT employee_id FROM actor), (SELECT actor_name FROM actor),
       'Adjusted account balance', 'customer', r.customer_id::TEXT,
       'balance', (-r.live_credit)::TEXT, (-r.target_credit)::TEXT,
       'Staff review 2026-09-16: credit reduced to the value of the months the customer actually paid for.',
       CURRENT_TIMESTAMP, 'staff-credit-fix-20260916:' || r.customer_id::TEXT
FROM resolved r
WHERE r.skip_reason IS NULL
ON CONFLICT (source_key) DO NOTHING;

-- AFTER
SELECT COUNT(*) AS accounts_corrected, SUM(adjustment) AS total_credit_removed
FROM resolved WHERE skip_reason IS NULL;

SELECT r.customer_id, r.name_on_file, b.balance AS balance_now, -r.target_credit AS expected
FROM resolved r
JOIN public.customer_billing_status b USING (customer_id)
WHERE r.skip_reason IS NULL
ORDER BY r.customer_id;

-- ----------------------------------------------------------------------------
-- ROLLBACK = rehearsal.  COMMIT = for real (back up first).
-- ----------------------------------------------------------------------------
ROLLBACK;
