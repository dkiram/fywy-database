-- 066: include the 'offline' status in the billing guard.
--
-- Migration 065 stopped the charge generators billing accounts that are not in
-- service, but its status list predated the 'offline' status added in 063:
--
--     ('disconnected', 'pending_reconnection', 'closed', 'archived')
--
-- 'offline' is not in that list, so an offline account passes the guard and is
-- charged - which is the opposite of what the status is for. It marks a
-- customer whose service is down through an unresolved fault, and they are not
-- supposed to pay for months they had no service. 59 accounts currently carry
-- it.
--
-- This adds 'offline' in both places it matters, in both functions:
--
--   1. the status list itself, so an offline account raises no new charge; and
--   2. the account_status_history lookup behind service_ended_on, so charges
--      stop from the date the account went offline rather than from whenever a
--      deactivation_date happens to have been set.
--
-- Nothing else changes. Everything below is 065 with that one list extended.

-- ===========================================================================
-- The daily generator
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.spcl_generate_monthly_charges(as_of_date date)
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
DECLARE
    inserted_count INTEGER;
    previous_date DATE;
    generation_start DATE;
BEGIN
    INSERT INTO public.billing_generation_state (singleton, generated_through)
    VALUES (TRUE, NULL)
    ON CONFLICT (singleton) DO NOTHING;
    SELECT generated_through
    INTO previous_date
    FROM public.billing_generation_state
    WHERE singleton = TRUE
    FOR UPDATE;
    IF previous_date IS NOT NULL AND previous_date >= as_of_date THEN
        RETURN 0;
    END IF;
    generation_start := COALESCE(
        previous_date + 1,
        (as_of_date - INTERVAL '1 year')::DATE
    );
    INSERT INTO public.account_ledger_entries (
        customer_id, entry_type, amount, effective_date, due_date,
        grace_end_date, description, customer_rate_history_id,
        is_verified, source_key
    )
    SELECT
        c.customer_id,
        'monthly_charge',
        rate.monthly_fee,
        due.due_date,
        due.due_date,
        due.due_date + 10,
        'Monthly service charge for activation anniversary',
        rate.customer_rate_history_id,
        NOT rate.is_legacy_estimate,
        'monthly-charge:' || c.customer_id::TEXT || ':' || due.due_date::TEXT
    FROM public.customers c
    LEFT JOIN public.customer_billing_start bs ON bs.customer_id = c.customer_id
    -- When the account is not billable, this is the date we believe service
    -- actually ended. deactivation_date first; otherwise the most recent
    -- transition into a non-billable status recorded in the status history.
    -- NULL means we have no idea, and the guard below then charges nothing.
    CROSS JOIN LATERAL (
        SELECT COALESCE(
            c.deactivation_date,
            (
                SELECT MAX(h.effective_date)
                FROM public.account_status_history h
                WHERE h.customer_id = c.customer_id
                  AND h.to_status IN
                      ('disconnected', 'pending_reconnection', 'closed', 'archived', 'offline')
            )
        ) AS service_ended_on
    ) disc
    CROSS JOIN LATERAL GENERATE_SERIES(
        DATE_TRUNC('month', GREATEST(
            COALESCE(c.reactivation_date, c.activation_date),
            generation_start,
            COALESCE(bs.billing_start_date, DATE '1900-01-01')
        )),
        DATE_TRUNC('month', as_of_date),
        INTERVAL '1 month'
    ) month_value
    CROSS JOIN LATERAL (
        SELECT public.spcl_anniversary_date(c.activation_date, month_value::DATE) AS due_date
    ) due
    JOIN LATERAL (
        SELECT r.customer_rate_history_id, r.monthly_fee, r.is_legacy_estimate
        FROM public.customer_rate_history r
        WHERE r.customer_id = c.customer_id
          AND r.effective_date <= due.due_date
        ORDER BY r.effective_date DESC, r.customer_rate_history_id DESC
        LIMIT 1
    ) rate ON TRUE
    WHERE c.activation_date IS NOT NULL
      AND c.monthly_fee IS NOT NULL
      AND rate.monthly_fee > 0
      AND (previous_date IS NULL OR due.due_date > previous_date)
      AND due.due_date > COALESCE(c.reactivation_date, c.activation_date)
      AND (bs.billing_start_date IS NULL OR due.due_date > bs.billing_start_date)
      AND due.due_date <= as_of_date
      -- FIXED. A non-billable account is charged only for dates we can show it
      -- was still connected. Previously a NULL deactivation_date waved every
      -- disconnected account straight through, forever.
      AND (
          c.status NOT IN ('disconnected', 'pending_reconnection', 'closed', 'archived', 'offline')
          OR (
              disc.service_ended_on IS NOT NULL
              AND due.due_date < disc.service_ended_on
          )
      )
    ON CONFLICT (source_key) DO NOTHING;
    GET DIAGNOSTICS inserted_count = ROW_COUNT;
    UPDATE public.billing_generation_state SET
        generated_through = as_of_date,
        updated_at = CURRENT_TIMESTAMP
    WHERE singleton = TRUE;
    RETURN inserted_count;
END;
$function$;


-- ===========================================================================
-- The single-customer rebuild. Same bug, same fix - otherwise rebuilding one
-- customer would reintroduce exactly what the generator no longer creates.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.spcl_regenerate_customer_charges(target_customer integer, as_of_date date)
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
DECLARE
    inserted_count   INTEGER;
    generation_start DATE;
    blocking_waivers INTEGER;
BEGIN
    SELECT count(*) INTO blocking_waivers
      FROM public.waiver_requests w
     WHERE w.customer_id = target_customer;
    IF blocking_waivers > 0 THEN
        RAISE EXCEPTION
            'customer % has % waiver request(s); their charges cannot be '
            'rebuilt without stranding the waiver credit',
            target_customer, blocking_waivers;
    END IF;
    DELETE FROM public.account_ledger_entries
     WHERE customer_id = target_customer
       AND entry_type = 'monthly_charge';
    -- Reach back to the paid-through date where there is one, so a corrected
    -- activation date rebuilds the customer's real arrears rather than a
    -- one-year slice of them.
    SELECT LEAST(
        (as_of_date - INTERVAL '1 year')::DATE,
        COALESCE(bs.billing_start_date, (as_of_date - INTERVAL '1 year')::DATE)
    )
    INTO generation_start
    FROM public.customers c
    LEFT JOIN public.customer_billing_start bs ON bs.customer_id = c.customer_id
    WHERE c.customer_id = target_customer;
    INSERT INTO public.account_ledger_entries (
        customer_id, entry_type, amount, effective_date, due_date,
        grace_end_date, description, customer_rate_history_id,
        is_verified, source_key
    )
    SELECT
        c.customer_id,
        'monthly_charge',
        rate.monthly_fee,
        due.due_date,
        due.due_date,
        due.due_date + 10,
        'Monthly service charge for activation anniversary',
        rate.customer_rate_history_id,
        NOT rate.is_legacy_estimate,
        'monthly-charge:' || c.customer_id::TEXT || ':' || due.due_date::TEXT
    FROM public.customers c
    LEFT JOIN public.customer_billing_start bs ON bs.customer_id = c.customer_id
    CROSS JOIN LATERAL (
        SELECT COALESCE(
            c.deactivation_date,
            (
                SELECT MAX(h.effective_date)
                FROM public.account_status_history h
                WHERE h.customer_id = c.customer_id
                  AND h.to_status IN
                      ('disconnected', 'pending_reconnection', 'closed', 'archived', 'offline')
            )
        ) AS service_ended_on
    ) disc
    CROSS JOIN LATERAL GENERATE_SERIES(
        DATE_TRUNC('month', GREATEST(
            COALESCE(c.reactivation_date, c.activation_date),
            generation_start
        )),
        DATE_TRUNC('month', as_of_date),
        INTERVAL '1 month'
    ) month_value
    CROSS JOIN LATERAL (
        SELECT public.spcl_anniversary_date(c.activation_date, month_value::DATE) AS due_date
    ) due
    JOIN LATERAL (
        SELECT r.customer_rate_history_id, r.monthly_fee, r.is_legacy_estimate
        FROM public.customer_rate_history r
        WHERE r.customer_id = c.customer_id
          AND r.effective_date <= due.due_date
        ORDER BY r.effective_date DESC, r.customer_rate_history_id DESC
        LIMIT 1
    ) rate ON TRUE
    WHERE c.customer_id = target_customer
      AND c.activation_date IS NOT NULL
      AND c.monthly_fee IS NOT NULL
      AND rate.monthly_fee > 0
      AND due.due_date > COALESCE(c.reactivation_date, c.activation_date)
      AND (bs.billing_start_date IS NULL OR due.due_date > bs.billing_start_date)
      AND due.due_date <= as_of_date
      -- FIXED - see spcl_generate_monthly_charges above.
      AND (
          c.status NOT IN ('disconnected', 'pending_reconnection', 'closed', 'archived', 'offline')
          OR (
              disc.service_ended_on IS NOT NULL
              AND due.due_date < disc.service_ended_on
          )
      )
    ON CONFLICT (source_key) DO NOTHING;
    GET DIAGNOSTICS inserted_count = ROW_COUNT;
    RETURN inserted_count;
END;
$function$;
