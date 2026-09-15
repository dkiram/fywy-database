-- ============================================================================
-- Annett Miller (customer 14954): one of two October-tagged payments should
-- say September instead.
--
-- She has TWO identical payments - same amount, same month_paid, same
-- payment_date - both tagged October 2026:
--   441835  Monthly Fee  J$2,500  month_paid 2026-10-01  paid 2026-09-14
--   441840  Monthly Fee  J$2,500  month_paid 2026-10-01  paid 2026-09-14
-- This relabels 441835 to September 2026 (2026-09-01, the app's 1st-of-month
-- convention), leaving 441840 as October. Purely a label - month_paid is not
-- part of any balance calculation, so this does not touch her balance.
--
-- NOTE: her account separately carries a -5,000.00 credit (not requested to
-- be touched here - see zero-credits-2026-09-15.sql if that needs fixing too).
--
-- Plain SQL. TablePlus "Run All" or psql. Run on BOTH databases.
-- LAST LINE IS `ROLLBACK` - rehearsal. Read the printed rows, back up,
-- change ROLLBACK -> COMMIT, run again.
-- ============================================================================

BEGIN;

CREATE TEMP TABLE actor ON COMMIT DROP AS
SELECT e.employee_id, e.first_name || ' ' || e.last_name AS actor_name
FROM public.employees e WHERE e.employee_id = 2;

DO $g$
DECLARE n INTEGER;
BEGIN
    SELECT count(*) INTO n FROM actor;
    IF n <> 1 THEN RAISE EXCEPTION 'employee_id 2 matched % rows, expected 1. Nothing changed.', n; END IF;
END $g$;

-- Confirm both October payments exist exactly as expected before touching either.
DO $g$
DECLARE n INTEGER;
BEGIN
    SELECT count(*) INTO n FROM public.payments
    WHERE payment_id IN (441835, 441840)
      AND customer_id = 14954
      AND amount_paid = 2500.00
      AND month_paid = DATE '2026-10-01'
      AND COALESCE(payment_type, legacy_payment_type) = 'Monthly Fee'
      AND voided_at IS NULL;
    IF n <> 2 THEN
        RAISE EXCEPTION 'Expected both 441835 and 441840 to match (14954 / J$2,500 / Oct 2026 / not voided), found %. Nothing changed.', n;
    END IF;
END $g$;

SELECT 'BEFORE' AS check, payment_id, amount_paid, month_paid, payment_date
FROM public.payments WHERE payment_id IN (441835, 441840) ORDER BY payment_id;

UPDATE public.payments
SET month_paid = DATE '2026-09-01'
WHERE payment_id = 441835 AND customer_id = 14954;

INSERT INTO public.audit_logs (
    employee_id, actor_name, action, entity_type, entity_id,
    field_name, old_value, new_value, reason, occurred_at, source_key
)
SELECT (SELECT employee_id FROM actor), (SELECT actor_name FROM actor),
       'Corrected payment month', 'payment', '441835',
       'month_paid', '2026-10-01', '2026-09-01',
       'One of two identically-tagged October payments corrected to September at management request.',
       CURRENT_TIMESTAMP, 'fix-2026-09-15:annett-14954-month:441835'
ON CONFLICT (source_key) DO NOTHING;

SELECT 'AFTER' AS check, payment_id, amount_paid, month_paid, payment_date
FROM public.payments WHERE payment_id IN (441835, 441840) ORDER BY payment_id;

-- ----------------------------------------------------------------------------
-- ROLLBACK = rehearsal.  COMMIT = for real (back up first, run on BOTH DBs).
-- ----------------------------------------------------------------------------
ROLLBACK;
