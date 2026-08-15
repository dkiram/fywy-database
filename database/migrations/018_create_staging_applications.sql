-- Stages both legacy application-table variants without coercing their raw values.
CREATE SCHEMA IF NOT EXISTS staging;

CREATE TABLE IF NOT EXISTS staging.applications_current (
    staging_id BIGSERIAL PRIMARY KEY,

    application_id TEXT,
    name TEXT,
    alias TEXT,
    address TEXT,
    occupation TEXT,
    telephone TEXT,
    email TEXT,
    id_type TEXT,
    id_number TEXT,
    package_id TEXT,
    monthly_fee TEXT,
    application_date TEXT,
    card_number TEXT,
    activation_date TEXT,
    adult_channel TEXT,
    additional_box TEXT,
    pole_box_number TEXT,
    port_number TEXT,

    imported_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS staging.applications_copy (
    staging_id BIGSERIAL PRIMARY KEY,

    application_id TEXT,
    name TEXT,
    alias TEXT,
    address TEXT,
    occupation TEXT,
    telephone TEXT,
    email TEXT,
    id_type TEXT,
    id_number TEXT,
    package_id TEXT,
    monthly_fee TEXT,
    application_date TEXT,
    card_number TEXT,
    activation_date TEXT,
    adult_channel TEXT,
    additional_box TEXT,

    imported_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
