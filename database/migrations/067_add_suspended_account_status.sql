-- 067_add_suspended_account_status.sql
--
-- Adds a seventh account status: 'suspended'.
--
-- WHAT SUSPENSION IS
--
-- A customer who will be away - overseas, a house closed for the season -
-- asks SPCL to stop their service rather than keep paying the full package
-- rate. Their ONT is deactivated exactly as it is for a disconnection, so
-- physically this IS a disconnection: no service reaches the house. What is
-- different is the money.
--
--   * While suspended the customer is billed a flat J$500 per month instead
--     of their package rate. The charge falls on the monthly anniversary of
--     the day they were suspended, starting on that day itself.
--   * Coming back costs J$500 if they were away three months or less, and the
--     normal package reconnection fee (J$500 -> J$1,500) if they were away
--     longer. The fee is priced and posted when they ask to come back, not
--     when they leave, because on the day they leave nobody knows yet which
--     of the two it will be.
--   * The J$500 monthly charge keeps accruing for as long as the suspension
--     lasts. Passing the three-month line raises the reconnection fee; it does
--     not stop the monthly charge.
--
-- WHY IT IS NOT ONE OF THE STATUSES WE ALREADY HAVE
--
--   'disconnected' bills nothing and posts the full J$1,500 fee up front, at
--       the moment of cutoff. Both halves are wrong for a suspension.
--   'offline'      (migration 063) sends no OLT command, posts no fee and
--                  bills nothing. It marks an unresolved fault, not a paying
--                  arrangement.
--
-- WHAT COMES FOR FREE FROM EXISTING STRUCTURE
--
--   * The full monthly package charge stops on its own. Migration 054's
--     BEFORE INSERT trigger on account_ledger_entries refuses any
--     monthly_charge for a date on which the account was not 'active', and a
--     suspension writes exactly such a status-history row. The guard lists in
--     the 065/066 charge generators are widened below as well, so the
--     generator does not do the work only to have the trigger throw it away.
--   * The delinquency chase list, the dashboard delinquent count, the
--     five-day reminder emails and the automatic OLT disconnection run all
--     filter on status = 'active', so a suspended account drops off every one
--     of them without any change to those queries.
--   * Coming back is a single direct transition, suspended -> active, gated
--     on a cleared balance exactly like any other reconnection. It
--     deliberately does NOT pass through 'pending_reconnection': that queue
--     exists to hold a disconnected customer while an Admin decides whether
--     to let them back on owing money, and routing a suspension through it
--     would mean a cancelled request either resets the three-month clock or
--     strands the customer in 'disconnected'. A customer who cannot pay
--     simply stays suspended and keeps accruing J$500 a month, which is both
--     simpler and what actually happens.
--
-- The state machine, the fee posting and the counter-facing quote live in the
-- application layer. This migration provides the statuses, the money, and the
-- functions that price it.

BEGIN;

-- ===========================================================================
-- 1. Widen the status CHECK constraints
--
-- Same discovery-by-definition approach migration 063 used: these constraints
-- were created inline in migrations 007 and 024 and only 063 gave them names,
-- so find them by what they say rather than by a guessed name.
-- ===========================================================================
DO $$
DECLARE
    target RECORD;
BEGIN
    FOR target IN
        SELECT conrelid::regclass AS table_name, conname
        FROM pg_constraint
        WHERE contype = 'c'
          AND conrelid IN (
              'public.customers'::regclass,
              'public.account_status_history'::regclass
          )
          AND pg_get_constraintdef(oid) ILIKE '%status%'
          AND pg_get_constraintdef(oid) ILIKE '%active%'
    LOOP
        EXECUTE format(
            'ALTER TABLE %s DROP CONSTRAINT %I',
            target.table_name,
            target.conname
        );
    END LOOP;
END $$;

ALTER TABLE public.customers
    ADD CONSTRAINT customers_status_check
    CHECK (status IN (
        'active',
        'disconnected',
        'pending_reconnection',
        'closed',
        'archived',
        'offline',
        'suspended'
    ));

ALTER TABLE public.account_status_history
    ADD CONSTRAINT account_status_history_from_status_check
    CHECK (
        from_status IS NULL
        OR from_status IN (
            'active',
            'disconnected',
            'pending_reconnection',
            'closed',
            'archived',
            'offline',
            'suspended'
        )
    );

ALTER TABLE public.account_status_history
    ADD CONSTRAINT account_status_history_to_status_check
    CHECK (
        to_status IN (
            'active',
            'disconnected',
            'pending_reconnection',
            'closed',
            'archived',
            'offline',
            'suspended'
        )
    );

-- Unlike 'offline', a suspension DOES send a real deactivate command to the
-- OLT, so it travels through the integrated account_transition workflow and
-- is written into the olt_action_attempts journal. Migration 050's two status
-- checks on that journal predate both 'offline' and 'suspended' and would
-- reject the row. Widen them to the full status list.
ALTER TABLE public.olt_action_attempts
    DROP CONSTRAINT IF EXISTS olt_action_attempts_account_status_before_check,
    DROP CONSTRAINT IF EXISTS olt_action_attempts_account_status_after_check;

ALTER TABLE public.olt_action_attempts
    ADD CONSTRAINT olt_action_attempts_account_status_before_check
    CHECK (
        account_status_before IS NULL
        OR account_status_before IN (
            'active', 'disconnected', 'pending_reconnection',
            'closed', 'archived', 'offline', 'suspended'
        )
    ),
    ADD CONSTRAINT olt_action_attempts_account_status_after_check
    CHECK (
        account_status_after IS NULL
        OR account_status_after IN (
            'active', 'disconnected', 'pending_reconnection',
            'closed', 'archived', 'offline', 'suspended'
        )
    );


-- ===========================================================================
-- 2. The terms
--
-- One editable row rather than three constants buried in a function body, so
-- the office can change the holding fee without a deploy. Already-generated
-- charges are never rewritten when this changes: the ledger keeps what a
-- customer was actually billed at the time, which is the same rule
-- customer_rate_history follows for package rates.
--
-- extended_reconnection_fee is only a fallback. The real long-suspension fee
-- is the customer's own package reconnection_fee, so a suspension that runs
-- long costs exactly what any other reconnection costs and there is one place
-- to change it.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.suspension_terms (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),

    monthly_fee NUMERIC(10,2) NOT NULL CHECK (monthly_fee >= 0),
    reconnection_fee NUMERIC(10,2) NOT NULL CHECK (reconnection_fee >= 0),
    extended_reconnection_fee NUMERIC(10,2) NOT NULL CHECK (extended_reconnection_fee >= 0),
    extended_after_months SMALLINT NOT NULL CHECK (extended_after_months > 0),

    updated_by_employee_id BIGINT
        REFERENCES public.employees(employee_id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO public.suspension_terms (
    singleton, monthly_fee, reconnection_fee,
    extended_reconnection_fee, extended_after_months
)
VALUES (TRUE, 500.00, 500.00, 1500.00, 3)
ON CONFLICT (singleton) DO NOTHING;

COMMENT ON TABLE public.suspension_terms IS
    'The single row of suspension pricing: J$500 per suspended month, J$500 to '
    'reconnect within three months, the package reconnection fee after that.';
COMMENT ON COLUMN public.suspension_terms.extended_reconnection_fee IS
    'Fallback long-suspension fee, used only when the customer package carries '
    'no reconnection_fee of its own.';


-- ===========================================================================
-- 3. The two new ledger entry types
--
--   suspension_charge             the recurring J$500 holding fee
--   suspension_reconnection_fee   the J$500 / J$1,500 charged to come back
--
-- The second is deliberately NOT reusing 'reconnection_fee'. Reporting needs
-- to be able to tell a customer who suspended on purpose apart from one who
-- was cut off for non-payment, and the source_key namespaces would otherwise
-- collide with the existing 'reconnection-fee:status-history:<id>' key.
-- ===========================================================================
ALTER TABLE public.account_ledger_entries
    DROP CONSTRAINT IF EXISTS account_ledger_entries_entry_type_check;

ALTER TABLE public.account_ledger_entries
    ADD CONSTRAINT account_ledger_entries_entry_type_check
    CHECK (entry_type IN (
        'opening_balance', 'monthly_charge', 'monthly_payment',
        'reconnection_fee', 'reconnection_payment', 'waiver', 'adjustment',
        'suspension_charge', 'suspension_reconnection_fee'
    ));


-- ===========================================================================
-- 4. Suspension episodes
--
-- account_status_history is the durable service timeline, so an episode is
-- just a transition INTO 'suspended' paired with whatever transition came
-- next. ended_on IS NULL means the customer is suspended right now.
--
-- Ordering matches spcl_customer_service_active_on exactly - effective_date,
-- then changed_at, then id - so a same-day suspend-and-undo collapses to a
-- zero-length episode in both places rather than disagreeing.
-- ===========================================================================
CREATE OR REPLACE VIEW public.customer_suspension_episodes AS
WITH ordered AS (
    SELECT
        history.customer_id,
        history.account_status_history_id,
        history.to_status,
        history.effective_date,
        LEAD(history.effective_date) OVER (
            PARTITION BY history.customer_id
            ORDER BY history.effective_date, history.changed_at,
                     history.account_status_history_id
        ) AS next_effective_date
    FROM public.account_status_history history
)
SELECT
    ordered.customer_id,
    ordered.account_status_history_id AS suspension_history_id,
    ordered.effective_date AS suspended_on,
    ordered.next_effective_date AS ended_on
FROM ordered
WHERE ordered.to_status = 'suspended';

COMMENT ON VIEW public.customer_suspension_episodes IS
    'One row per suspension the customer has ever had. ended_on IS NULL means '
    'the suspension is still running.';


-- ===========================================================================
-- 5. Was this account suspended on this date?
--
-- The mirror of migration 054's spcl_customer_service_active_on, and used the
-- same way: to stop a charge existing for a date the status does not support.
-- There is no legacy-columns fallback here on purpose. Suspension did not
-- exist before this migration, so an account with no status history was never
-- suspended - guessing from activation/deactivation dates could only invent
-- charges.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.spcl_customer_suspended_on(
    target_customer INTEGER,
    service_date DATE
)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
STRICT
AS $$
    SELECT COALESCE(
        (
            SELECT history.to_status = 'suspended'
            FROM public.account_status_history history
            WHERE history.customer_id = target_customer
              AND history.effective_date <= service_date
            ORDER BY
                history.effective_date DESC,
                history.changed_at DESC,
                history.account_status_history_id DESC
            LIMIT 1
        ),
        FALSE
    );
$$;

COMMENT ON FUNCTION public.spcl_customer_suspended_on(INTEGER, DATE) IS
    'Whether the account was in the suspended state on a date, read from the '
    'status-history timeline.';


-- ===========================================================================
-- 6. Extend the migration 054 ledger guard
--
-- 054 refuses a monthly_charge for any date the account was not active. The
-- same protection has to cover the holding fee from the other direction, or a
-- rerun after the customer comes back would keep minting J$500 charges for
-- months in which they were already reconnected and paying full rate.
--
-- Note what is NOT guarded here: suspension_reconnection_fee. That one is
-- posted on the day the customer asks to come back, by which point the
-- status may already have moved on, so a date-based guard would fight the
-- workflow. Its idempotency comes from its source_key instead.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.spcl_prevent_offline_monthly_charge()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.entry_type = 'monthly_charge'
       AND NOT public.spcl_customer_service_active_on(
           NEW.customer_id,
           COALESCE(NEW.due_date, NEW.effective_date)
       ) THEN
        RETURN NULL;
    END IF;

    IF NEW.entry_type = 'suspension_charge'
       AND NOT public.spcl_customer_suspended_on(
           NEW.customer_id,
           COALESCE(NEW.due_date, NEW.effective_date)
       ) THEN
        RETURN NULL;
    END IF;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.spcl_prevent_offline_monthly_charge() IS
    'Refuses a monthly_charge for a date the account was not active, and a '
    'suspension_charge for a date it was not suspended.';


-- ===========================================================================
-- 7. Generate the monthly holding fee
--
-- One J$500 charge on the anniversary day of each month of the suspension,
-- starting on the day of suspension itself. spcl_anniversary_date clamps the
-- 29th, 30th and 31st to the last valid day of a short month, exactly as it
-- does for the package charge.
--
-- Worked example, suspended 10 Aug, reconnected 5 Sep:
--   candidate dates are 10 Aug and 10 Sep; 10 Sep is not before the 5 Sep end
--   date, so exactly one J$500 charge is raised. One month away, one month
--   billed.
--
-- Idempotent through source_key, which is keyed on the immutable
-- status-history ID of the suspension - so a customer who suspends, returns
-- and suspends again on the same calendar day next year gets two separate
-- charges rather than one silently swallowed by ON CONFLICT.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.spcl_generate_suspension_charges(as_of_date DATE)
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
    WHERE terms.monthly_fee > 0
      AND charge.charge_date >= episode.suspended_on
      AND charge.charge_date <= as_of_date
      AND (episode.ended_on IS NULL OR charge.charge_date < episode.ended_on)
    ON CONFLICT (source_key) DO NOTHING;

    GET DIAGNOSTICS inserted_count = ROW_COUNT;
    RETURN inserted_count;
END;
$$;

COMMENT ON FUNCTION public.spcl_generate_suspension_charges(DATE) IS
    'Raises the flat monthly suspension fee on each anniversary day inside '
    'every suspension episode. Idempotent; safe to call on every request.';


-- ===========================================================================
-- 8. Price the fee to come back
--
-- Returns what a customer would pay today to end their current suspension:
-- the short fee up to and including the three-month anniversary, and the
-- package reconnection fee after it.
--
-- The boundary is deliberately inclusive. Suspended 10 Aug and back on
-- 10 Nov is three months to the day - still J$500. 11 Nov is the first day it
-- becomes J$1,500. "More than three months" means more than three months.
--
-- Returns NULL when the customer is not currently suspended, which callers
-- read as "there is no fee to quote".
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.spcl_suspension_reconnection_fee(
    target_customer INTEGER,
    as_of_date DATE
)
RETURNS NUMERIC
LANGUAGE SQL
STABLE
STRICT
AS $$
    SELECT CASE
        WHEN as_of_date > public.spcl_anniversary_date(
                 episode.suspended_on,
                 (
                     DATE_TRUNC('month', episode.suspended_on)
                     + (terms.extended_after_months || ' months')::INTERVAL
                 )::DATE
             )
        THEN COALESCE(package.reconnection_fee, terms.extended_reconnection_fee)
        ELSE terms.reconnection_fee
    END
    FROM public.customer_suspension_episodes episode
    JOIN public.customers customer
      ON customer.customer_id = episode.customer_id
    LEFT JOIN public.packages package
      ON package.package_id = customer.package_id
    CROSS JOIN public.suspension_terms terms
    WHERE episode.customer_id = target_customer
      AND episode.ended_on IS NULL
      AND customer.status = 'suspended'
    ORDER BY episode.suspended_on DESC, episode.suspension_history_id DESC
    LIMIT 1;
$$;

COMMENT ON FUNCTION public.spcl_suspension_reconnection_fee(INTEGER, DATE) IS
    'What ending the current suspension costs on a given date: the short fee '
    'through the three-month anniversary, the package fee after it. NULL when '
    'the customer is not suspended.';


-- ===========================================================================
-- 9. The counter-facing quote
--
-- Staff at the counter need to answer "what do I owe to come back on?" and
-- "how long have I got before it goes up?" without doing date arithmetic in
-- their head. One view so the profile card, the operations queue and any
-- later report all quote the same number.
-- ===========================================================================
CREATE OR REPLACE VIEW public.customer_suspension_status AS
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
    -- The number the counter actually needs: everything outstanding plus the
    -- fee that is about to be posted. Reconnection clears the balance, and
    -- the fee is part of that balance the moment it lands, so quoting one
    -- without the other sends the customer away short.
    (
        billing.outstanding_balance
        + public.spcl_suspension_reconnection_fee(
            episode.customer_id,
            (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE
          )
    )::NUMERIC(14,2) AS total_due_to_reconnect
FROM public.customer_suspension_episodes episode
JOIN public.customers customer
  ON customer.customer_id = episode.customer_id
JOIN public.customer_billing_status billing
  ON billing.customer_id = episode.customer_id
LEFT JOIN public.packages package
  ON package.package_id = customer.package_id
CROSS JOIN public.suspension_terms terms
WHERE episode.ended_on IS NULL
  AND customer.status = 'suspended';

COMMENT ON VIEW public.customer_suspension_status IS
    'One row per currently-suspended customer: when it started, what coming '
    'back costs today, and the date after which that price rises.';


-- ===========================================================================
-- 10. Keep the full package charge away from suspended months
--
-- Migration 054's trigger already blocks these, but the 065/066 generators
-- should not be producing rows for the trigger to discard - and, more to the
-- point, service_ended_on has to know about suspension or a suspended
-- account with a NULL deactivation_date falls into the "we have no idea when
-- service ended" branch. Both functions are otherwise byte-for-byte 066.
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
    -- The holding fee is raised on every call, before the once-a-day guard
    -- below. Every existing caller of this function - the balance check
    -- inside an account transition, the payment screen, the nightly run -
    -- therefore sees a suspended customer's true balance without any of them
    -- needing to know that suspension exists.
    PERFORM public.spcl_generate_suspension_charges(as_of_date);

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
    WHERE c.activation_date IS NOT NULL
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
    UPDATE public.billing_generation_state SET
        generated_through = as_of_date,
        updated_at = CURRENT_TIMESTAMP
    WHERE singleton = TRUE;
    RETURN inserted_count;
END;
$function$;


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
    -- Only the package charge is torn down and rebuilt. Suspension charges
    -- are left alone: they are not derived from customer_rate_history, so a
    -- rebuild has nothing better to replace them with, and deleting them
    -- would quietly forgive money the customer genuinely owes.
    DELETE FROM public.account_ledger_entries
     WHERE customer_id = target_customer
       AND entry_type = 'monthly_charge';
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
                      ('disconnected', 'pending_reconnection', 'closed',
                       'archived', 'offline', 'suspended')
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


COMMIT;
