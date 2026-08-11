ALTER TABLE staging.data_issues
ADD COLUMN IF NOT EXISTS resolution_status TEXT,
ADD COLUMN IF NOT EXISTS resolved_value TEXT,
ADD COLUMN IF NOT EXISTS resolution_note TEXT,
ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

UPDATE staging.data_issues
SET
    resolution_status = 'verified',
    resolved_value = '2020-07-31',
    resolution_note = 'Verified directly in legacy Microsoft Access database. Legacy year appears malformed, causing Excel export to display hashes.',
    resolved_at = CURRENT_TIMESTAMP
WHERE source_table = 'customers'
  AND source_record_id = '1500'
  AND field_name IN ('activation_date', 're_activation_date');