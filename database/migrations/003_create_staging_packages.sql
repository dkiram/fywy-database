CREATE TABLE IF NOT EXISTS staging.packages (
    staging_id BIGSERIAL PRIMARY KEY,

    package_id TEXT,
    package_name TEXT,
    installation TEXT,
    monthly_charge TEXT,
    reconnection TEXT,

    imported_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);