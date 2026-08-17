-- A read-only role, for browsing production from a GUI client (TablePlus,
-- DBeaver) over an SSH tunnel.
--
-- The point is that browsing live customer data should not be able to change
-- it. Grid views in these clients make editing a cell feel like editing a
-- spreadsheet, and there is no undo on the other side. This role can SELECT
-- and nothing else, so a mistyped edit fails with a permissions error instead
-- of quietly rewriting a row.
--
-- The role is created WITHOUT LOGIN and without a password on purpose: a
-- password written into a migration file is a password committed to git.
-- Grant it a login once, by hand, on the NAS:
--
--   docker exec -it spcl-postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
--     -c "ALTER ROLE spcl_readonly WITH LOGIN PASSWORD 'pick-something-long';"
--
-- To revoke access later, without touching any grants:
--
--   ALTER ROLE spcl_readonly WITH NOLOGIN;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'spcl_readonly') THEN
        CREATE ROLE spcl_readonly NOLOGIN;
    END IF;
END
$$;

-- The database name comes from .env.production and is not knowable here, so
-- ask the server what it is rather than hard-coding a guess.
DO $$
BEGIN
    EXECUTE format(
        'GRANT CONNECT ON DATABASE %I TO spcl_readonly',
        current_database()
    );
END
$$;

-- Existing tables.
GRANT USAGE  ON SCHEMA public  TO spcl_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO spcl_readonly;

GRANT USAGE  ON SCHEMA staging TO spcl_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA staging TO spcl_readonly;

-- And tables that do not exist yet. Without this, every future migration
-- would silently create a table this role cannot see, and the omission only
-- shows up months later as "why is that table missing in TablePlus".
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT ON TABLES TO spcl_readonly;

ALTER DEFAULT PRIVILEGES IN SCHEMA staging
    GRANT SELECT ON TABLES TO spcl_readonly;
