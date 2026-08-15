-- Creates the canonical payment ledger while preserving unrecognized legacy values.
CREATE TABLE IF NOT EXISTS public.payments (
    payment_id BIGSERIAL PRIMARY KEY,

    -- Original Access IDs
    legacy_payment_id INTEGER,
    legacy_customer_id TEXT,

    -- Link only when the customer still exists
    customer_id INTEGER
        REFERENCES public.customers(customer_id),

    -- Clean/recognized type
    payment_type TEXT,

    -- Exact legacy value, even if malformed
    legacy_payment_type TEXT,

    amount_paid NUMERIC(14,2),

    month_paid DATE,
    payment_date DATE,

    location TEXT,

    -- Historical cashier name from Access
    cashier_name TEXT,

    source_staging_id BIGINT UNIQUE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
