-- MVP 4 billing follow-up: one-year reconstruction, legacy opening balance,
-- effective-dated rates, disconnection holds, waivers, and approval readiness.

ALTER TABLE public.pole_boxes
ADD COLUMN IF NOT EXISTS legacy_box_id INTEGER,
ADD COLUMN IF NOT EXISTS legacy_box_number TEXT,
ADD COLUMN IF NOT EXISTS legacy_capacity_raw INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS pole_boxes_legacy_box_id_unique
ON public.pole_boxes (legacy_box_id)
WHERE legacy_box_id IS NOT NULL;

ALTER TABLE public.customers
ADD COLUMN IF NOT EXISTS legacy_pole_box_id INTEGER;

ALTER TABLE public.service_ticket_history
ADD COLUMN IF NOT EXISTS source_key TEXT;

-- Access contains two service records whose customer IDs no longer exist in
-- Customer TBL. Preserve those records as unlinked legacy tickets instead of
-- inventing replacement customers or silently discarding the work history.
ALTER TABLE public.service_tickets
ALTER COLUMN customer_id DROP NOT NULL;

ALTER TABLE public.service_tickets
ADD COLUMN IF NOT EXISTS legacy_customer_id INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS service_ticket_history_source_key_unique
ON public.service_ticket_history (source_key)
WHERE source_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.customer_rate_history (
    customer_rate_history_id BIGSERIAL PRIMARY KEY,
    customer_id INTEGER NOT NULL REFERENCES public.customers(customer_id) ON DELETE RESTRICT,
    monthly_fee NUMERIC(14,2) NOT NULL CHECK (monthly_fee >= 0),
    effective_date DATE NOT NULL,
    reason TEXT NOT NULL CHECK (LENGTH(TRIM(reason)) >= 3),
    changed_by_employee_id BIGINT REFERENCES public.employees(employee_id) ON DELETE SET NULL,
    is_legacy_estimate BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    source_key TEXT UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_customer_rate_history_effective
ON public.customer_rate_history (customer_id, effective_date DESC);

-- Positive ledger amounts increase what is owed; negative amounts are payments,
-- credits, or waivers. Legacy opening entries are visibly marked unverified.
CREATE TABLE IF NOT EXISTS public.account_ledger_entries (
    account_ledger_entry_id BIGSERIAL PRIMARY KEY,
    customer_id INTEGER NOT NULL REFERENCES public.customers(customer_id) ON DELETE RESTRICT,
    entry_type TEXT NOT NULL CHECK (entry_type IN (
        'opening_balance', 'monthly_charge', 'monthly_payment',
        'reconnection_fee', 'reconnection_payment', 'waiver', 'adjustment'
    )),
    amount NUMERIC(14,2) NOT NULL CHECK (amount <> 0),
    effective_date DATE NOT NULL,
    due_date DATE,
    grace_end_date DATE,
    description TEXT NOT NULL,
    payment_id BIGINT REFERENCES public.payments(payment_id) ON DELETE RESTRICT,
    customer_rate_history_id BIGINT
        REFERENCES public.customer_rate_history(customer_rate_history_id)
        ON DELETE SET NULL,
    created_by_employee_id BIGINT REFERENCES public.employees(employee_id) ON DELETE SET NULL,
    reason TEXT,
    is_verified BOOLEAN NOT NULL DEFAULT TRUE,
    source_key TEXT UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_account_ledger_customer_date
ON public.account_ledger_entries (customer_id, effective_date, account_ledger_entry_id);

CREATE INDEX IF NOT EXISTS idx_account_ledger_due
ON public.account_ledger_entries (due_date, grace_end_date)
WHERE amount > 0;

CREATE TABLE IF NOT EXISTS public.disconnection_holds (
    disconnection_hold_id BIGSERIAL PRIMARY KEY,
    customer_id INTEGER NOT NULL REFERENCES public.customers(customer_id) ON DELETE RESTRICT,
    starts_on DATE NOT NULL DEFAULT ((CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE),
    expires_on DATE NOT NULL,
    reason TEXT NOT NULL CHECK (LENGTH(TRIM(reason)) >= 3),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released', 'expired')),
    approved_by_employee_id BIGINT REFERENCES public.employees(employee_id) ON DELETE SET NULL,
    released_by_employee_id BIGINT REFERENCES public.employees(employee_id) ON DELETE SET NULL,
    released_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (expires_on >= starts_on)
);

CREATE INDEX IF NOT EXISTS idx_disconnection_holds_active
ON public.disconnection_holds (customer_id, expires_on)
WHERE status = 'active';

-- Clamp anniversaries such as the 31st to the last valid day of short months.
CREATE OR REPLACE FUNCTION public.spcl_anniversary_date(anchor_date DATE, month_date DATE)
RETURNS DATE
LANGUAGE SQL
IMMUTABLE
STRICT
AS $$
    SELECT MAKE_DATE(
        EXTRACT(YEAR FROM month_date)::INTEGER,
        EXTRACT(MONTH FROM month_date)::INTEGER,
        LEAST(
            EXTRACT(DAY FROM anchor_date)::INTEGER,
            EXTRACT(DAY FROM (
                DATE_TRUNC('month', month_date)::DATE + INTERVAL '1 month - 1 day'
            ))::INTEGER
        )
    );
$$;

-- SPCL disconnects on the first 20th that is not before the ten-day grace end.
CREATE OR REPLACE FUNCTION public.spcl_scheduled_disconnection(grace_end DATE)
RETURNS DATE
LANGUAGE SQL
IMMUTABLE
STRICT
AS $$
    SELECT CASE
        WHEN EXTRACT(DAY FROM grace_end) <= 20
            THEN DATE_TRUNC('month', grace_end)::DATE + 19
        ELSE (DATE_TRUNC('month', grace_end)::DATE + INTERVAL '1 month')::DATE + 19
    END;
$$;

-- Seed the current rate at the start of the one-year reconstruction window.
-- Future rate edits append exact effective-dated rows through the API.
INSERT INTO public.customer_rate_history (
    customer_id, monthly_fee, effective_date, reason,
    is_legacy_estimate, source_key
)
SELECT
    c.customer_id,
    CASE
        -- Preserve plausible negotiated rates; obvious legacy keying errors
        -- fall back to the package default without overwriting Customer TBL.
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

-- Brought-forward balance before the one-year window. The Access database did
-- not store a balance column; it calculated balances dynamically. This snapshot
-- reproduces that evidence using monthly payments only and is marked unverified.
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

-- Import only true Monthly Fee payments into the one-year reconstructed ledger.
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
  AND p.payment_date >= ((CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE - INTERVAL '1 year')::DATE
  AND p.payment_date <= (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE
  AND COALESCE(p.payment_type, p.legacy_payment_type) = 'Monthly Fee'
  AND p.amount_paid > 0
ON CONFLICT (source_key) DO NOTHING;

-- Idempotently create anniversary charges up to a requested date. Calling this
-- from dashboard/report/payment workflows keeps future months current. A
-- singleton watermark makes repeated page loads an O(1) no-op instead of
-- rebuilding one year for every customer on every request.
CREATE TABLE IF NOT EXISTS public.billing_generation_state (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    generated_through DATE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO public.billing_generation_state (singleton, generated_through)
VALUES (TRUE, NULL)
ON CONFLICT (singleton) DO NOTHING;

-- Repair only legacy-estimated charges whose inferred rate changed during a
-- migration rerun. This is a one-time migration correction, never page-load work.
WITH corrected_charges AS (
    SELECT
        ledger.account_ledger_entry_id,
        rate.customer_rate_history_id,
        rate.monthly_fee,
        rate.is_legacy_estimate
    FROM public.account_ledger_entries ledger
    JOIN LATERAL (
        SELECT history.customer_rate_history_id,
            history.monthly_fee, history.is_legacy_estimate
        FROM public.customer_rate_history history
        WHERE history.customer_id = ledger.customer_id
          AND history.effective_date <= ledger.effective_date
        ORDER BY history.effective_date DESC,
            history.customer_rate_history_id DESC
        LIMIT 1
    ) rate ON TRUE
    WHERE ledger.entry_type = 'monthly_charge'
      AND ledger.is_verified = FALSE
      AND (
          ledger.amount IS DISTINCT FROM rate.monthly_fee
          OR ledger.customer_rate_history_id IS DISTINCT FROM rate.customer_rate_history_id
      )
)
UPDATE public.account_ledger_entries ledger SET
    amount = corrected.monthly_fee,
    customer_rate_history_id = corrected.customer_rate_history_id,
    is_verified = NOT corrected.is_legacy_estimate
FROM corrected_charges corrected
WHERE ledger.account_ledger_entry_id = corrected.account_ledger_entry_id;

CREATE OR REPLACE FUNCTION public.spcl_generate_monthly_charges(as_of_date DATE)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    inserted_count INTEGER;
    previous_date DATE;
    generation_start DATE;
BEGIN
    -- Serialize the once-per-day generator and return immediately when another
    -- request has already generated through the requested date.
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
    WHERE c.activation_date IS NOT NULL
      AND c.monthly_fee IS NOT NULL
      AND rate.monthly_fee > 0
      AND (previous_date IS NULL OR due.due_date > previous_date)
      AND due.due_date > COALESCE(c.reactivation_date, c.activation_date)
      AND due.due_date <= as_of_date
      AND (
          c.status NOT IN ('disconnected', 'pending_reconnection', 'closed', 'archived')
          OR c.deactivation_date IS NULL
          OR due.due_date < c.deactivation_date
      )
    ON CONFLICT (source_key) DO NOTHING;

    GET DIAGNOSTICS inserted_count = ROW_COUNT;

    UPDATE public.billing_generation_state SET
        generated_through = as_of_date,
        updated_at = CURRENT_TIMESTAMP
    WHERE singleton = TRUE;

    RETURN inserted_count;
END;
$$;

SELECT public.spcl_generate_monthly_charges(
    (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE
);

-- Existing disconnected accounts must clear the package reconnection fee too.
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

-- Calculate the oldest unpaid debit by applying all payments/credits FIFO.
CREATE OR REPLACE VIEW public.customer_billing_status AS
WITH totals AS (
    SELECT
        customer_id,
        COALESCE(SUM(amount), 0)::NUMERIC(14,2) AS balance,
        COALESCE(-SUM(amount) FILTER (WHERE amount < 0), 0)::NUMERIC(14,2) AS total_credits,
        COUNT(*) FILTER (WHERE is_verified = FALSE)::INTEGER AS unverified_entries
    FROM public.account_ledger_entries
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
    WHERE amount > 0
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
    WHERE status = 'active'
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
         ELSE public.spcl_scheduled_disconnection(o.grace_end_date)
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
        AND public.spcl_scheduled_disconnection(o.grace_end_date)
            <= (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE
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
LEFT JOIN active_holds h USING (customer_id);
