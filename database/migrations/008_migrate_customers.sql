-- Cleans staged customer strings and inserts them into the canonical customer table.
INSERT INTO public.customers (
    customer_id,
    name,
    address,
    occupation,
    telephone,
    email,
    id_type,
    id_number,

    package_id,
    legacy_package_id,
    monthly_fee,

    application_date,
    activation_date,
    deactivation_date,
    reactivation_date,

    status,
    adult_channel,

    pole_box_number,
    port_number,

    legacy_alias_notes,
    legacy_card_number,
    legacy_additional_box_notes,

    source_staging_id
)
SELECT
    customer_id::INTEGER,

    NULLIF(TRIM(name), ''),
    NULLIF(TRIM(address), ''),
    NULLIF(TRIM(occupation), ''),
    NULLIF(TRIM(telephone), ''),
    NULLIF(TRIM(email), ''),

    NULLIF(TRIM(id_type), ''),
    NULLIF(TRIM(id_number), ''),

    CASE
        WHEN package_id IN ('1', '2', '3')
        THEN package_id::SMALLINT
        ELSE NULL
    END,

    NULLIF(TRIM(package_id), '')::SMALLINT,

    NULLIF(TRIM(monthly_fee), '')::NUMERIC(14,2),

    CASE
        WHEN application_date ~ '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}$'
        THEN TO_DATE(application_date, 'MM/DD/YYYY')
        ELSE NULL
    END,

    /*
      Customer 1500 was manually verified in Access.
    */
    CASE
        WHEN customer_id = '1500'
            THEN DATE '2020-07-31'

        WHEN activation_date ~ '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}$'
            THEN TO_DATE(activation_date, 'MM/DD/YYYY')

        ELSE NULL
    END,

    CASE
        WHEN de_activation_date ~ '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}$'
        THEN TO_DATE(de_activation_date, 'MM/DD/YYYY')
        ELSE NULL
    END,

    CASE
        WHEN customer_id = '1500'
            THEN DATE '2020-07-31'

        WHEN re_activation_date ~ '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}$'
            THEN TO_DATE(re_activation_date, 'MM/DD/YYYY')

        ELSE NULL
    END,

    CASE
        WHEN de_activate::BOOLEAN = TRUE
            THEN 'disconnected'
        ELSE 'active'
    END,

    adult_channel::BOOLEAN,

    NULLIF(TRIM(pole_box_number), ''),
    NULLIF(TRIM(port_number), ''),

    NULLIF(TRIM(alias), ''),
    NULLIF(TRIM(card_number), ''),
    NULLIF(TRIM(additional_box), ''),

    staging_id

FROM staging.customers

ON CONFLICT (customer_id) DO NOTHING;
