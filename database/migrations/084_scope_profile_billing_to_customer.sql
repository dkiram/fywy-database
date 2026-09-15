-- Profile reads must not run all-account generators or aggregate every ledger.
-- These scoped variants preserve the batch billing rules and source keys.
-- Existing batch functions remain available for automation and reports.

CREATE OR REPLACE FUNCTION public.spcl_generate_customer_suspension_charges(target_customer INTEGER, as_of_date DATE)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    inserted_count INTEGER;
BEGIN
    INSERT INTO public.account_ledger_entries (
        customer_id, entry_type, amount, effective_date, due_date,
        grace_end_date, description, is_verified, source_key
    )
    SELECT
        episode.customer_id,
        'suspension_charge',
        terms.monthly_fee,
        charge.charge_date,
        charge.charge_date,
        charge.charge_date + 10,
        'Monthly suspension fee while service is suspended',
        TRUE,
        'suspension-charge:' || episode.suspension_history_id::TEXT
            || ':' || charge.charge_date::TEXT
    FROM public.customer_suspension_episodes episode
    CROSS JOIN public.suspension_terms terms
    -- Months elapsed between the start of the suspension and the earlier of
    -- today and the day it ended. AGE gives whole calendar months, which is
    -- what the anniversary rule needs.
    CROSS JOIN LATERAL (
        SELECT public.spcl_anniversary_date(
                   episode.suspended_on,
                   (
                       DATE_TRUNC('month', episode.suspended_on)
                       + (month_offset || ' months')::INTERVAL
                   )::DATE
               ) AS charge_date
        FROM GENERATE_SERIES(
            0,
            GREATEST(
                0,
                (
                    DATE_PART(
                        'year',
                        AGE(
                            LEAST(as_of_date, COALESCE(episode.ended_on, as_of_date)),
                            episode.suspended_on
                        )
                    ) * 12
                    + DATE_PART(
                        'month',
                        AGE(
                            LEAST(as_of_date, COALESCE(episode.ended_on, as_of_date)),
                            episode.suspended_on
                        )
                    )
                )::INTEGER
            )
        ) AS month_offset
    ) charge
    WHERE episode.customer_id = target_customer
      AND terms.monthly_fee > 0
      AND charge.charge_date >= episode.suspended_on
      AND charge.charge_date <= as_of_date
      AND (episode.ended_on IS NULL OR charge.charge_date < episode.ended_on)
    ON CONFLICT (source_key) DO NOTHING;

    GET DIAGNOSTICS inserted_count = ROW_COUNT;
    RETURN inserted_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.spcl_generate_customer_monthly_charges(target_customer INTEGER, as_of_date date)
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
DECLARE
    inserted_count INTEGER;
    previous_date DATE;
    generation_start DATE;
BEGIN
    PERFORM public.spcl_generate_customer_suspension_charges(target_customer, as_of_date);

    -- Read the batch watermark without locking or advancing it. Generating one
    -- account must never mark every other account as up to date.
    SELECT generated_through INTO previous_date
    FROM public.billing_generation_state WHERE singleton = TRUE;
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
    CROSS JOIN LATERAL (
        SELECT COALESCE(
            c.deactivation_date,
            (
                SELECT MAX(h.effective_date)
                FROM public.account_status_history h
                WHERE h.customer_id = c.customer_id
                  AND h.to_status IN
                      ('disconnected', 'pending_reconnection', 'closed',
                       'archived', 'offline', 'suspended')
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
    WHERE c.customer_id = target_customer
      AND c.activation_date IS NOT NULL
      AND c.monthly_fee IS NOT NULL
      AND rate.monthly_fee > 0
      AND (previous_date IS NULL OR due.due_date > previous_date)
      AND due.due_date > COALESCE(c.reactivation_date, c.activation_date)
      AND (bs.billing_start_date IS NULL OR due.due_date > bs.billing_start_date)
      AND due.due_date <= as_of_date
      AND (
          c.status NOT IN ('disconnected', 'pending_reconnection', 'closed',
                           'archived', 'offline', 'suspended')
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


CREATE OR REPLACE FUNCTION public.spcl_customer_billing_status(target_customer INTEGER)
RETURNS SETOF public.customer_billing_status
LANGUAGE SQL STABLE AS $$
WITH totals AS (
    SELECT
        customer_id,
        COALESCE(SUM(amount), 0)::NUMERIC(14,2) AS balance,
        COALESCE(-SUM(amount) FILTER (WHERE amount < 0), 0)::NUMERIC(14,2) AS total_credits,
        COUNT(*) FILTER (WHERE is_verified = FALSE)::INTEGER AS unverified_entries
    FROM public.account_ledger_entries
    WHERE customer_id = target_customer
    GROUP BY customer_id
),
debits AS (
    SELECT
        customer_id,
        due_date,
        grace_end_date,
        SUM(amount) OVER (
            PARTITION BY customer_id
            ORDER BY due_date NULLS FIRST, account_ledger_entry_id
        ) AS cumulative_debits
    FROM public.account_ledger_entries
    WHERE customer_id = target_customer AND amount > 0
),
oldest_unpaid AS (
    SELECT DISTINCT ON (d.customer_id)
        d.customer_id,
        d.due_date,
        d.grace_end_date
    FROM debits d
    JOIN totals t USING (customer_id)
    WHERE d.cumulative_debits > t.total_credits
    ORDER BY d.customer_id, d.due_date NULLS FIRST
),
active_holds AS (
    SELECT DISTINCT ON (customer_id)
        customer_id, disconnection_hold_id, expires_on, reason
    FROM public.disconnection_holds
    WHERE customer_id = target_customer AND status = 'active'
      AND expires_on >= (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE
    ORDER BY customer_id, expires_on DESC, disconnection_hold_id DESC
)
SELECT
    c.customer_id,
    COALESCE(t.balance, 0)::NUMERIC(14,2) AS balance,
    GREATEST(-COALESCE(t.balance, 0), 0)::NUMERIC(14,2) AS credit_balance,
    GREATEST(COALESCE(t.balance, 0), 0)::NUMERIC(14,2) AS outstanding_balance,
    o.due_date AS oldest_unpaid_due_date,
    o.grace_end_date,
    CASE WHEN o.grace_end_date IS NULL THEN NULL
         ELSE o.grace_end_date + 1
    END AS scheduled_disconnection_date,
    (
        COALESCE(t.balance, 0) > 0
        AND o.grace_end_date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE
    ) AS is_delinquent,
    (h.disconnection_hold_id IS NOT NULL) AS is_on_hold,
    h.expires_on AS hold_expires_on,
    h.reason AS hold_reason,
    (
        c.status = 'active'
        AND COALESCE(t.balance, 0) > 0
        AND o.grace_end_date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE
        AND h.disconnection_hold_id IS NULL
    ) AS eligible_for_disconnection,
    (
        c.status IN ('disconnected', 'pending_reconnection')
        AND COALESCE(t.balance, 0) <= 0
    ) AS ready_for_reconnection,
    COALESCE(t.unverified_entries, 0)::INTEGER AS unverified_entries
FROM public.customers c
LEFT JOIN totals t USING (customer_id)
LEFT JOIN oldest_unpaid o USING (customer_id)
LEFT JOIN active_holds h USING (customer_id)
WHERE c.customer_id = target_customer;
$$;

CREATE OR REPLACE FUNCTION public.spcl_customer_suspension_status(target_customer INTEGER)
RETURNS SETOF public.customer_suspension_status
LANGUAGE SQL STABLE AS $$
SELECT
    episode.customer_id,
    episode.suspension_history_id,
    episode.suspended_on,
    (
        DATE_PART(
            'year',
            AGE((CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE, episode.suspended_on)
        ) * 12
        + DATE_PART(
            'month',
            AGE((CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE, episode.suspended_on)
        )
    )::INTEGER AS months_suspended,
    public.spcl_anniversary_date(
        episode.suspended_on,
        (
            DATE_TRUNC('month', episode.suspended_on)
            + (terms.extended_after_months || ' months')::INTERVAL
        )::DATE
    ) AS extended_fee_starts_after,
    public.spcl_suspension_reconnection_fee(
        episode.customer_id,
        (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE
    ) AS reconnection_fee_today,
    COALESCE(package.reconnection_fee, terms.extended_reconnection_fee)
        AS reconnection_fee_after,
    terms.monthly_fee AS suspension_monthly_fee,
    (
        SELECT COALESCE(SUM(ledger.amount), 0)::NUMERIC(14,2)
        FROM public.account_ledger_entries ledger
        WHERE ledger.customer_id = episode.customer_id
          AND ledger.entry_type = 'suspension_charge'
          AND ledger.source_key LIKE
              'suspension-charge:' || episode.suspension_history_id::TEXT || ':%'
    ) AS suspension_charges_to_date,
    GREATEST(
        billing.balance
        + public.spcl_suspension_reconnection_fee(
            episode.customer_id,
            (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE
          ),
        0::NUMERIC
    )::NUMERIC(14,2) AS total_due_to_reconnect
FROM public.customer_suspension_episodes episode
JOIN public.customers customer
  ON customer.customer_id = episode.customer_id
JOIN public.spcl_customer_billing_status(target_customer) billing
  ON billing.customer_id = episode.customer_id
LEFT JOIN public.packages package
  ON package.package_id = customer.package_id
CROSS JOIN public.suspension_terms terms
WHERE episode.customer_id = target_customer
  AND episode.ended_on IS NULL
  AND customer.status = 'suspended';
$$;
