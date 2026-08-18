-- Adds the two offices that 035 missed.
--
-- 035 seeded Blenheim (HO), Newport, Mandeville, Kingston, May Pen and
-- Hanover. Kellits and Black River are real offices with staff, and
-- createEmployees.ts refuses the whole staff list — not just the affected
-- person — if a locationCode has no matching row, so these have to exist
-- before the import runs.
--
-- Same reasoning as 035: `code` is the stable handle. location_id is a
-- SMALLSERIAL and depends on insertion order, so it differs between a
-- developer machine and the NAS; 'KEL' means Kellits on both.

INSERT INTO public.locations (name, code, is_head_office)
VALUES
    ('Kellits',     'KEL', FALSE),
    ('Black River', 'BLA', FALSE)
ON CONFLICT (code) DO NOTHING;
