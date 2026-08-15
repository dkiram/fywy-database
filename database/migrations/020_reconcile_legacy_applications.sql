-- Builds normalized comparisons, imports legacy applications, and suggests customer matches.
CREATE OR REPLACE VIEW staging.application_reconciliation AS
WITH staged_applications AS (
    -- Combine the current and copied Access tables while retaining source identity.
    SELECT
        'ApplicationTBL'::TEXT AS legacy_source,
        staging_id AS source_staging_id,
        application_id,
        name,
        address,
        telephone,
        id_number,
        application_date
    FROM staging.applications_current

    UNION ALL

    SELECT
        'Copy of ApplicationTBL'::TEXT AS legacy_source,
        staging_id AS source_staging_id,
        application_id,
        name,
        address,
        telephone,
        id_number,
        application_date
    FROM staging.applications_copy
),
normalized_applications AS (
    -- Normalize names, phones, and IDs only for comparison; raw values remain untouched.
    SELECT
        *,
        REGEXP_REPLACE(
            LOWER(TRIM(COALESCE(name, ''))),
            '[^a-z0-9]',
            '',
            'g'
        ) AS normalized_name,
        REGEXP_REPLACE(
            LOWER(TRIM(COALESCE(address, ''))),
            '[^a-z0-9]',
            '',
            'g'
        ) AS normalized_address,
        RIGHT(
            REGEXP_REPLACE(COALESCE(telephone, ''), '[^0-9]', '', 'g'),
            7
        ) AS normalized_phone,
        REGEXP_REPLACE(
            LOWER(TRIM(COALESCE(id_number, ''))),
            '[^a-z0-9]',
            '',
            'g'
        ) AS normalized_id_number
    FROM staged_applications
),
normalized_customers AS (
    -- Build the same comparison keys for canonical customers.
    SELECT
        customer_id,
        REGEXP_REPLACE(
            LOWER(TRIM(COALESCE(name, ''))),
            '[^a-z0-9]',
            '',
            'g'
        ) AS normalized_name,
        REGEXP_REPLACE(
            LOWER(TRIM(COALESCE(address, ''))),
            '[^a-z0-9]',
            '',
            'g'
        ) AS normalized_address,
        RIGHT(
            REGEXP_REPLACE(COALESCE(telephone, ''), '[^0-9]', '', 'g'),
            7
        ) AS normalized_phone,
        REGEXP_REPLACE(
            LOWER(TRIM(COALESCE(id_number, ''))),
            '[^a-z0-9]',
            '',
            'g'
        ) AS normalized_id_number
    FROM public.customers
),
candidate_signals AS (
    -- Emit each exact matching signal between an application and a customer.
    SELECT
        a.legacy_source,
        a.source_staging_id,
        c.customer_id,
        'id_number'::TEXT AS signal
    FROM normalized_applications a
    INNER JOIN normalized_customers c
        ON a.normalized_id_number = c.normalized_id_number
    WHERE LENGTH(a.normalized_id_number) >= 5
      AND a.normalized_id_number NOT IN (
          'na',
          'none',
          'unknown',
          'nil',
          'noid',
          'notavailable',
          'passport',
          'driverslicence',
          'driverslicense',
          'trn'
      )
      AND a.normalized_id_number !~ '^([a-z0-9])\1+$'

    UNION

    SELECT
        a.legacy_source,
        a.source_staging_id,
        c.customer_id,
        'name_phone'::TEXT AS signal
    FROM normalized_applications a
    INNER JOIN normalized_customers c
        ON a.normalized_name = c.normalized_name
       AND a.normalized_phone = c.normalized_phone
    WHERE a.normalized_name <> ''
      AND LENGTH(a.normalized_phone) = 7

    UNION

    SELECT
        a.legacy_source,
        a.source_staging_id,
        c.customer_id,
        'name_address'::TEXT AS signal
    FROM normalized_applications a
    INNER JOIN normalized_customers c
        ON a.normalized_name = c.normalized_name
       AND a.normalized_address = c.normalized_address
    WHERE a.normalized_name <> ''
      AND a.normalized_address <> ''
),
candidate_scores AS (
    -- Count corroborating signals so a single weak match cannot silently link a customer.
    SELECT
        legacy_source,
        source_staging_id,
        customer_id,
        COUNT(DISTINCT signal) AS signal_count
    FROM candidate_signals
    GROUP BY
        legacy_source,
        source_staging_id,
        customer_id
),
corroborated_summary AS (
    -- Summarize candidates that meet the trusted multi-signal threshold.
    SELECT
        legacy_source,
        source_staging_id,
        COUNT(*) FILTER (WHERE signal_count >= 2) AS corroborated_count,
        MIN(customer_id) FILTER (WHERE signal_count >= 2)
            AS corroborated_customer_id
    FROM candidate_scores
    GROUP BY legacy_source, source_staging_id
),
signal_summary AS (
    -- Track ambiguous single-signal candidates that still need human review.
    SELECT
        legacy_source,
        source_staging_id,
        COUNT(DISTINCT customer_id) AS total_candidate_count,
        COUNT(DISTINCT customer_id)
            FILTER (WHERE signal = 'id_number') AS id_candidate_count,
        COUNT(DISTINCT customer_id)
            FILTER (WHERE signal = 'name_phone') AS phone_candidate_count,
        COUNT(DISTINCT customer_id)
            FILTER (WHERE signal = 'name_address') AS address_candidate_count,
        MIN(customer_id)
            FILTER (WHERE signal = 'id_number') AS id_candidate_id,
        MIN(customer_id)
            FILTER (WHERE signal = 'name_phone') AS phone_candidate_id,
        MIN(customer_id)
            FILTER (WHERE signal = 'name_address') AS address_candidate_id
    FROM candidate_signals
    GROUP BY legacy_source, source_staging_id
),
classified AS (
    -- Assign the final match method, suggestion, and workflow status for each legacy row.
    SELECT
        a.legacy_source,
        a.source_staging_id,
        a.application_id,
        a.application_date,
        CASE
            WHEN COALESCE(cs.corroborated_count, 0) = 1
                THEN 'corroborated_match'
            WHEN COALESCE(cs.corroborated_count, 0) > 1
                OR COALESCE(ss.total_candidate_count, 0) > 1
                THEN 'ambiguous_or_conflicting'
            WHEN COALESCE(ss.id_candidate_count, 0) = 1
                THEN 'unique_id_number_only'
            WHEN COALESCE(ss.phone_candidate_count, 0) = 1
                THEN 'unique_name_phone_only'
            WHEN COALESCE(ss.address_candidate_count, 0) = 1
                THEN 'unique_name_address_only'
            ELSE 'no_match'
        END AS match_method,
        CASE
            WHEN COALESCE(cs.corroborated_count, 0) = 1
                THEN cs.corroborated_customer_id
            WHEN COALESCE(cs.corroborated_count, 0) = 0
                AND COALESCE(ss.total_candidate_count, 0) = 1
                THEN COALESCE(
                    ss.id_candidate_id,
                    ss.phone_candidate_id,
                    ss.address_candidate_id
                )
            ELSE NULL
        END AS suggested_customer_id
    FROM normalized_applications a
    LEFT JOIN corroborated_summary cs
        ON a.legacy_source = cs.legacy_source
       AND a.source_staging_id = cs.source_staging_id
    LEFT JOIN signal_summary ss
        ON a.legacy_source = ss.legacy_source
       AND a.source_staging_id = ss.source_staging_id
)
SELECT
    legacy_source,
    source_staging_id,
    application_id,
    match_method,
    suggested_customer_id,
    CASE
        WHEN legacy_source = 'Copy of ApplicationTBL'
            AND match_method = 'corroborated_match'
            THEN suggested_customer_id
        ELSE NULL
    END AS confirmed_customer_id,
    CASE
        WHEN legacy_source = 'Copy of ApplicationTBL'
            AND match_method = 'corroborated_match'
            THEN 'serviced'
        WHEN match_method <> 'no_match'
            AND TRIM(COALESCE(application_date, ''))
                ~ '^[0-9]{1,2}/[0-9]{1,2}/2026( |$)'
            THEN 'match_review'
        ELSE 'legacy_unresolved'
    END AS import_status
FROM classified;

WITH source_rows AS (
    -- Rebuild the full source record used by the canonical insert below.
    SELECT
        'ApplicationTBL'::TEXT AS legacy_source,
        staging_id AS source_staging_id,
        application_id,
        name,
        alias,
        address,
        occupation,
        telephone,
        email,
        id_type,
        id_number,
        package_id,
        monthly_fee,
        application_date,
        card_number,
        activation_date,
        adult_channel,
        additional_box,
        pole_box_number,
        port_number
    FROM staging.applications_current

    UNION ALL

    SELECT
        'Copy of ApplicationTBL'::TEXT AS legacy_source,
        staging_id AS source_staging_id,
        application_id,
        name,
        alias,
        address,
        occupation,
        telephone,
        email,
        id_type,
        id_number,
        package_id,
        monthly_fee,
        application_date,
        card_number,
        activation_date,
        adult_channel,
        additional_box,
        NULL::TEXT AS pole_box_number,
        NULL::TEXT AS port_number
    FROM staging.applications_copy
)
INSERT INTO public.applications (
    -- Preserve imported data and matching evidence; do not overwrite existing imports.
    name,
    alias,
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
    adult_channel,
    additional_box,
    pole_box_number,
    port_number,
    status,
    customer_id,
    suggested_customer_id,
    match_method,
    legacy_source,
    legacy_application_id,
    source_staging_id
)
SELECT
    COALESCE(NULLIF(TRIM(s.name), ''), 'Unknown legacy applicant'),
    NULLIF(TRIM(s.alias), ''),
    NULLIF(TRIM(s.address), ''),
    NULLIF(TRIM(s.occupation), ''),
    NULLIF(TRIM(s.telephone), ''),
    NULLIF(TRIM(s.email), ''),
    NULLIF(TRIM(s.id_type), ''),
    NULLIF(TRIM(s.id_number), ''),
    CASE
        WHEN TRIM(s.package_id) ~ '^[0-9]+$'
         AND EXISTS (
            SELECT 1
            FROM public.packages p
            WHERE p.package_id = TRIM(s.package_id)::SMALLINT
         )
            THEN TRIM(s.package_id)::SMALLINT
        ELSE NULL
    END,
    CASE
        WHEN TRIM(s.package_id) ~ '^[0-9]+$'
            THEN TRIM(s.package_id)::SMALLINT
        ELSE NULL
    END,
    CASE
        WHEN REPLACE(TRIM(s.monthly_fee), ',', '')
            ~ '^-?[0-9]+(\.[0-9]+)?$'
            THEN REPLACE(TRIM(s.monthly_fee), ',', '')::NUMERIC(14,2)
        ELSE NULL
    END,
    CASE
        WHEN TRIM(s.application_date)
            ~ '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{4} [0-9]{1,2}:[0-9]{2}$'
            THEN TO_TIMESTAMP(
                TRIM(s.application_date),
                'MM/DD/YYYY HH24:MI'
            )::DATE
        WHEN TRIM(s.application_date)
            ~ '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}$'
            THEN TO_DATE(TRIM(s.application_date), 'MM/DD/YYYY')
        ELSE NULL
    END,
    CASE
        WHEN TRIM(s.activation_date)
            ~ '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{4} [0-9]{1,2}:[0-9]{2}$'
            THEN TO_TIMESTAMP(
                TRIM(s.activation_date),
                'MM/DD/YYYY HH24:MI'
            )::DATE
        WHEN TRIM(s.activation_date)
            ~ '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}$'
            THEN TO_DATE(TRIM(s.activation_date), 'MM/DD/YYYY')
        ELSE NULL
    END,
    CASE
        WHEN LOWER(TRIM(COALESCE(s.adult_channel, '')))
            IN ('true', 'yes', '1', '-1')
            THEN TRUE
        ELSE FALSE
    END,
    CASE
        WHEN TRIM(s.additional_box) ~ '^-?[0-9]+$'
            THEN TRIM(s.additional_box)::SMALLINT
        ELSE NULL
    END,
    NULLIF(TRIM(s.pole_box_number), ''),
    NULLIF(TRIM(s.port_number), ''),
    r.import_status,
    r.confirmed_customer_id,
    r.suggested_customer_id,
    r.match_method,
    s.legacy_source,
    CASE
        WHEN TRIM(s.application_id) ~ '^[0-9]+$'
            THEN TRIM(s.application_id)::INTEGER
        ELSE NULL
    END,
    s.source_staging_id
FROM source_rows s
INNER JOIN staging.application_reconciliation r
    ON s.legacy_source = r.legacy_source
   AND s.source_staging_id = r.source_staging_id
WHERE TRIM(COALESCE(s.application_id, '')) ~ '^[0-9]+$'
ON CONFLICT (legacy_source, legacy_application_id) DO NOTHING;
