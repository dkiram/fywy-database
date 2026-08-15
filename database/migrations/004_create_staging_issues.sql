-- Records known validation problems discovered while profiling staged legacy data.
CREATE TABLE IF NOT EXISTS staging.data_issues (
    issue_id BIGSERIAL PRIMARY KEY,

    source_table TEXT NOT NULL,
    source_record_id TEXT,
    field_name TEXT NOT NULL,

    raw_value TEXT,
    issue_type TEXT NOT NULL,

    detected_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO staging.data_issues (
    source_table,
    source_record_id,
    field_name,
    raw_value,
    issue_type
)
SELECT
    'customers',
    customer_id,
    'activation_date',
    activation_date,
    'invalid_date_format'
FROM staging.customers
WHERE activation_date IS NOT NULL
  AND TRIM(activation_date) <> ''
  AND TRIM(activation_date)
      !~ '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}$';

INSERT INTO staging.data_issues (
    source_table,
    source_record_id,
    field_name,
    raw_value,
    issue_type
)
SELECT
    'customers',
    customer_id,
    're_activation_date',
    re_activation_date,
    'invalid_date_format'
FROM staging.customers
WHERE re_activation_date IS NOT NULL
  AND TRIM(re_activation_date) <> ''
  AND TRIM(re_activation_date)
      !~ '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}$';
