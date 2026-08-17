-- Adds three head office employees with bcrypt-hashed passwords (cost 12),
-- matching the hashing policy used by seedDevEmployee and the change-password route.
--
-- Plaintext passwords (for handover, not stored):
--   kdunn     -> 12345678
--   sfrith    -> 87654321
--   qbabootie -> 01234567

INSERT INTO public.employees (
    first_name,
    last_name,
    username,
    password_hash,
    role,
    location_id
)
SELECT
    new_employee.first_name,
    new_employee.last_name,
    new_employee.username,
    new_employee.password_hash,
    new_employee.role,
    l.location_id
FROM (
    VALUES
        ('Kimone',   'Dunn',     'kdunn',     '$2b$12$vDS9ICPV7VphQqJ3InkH7eQA5AYb9B2Dz/BxKGU/zBLGXkgURH.JW', 'head_office'),
        ('Suwayne',  'Frith',    'sfrith',    '$2b$12$JgL8idkBzCROT7KAlcHn1eidv0D42hn328VsH43JEFn5EedOo0rse', 'head_office'),
        ('Quacian',  'Babootie', 'qbabootie', '$2b$12$Mxhi8nGTWqwdsKBbz7qInOLo0Fev8GXbkWY9DQqz01c4vaBI5KKaK', 'head_office')
) AS new_employee (first_name, last_name, username, password_hash, role)

JOIN public.locations l
  ON l.code = 'HO'

-- Rerunning is safe: the lower(username) unique index absorbs duplicates.
ON CONFLICT DO NOTHING;
