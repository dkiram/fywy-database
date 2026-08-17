-- Replaces the two placeholder locations with the real offices.
--
-- Until now `locations` held only what migration 013 seeded: 'Head Office'
-- and 'Development Branch'. Staff could not be assigned anywhere real, and
-- the office a payment was taken at had nowhere to point.
--
-- `code` exists so that scripts and later migrations can find a location
-- without knowing its number. location_id is a SMALLSERIAL, so it depends on
-- the order rows were inserted and can differ between a developer machine
-- and the NAS; 'MAN' means Mandeville everywhere.
--
-- Note that location is not role. Role is what someone may do; location is
-- where they work. A head_office role at Mandeville is a normal combination.

-- The head office is Blenheim. 013 called it 'Head Office', which is a
-- description rather than a name - staff pick their office from a dropdown
-- and should see the place they drive to.
UPDATE public.locations
SET name = 'Blenheim'
WHERE code = 'HO';

INSERT INTO public.locations (name, code, is_head_office)
VALUES
    ('Newport',    'NEW', FALSE),
    ('Mandeville', 'MAN', FALSE),
    ('Kingston',   'KIN', FALSE),
    ('May Pen',    'MAY', FALSE),
    ('Hanover',    'HAN', FALSE)
ON CONFLICT (code) DO NOTHING;

-- The development branch is meaningless in production and only clutters the
-- dropdowns. Deactivated rather than deleted: anything already pointing at
-- it keeps its foreign key, and a developer database can switch it back on.
UPDATE public.locations
SET is_active = FALSE
WHERE code = 'DEV';
