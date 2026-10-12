-- ============================================================================
-- READ ONLY. Which account failed to land on target in
-- FIX-father-list-2026-10-08-targets.sql, and why?
--
-- The guard compares each account's balance after the write against its
-- computed target. An account can fail that for exactly one reason here: its
-- adjustment was never inserted, because an entry with the same source_key
-- already existed and ON CONFLICT DO NOTHING swallowed it.
--
-- Both 2026-10-08 scripts write 'father-credit-fix-20261008:<customer_id>'.
-- So a collision happens if:
--   (a) the zero script was already committed and one account is reached by
--       BOTH scripts - most likely via a loose ILIKE pattern; or
--   (b) two different names in the targets script resolve to the SAME account,
--       so the first adjustment applies and the second no-ops.
--
-- Section 1 resolves the nine target rows exactly as the fix script does and
-- shows which already carry that source_key. Section 2 looks for two labels
-- landing on one account. Section 3 lists every 2026-10-08 entry already on
-- the ledger.
--
-- Writes nothing. Wrapped in BEGIN/ROLLBACK with ON COMMIT DROP so its temp
-- tables do not outlive the run - an earlier version omitted both and left
-- `wanted`, `matched` and `chosen` behind in the session, which then blocked
-- the fix script with "relation wanted already exists". If you hit that, run
--   DROP TABLE IF EXISTS wanted, matched, chosen;
-- or reconnect, since temp tables die with the session.
-- ============================================================================

BEGIN;

DROP TABLE IF EXISTS wanted, matched, chosen;

CREATE TEMP TABLE wanted (
    label          TEXT PRIMARY KEY,
    known_id       INTEGER,
    pattern        TEXT,
    mode           TEXT,
    amount         NUMERIC(14,2),
    target_balance NUMERIC(14,2)
) ON COMMIT DROP;

INSERT INTO wanted VALUES
('Carla Mayne',             7905, NULL,                   'target', NULL, -2500.00),
('Catherine Harrison',      NULL, '%catherine%harrison%', 'target', NULL, -3250.00),
('Richie Bramwell',         NULL, '%richie%bramwell%',    'target', NULL, -3500.00),
('Delbert Lodge-Rose Hall', 9719, NULL,                   'target', NULL, -2500.00),
('Michael Spence',          NULL, '%michael%spence%',     'target', NULL, -2500.00),
('Venese Windeth',         11780, NULL,                   'target', NULL,  2500.00),
('Novelett Marshall',       NULL, '%novelett%marshall%',  'addbal', 3500.00,  NULL),
('Marlon Mayne CX',         NULL, '%marlon%mayne%',       'target', NULL,  2500.00),
('Rachea Matthews',         NULL, '%rache%matthews%',   'owemonth', NULL,     NULL);

CREATE TEMP TABLE matched ON COMMIT DROP AS
SELECT w.label, w.mode, w.amount, w.target_balance,
       c.customer_id, c.name AS name_on_file, c.status, c.monthly_fee,
       b.balance,
       (LOWER(TRIM(c.name)) = LOWER(TRIM(w.label))) AS exact_match
FROM wanted w
JOIN public.customers c
  ON (w.known_id IS NOT NULL AND c.customer_id = w.known_id)
  OR (w.known_id IS NULL AND c.name ILIKE w.pattern)
LEFT JOIN public.customer_billing_status b ON b.customer_id = c.customer_id;

CREATE TEMP TABLE chosen ON COMMIT DROP AS
SELECT m.*, COUNT(*) OVER (PARTITION BY m.label) AS candidates_for_name
FROM matched m
WHERE m.exact_match
   OR NOT EXISTS (SELECT 1 FROM matched m2 WHERE m2.label = m.label AND m2.exact_match);

-- 1. THE ANSWER: a row with already_has_key = true is the one that no-opped.
SELECT 'RESOLVED ROWS' AS check,
       ch.label, ch.mode, ch.customer_id, ch.name_on_file, ch.status,
       ch.monthly_fee, ch.balance AS balance_now,
       CASE ch.mode
         WHEN 'target'   THEN ch.target_balance
         WHEN 'addbal'   THEN (ch.balance + ch.amount)
         WHEN 'owemonth' THEN ch.monthly_fee
       END AS computed_target,
       ch.candidates_for_name,
       EXISTS (
           SELECT 1 FROM public.account_ledger_entries l
           WHERE l.source_key = 'father-credit-fix-20261008:' || ch.customer_id::TEXT
       ) AS already_has_key,
       (SELECT l.amount FROM public.account_ledger_entries l
        WHERE l.source_key = 'father-credit-fix-20261008:' || ch.customer_id::TEXT
        LIMIT 1) AS existing_entry_amount
FROM chosen ch
ORDER BY already_has_key DESC, ch.label;

-- 2. Did two different labels land on the same account?
SELECT 'TWO LABELS, ONE ACCOUNT' AS check,
       customer_id, name_on_file,
       STRING_AGG(label, ' + ' ORDER BY label) AS labels,
       COUNT(*) AS times
FROM chosen
GROUP BY customer_id, name_on_file
HAVING COUNT(*) > 1;

-- 3. Everything already written under the 2026-10-08 batch key, so you can see
--    whether the zero script is committed and which accounts it covered.
SELECT 'ALREADY ON THE LEDGER FOR 2026-10-08' AS check,
       l.source_key, l.customer_id, c.name, l.amount, l.effective_date,
       LEFT(l.description, 60) AS description
FROM public.account_ledger_entries l
JOIN public.customers c USING (customer_id)
WHERE l.source_key LIKE 'father-credit-fix-20261008:%'
ORDER BY l.customer_id;

ROLLBACK;
