-- ============================================================================
-- Corrections from the 2026-10-02 list. Three operations - read `mode`.
--
--   clear         13887 Janell Simpson     "clear credit of 4500"   -> 0
--   clear          5191 Kareen Reid        "remove 1000 credit"     -> 0
--   clear               Orlando Nembhard   "clear credit of 8000"   -> 0
--   reducecredit   1508 Linvol morgan      "remove 1000 FROM credit" -> keeps the rest
--   addcredit            Stashell Daley    "add 3500 credit"        -> credit UP 3,500
--
-- WHAT EACH MODE MEANS
--
-- clear: take the whole credit to zero, whatever it is now. The figure in the
--   message is what he saw on screen; `figure_check` flags a gap.
--
-- reducecredit: take a FIXED 1,000 off Linvol Morgan's credit and leave the
--   rest. "remove 1000 FROM credit" is the same wording as Robert Powell
--   (2026-09-26) and Eric Dunn (2026-09-30), and it means something different
--   from "remove 1000 credit": if he holds more than 1,000 he keeps the
--   difference. If he holds less, the row is skipped rather than tipping him
--   into debt. Note he was DISCONNECTED and owing 4,000 in the 2026-09-15
--   review files, so his position has moved - read his row.
--
-- addcredit: GIVES THE CUSTOMER MONEY. Stashell Daley's credit goes UP by
--   3,500. Read as "increase the credit by 3,500", matching how "Yvonne
--   shields add 1000 credit for September" was handled on 2026-09-18. If your
--   father meant she should END at 3,500 credit rather than gain 3,500, the
--   two differ unless she is at zero now - the BEFORE block shows which.
--
-- Kareen Reid's figure is worth a glance: the message says 1,000 but the
-- 2026-09-15 review files had her at 2,500. `figure_check` will show where she
-- actually is. The instruction is to clear it either way.
--
-- Guards: exactly one account per name, name on file must match, and each must
-- land EXACTLY on its computed target. The only row that can give money is the
-- addcredit one, and it is labelled as such in `direction`. Idempotent via
-- source_key.
--
-- LAST LINE IS `ROLLBACK` - rehearsal. Read every block, back up,
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

CREATE TEMP TABLE wanted (
    label       TEXT PRIMARY KEY,
    known_id    INTEGER,
    pattern     TEXT,
    mode        TEXT,           -- clear | reducecredit | addcredit
    amount      NUMERIC(14,2),
    instruction TEXT
) ON COMMIT DROP;

INSERT INTO wanted VALUES
('Janell Simpson',   13887, NULL,                 'clear',        4500.00, 'clear the credit'),
('Kareen Reid',       5191, NULL,                 'clear',        1000.00, 'remove the credit'),
('Orlando Nembhard',  NULL, '%orlando%nembhard%', 'clear',        8000.00, 'clear the credit'),
('Linvol morgan',     1508, NULL,                 'reducecredit', 1000.00, 'remove 1,000 from the credit'),
('Stashell Daley',    NULL, '%stashell%',         'addcredit',    3500.00, 'add 3,500 credit');

CREATE TEMP TABLE matched ON COMMIT DROP AS
SELECT w.label, w.mode, w.amount, w.instruction,
       c.customer_id,
       c.name AS name_on_file,
       c.status,
       c.monthly_fee,
       b.balance,
       b.credit_balance,
       (LOWER(TRIM(c.name)) = LOWER(TRIM(w.label))) AS exact_match
FROM wanted w
JOIN public.customers c
  ON (w.known_id IS NOT NULL AND c.customer_id = w.known_id)
  OR (w.known_id IS NULL AND c.name ILIKE w.pattern)
LEFT JOIN public.customer_billing_status b ON b.customer_id = c.customer_id;

CREATE TEMP TABLE chosen ON COMMIT DROP AS
SELECT m.*,
       COUNT(*) OVER (PARTITION BY m.label) AS candidates_for_name
FROM matched m
WHERE m.exact_match
   OR NOT EXISTS (SELECT 1 FROM matched m2 WHERE m2.label = m.label AND m2.exact_match);

CREATE TEMP TABLE resolved ON COMMIT DROP AS
SELECT c.*,
       CASE c.mode
         WHEN 'clear'        THEN c.credit_balance
         WHEN 'reducecredit' THEN c.amount
         WHEN 'addcredit'    THEN -c.amount
       END AS adjustment,
       CASE c.mode
         WHEN 'clear'        THEN 0::NUMERIC(14,2)
         WHEN 'reducecredit' THEN (c.balance + c.amount)::NUMERIC(14,2)
         WHEN 'addcredit'    THEN (c.balance - c.amount)::NUMERIC(14,2)
       END AS computed_target,
       CASE
           WHEN c.candidates_for_name > 1   THEN 'still ambiguous after exact-match - pin the id by hand'
           WHEN c.balance IS NULL           THEN 'no billing status row'
           WHEN c.mode = 'clear'
            AND COALESCE(c.credit_balance, 0) <= 0
                                            THEN 'not in credit - nothing to remove'
           WHEN c.mode = 'reducecredit'
            AND COALESCE(c.credit_balance, 0) < c.amount
                                            THEN 'credit is smaller than the amount to remove - would create debt'
           ELSE NULL
       END AS skip_reason
FROM chosen c;

SELECT 'NOT FOUND' AS check, w.label, w.pattern
FROM wanted w
WHERE NOT EXISTS (SELECT 1 FROM matched m WHERE m.label = w.label);

SELECT 'ALL CANDIDATES SEEN' AS check, label, customer_id, name_on_file, status,
       balance, credit_balance, exact_match
FROM matched
ORDER BY label, exact_match DESC, credit_balance DESC NULLS LAST, customer_id;

-- THE BLOCK TO READ.
SELECT 'WILL APPLY' AS check, label, mode, customer_id, name_on_file, status,
       monthly_fee, balance AS balance_now, credit_balance AS credit_now,
       adjustment, computed_target AS balance_after,
       CASE WHEN mode = 'addcredit'    THEN 'ADDS CREDIT - gives money'
            WHEN mode = 'reducecredit' THEN 'fixed reduction, keeps the rest'
            ELSE                            'removes credit' END AS direction,
       amount AS father_said,
       CASE WHEN mode <> 'clear'             THEN 'n/a for this mode'
            WHEN amount = credit_balance     THEN 'matches what he said'
            ELSE 'DIFFERS from what he said - look' END AS figure_check,
       instruction
FROM resolved WHERE skip_reason IS NULL
ORDER BY label;

SELECT 'SKIPPED' AS check, label, mode, customer_id, name_on_file, status,
       balance AS balance_now, credit_balance, amount,
       candidates_for_name, skip_reason
FROM resolved WHERE skip_reason IS NOT NULL
ORDER BY label, customer_id;

INSERT INTO public.account_ledger_entries (
    customer_id, entry_type, amount, effective_date, description,
    created_by_employee_id, reason, is_verified, source_key
)
SELECT r.customer_id, 'adjustment', r.adjustment,
       (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
       CASE WHEN r.mode = 'addcredit'
            THEN 'Credit added on review (account review 2026-10-02).'
            ELSE 'Credit corrected on review (account review 2026-10-02).' END,
       2,
       'Account review 2026-10-02: ' || r.instruction || '. The underlying payments are untouched.',
       TRUE,
       'father-credit-fix-20261002:' || r.customer_id::TEXT
FROM resolved r
WHERE r.skip_reason IS NULL
ON CONFLICT (source_key) DO NOTHING;

-- Guard: every account landed where its mode says, and only the addcredit row
-- is allowed to end further into credit than it started.
DO $g$
DECLARE bad INTEGER;
BEGIN
    SELECT count(*) INTO bad
    FROM resolved r
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
SELECT (SELECT employee_id FROM actor), (SELECT actor_name FROM actor),
       'Adjusted account balance', 'customer', r.customer_id::TEXT,
       'balance', r.balance::TEXT, r.computed_target::TEXT,
       'Account review 2026-10-02: ' || r.instruction || '.',
       CURRENT_TIMESTAMP, 'father-credit-fix-20261002:' || r.customer_id::TEXT
FROM resolved r
WHERE r.skip_reason IS NULL
ON CONFLICT (source_key) DO NOTHING;

SELECT 'AFTER' AS check, r.customer_id, r.name_on_file, b.balance AS balance_now,
       r.computed_target AS expected
FROM resolved r
JOIN public.customer_billing_status b USING (customer_id)
WHERE r.skip_reason IS NULL
ORDER BY r.customer_id;

-- ----------------------------------------------------------------------------
-- ROLLBACK = rehearsal.  COMMIT = for real (back up first).
-- ----------------------------------------------------------------------------
ROLLBACK;
