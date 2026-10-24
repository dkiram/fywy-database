-- ============================================================================
-- Corrections from the 2026-10-12 list. Two operations - read `mode`.
--
-- clear (to 0.00):
--    8753 Denise Davis                      2,500   (id given - see note)
--   15293 Cereta Vaughn                         -   "clear credit", id given
--         Sheneika Ellis                   4,000
--         Shelly-Ann Larmond/Carmenta Bell 1,000
--
-- reducecredit (fixed amount off, keeps the rest):
--   12868 Tommeco Bennett /Michella Haye    1,000  "remove 1000 FROM credit"
--
-- THE TWO 1,000 ITEMS ARE DIFFERENT OPERATIONS. "remove 1000 FROM credit"
-- (Tommeco Bennett) takes 1,000 off and leaves the remainder; "remove 1000
-- credit" (Shelly-Ann Larmond) clears the credit, which happens to be 1,000.
-- Same distinction as Robert Powell on 2026-09-26, Eric Dunn on 2026-09-30 and
-- Linvol Morgan on 2026-10-02. If Tommeco Bennett holds less than 1,000 the
-- row is skipped rather than tipping the account into debt.
--
-- DENISE DAVIS (8753) IS A REPEAT. She was one of the 37 accounts the
-- 2026-09-15 reconciliation over-credited, and was corrected for it by
-- FIX-reconciliation-overcredit-remaining.sql around 2026-09-19 (proposal
-- 4,500 against a committed 7,500, so 3,000 came off). She is now showing a
-- further 2,500. Clearing it is fine, but a third correction on one account in
-- a month suggests something upstream keeps putting credit there - worth a
-- look at how she is being billed rather than clearing her again next month.
--
-- Customer 12868 is on file as "Tommeco Bennett /Michella Haye" - note the
-- SPACE before the slash - so it is pinned by id rather than matched on text.
-- Shelly-Ann Larmond/Carmenta Bell is searched on "carmenta", which is
-- distinctive; the review files hold several unrelated Larmonds.
--
-- Temp tables are named fix1012_* rather than the generic names used in
-- earlier scripts, so they cannot collide with another script's leftovers in
-- the same session.
--
-- SAFE TO RE-RUN: anything already carrying this batch's source_key is
-- skipped.
--
-- LAST LINE IS `ROLLBACK` - rehearsal. Read every block, back up,
-- THEN change ROLLBACK -> COMMIT and run again:
--   docker exec -it spcl-backup sh /opt/spcl-deploy/backup.sh   # before COMMIT
-- ============================================================================

BEGIN;

DROP TABLE IF EXISTS fix1012_wanted, fix1012_matched, fix1012_chosen, fix1012_resolved;

CREATE TEMP TABLE fix1012_actor ON COMMIT DROP AS
SELECT e.employee_id, e.first_name || ' ' || e.last_name AS actor_name
FROM public.employees e
WHERE e.employee_id = 2;

DO $g$
DECLARE n INTEGER;
BEGIN
    SELECT count(*) INTO n FROM fix1012_actor;
    IF n <> 1 THEN RAISE EXCEPTION 'employee_id 2 matched % rows, expected 1. Nothing changed.', n; END IF;
END $g$;

CREATE TEMP TABLE fix1012_wanted (
    label       TEXT PRIMARY KEY,
    known_id    INTEGER,
    pattern     TEXT,
    mode        TEXT,            -- clear | reducecredit
    amount      NUMERIC(14,2),
    instruction TEXT
) ON COMMIT DROP;

INSERT INTO fix1012_wanted VALUES
('Denise Davis',                      8753, NULL,          'clear',        2500.00, 'clear the 2,500 credit'),
('Cereta Vaughn',                    15293, NULL,          'clear',           NULL, 'clear the credit'),
('Sheneika Ellis',                    NULL, '%sheneika%',  'clear',        4000.00, 'remove the 4,000 credit'),
('Shelly-Ann Larmond/Carmenta Bell',  NULL, '%carmenta%',  'clear',        1000.00, 'remove the 1,000 credit'),
('Tommeco Bennett /Michella Haye',   12868, NULL,          'reducecredit', 1000.00, 'remove 1,000 from the credit');

CREATE TEMP TABLE fix1012_matched ON COMMIT DROP AS
SELECT w.label, w.mode, w.amount, w.instruction,
       c.customer_id,
       c.name AS name_on_file,
       c.status,
       c.monthly_fee,
       b.balance,
       b.credit_balance,
       (LOWER(TRIM(c.name)) = LOWER(TRIM(w.label))) AS exact_match
FROM fix1012_wanted w
JOIN public.customers c
  ON (w.known_id IS NOT NULL AND c.customer_id = w.known_id)
  OR (w.known_id IS NULL AND c.name ILIKE w.pattern)
LEFT JOIN public.customer_billing_status b ON b.customer_id = c.customer_id;

CREATE TEMP TABLE fix1012_chosen ON COMMIT DROP AS
SELECT m.*,
       COUNT(*) OVER (PARTITION BY m.label) AS candidates_for_name
FROM fix1012_matched m
WHERE m.exact_match
   OR NOT EXISTS (SELECT 1 FROM fix1012_matched m2 WHERE m2.label = m.label AND m2.exact_match);

CREATE TEMP TABLE fix1012_resolved ON COMMIT DROP AS
SELECT c.*,
       CASE c.mode
         WHEN 'clear'        THEN (-c.balance)
         WHEN 'reducecredit' THEN c.amount
       END AS adjustment,
       CASE c.mode
         WHEN 'clear'        THEN 0::NUMERIC(14,2)
         WHEN 'reducecredit' THEN (c.balance + c.amount)::NUMERIC(14,2)
       END AS computed_target,
       CASE
           WHEN EXISTS (SELECT 1 FROM public.account_ledger_entries l
                        WHERE l.source_key = 'father-credit-fix-20261012:' || c.customer_id::TEXT)
                                          THEN 'already applied in an earlier run of this batch'
           WHEN c.candidates_for_name > 1 THEN 'more than one match - supply the account number'
           WHEN c.balance IS NULL         THEN 'no billing status row'
           WHEN c.mode = 'clear'
            AND c.balance = 0             THEN 'already at zero - nothing to do'
           WHEN c.mode = 'reducecredit'
            AND COALESCE(c.credit_balance, 0) < c.amount
                                          THEN 'credit is smaller than the amount to remove - would create debt'
           ELSE NULL
       END AS skip_reason
FROM fix1012_chosen c;

SELECT 'NOT FOUND' AS check, w.label, w.pattern, w.instruction
FROM fix1012_wanted w
WHERE NOT EXISTS (SELECT 1 FROM fix1012_matched m WHERE m.label = w.label);

SELECT 'ALL CANDIDATES SEEN' AS check, label, customer_id, name_on_file, status,
       monthly_fee, balance, credit_balance, exact_match
FROM fix1012_matched
ORDER BY label, exact_match DESC, balance, customer_id;

-- THE BLOCK TO READ.
SELECT 'WILL APPLY' AS check, label, mode, customer_id, name_on_file, status,
       monthly_fee, balance AS balance_now, credit_balance AS credit_now,
       adjustment, computed_target AS balance_after,
       CASE WHEN mode = 'reducecredit' THEN 'fixed reduction, keeps the rest'
            WHEN balance < 0           THEN 'removes credit'
            ELSE                            'FORGIVES DEBT - gives money away' END AS direction,
       amount AS father_said,
       CASE WHEN mode <> 'clear'           THEN 'n/a for this mode'
            WHEN amount IS NULL            THEN 'no figure quoted'
            WHEN amount = credit_balance   THEN 'matches what he said'
            ELSE 'DIFFERS from what he said - look' END AS figure_check,
       instruction
FROM fix1012_resolved WHERE skip_reason IS NULL
ORDER BY label;

SELECT 'SKIPPED' AS check, label, mode, customer_id, name_on_file, status,
       balance AS balance_now, credit_balance, amount,
       candidates_for_name, skip_reason
FROM fix1012_resolved WHERE skip_reason IS NOT NULL
ORDER BY label, customer_id;

INSERT INTO public.account_ledger_entries (
    customer_id, entry_type, amount, effective_date, description,
    created_by_employee_id, reason, is_verified, source_key
)
SELECT r.customer_id, 'adjustment', r.adjustment,
       (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
       CASE WHEN r.mode = 'clear' AND r.balance > 0
            THEN 'Outstanding balance cleared at management instruction (account review 2026-10-12).'
            ELSE 'Credit corrected on review (account review 2026-10-12).' END,
       2,
       'Account review 2026-10-12: ' || r.instruction || '. The underlying payments are untouched.',
       TRUE,
       'father-credit-fix-20261012:' || r.customer_id::TEXT
FROM fix1012_resolved r
WHERE r.skip_reason IS NULL
ON CONFLICT (source_key) DO NOTHING;

DO $g$
DECLARE bad INTEGER;
BEGIN
    SELECT count(*) INTO bad
    FROM fix1012_resolved r
    JOIN public.customer_billing_status b USING (customer_id)
    WHERE r.skip_reason IS NULL
      AND (b.balance <> r.computed_target OR b.balance > 0);
    IF bad > 0 THEN
        RAISE EXCEPTION '% account(s) did not land on target or ended up owing. Nothing committed.', bad;
    END IF;
END $g$;

INSERT INTO public.audit_logs (
    employee_id, actor_name, action, entity_type, entity_id,
    field_name, old_value, new_value, reason, occurred_at, source_key
)
SELECT (SELECT employee_id FROM fix1012_actor), (SELECT actor_name FROM fix1012_actor),
       'Adjusted account balance', 'customer', r.customer_id::TEXT,
       'balance', r.balance::TEXT, r.computed_target::TEXT,
       'Account review 2026-10-12: ' || r.instruction || '.',
       CURRENT_TIMESTAMP, 'father-credit-fix-20261012:' || r.customer_id::TEXT
FROM fix1012_resolved r
WHERE r.skip_reason IS NULL
ON CONFLICT (source_key) DO NOTHING;

SELECT 'AFTER' AS check, r.customer_id, r.name_on_file, b.balance AS balance_now,
       r.computed_target AS expected
FROM fix1012_resolved r
JOIN public.customer_billing_status b USING (customer_id)
WHERE r.skip_reason IS NULL
ORDER BY r.customer_id;

-- ----------------------------------------------------------------------------
-- ROLLBACK = rehearsal.  COMMIT = for real (back up first).
-- ----------------------------------------------------------------------------
ROLLBACK;
