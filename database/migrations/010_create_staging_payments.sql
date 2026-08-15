-- Defines the earlier minimal payment staging shape used by the base import process.
CREATE TABLE staging.payments (
    staging_id BIGSERIAL PRIMARY KEY,

    payment_id TEXT,
    customer_id TEXT,
    payment_type TEXT,
    amount_paid TEXT,
    month_paid TEXT,
    payment_date TEXT,
    location TEXT,
    cashier_name TEXT,

    imported_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
