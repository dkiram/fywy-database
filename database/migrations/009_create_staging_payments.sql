-- Stages the expanded payment export, including joined legacy customer context.
CREATE TABLE IF NOT EXISTS staging.payments (
    staging_id BIGSERIAL PRIMARY KEY,

    payment_id TEXT,
    customer_id TEXT,

    payment_type TEXT,
    amount_paid TEXT,
    month_paid_for TEXT,
    payment_date TEXT,

    location TEXT,
    cashier_name TEXT,

    /* Joined legacy customer fields */
    customer_name TEXT,
    customer_id_customer_table TEXT,
    telephone TEXT,
    customer_id_customer_tbl1 TEXT,
    package TEXT,
    de_activate TEXT,
    adult_channel TEXT,
    monthly_charge TEXT,
    additional_box TEXT,
    monthly_fee_customer_tbl TEXT,

    imported_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);-
