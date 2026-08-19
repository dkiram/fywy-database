-- 038_cutover_reimport_from_access.sql
--
-- The Access cutover. Empties every table that holds imported or generated
-- business data, reloads it from a fresh Access export, and then re-runs every
-- derivation step that migrations 020, 021, 024, 025 and 026 performed when
-- they first ran.
--
-- Why the re-runs are here: migrate.sh records a migration as applied and never
-- runs it again. Those five files did not only create tables, they also
-- generated the account status timeline, the pole box inventory, the rate
-- history and the entire billing ledger from the customer and payment data. A
-- truncate leaves all of that empty permanently unless it is rebuilt here.
--
-- WHAT THIS DOES NOT TOUCH: employees, locations, packages, user_sessions,
-- schema_migrations. No employee row is created, altered or deleted, and no
-- column on the employees table changes.
--
-- The whole file runs inside one transaction (migrate.sh applies it with
-- psql -1 --set ON_ERROR_STOP=1). Any error rolls back everything, leaving the
-- database exactly as it was.
--
-- Input files, expected at /opt/spcl-database/imports/ inside the container:
--   staging_customers.csv.gz              11,228 rows
--   staging_payments.csv.gz              432,214 rows
--   staging_applications_current.csv          61 rows
--   staging_applications_copy.csv            122 rows
--   legacy_pole_boxes.csv                    339 rows
--   legacy_service_tickets.csv                 3 rows


-- ---------------------------------------------------------------------------
-- 1. Refuse to run if the tables we are protecting are not there
-- ---------------------------------------------------------------------------
--
-- If employees or locations are empty, something is already wrong and a
-- truncate would make it much harder to diagnose. Stop before touching data.

DO $$
DECLARE
    employee_count INTEGER;
    location_count INTEGER;
    package_count  INTEGER;
BEGIN
    SELECT count(*) INTO employee_count FROM public.employees;
    SELECT count(*) INTO location_count FROM public.locations;
    SELECT count(*) INTO package_count  FROM public.packages;

    IF employee_count = 0 THEN
        RAISE EXCEPTION
            'employees table is empty - refusing to run the cutover';
    END IF;

    IF location_count = 0 THEN
        RAISE EXCEPTION
            'locations table is empty - refusing to run the cutover';
    END IF;

    IF package_count = 0 THEN
        RAISE EXCEPTION
            'packages table is empty - customers would import with no package';
    END IF;

    RAISE NOTICE 'preserving % employees, % locations, % packages',
        employee_count, location_count, package_count;
END $$;


-- ---------------------------------------------------------------------------
-- 2. Record what is being replaced, so the result can be compared afterwards
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.cutover_snapshot (
    taken_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    phase       TEXT        NOT NULL,
    table_name  TEXT        NOT NULL,
    row_count   BIGINT      NOT NULL,
    total_value NUMERIC(18,2)
);

INSERT INTO public.cutover_snapshot (phase, table_name, row_count, total_value)
SELECT 'before', 'customers', count(*), NULL FROM public.customers
UNION ALL
SELECT 'before', 'payments', count(*), COALESCE(SUM(amount_paid), 0)
    FROM public.payments
UNION ALL
SELECT 'before', 'applications', count(*), NULL FROM public.applications
UNION ALL
SELECT 'before', 'account_ledger_entries', count(*), COALESCE(SUM(amount), 0)
    FROM public.account_ledger_entries;


-- ---------------------------------------------------------------------------
-- 3. Empty the imported and generated data
-- ---------------------------------------------------------------------------
--
-- All in one statement because Postgres refuses to truncate a table that is
-- still referenced by a table it is not truncating. Note billing_generation_state
-- is included deliberately: it is the watermark saying "charges generated
-- through date X". Leaving it behind means the generator in section 9 returns
-- immediately and every customer ends up looking like they owe nothing.

TRUNCATE TABLE
    public.reconnection_requests,
    public.waiver_requests,
    public.disconnection_holds,
    public.account_ledger_entries,
    public.customer_rate_history,
    public.account_status_history,
    public.audit_logs,
    public.login_sessions,
    public.billing_generation_state,
    public.service_ticket_history,
    public.service_tickets,
    public.applications,
    public.payments,
    public.pole_boxes,
    public.customers,
    staging.data_issues,
    staging.applications_copy,
    staging.applications_current,
    staging.payments,
    staging.packages,
    staging.customers
RESTART IDENTITY;


-- ---------------------------------------------------------------------------
-- 4. Reshape the staging and payment tables for this export
-- ---------------------------------------------------------------------------
--
-- The new Access file replaced the free-text "Location" and "Cashier Name"
-- columns on Payment TBL with a CashierID pointing at a proper cashier table.
-- The export resolves that ID back into a name and a location, so the existing
-- staging shape still fits. Two additions are needed:
--
--   legacy_payment_date_raw - 14,738 payments carry an impossible year
--     (08/18/00 and similar). Where the surrounding PaymentIDs agree on the
--     real year the export repairs the date; where they do not, the date is
--     left empty. Either way the original Access text is kept here so the
--     repair is auditable and reversible.

DROP TABLE IF EXISTS staging.payments;

CREATE TABLE staging.payments (
    staging_id              BIGSERIAL PRIMARY KEY,

    payment_id              TEXT,
    customer_id             TEXT,
    payment_type            TEXT,
    amount_paid             TEXT,
    month_paid              TEXT,
    payment_date            TEXT,
    location                TEXT,
    cashier_name            TEXT,
    legacy_payment_date_raw TEXT,

    imported_at             TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

GRANT SELECT ON staging.payments TO spcl_readonly;

ALTER TABLE public.payments
    ADD COLUMN IF NOT EXISTS legacy_payment_date_raw TEXT;

COMMENT ON COLUMN public.payments.legacy_payment_date_raw IS
    'The payment date exactly as Access held it. Set for every imported row. '
    'Where payment_date is NULL this is the only record of when the payment '
    'was taken, and the year could not be determined.';


-- ---------------------------------------------------------------------------
-- 5. Load the export
-- ---------------------------------------------------------------------------

\copy staging.customers (customer_id, name, alias, address, occupation, telephone, email, id_type, id_number, package_id, monthly_fee, application_date, card_number, activation_date, de_activate, de_activation_date, adult_channel, re_activation_date, additional_box, pole_box_number, port_number) FROM PROGRAM 'gzip -dc /opt/spcl-database/imports/staging_customers.csv.gz' WITH (FORMAT csv, HEADER true)

\copy staging.payments (payment_id, customer_id, payment_type, amount_paid, month_paid, payment_date, location, cashier_name, legacy_payment_date_raw) FROM PROGRAM 'gzip -dc /opt/spcl-database/imports/staging_payments.csv.gz' WITH (FORMAT csv, HEADER true)

\copy staging.applications_current (application_id, name, alias, address, occupation, telephone, email, id_type, id_number, package_id, monthly_fee, application_date, card_number, activation_date, adult_channel, additional_box, pole_box_number, port_number) FROM '/opt/spcl-database/imports/staging_applications_current.csv' WITH (FORMAT csv, HEADER true)

\copy staging.applications_copy (application_id, name, alias, address, occupation, telephone, email, id_type, id_number, package_id, monthly_fee, application_date, card_number, activation_date, adult_channel, additional_box) FROM '/opt/spcl-database/imports/staging_applications_copy.csv' WITH (FORMAT csv, HEADER true)

CREATE TEMP TABLE legacy_pole_box_import (
    legacy_box_id TEXT,
    box_number    TEXT,
    capacity_raw  TEXT
) ON COMMIT DROP;

\copy legacy_pole_box_import (legacy_box_id, box_number, capacity_raw) FROM '/opt/spcl-database/imports/legacy_pole_boxes.csv' WITH (FORMAT csv, HEADER true)

CREATE TEMP TABLE legacy_service_import (
    legacy_service_id TEXT,
    customer_id       TEXT,
    issue_summary     TEXT,
    reported_date     TEXT,
    resolution_notes  TEXT,
    resolved_date     TEXT
) ON COMMIT DROP;

\copy legacy_service_import (legacy_service_id, customer_id, issue_summary, reported_date, resolution_notes, resolved_date) FROM '/opt/spcl-database/imports/legacy_service_tickets.csv' WITH (FORMAT csv, HEADER true)


DO $$
DECLARE
    c BIGINT; p BIGINT; a1 BIGINT; a2 BIGINT;
BEGIN
    SELECT count(*) INTO c  FROM staging.customers;
    SELECT count(*) INTO p  FROM staging.payments;
    SELECT count(*) INTO a1 FROM staging.applications_current;
    SELECT count(*) INTO a2 FROM staging.applications_copy;

    RAISE NOTICE 'staged: % customers, % payments, % + % applications', c, p, a1, a2;

    IF c <> 11228 THEN
        RAISE EXCEPTION
            'expected 11228 staged customers, got % - wrong or truncated file', c;
    END IF;

    IF p <> 432214 THEN
        RAISE EXCEPTION
            'expected 432214 staged payments, got % - wrong or truncated file', p;
    END IF;
END $$;


-- ---------------------------------------------------------------------------
-- 6. Customers  (the logic of migration 008)
-- ---------------------------------------------------------------------------
--
-- Unchanged from 008 except that the special case for customer 1500 is gone.
-- That was a hand-verified fix for one record in the previous export; this
-- export carries its own dates and does not need it.

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

    CASE
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
        WHEN re_activation_date ~ '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}$'
        THEN TO_DATE(re_activation_date, 'MM/DD/YYYY')
        ELSE NULL
    END,

    CASE
        WHEN de_activate = '1' THEN 'disconnected'
        ELSE 'active'
    END,

    COALESCE(NULLIF(adult_channel, '')::BOOLEAN, FALSE),

    NULLIF(TRIM(pole_box_number), ''),
    NULLIF(TRIM(port_number), ''),

    NULLIF(TRIM(alias), ''),
    NULLIF(TRIM(card_number), ''),
    NULLIF(TRIM(additional_box), ''),

    staging_id

FROM staging.customers
WHERE TRIM(COALESCE(customer_id, '')) ~ '^[0-9]+$'
ON CONFLICT (customer_id) DO NOTHING;


-- The standalone sequence from migration 021. It is not owned by the customers
-- table, so RESTART IDENTITY above did not touch it. Left alone it would hand
-- out customer numbers that collide with the ones just imported.

SELECT SETVAL(
    'public.customer_id_seq',
    GREATEST((SELECT COALESCE(MAX(customer_id), 1) FROM public.customers), 1),
    TRUE
);


-- ---------------------------------------------------------------------------
-- 7. Payments  (the logic of migration 012)
-- ---------------------------------------------------------------------------
--
-- Payments whose customer no longer exists in Access are kept. There are
-- 10,816 of them across 1,079 customer numbers deleted long before this
-- cutover. They import with customer_id NULL and the original number preserved
-- in legacy_customer_id, so the money still reconciles.

INSERT INTO public.payments (
    legacy_payment_id,
    legacy_customer_id,
    customer_id,

    payment_type,
    legacy_payment_type,

    amount_paid,

    month_paid,
    payment_date,
    legacy_payment_date_raw,

    location,
    cashier_name,

    source_staging_id
)
SELECT
    CASE
        WHEN TRIM(p.payment_id) ~ '^[0-9]+$'
        THEN p.payment_id::INTEGER
        ELSE NULL
    END,

    NULLIF(TRIM(p.customer_id), ''),

    c.customer_id,

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
        WHEN TRIM(p.amount_paid) ~ '^-?[0-9]+(\.[0-9]+)?$'
        THEN p.amount_paid::NUMERIC(14,2)
        ELSE NULL
    END,

    CASE
        WHEN TRIM(p.month_paid) ~ '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}$'
        THEN TO_DATE(TRIM(p.month_paid), 'MM/DD/YYYY')
        ELSE NULL
    END,

    CASE
        WHEN TRIM(p.payment_date) ~ '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}$'
        THEN TO_DATE(TRIM(p.payment_date), 'MM/DD/YYYY')
        ELSE NULL
    END,

    NULLIF(TRIM(p.legacy_payment_date_raw), ''),

    NULLIF(TRIM(p.location), ''),
    NULLIF(TRIM(p.cashier_name), ''),

    p.staging_id

FROM staging.payments p

LEFT JOIN public.customers c
    ON p.customer_id = c.customer_id::TEXT;


-- Every payment must have arrived, and the money must add up to the cent
-- against the Access file. If either check fails the whole cutover rolls back.

DO $$
DECLARE
    imported BIGINT;
    total    NUMERIC(18,2);
    undated  BIGINT;
    orphaned BIGINT;
BEGIN
    SELECT count(*), COALESCE(SUM(amount_paid), 0)
      INTO imported, total
      FROM public.payments;

    SELECT count(*) INTO undated
      FROM public.payments WHERE payment_date IS NULL;

    SELECT count(*) INTO orphaned
      FROM public.payments WHERE customer_id IS NULL;

    RAISE NOTICE 'payments: % imported, total %, % undated, % unlinked',
        imported, total, undated, orphaned;

    IF imported <> 432214 THEN
        RAISE EXCEPTION 'expected 432214 payments, got %', imported;
    END IF;

    -- Access holds amounts to four decimal places and 16 payments carry a
    -- fraction of a cent (0.0015, 0.0025 and similar - junk rows worth
    -- four cents in total across the whole file). Storing money as
    -- NUMERIC(14,2) rounds those away, so the imported total lands a few
    -- cents below the raw Access figure of 1,176,615,168.0405. A dollar of
    -- tolerance catches a genuinely lost or duplicated payment while
    -- ignoring rounding that cannot be avoided.
    IF ABS(total - 1176615168.04) > 1.00 THEN
        RAISE EXCEPTION
            'payment total is % but Access says 1176615168.04 - that gap is '
            'too large to be rounding, something did not import', total;
    END IF;
END $$;


-- ---------------------------------------------------------------------------
-- 8. Applications  (migration 020, then 021's card-number backfill)
-- ---------------------------------------------------------------------------

WITH source_rows AS (
    SELECT
        'ApplicationTBL'::TEXT AS legacy_source,
        staging_id AS source_staging_id,
        application_id, name, alias, address, occupation, telephone, email,
        id_type, id_number, package_id, monthly_fee, application_date,
        card_number, activation_date, adult_channel, additional_box,
        pole_box_number, port_number
    FROM staging.applications_current

    UNION ALL

    SELECT
        'Copy of ApplicationTBL'::TEXT AS legacy_source,
        staging_id AS source_staging_id,
        application_id, name, alias, address, occupation, telephone, email,
        id_type, id_number, package_id, monthly_fee, application_date,
        card_number, activation_date, adult_channel, additional_box,
        NULL::TEXT AS pole_box_number,
        NULL::TEXT AS port_number
    FROM staging.applications_copy
)
INSERT INTO public.applications (
    name, alias, address, occupation, telephone, email, id_type, id_number,
    package_id, legacy_package_id, monthly_fee, application_date,
    activation_date, adult_channel, additional_box, pole_box_number,
    port_number, status, customer_id, suggested_customer_id, match_method,
    legacy_source, legacy_application_id, source_staging_id
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
            SELECT 1 FROM public.packages p
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
        WHEN REPLACE(TRIM(s.monthly_fee), ',', '') ~ '^-?[0-9]+(\.[0-9]+)?$'
            THEN REPLACE(TRIM(s.monthly_fee), ',', '')::NUMERIC(14,2)
        ELSE NULL
    END,
    CASE
        WHEN TRIM(s.application_date) ~ '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}$'
            THEN TO_DATE(TRIM(s.application_date), 'MM/DD/YYYY')
        ELSE NULL
    END,
    CASE
        WHEN TRIM(s.activation_date) ~ '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}$'
            THEN TO_DATE(TRIM(s.activation_date), 'MM/DD/YYYY')
        ELSE NULL
    END,
    CASE
        WHEN LOWER(TRIM(COALESCE(s.adult_channel, ''))) IN ('true', 'yes', '1', '-1')
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


UPDATE public.applications a
SET legacy_card_number = NULLIF(TRIM(s.card_number), '')
FROM (
    SELECT 'ApplicationTBL'::TEXT AS legacy_source, staging_id, card_number
      FROM staging.applications_current
    UNION ALL
    SELECT 'Copy of ApplicationTBL'::TEXT, staging_id, card_number
      FROM staging.applications_copy
) s
WHERE a.legacy_source = s.legacy_source
  AND a.source_staging_id = s.staging_id
  AND a.legacy_card_number IS NULL;


-- ---------------------------------------------------------------------------
-- 9. Rebuild everything that is derived from customers and payments
-- ---------------------------------------------------------------------------
--
-- Order matters and is not negotiable:
--   status history and pole boxes are independent
--   rate history must precede opening balances and the charge generator
--   the charge generator must precede nothing, but needs a NULL watermark
--
-- 9a. Account status timeline (migration 024)

INSERT INTO public.account_status_history (
    customer_id, from_status, to_status, reason, effective_date,
    changed_by_employee_id, application_id, changed_at, source_key
)
SELECT
    c.customer_id,
    NULL,
    c.status,
    'Imported legacy current account status',
    COALESCE(
        CASE
            WHEN c.status = 'disconnected' THEN c.deactivation_date
            WHEN c.status = 'active' THEN c.reactivation_date
            ELSE NULL
        END,
        c.activation_date,
        c.application_date,
        c.created_at::DATE
    ),
    NULL,
    NULL,
    c.created_at,
    'legacy-current-status:' || c.customer_id::TEXT
FROM public.customers c
ON CONFLICT (source_key) DO NOTHING;


-- 9b. Pole box inventory (migration 025), then the real box list from Access

INSERT INTO public.pole_boxes (box_number, notes)
SELECT DISTINCT ON (UPPER(TRIM(c.pole_box_number)))
    TRIM(c.pole_box_number),
    'Imported from existing customer pole-box assignments'
FROM public.customers c
WHERE NULLIF(TRIM(c.pole_box_number), '') IS NOT NULL
ORDER BY UPPER(TRIM(c.pole_box_number)), c.customer_id
ON CONFLICT (normalized_box_number) DO NOTHING;

-- Access has an actual PoleBoxTBL with capacities. Boxes already created as
-- shells above get their legacy identity and capacity filled in; boxes nobody
-- is assigned to yet are added.

UPDATE public.pole_boxes b
SET legacy_box_id     = NULLIF(TRIM(i.legacy_box_id), '')::INTEGER,
    legacy_box_number = NULLIF(TRIM(i.box_number), ''),
    legacy_capacity_raw = CASE
        WHEN TRIM(COALESCE(i.capacity_raw, '')) ~ '^[0-9]+$'
        THEN TRIM(i.capacity_raw)::INTEGER
        ELSE NULL
    END,
    notes = 'Imported from the Access pole box register'
FROM legacy_pole_box_import i
WHERE b.normalized_box_number = UPPER(TRIM(i.box_number))
  AND TRIM(COALESCE(i.legacy_box_id, '')) ~ '^[0-9]+$';

INSERT INTO public.pole_boxes (
    box_number, notes, legacy_box_id, legacy_box_number, legacy_capacity_raw
)
SELECT DISTINCT ON (UPPER(TRIM(i.box_number)))
    TRIM(i.box_number),
    'Imported from the Access pole box register',
    NULLIF(TRIM(i.legacy_box_id), '')::INTEGER,
    NULLIF(TRIM(i.box_number), ''),
    CASE
        WHEN TRIM(COALESCE(i.capacity_raw, '')) ~ '^[0-9]+$'
        THEN TRIM(i.capacity_raw)::INTEGER
        ELSE NULL
    END
FROM legacy_pole_box_import i
WHERE NULLIF(TRIM(i.box_number), '') IS NOT NULL
  AND TRIM(COALESCE(i.legacy_box_id, '')) ~ '^[0-9]+$'
ORDER BY UPPER(TRIM(i.box_number)), NULLIF(TRIM(i.legacy_box_id), '')::INTEGER
ON CONFLICT (normalized_box_number) DO NOTHING;


-- 9c. Legacy service records, brought in as closed tickets.
--
-- Access has a flat service log, not a ticket model. These come in already
-- resolved rather than landing in anyone's work queue.

-- Only one of the three Access rows has any detail. The other two have no
-- description, no notes, and a "service date" in 2017 against a report date in
-- 2026. Those come in cancelled rather than completed: marking an empty record
-- completed would put a resolved ticket in the history with nothing in it, and
-- the table's own CHECK constraint refuses a completed ticket with no notes.

INSERT INTO public.service_tickets (
    customer_id, legacy_customer_id, issue_summary, status, priority,
    reported_date, service_date, completed_at, resolution_notes,
    legacy_service_id, legacy_source, source_key
)
SELECT
    c.customer_id,
    CASE
        WHEN TRIM(COALESCE(i.customer_id, '')) ~ '^[0-9]+$'
        THEN TRIM(i.customer_id)::INTEGER
        ELSE NULL
    END,
    COALESCE(
        NULLIF(TRIM(i.issue_summary), ''),
        'Legacy service record imported from Access with no description'
    ),
    CASE
        WHEN LENGTH(TRIM(COALESCE(i.resolution_notes, ''))) >= 3
         AND TRIM(i.resolved_date) ~ '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}$'
        THEN 'completed'
        ELSE 'cancelled'
    END,
    'normal',
    CASE
        WHEN TRIM(i.reported_date) ~ '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}$'
        THEN TO_DATE(TRIM(i.reported_date), 'MM/DD/YYYY')
        ELSE (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE
    END,
    CASE
        WHEN LENGTH(TRIM(COALESCE(i.resolution_notes, ''))) >= 3
         AND TRIM(i.resolved_date) ~ '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}$'
        THEN TO_DATE(TRIM(i.resolved_date), 'MM/DD/YYYY')
        ELSE NULL
    END,
    CASE
        WHEN LENGTH(TRIM(COALESCE(i.resolution_notes, ''))) >= 3
         AND TRIM(i.resolved_date) ~ '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}$'
        THEN TO_DATE(TRIM(i.resolved_date), 'MM/DD/YYYY')::TIMESTAMPTZ
        ELSE NULL
    END,
    COALESCE(
        NULLIF(TRIM(i.resolution_notes), ''),
        'No service details were recorded in Access'
    ),
    NULLIF(TRIM(i.legacy_service_id), ''),
    'Service TBL',
    'legacy-service:' || TRIM(i.legacy_service_id)
FROM legacy_service_import i
LEFT JOIN public.customers c
    ON TRIM(COALESCE(i.customer_id, '')) ~ '^[0-9]+$'
   AND c.customer_id = TRIM(i.customer_id)::INTEGER
WHERE NULLIF(TRIM(i.legacy_service_id), '') IS NOT NULL
ON CONFLICT (source_key) DO NOTHING;


-- 9d. Rate history (migration 026). Everything below depends on this.

INSERT INTO public.customer_rate_history (
    customer_id, monthly_fee, effective_date, reason,
    is_legacy_estimate, source_key
)
SELECT
    c.customer_id,
    CASE
        WHEN c.monthly_fee BETWEEN 0 AND 30000 THEN c.monthly_fee
        ELSE COALESCE(p.default_monthly_charge, 2500)
    END,
    ((CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE - INTERVAL '1 year')::DATE,
    CASE
        WHEN c.monthly_fee BETWEEN 0 AND 30000
            THEN 'Current legacy rate assumed for the one-year migration window'
        ELSE 'Implausible legacy customer rate replaced by package default for reconstruction'
    END,
    TRUE,
    'legacy-rate-window:' || c.customer_id::TEXT
FROM public.customers c
LEFT JOIN public.packages p ON p.package_id = c.package_id
WHERE c.monthly_fee IS NOT NULL
ON CONFLICT (source_key) DO UPDATE SET
    monthly_fee = EXCLUDED.monthly_fee,
    reason = EXCLUDED.reason;


-- 9e. Balances brought forward from before the one-year window

WITH settings AS (
    SELECT ((CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE - INTERVAL '1 year')::DATE AS window_start
),
legacy_calculation AS (
    SELECT
        c.customer_id,
        settings.window_start,
        GREATEST(
            (
                EXTRACT(YEAR FROM AGE(settings.window_start, COALESCE(c.reactivation_date, c.activation_date)))::INTEGER * 12
                + EXTRACT(MONTH FROM AGE(settings.window_start, COALESCE(c.reactivation_date, c.activation_date)))::INTEGER
            ),
            0
        ) * COALESCE(rate.monthly_fee, 0)
        - COALESCE(SUM(p.amount_paid) FILTER (
            WHERE p.payment_date < settings.window_start
              AND COALESCE(p.payment_type, p.legacy_payment_type) = 'Monthly Fee'
        ), 0) AS opening_amount
    FROM public.customers c
    CROSS JOIN settings
    LEFT JOIN public.customer_rate_history rate
      ON rate.source_key = 'legacy-rate-window:' || c.customer_id::TEXT
    LEFT JOIN public.payments p ON p.customer_id = c.customer_id
    WHERE COALESCE(c.reactivation_date, c.activation_date) IS NOT NULL
      AND COALESCE(c.reactivation_date, c.activation_date) < settings.window_start
    GROUP BY c.customer_id, settings.window_start, rate.monthly_fee
)
INSERT INTO public.account_ledger_entries (
    customer_id, entry_type, amount, effective_date, due_date,
    grace_end_date, description, is_verified, source_key
)
SELECT
    customer_id,
    'opening_balance',
    opening_amount,
    window_start - 1,
    window_start - 1,
    window_start - 1,
    'Estimated legacy balance brought forward before the one-year migration window',
    FALSE,
    'legacy-opening-balance:' || customer_id::TEXT
FROM legacy_calculation
WHERE opening_amount <> 0
ON CONFLICT (source_key) DO UPDATE SET
    amount = EXCLUDED.amount,
    description = EXCLUDED.description,
    is_verified = FALSE;


-- 9f. Payments into the ledger
--
-- The voided_at guard is new. Migration 026 predates payment voids, so the
-- original had no reason to filter them. Nothing imported from Access is
-- voided, so this changes nothing today - it stops the statement being wrong
-- the next time somebody runs it.

INSERT INTO public.account_ledger_entries (
    customer_id, entry_type, amount, effective_date, description,
    payment_id, is_verified, source_key
)
SELECT
    p.customer_id,
    'monthly_payment',
    -ABS(p.amount_paid),
    p.payment_date,
    'Imported monthly payment',
    p.payment_id,
    TRUE,
    'payment:' || p.payment_id::TEXT
FROM public.payments p
WHERE p.customer_id IS NOT NULL
  AND p.voided_at IS NULL
  AND p.payment_date >= ((CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE - INTERVAL '1 year')::DATE
  AND p.payment_date <= (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE
  AND COALESCE(p.payment_type, p.legacy_payment_type) = 'Monthly Fee'
  AND p.amount_paid > 0
ON CONFLICT (source_key) DO NOTHING;


-- 9g. The billing watermark. Truncated above, so this puts back the single
-- row with a NULL generated_through, which is what makes the next step
-- rebuild a full year of charges rather than returning zero.

INSERT INTO public.billing_generation_state (singleton, generated_through)
VALUES (TRUE, NULL)
ON CONFLICT (singleton) DO UPDATE SET generated_through = NULL;


-- 9h. Generate twelve months of charges

SELECT public.spcl_generate_monthly_charges(
    (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE
);


-- 9i. Reconnection fees owed by accounts that are currently disconnected

INSERT INTO public.account_ledger_entries (
    customer_id, entry_type, amount, effective_date, due_date,
    grace_end_date, description, is_verified, source_key
)
SELECT
    c.customer_id,
    'reconnection_fee',
    p.reconnection_fee,
    COALESCE(c.deactivation_date, (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE),
    COALESCE(c.deactivation_date, (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE),
    COALESCE(c.deactivation_date, (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE),
    'Reconnection fee required for disconnected legacy account',
    FALSE,
    'legacy-reconnection-fee:' || c.customer_id::TEXT
FROM public.customers c
JOIN public.packages p ON p.package_id = c.package_id
WHERE c.status IN ('disconnected', 'pending_reconnection')
  AND p.reconnection_fee > 0
ON CONFLICT (source_key) DO NOTHING;


-- ---------------------------------------------------------------------------
-- 10. Prove it worked
-- ---------------------------------------------------------------------------

INSERT INTO public.cutover_snapshot (phase, table_name, row_count, total_value)
SELECT 'after', 'customers', count(*), NULL FROM public.customers
UNION ALL
SELECT 'after', 'payments', count(*), COALESCE(SUM(amount_paid), 0)
    FROM public.payments
UNION ALL
SELECT 'after', 'applications', count(*), NULL FROM public.applications
UNION ALL
SELECT 'after', 'account_ledger_entries', count(*), COALESCE(SUM(amount), 0)
    FROM public.account_ledger_entries;

DO $$
DECLARE
    active_count   BIGINT;
    disc_count     BIGINT;
    rate_count     BIGINT;
    charge_count   BIGINT;
    no_rate        BIGINT;
    emp_count      BIGINT;
BEGIN
    SELECT count(*) INTO active_count
        FROM public.customers WHERE status = 'active';
    SELECT count(*) INTO disc_count
        FROM public.customers WHERE status = 'disconnected';
    SELECT count(*) INTO rate_count FROM public.customer_rate_history;
    SELECT count(*) INTO charge_count
        FROM public.account_ledger_entries WHERE entry_type = 'monthly_charge';
    SELECT count(*) INTO emp_count FROM public.employees;

    SELECT count(*) INTO no_rate
      FROM public.customers c
     WHERE c.status = 'active'
       AND NOT EXISTS (
            SELECT 1 FROM public.customer_rate_history r
             WHERE r.customer_id = c.customer_id
       );

    RAISE NOTICE '--------------------------------------------------';
    RAISE NOTICE 'customers      : % active, % disconnected', active_count, disc_count;
    RAISE NOTICE 'rate history   : % rows', rate_count;
    RAISE NOTICE 'monthly charges: % rows', charge_count;
    RAISE NOTICE 'employees      : % (untouched)', emp_count;
    RAISE NOTICE '--------------------------------------------------';

    -- An empty charge ledger is the failure that looks like success: the app
    -- loads, every page works, and every customer reads as owing nothing.
    IF charge_count = 0 THEN
        RAISE EXCEPTION
            'no monthly charges were generated - the billing watermark or the '
            'rate history did not rebuild, and every account would show a zero '
            'balance';
    END IF;

    IF no_rate > 0 THEN
        RAISE WARNING
            '% active customers have no rate history and will never be '
            'charged - they have no monthly fee in Access', no_rate;
    END IF;
END $$;
