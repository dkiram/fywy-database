-- ============================================================================
-- Make sure Kingston is in the Office list.
--
-- Plain SQL — paste into a TablePlus tab (Run All) or pipe through psql.
-- Safe to run more than once, and on both databases.
--
-- Migration 035 already seeds Kingston with code 'KIN', so if it is missing
-- from the dropdown it is one of:
--   * the row is there but switched off (is_active = FALSE) -> switched on
--   * the row exists under another code (typed in by hand)  -> switched on,
--                                                               code left alone
--   * the row was never created                              -> inserted
--
-- The Office dropdown reads /api/locations, which only lists active rows, so
-- reloading the Admin Controls page is enough to see it afterwards.
-- ============================================================================

BEGIN;

DO $kingston$
BEGIN
    IF EXISTS (SELECT 1 FROM public.locations WHERE code = 'KIN') THEN
        UPDATE public.locations
        SET name = 'Kingston', is_active = TRUE
        WHERE code = 'KIN';
        RAISE NOTICE 'Kingston (KIN) already existed - made sure it is active';

    ELSIF EXISTS (SELECT 1 FROM public.locations WHERE LOWER(TRIM(name)) = 'kingston') THEN
        UPDATE public.locations
        SET is_active = TRUE
        WHERE LOWER(TRIM(name)) = 'kingston';
        RAISE NOTICE 'Kingston existed under another code - made sure it is active';

    ELSE
        INSERT INTO public.locations (name, code, is_head_office)
        VALUES ('Kingston', 'KIN', FALSE);
        RAISE NOTICE 'Kingston added';
    END IF;
END
$kingston$;

-- What the dropdown will show, in the same order.
SELECT location_id, name, code, is_head_office, is_active
FROM public.locations
ORDER BY is_active DESC, is_head_office DESC, name;

COMMIT;
