CREATE TABLE IF NOT EXISTS staging.customers (
    staging_id BIGSERIAL PRIMARY KEY,

    customer_id TEXT,
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

    de_activate TEXT,
    de_activation_date TEXT,

    adult_channel TEXT,

    re_activation_date TEXT,

    additional_box TEXT,

    pole_box_number TEXT,
    port_number TEXT,

    imported_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);