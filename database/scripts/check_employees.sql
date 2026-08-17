-- Diagnostic: does the account actually exist, and is it usable?

-- 1. Is the HO location present? If this returns 0 rows, the INSERT in
--    add_employees.sql joined against nothing and silently added nobody.
SELECT location_id, name, code
FROM public.locations;

-- 2. Do the three accounts exist, and what state are they in?
SELECT
    employee_id,
    username,
    first_name,
    last_name,
    role,
    location_id,
    is_active,
    LEFT(password_hash, 7) AS hash_prefix,   -- expect $2b$12$
    LENGTH(password_hash) AS hash_length,    -- expect 60
    created_at
FROM public.employees
WHERE LOWER(username) IN ('kdunn', 'sfrith', 'qbabootie')
ORDER BY username;

-- 3. Everyone in the table, for context.
SELECT employee_id, username, role, is_active
FROM public.employees
ORDER BY employee_id;
