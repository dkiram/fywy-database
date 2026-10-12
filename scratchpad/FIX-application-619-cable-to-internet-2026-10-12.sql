-- ============================================================================
-- Application #619: Cable Only -> Internet Starter (10 Mbps) @ J$3,000/month.
--
-- Package 2 is "Internet — Starter (10 Mbps)", the only J$3,000 internet plan.
--
-- What it changes:
--   * applications 619: package_id = 2, monthly_fee = 3000
--   * if the application is already serviced (has a customer), that customer
--     gets the same change the Manage Subscription button makes:
--       customers.package_id = 2, monthly_fee = 3000,
--       additional_cable_boxes = 0 (internet-only has no cable),
--       a new customer_rate_history row effective TODAY, and an audit row.
--
-- What it does NOT touch: monthly charges already raised and any installation
-- payment. Block 1 lists both so you can see whether anything needs a follow-up
-- (cable install is J$4,500, internet install is J$7,000).
--
-- Guards: application exists, its current package is a cable-only plan, and
-- the linked customer (if any) is not terminated. Re-running is harmless: once
-- the application is on package 2 the script stops with "already on Internet".
--
-- LAST LINE IS `ROLLBACK` - rehearsal. Read the output, back up,
-- THEN change ROLLBACK -> COMMIT and run again:
--   docker exec -it spcl-backup sh /opt/spcl-deploy/backup.sh   # before COMMIT
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Look first (read-only)
-- ---------------------------------------------------------------------------
SELECT a.application_id, a.name, a.status, a.package_id, p.name AS package_name,
       a.monthly_fee, a.additional_box, a.adult_channel,
       a.activation_date, a.customer_id
FROM public.applications a
LEFT JOIN public.packages p ON p.package_id = a.package_id
WHERE a.application_id = 619;

SELECT c.customer_id, c.name, c.status, c.package_id, p.name AS package_name,
       c.monthly_fee, c.additional_cable_boxes, c.activation_date
FROM public.applications a
JOIN public.customers c ON c.customer_id = a.customer_id
LEFT JOIN public.packages p ON p.package_id = c.package_id
WHERE a.application_id = 619;

-- Rate rows on file for the customer (empty if not yet activated).
SELECT r.customer_rate_history_id, r.package_id, r.monthly_fee,
       r.effective_date, r.reason
FROM public.applications a
JOIN public.customer_rate_history r ON r.customer_id = a.customer_id
WHERE a.application_id = 619
ORDER BY r.effective_date, r.customer_rate_history_id;

-- Monthly charges already raised at the old rate - these stay as they are.
SELECT l.account_ledger_entry_id, l.due_date, l.amount, l.description
FROM public.applications a
JOIN public.account_ledger_entries l ON l.customer_id = a.customer_id
WHERE a.application_id = 619
  AND l.entry_type = 'monthly_charge'
ORDER BY l.due_date;

-- Installation payment taken at the counter (if any).
SELECT pay.payment_id, pay.payment_type, pay.amount_paid, pay.payment_date, pay.voided_at
FROM public.payments pay
WHERE pay.application_id = 619;

-- ---------------------------------------------------------------------------
-- 2. The change
-- ---------------------------------------------------------------------------
BEGIN;

DO $$
DECLARE
    app            RECORD;
    cust           RECORD;
    new_package    RECORD;
    actor CONSTANT TEXT := 'SQL maintenance (management-requested)';
    why   CONSTANT TEXT := 'Application #619: plan changed from Cable Only to Internet at J$3,000';
BEGIN
    SELECT a.*, p.name AS package_name, p.service_type
      INTO app
      FROM public.applications a
      LEFT JOIN public.packages p ON p.package_id = a.package_id
     WHERE a.application_id = 619
       FOR UPDATE OF a;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Application 619 not found';
    END IF;
    IF app.package_id = 2 THEN
        RAISE EXCEPTION 'Application 619 is already on Internet Starter - nothing to do';
    END IF;
    IF app.service_type IS DISTINCT FROM 'cable' THEN
        RAISE EXCEPTION 'Application 619 is on "%" (package %), not a cable-only plan - check before changing',
            app.package_name, app.package_id;
    END IF;

    SELECT package_id, name, default_monthly_charge
      INTO new_package
      FROM public.packages
     WHERE package_id = 2 AND is_active AND service_type = 'internet';
    IF NOT FOUND OR new_package.default_monthly_charge <> 3000 THEN
        RAISE EXCEPTION 'Package 2 is not an active J$3,000 internet plan - catalog has changed';
    END IF;

    -- The application record.
    UPDATE public.applications
       SET package_id = 2, monthly_fee = 3000, updated_at = CURRENT_TIMESTAMP
     WHERE application_id = 619;

    INSERT INTO public.audit_logs (
        actor_name, action, entity_type, entity_id, field_name,
        old_value, new_value, reason, occurred_at
    ) VALUES (
        actor, 'Edited application', 'application', '619', 'package',
        COALESCE(app.package_name, 'No package') || ' @ J$' || COALESCE(app.monthly_fee, 0)::TEXT,
        new_package.name || ' @ J$3000.00', why, CURRENT_TIMESTAMP
    );

    RAISE NOTICE 'Application 619 (%): % @ % -> % @ 3000.00',
        app.name, app.package_name, app.monthly_fee, new_package.name;

    -- Not activated yet: the activation form will carry package 2 forward.
    IF app.customer_id IS NULL THEN
        RAISE NOTICE 'No customer linked yet (status %); only the application was changed', app.status;
        RETURN;
    END IF;

    SELECT c.customer_id, c.name, c.status, c.package_id, c.monthly_fee,
           p.name AS package_name
      INTO cust
      FROM public.customers c
      LEFT JOIN public.packages p ON p.package_id = c.package_id
     WHERE c.customer_id = app.customer_id
       FOR UPDATE OF c;

    IF cust.status = 'terminated' THEN
        RAISE EXCEPTION 'Customer % is terminated - a terminated subscription cannot be changed', cust.customer_id;
    END IF;

    -- Same writes as PATCH /api/customers/:id/subscription.
    UPDATE public.customers
       SET package_id = 2, monthly_fee = 3000, additional_cable_boxes = 0
     WHERE customer_id = cust.customer_id;

    INSERT INTO public.customer_rate_history (
        customer_id, package_id, monthly_fee, effective_date, reason,
        changed_by_employee_id, is_legacy_estimate
    ) VALUES (
        cust.customer_id, 2, 3000,
        (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
        why, NULL, FALSE
    );

    INSERT INTO public.audit_logs (
        actor_name, action, entity_type, entity_id, field_name,
        old_value, new_value, reason, occurred_at
    ) VALUES (
        actor, 'Changed customer package', 'customer', cust.customer_id::TEXT, 'subscription',
        COALESCE(cust.package_name, 'No package') || ' @ J$' || COALESCE(cust.monthly_fee, 0)::TEXT,
        new_package.name || ' @ J$3000.00', why, CURRENT_TIMESTAMP
    );

    RAISE NOTICE 'Customer % (%): % @ % -> % @ 3000.00, effective today',
        cust.customer_id, cust.name, cust.package_name, cust.monthly_fee, new_package.name;
END;
$$;

-- After: both rows should now show package 2 @ 3000.00.
SELECT a.application_id, a.package_id, a.monthly_fee,
       c.customer_id, c.package_id AS customer_package_id,
       c.monthly_fee AS customer_monthly_fee, c.additional_cable_boxes
FROM public.applications a
LEFT JOIN public.customers c ON c.customer_id = a.customer_id
WHERE a.application_id = 619;

ROLLBACK;
