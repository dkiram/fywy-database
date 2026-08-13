INSERT INTO public.payments (
    legacy_payment_id,
    legacy_customer_id,
    customer_id,

    payment_type,
    legacy_payment_type,

    amount_paid,

    month_paid,
    payment_date,

    location,
    cashier_name,

    source_staging_id
)
SELECT
    CASE
        WHEN TRIM(payment_id) ~ '^[0-9]+$'
        THEN payment_id::INTEGER
        ELSE NULL
    END,

    NULLIF(TRIM(p.customer_id), ''),

    CASE
        WHEN c.customer_id IS NOT NULL
        THEN c.customer_id
        ELSE NULL
    END,

    CASE
        WHEN TRIM(p.payment_type) IN (
            'Monthly Fee',
            'Reconnection Fee',
            'Installation Fee',
            'Hurricane Discount'
        )
        THEN TRIM(p.payment_type)
        ELSE NULL
    END,

    NULLIF(TRIM(p.payment_type), ''),

    CASE
        WHEN TRIM(p.amount_paid)
            ~ '^-?[0-9]+(\.[0-9]+)?$'
        THEN p.amount_paid::NUMERIC(14,2)
        ELSE NULL
    END,

    CASE
        WHEN TRIM(p.month_paid)
            ~ '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}$'
        THEN TO_DATE(TRIM(p.month_paid), 'MM/DD/YYYY')
        ELSE NULL
    END,

    CASE
        WHEN TRIM(p.payment_date)
            ~ '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}$'
        THEN TO_DATE(TRIM(p.payment_date), 'MM/DD/YYYY')
        ELSE NULL
    END,

    NULLIF(TRIM(p.location), ''),

    NULLIF(TRIM(p.cashier_name), ''),

    p.staging_id

FROM staging.payments p

LEFT JOIN public.customers c
    ON p.customer_id = c.customer_id::TEXT;