-- ============================================================================
-- Corrections from the 2026-10-07/08 lists - the seventeen that go to 0.00.
-- They arrive from BOTH SIDES, so read the `direction` column:
--
-- "no credit" / "should not have a credit" / "remove 2500 credit":
--    7410? Roxanne McPherson          id from the settled-twice sweep
--          Ohmowale Daley
--   11569? Shaneka Tyrell #2          SEE NOTE - the "#2" matters
--          Dave O Wedderburn
--          Christal Fuller
--          Rowan Patterson
--          Lancaster S.D.A Church
--          Jabari Akeem Dohman
--   13849  Everton Blake
--    6345? Yanique Mardner            id from the settled-twice sweep
--    8307? Sophia Simpson             id from the settled-twice sweep
--   12029  Peter Edwards
--          Kevin Thompson
--
-- "remove balance" / "no balance" - these FORGIVE DEBT:
--   13659  Ann Tonett Pinnock
--    1365  Samone Patterson
--          Otis Reid
--          Sean Peterkin
--
-- The script zeroes whatever is on each account and labels which way it went,
-- so a surprise does not turn into a wrong write. That matters because the
-- sign is not reliable from the wording: on 2026-10-04 Tamaim Richards Mckay
-- was described as a 4,000 "balance" and was actually holding 4,000 CREDIT,
-- an 8,000 swing from what the review files said three weeks earlier.
--
-- SHANEKA TYRELL #2. Your father wrote "#2" and the review files contain
-- "Shaneka Tyrell" with NO suffix (11569). Those are different accounts. The
-- pattern searches both and exact-match prefers "Shaneka Tyrell #2"; if only
-- the unsuffixed one exists, the row still resolves to it and the ALL
-- CANDIDATES block will show that is what happened. CHECK THAT ROW before
-- committing - the same trap as Shanel Taylor on 2026-09-24 and Robert Powell
-- on 2026-09-26.
--
-- LANCASTER S.D.A CHURCH is searched on "lancaster" alone, because the review
-- files already hold "Lancaster Church Of God Of Prophecy" and "Lancaster
-- Emmanuel Apostolic Church" - different congregations. Expect several
-- candidates and pick the SDA one; it will skip rather than guess.
--
-- Three ids are taken from the settled-twice sweep output rather than the
-- review files, and are marked "?" above. Each is still name-checked, so a
-- wrong id cannot go through quietly.
--
-- NOT HERE - these need an amount from your father:
--   Marlon Mayne CX   "should not have a credit and should have a balance"
--                     - how much balance?
--   Rachea Matthews   "should have a balance for sept" - how much? Probably
--                     one month's fee, but which figure is his call.
--
-- Also pasted into that message but NOT an instruction: "Good morning, wont be
-- able to make it to work today not feeling well." Someone calling in sick.
-- Ignored.
--
-- Guards: one account per name, name on file must match where an id is pinned,
-- it must not already be at zero, and it must land on EXACTLY 0.00.
-- Idempotent via source_key.
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
    father_said NUMERIC(14,2),
    instruction TEXT
) ON COMMIT DROP;

INSERT INTO wanted VALUES
('Roxanne McPherson',    7410, NULL,                  2500.00, 'remove the 2,500 credit'),
('Ohmowale Daley',       NULL, '%ohmowale%',          2500.00, 'remove the 2,500 credit'),
('Shaneka Tyrell #2',    NULL, '%shaneka%tyrell%',       NULL, 'there should be no credit'),
('Dave O Wedderburn',    NULL, '%wedderburn%',           NULL, 'not supposed to have a credit'),
('Christal Fuller',      NULL, '%christal%fuller%',      NULL, 'should not have a credit'),
('Rowan Patterson',      NULL, '%rowan%patterson%',      NULL, 'no credit'),
('Lancaster S.D.A Church', NULL, '%lancaster%',          NULL, 'no credit'),
('Jabari Akeem Dohman',  NULL, '%jabari%',               NULL, 'no credit'),
('Everton Blake',       13849, NULL,                     NULL, 'should not have a credit'),
('Yanique Mardner',      6345, NULL,                     NULL, 'should not have a credit'),
('Sophia Simpson',       8307, NULL,                     NULL, 'no credit'),
('Peter Edwards',       12029, NULL,                     NULL, 'no credit'),
('Kevin Thompson',       NULL, '%kevin%thompson%',       NULL, 'no credit'),
('Ann Tonett Pinnock',  13659, NULL,                     NULL, 'remove the balance'),
('Samone Patterson',     1365, NULL,                     NULL, 'no balance'),
('Otis Reid',            NULL, '%otis%reid%',            NULL, 'no balance'),
('Sean Peterkin',        NULL, '%peterkin%',             NULL, 'no balance');

CREATE TEMP TABLE matched ON COMMIT DROP AS
SELECT w.label, w.father_said, w.instruction,
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
       (-c.balance) AS adjustment,
       CASE
           WHEN c.candidates_for_name > 1 THEN 'more than one match - supply the account number'
           WHEN c.balance IS NULL         THEN 'no billing status row'
           WHEN c.balance = 0             THEN 'already at zero - nothing to do'
           ELSE NULL
       END AS skip_reason
FROM chosen c;

SELECT 'NOT FOUND' AS check, w.label, w.pattern, w.instruction
FROM wanted w
WHERE NOT EXISTS (SELECT 1 FROM matched m WHERE m.label = w.label);

-- Every candidate - this is where a second Shaneka Tyrell or the wrong
-- Lancaster church shows up.
SELECT 'ALL CANDIDATES SEEN' AS check, label, customer_id, name_on_file, status,
       monthly_fee, balance, credit_balance, exact_match
FROM matched
ORDER BY label, exact_match DESC, balance, customer_id;

-- THE BLOCK TO READ.
SELECT 'WILL APPLY' AS check, label, customer_id, name_on_file, status,
       monthly_fee, balance AS balance_now, adjustment, 0.00 AS balance_after,
       CASE WHEN balance < 0 THEN 'removes credit'
            ELSE                  'FORGIVES DEBT - gives money away' END AS direction,
       father_said,
       CASE WHEN father_said IS NULL           THEN 'no figure quoted'
            WHEN father_said = credit_balance  THEN 'matches what he said'
            ELSE 'DIFFERS from what he said - look' END AS figure_check,
       instruction
FROM resolved WHERE skip_reason IS NULL
ORDER BY balance, label;

SELECT 'SKIPPED' AS check, label, customer_id, name_on_file, status,
       balance AS balance_now, credit_balance, candidates_for_name, skip_reason
FROM resolved WHERE skip_reason IS NOT NULL
ORDER BY label, customer_id;

INSERT INTO public.account_ledger_entries (
    customer_id, entry_type, amount, effective_date, description,
    created_by_employee_id, reason, is_verified, source_key
)
SELECT r.customer_id, 'adjustment', r.adjustment,
       (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
       CASE WHEN r.balance > 0
            THEN 'Outstanding balance cleared at management instruction (account review 2026-10-08).'
            ELSE 'Credit removed on review: the account should not be carrying a credit (account review 2026-10-08).' END,
       2,
       CASE WHEN r.balance > 0
            THEN 'Management instruction 2026-10-08: ' || r.instruction || '. This forgives money owed. The underlying charges and payments are left on the ledger.'
            ELSE 'Account review 2026-10-08: ' || r.instruction || '. Removed in full; the underlying payments are untouched.' END,
       TRUE,
       'father-credit-fix-20261008:' || r.customer_id::TEXT
FROM resolved r
WHERE r.skip_reason IS NULL
ON CONFLICT (source_key) DO NOTHING;

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
       CASE WHEN r.balance > 0 THEN 'Wrote off account balance'
            ELSE                    'Adjusted account balance' END,
       'customer', r.customer_id::TEXT,
       'balance', r.balance::TEXT, '0.00',
       CASE WHEN r.balance > 0
            THEN 'Management instruction 2026-10-08: outstanding balance of J$' || r.balance::TEXT || ' cleared. Money owed was forgiven.'
            ELSE 'Account review 2026-10-08: credit removed, the account should not be carrying one.' END,
       CURRENT_TIMESTAMP, 'father-credit-fix-20261008:' || r.customer_id::TEXT
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
