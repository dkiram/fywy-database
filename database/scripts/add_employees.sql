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
        ('Lisa',   'Dunn',     'ldunn',     '$2b$12$17zeW1y8IjSXoeEGmpKFDOZycgnWhM2MUNL7i/AjCxrrrwwcUK2ta', 'head_office'),

) AS new_employee (first_name, last_name, username, password_hash, role)

JOIN public.locations l
  ON l.code = 'HO'

-- Rerunning is safe: the lower(username) unique index absorbs duplicates.
ON CONFLICT DO NOTHING;
