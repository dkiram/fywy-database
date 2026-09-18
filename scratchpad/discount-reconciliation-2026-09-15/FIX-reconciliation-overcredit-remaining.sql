-- ============================================================================
-- Removes the over-credit the 2026-09-15 committed reconciliation gave that
-- its own proposal did not.
--
-- Background: `all-account-review.md` (the proposal, 2,646 accounts) deducted
-- already-posted future monthly charges from the prepaid reserve.
-- `FINAL-review.md` (what was committed, 2,649) preserved them instead. On 37
-- accounts that made the committed credit LARGER than proposed - J$87,800 in
-- total, and never smaller on any account. 3 further accounts were committed
-- that appear nowhere in the proposal.
--
-- Accounting of all 40:
--    8  already corrected 2026-09-16 (staff-credit-fix-20260916:*)  - skipped
--    3  never-proposed accounts (389, 5850, 10476), all in that same
--       2026-09-16 batch                                            - skipped
--    1  8881 Augustus Bailey - staff have an OPEN QUERY on it ("some months
--       are missing") and their figure (500) disagrees with the proposal
--       (4,500). Deliberately left alone.
--   28  handled here, J$64,250.00 total.
--
-- Each account gets ONE 'adjustment' for exactly its over-credit amount - the
-- difference between the committed target and the proposed target. A fixed
-- delta rather than an absolute target, so an account that has legitimately
-- taken a payment since 2026-09-15 is still corrected by the right amount.
--
-- SAFETY - a row failing any guard is SKIPPED and listed, never forced:
--   * name on file must match the name in the review files;
--   * the account must still be in credit;
--   * live credit must still be at least the committed target. If something
--     has already reduced this account (the current-charge corrections, the
--     August-2026 sweep, a reversal), its credit will be below that and the
--     row is skipped rather than corrected twice. THIS IS THE IMPORTANT ONE -
--     read the SKIPPED table before committing.
-- Idempotent via source_key; a second run inserts nothing.
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

-- Credit figures are magnitudes (a 2,000.00 credit = balance -2,000.00).
CREATE TEMP TABLE overcredit (
    customer_id      INTEGER PRIMARY KEY,
    expected_name    TEXT,
    proposed_credit  NUMERIC(14,2),
    committed_credit NUMERIC(14,2),
    overcredit       NUMERIC(14,2)
) ON COMMIT DROP;

INSERT INTO overcredit VALUES
( 12438, 'Vashty Thompson',               2000.00, 12000.00, 10000.00),
(  6554, 'Yvonne Stiff',                  4000.00, 12000.00,  8000.00),
(   963, 'Hortense Daley',                4000.00,  8000.00,  4000.00),
(  8753, 'Denise Davis',                  4500.00,  7500.00,  3000.00),
(  5810, 'Jerome Young',                  4000.00,  7000.00,  3000.00),
(  9474, 'Althea Francis',                2500.00,  5000.00,  2500.00),
(  2528, 'Maureen Bryan',                 1000.00,  3500.00,  2500.00),
(  4866, 'Jodi-ann Williams',             1000.00,  3500.00,  2500.00),
( 15064, 'Sandra Ferguson',                500.00,  3000.00,  2500.00),
(  7532, 'Pearline Bailey',               2500.00,  5000.00,  2500.00),
(  6301, 'Cynthia Elaine Griffiths',      2600.00,  5000.00,  2400.00),
( 10235, 'Najah Beckford-White',          3000.00,  5000.00,  2000.00),
( 10482, 'Everol Dwyer',                   500.00,  2500.00,  2000.00),
( 11179, 'Rochelle Smith',                3000.00,  5000.00,  2000.00),
(  5597, 'Grace Lawson',                  2500.00,  4500.00,  2000.00),
( 14199, 'Paul Rumble',                   4000.00,  6000.00,  2000.00),
(  4673, 'Chrystine Barbara Rodrigues1',  1750.00,  3500.00,  1750.00),
( 12832, 'Tanyalee Campbell',             1000.00,  2500.00,  1500.00),
(  4662, 'Nigel Morgan',                  2000.00,  3500.00,  1500.00),
(  7569, 'Dwayne Morris',                 3500.00,  5000.00,  1500.00),
(   498, 'Chuthild Spencer',              4000.00,  5000.00,  1000.00),
( 11423, 'Rudolph Rose #2',               1500.00,  2500.00,  1000.00),
(  3334, 'Tashia Brown #2',               4150.00,  5000.00,   850.00),
( 12121, 'Yanique Smith',                 2000.00,  2500.00,   500.00),
(  4890, 'Enid Lowe',                     2000.00,  2500.00,   500.00),
( 13421, 'Marjorie Wilk #2',              4500.00,  5000.00,   500.00),
(  5682, 'Annmarie Lamothe',              4500.00,  5000.00,   500.00),
(  4198, 'Jerome Lyle 2',                 4750.00,  5000.00,   250.00);

CREATE TEMP TABLE resolved ON COMMIT DROP AS
SELECT o.customer_id,
       o.expected_name,
       c.name                                   AS name_on_file,
       o.proposed_credit,
       o.committed_credit,
       o.overcredit,
       b.credit_balance                         AS live_credit,
       (b.credit_balance - o.overcredit)        AS credit_after,
       CASE
           WHEN c.customer_id IS NULL                        THEN 'customer id not found'
           WHEN LOWER(TRIM(c.name)) <> LOWER(TRIM(o.expected_name))
                                                             THEN 'name on file does not match the review files'
           WHEN b.customer_id IS NULL                        THEN 'no billing status row'
           WHEN COALESCE(b.credit_balance, 0) <= 0           THEN 'no longer in credit'
           WHEN b.credit_balance < o.committed_credit        THEN 'credit already reduced since 2026-09-15 - check before correcting again'
           WHEN EXISTS (SELECT 1 FROM public.account_ledger_entries l
                        WHERE l.customer_id = o.customer_id
                          AND l.source_key = 'staff-credit-fix-20260916:' || o.customer_id::TEXT)
                                                             THEN 'already corrected in the 2026-09-16 staff batch'
           ELSE NULL
       END AS skip_reason
FROM overcredit o
LEFT JOIN public.customers c               ON c.customer_id = o.customer_id
LEFT JOIN public.customer_billing_status b ON b.customer_id = o.customer_id;

-- BEFORE
SELECT 'WILL APPLY' AS outcome, customer_id, name_on_file,
       live_credit AS credit_now, overcredit AS removing, credit_after,
       proposed_credit AS proposal_said
FROM resolved WHERE skip_reason IS NULL
ORDER BY overcredit DESC;

SELECT 'SKIPPED' AS outcome, customer_id, expected_name, name_on_file,
       live_credit AS credit_now, committed_credit AS expected_from_sep15,
       overcredit, skip_reason
FROM resolved WHERE skip_reason IS NOT NULL
ORDER BY customer_id;

INSERT INTO public.account_ledger_entries (
    customer_id, entry_type, amount, effective_date, description,
    created_by_employee_id, reason, is_verified, source_key
)
SELECT r.customer_id, 'adjustment', r.overcredit,
       (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
       'Corrects credit issued above the approved reconciliation amount on 2026-09-15.',
       2,
       'The 2026-09-15 reconciliation posted more advance credit than the reviewed proposal allowed for this account, because future monthly charges already on the ledger were not deducted from the prepaid reserve. This removes only that difference; the customer keeps the prepaid credit they actually paid for.',
       TRUE,
       'reconciliation-overcredit-fix:' || r.customer_id::TEXT
FROM resolved r
WHERE r.skip_reason IS NULL
ON CONFLICT (source_key) DO NOTHING;

-- Guard: nobody was pushed out of credit and into debt.
DO $g$
DECLARE bad INTEGER;
BEGIN
    SELECT count(*) INTO bad
    FROM resolved r
    JOIN public.customer_billing_status b USING (customer_id)
    WHERE r.skip_reason IS NULL
      AND b.balance > 0;
    IF bad > 0 THEN
        RAISE EXCEPTION '% account(s) ended up owing money. Nothing committed.', bad;
    END IF;
END $g$;

INSERT INTO public.audit_logs (
    employee_id, actor_name, action, entity_type, entity_id,
    field_name, old_value, new_value, reason, occurred_at, source_key
)
SELECT (SELECT employee_id FROM actor), (SELECT actor_name FROM actor),
       'Adjusted account balance', 'customer', r.customer_id::TEXT,
       'balance', (-r.live_credit)::TEXT, (-r.credit_after)::TEXT,
       'Removed credit issued above the approved 2026-09-15 reconciliation amount for this account.',
       CURRENT_TIMESTAMP, 'reconciliation-overcredit-fix:' || r.customer_id::TEXT
FROM resolved r
WHERE r.skip_reason IS NULL
ON CONFLICT (source_key) DO NOTHING;

-- AFTER
SELECT COUNT(*) FILTER (WHERE skip_reason IS NULL)     AS accounts_corrected,
       COALESCE(SUM(overcredit) FILTER (WHERE skip_reason IS NULL), 0) AS total_removed,
       COUNT(*) FILTER (WHERE skip_reason IS NOT NULL) AS accounts_skipped
FROM resolved;

SELECT r.customer_id, r.name_on_file, b.balance AS balance_now,
       -r.credit_after AS expected
FROM resolved r
JOIN public.customer_billing_status b USING (customer_id)
WHERE r.skip_reason IS NULL
ORDER BY r.customer_id;

-- ----------------------------------------------------------------------------
-- ROLLBACK = rehearsal.  COMMIT = for real (back up first).
-- ----------------------------------------------------------------------------
ROLLBACK;
