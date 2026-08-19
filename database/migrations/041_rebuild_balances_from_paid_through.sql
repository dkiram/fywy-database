-- 041_rebuild_balances_from_paid_through.sql
--
-- Rebuild every legacy balance from Access's "Month Paid For" column.
--
-- WHY
-- ---
-- Migrations 026 and 038 reconstructed arrears as
--     (months since activation date) x current monthly fee
--       - (cash total of Monthly Fee payments)
-- and never looked at Access's "Month Paid For" column, which is the only
-- field that records WHICH month a payment covered. Three things go wrong:
--
--   1. Access's payment history is thin before 2019 - 398 rows in 2016,
--      325 in 2017, 2,624 in 2018. The rebuild reads those gaps as unpaid
--      months and bills for every one of them.
--   2. It applies TODAY'S fee to every historic month. Trevor Levy (2484)
--      paid $3,500/mo for years and now pays $4,500, so every past month
--      was re-billed at $4,500.
--   3. One impossible activation date bills a lifetime. Rickie Clarke
--      (8327) is dated 24 Jan 1938, producing $4,779,500 of arrears against
--      an account that Access says is paid through 20 July 2026.
--
-- Rehearsed on a full copy of the cutover data (19 Aug 2026): the app lists
-- 5,609 delinquent customers owing $201.2M. After this migration it lists
-- 6,131 owing $147.1M. 977 customers drop off the list because they were never
-- behind; 1,499 join it because the old ledger credited lump-sum payments
-- against months those payments never covered. Largest single balance falls
-- from $4,779,500 to $1,080,000 (a $30,000/month account that has never paid).
--
-- WHAT THIS DOES
-- --------------
-- Establishes a per-customer "paid through" date from the latest
-- "Month Paid For" on their legacy Monthly Fee payments, and charges only
-- the anniversaries that fall after it. A missing month in the middle of an
-- otherwise unbroken payment run is treated as forgiven, which is what the
-- office already does in practice.
--
-- Payments recorded in SPCL since the cutover are left alone and keep
-- crediting the ledger normally, so a payment taken this morning still
-- clears this month's charge.
--
-- WHAT THIS DOES NOT TOUCH
-- ------------------------
-- Nothing recorded through SPCL since the app went live. The payments table is
-- never written to. Step 4 deletes ledger rows only where the source is the
-- legacy import: the estimated opening balances, the reconstructed charges, and
-- the credits for payments carrying a legacy_payment_id. A payment taken at a
-- counter today has legacy_payment_id NULL, so both it and its ledger credit
-- survive untouched, and step 3 deliberately ignores those payments when
-- working out the paid-through date so the same money is never counted twice.
-- Customer status is not modified, so an account moved to pending_reconnection
-- by a payment this morning stays there.
--
-- Verified on a replica carrying 23 simulated counter payments across
-- delinquent, current and disconnected accounts: all 23 payment rows and all 23
-- ledger credits present and byte-identical afterwards, no status changes, and
-- the same again on a second run.
--
-- Some customers will end up holding a CREDIT rather than a debt - they paid
-- this morning against an inflated balance and, once corrected, owe less than
-- they handed over. The money stays on their account and comes off their next
-- charge. Nothing is written off.
--
-- SAFE TO RE-RUN. Like every other migration here it carries no BEGIN/COMMIT
-- of its own: migrate.sh applies it with psql -1, so the whole file plus its
-- schema_migrations row succeed or fail together.
--
-- TO REHEARSE IT AGAINST REAL DATA WITHOUT KEEPING ANYTHING, wrap it by hand:
--
--   docker exec -i spcl-backup sh -c '{ echo "BEGIN;"; \
--     cat /opt/spcl-database/migrations/041_rebuild_balances_from_paid_through.sql; \
--     echo "ROLLBACK;"; } | psql -v ON_ERROR_STOP=1'
--
-- Every NOTICE at the end still prints against the live data and the database
-- is left exactly as it was.


-- ---------------------------------------------------------------------------
-- 0. Refuse to run out of order
-- ---------------------------------------------------------------------------

DO $$
BEGIN
    IF to_regclass('public.account_ledger_entries') IS NULL THEN
        RAISE EXCEPTION 'account_ledger_entries is missing - run migrations 026 and 038 first';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'payments'
          AND column_name = 'month_paid'
    ) THEN
        RAISE EXCEPTION 'payments.month_paid is missing - this migration depends on it';
    END IF;
END $$;


-- ---------------------------------------------------------------------------
-- 1. Keep the evidence of what this changed
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.legacy_balance_rebuild (
    customer_id           INTEGER PRIMARY KEY
                          REFERENCES public.customers(customer_id) ON DELETE CASCADE,
    balance_before        NUMERIC(14,2),
    balance_after         NUMERIC(14,2),
    paid_through          DATE,
    billing_start_date    DATE,
    basis                 TEXT NOT NULL,
    activation_date_before DATE,
    activation_date_after  DATE,
    rebuilt_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TEMP TABLE balance_before ON COMMIT DROP AS
SELECT customer_id, outstanding_balance
FROM public.customer_billing_status;


-- ---------------------------------------------------------------------------
-- 2. Impossible activation dates
-- ---------------------------------------------------------------------------
-- Anything dated before 2010 predates the company's records. Kim's rule:
-- fall back to the customer's first known monthly-fee payment. Today this
-- catches exactly one record (8327, dated 1938); the rule is written
-- generally so a future bad keying does not need a code change.

CREATE TEMP TABLE activation_fix ON COMMIT DROP AS
SELECT
    c.customer_id,
    c.activation_date  AS old_activation_date,
    c.reactivation_date AS old_reactivation_date,
    MIN(p.payment_date) AS first_monthly_payment
FROM public.customers c
JOIN public.payments p
  ON p.customer_id = c.customer_id
 AND p.voided_at IS NULL
 AND COALESCE(p.payment_type, p.legacy_payment_type) = 'Monthly Fee'
 AND p.payment_date IS NOT NULL
WHERE c.activation_date < DATE '2010-01-01'
GROUP BY c.customer_id, c.activation_date, c.reactivation_date;

UPDATE public.customers c
SET activation_date = f.first_monthly_payment,
    reactivation_date = CASE
        WHEN c.reactivation_date < DATE '2010-01-01' THEN f.first_monthly_payment
        ELSE c.reactivation_date
    END
FROM activation_fix f
WHERE c.customer_id = f.customer_id;


-- ---------------------------------------------------------------------------
-- 3. Paid-through date per customer
-- ---------------------------------------------------------------------------
-- Derived from LEGACY payments only (legacy_payment_id IS NOT NULL). Payments
-- taken in SPCL since the cutover are deliberately excluded here so that they
-- keep working as ordinary ledger credits instead of being counted twice.
--
--   month_paid        - Access's own "Month Paid For". Best evidence.
--   payment_date      - fallback where the cashier left Month Paid For blank.
--   activation_date   - last resort; the customer has no payment history.
--
-- Values more than three months in the future are keying errors (there are 38
-- rows dated 2027) and are ignored.
--
-- The catch-up trap: a customer clearing years of arrears is often keyed as
-- one lump with Month Paid For left blank. Customer 1577 paid $192,000 in a
-- single line on 12 June 2026 against a $4,000 fee, and her last itemised
-- month is June 2022. Reading Month Paid For alone would bill her for 49
-- months she has already settled. So money paid after the last itemised month
-- and never allocated to one is converted back into whole months at the
-- customer's rate and added to the paid-through date. 536 customers carry
-- $10.3M of such payments.

CREATE TABLE IF NOT EXISTS public.customer_billing_start (
    customer_id        INTEGER PRIMARY KEY
                       REFERENCES public.customers(customer_id) ON DELETE CASCADE,
    billing_start_date DATE NOT NULL,
    paid_through       DATE,
    -- The effective_date the legacy rate row had BEFORE step 3b backdated it.
    -- Charges older than this are billed at an assumed rate, so they stay
    -- marked unverified. Written once and never overwritten, so re-running
    -- this migration cannot quietly promote an estimate to a fact.
    rate_verified_from DATE,
    basis              TEXT NOT NULL CHECK (basis IN (
                           'month_paid', 'payment_date', 'activation_date'
                       )),
    -- Catch-up money that was never allocated to a month, and the whole months
    -- of service it bought. Kept so the office can see why a paid-through date
    -- is later than the last itemised Month Paid For.
    unallocated_credit      NUMERIC(14,2) NOT NULL DEFAULT 0,
    months_from_unallocated INTEGER NOT NULL DEFAULT 0,
    note               TEXT,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE public.customer_billing_start IS
'Anniversary charges are only owed for due dates AFTER billing_start_date. '
'Set once at the legacy rebuild (migration 041) from Access''s Month Paid For '
'column. Head office may correct a row; charges regenerate from it.';

CREATE TEMP TABLE paid_through_calc ON COMMIT DROP AS
WITH legacy_monthly AS (
    SELECT
        p.customer_id,
        MAX(p.month_paid) FILTER (
            WHERE p.month_paid IS NOT NULL
              AND p.month_paid <= ((CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE
                                   + INTERVAL '3 months')::DATE
        ) AS latest_month_paid,
        MAX(p.payment_date) AS latest_payment_date
    FROM public.payments p
    WHERE p.customer_id IS NOT NULL
      AND p.legacy_payment_id IS NOT NULL
      AND p.voided_at IS NULL
      AND COALESCE(p.payment_type, p.legacy_payment_type) = 'Monthly Fee'
      AND p.amount_paid > 0
    GROUP BY p.customer_id
),
unallocated AS (
    SELECT p.customer_id, SUM(p.amount_paid) AS amount
    FROM public.payments p
    JOIN legacy_monthly m ON m.customer_id = p.customer_id
    WHERE p.legacy_payment_id IS NOT NULL
      AND p.voided_at IS NULL
      AND COALESCE(p.payment_type, p.legacy_payment_type) = 'Monthly Fee'
      AND p.amount_paid > 0
      AND p.month_paid IS NULL
      AND m.latest_month_paid IS NOT NULL
      AND p.payment_date > m.latest_month_paid
    GROUP BY p.customer_id
),
rate AS (
    SELECT c.customer_id,
        COALESCE(
            (SELECT r.monthly_fee FROM public.customer_rate_history r
             WHERE r.source_key = 'legacy-rate-window:' || c.customer_id::TEXT),
            c.monthly_fee
        ) AS monthly_fee
    FROM public.customers c
),
extra AS (
    SELECT
        u.customer_id,
        u.amount,
        CASE WHEN r.monthly_fee > 0
             THEN LEAST(FLOOR(u.amount / r.monthly_fee)::INTEGER, 600)
             ELSE 0
        END AS months
    FROM unallocated u
    JOIN rate r ON r.customer_id = u.customer_id
)
SELECT
    c.customer_id,
    CASE
        WHEN m.latest_month_paid IS NOT NULL THEN LEAST(
            (m.latest_month_paid + (COALESCE(e.months, 0) || ' months')::INTERVAL)::DATE,
            ((CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE + INTERVAL '3 months')::DATE
        )
        ELSE m.latest_payment_date
    END AS paid_through,
    CASE
        WHEN m.latest_month_paid   IS NOT NULL THEN 'month_paid'
        WHEN m.latest_payment_date IS NOT NULL THEN 'payment_date'
        ELSE 'activation_date'
    END AS basis,
    COALESCE(e.amount, 0)::NUMERIC(14,2) AS unallocated_credit,
    COALESCE(e.months, 0) AS months_from_unallocated
FROM public.customers c
LEFT JOIN legacy_monthly m ON m.customer_id = c.customer_id
LEFT JOIN extra e ON e.customer_id = c.customer_id
WHERE c.activation_date IS NOT NULL;

INSERT INTO public.customer_billing_start (
    customer_id, billing_start_date, paid_through, rate_verified_from, basis,
    unallocated_credit, months_from_unallocated, note
)
SELECT
    t.customer_id,
    CASE
        WHEN t.paid_through IS NULL
            THEN COALESCE(c.reactivation_date, c.activation_date)
        -- The anniversary inside the paid-through month counts as covered.
        ELSE GREATEST(
            public.spcl_anniversary_date(c.activation_date, t.paid_through),
            COALESCE(c.reactivation_date, c.activation_date)
        )
    END,
    t.paid_through,
    (
        SELECT r.effective_date
        FROM public.customer_rate_history r
        WHERE r.source_key = 'legacy-rate-window:' || t.customer_id::TEXT
    ),
    t.basis,
    t.unallocated_credit,
    t.months_from_unallocated,
    CASE
        WHEN t.months_from_unallocated > 0 THEN
            'Latest Access "Month Paid For", advanced ' || t.months_from_unallocated
            || ' month(s) for ' || t.unallocated_credit::TEXT
            || ' of catch-up payments that were never allocated to a month'
        WHEN t.basis = 'month_paid'   THEN 'Latest Access "Month Paid For" on a legacy monthly payment'
        WHEN t.basis = 'payment_date' THEN 'Month Paid For was blank; latest legacy monthly payment date used'
        ELSE                               'No legacy monthly payments on record; billed from activation'
    END
FROM paid_through_calc t
JOIN public.customers c ON c.customer_id = t.customer_id
ON CONFLICT (customer_id) DO UPDATE SET
    billing_start_date = EXCLUDED.billing_start_date,
    paid_through       = EXCLUDED.paid_through,
    rate_verified_from = COALESCE(
        public.customer_billing_start.rate_verified_from,
        EXCLUDED.rate_verified_from
    ),
    basis              = EXCLUDED.basis,
    unallocated_credit      = EXCLUDED.unallocated_credit,
    months_from_unallocated = EXCLUDED.months_from_unallocated,
    note               = EXCLUDED.note,
    updated_at         = CURRENT_TIMESTAMP;


-- ---------------------------------------------------------------------------
-- 3b. Let the rate history reach back as far as the arrears do
-- ---------------------------------------------------------------------------
-- Migration 026 seeded one rate row per customer, effective from exactly one
-- year ago. The charge generator joins the newest rate whose effective_date is
-- on or before the due date, so a due date older than that seed silently
-- produces no charge at all. That is how a customer three years behind was
-- showing only twelve months of charges under the old ledger.
--
-- Backdate the seeded row to the customer's billing start so real arrears can
-- be charged. It carries the customer's current fee, which is an assumption
-- about the past - charges dated before the original seed stay marked
-- unverified in step 5 for exactly that reason.

UPDATE public.customer_rate_history r
SET effective_date = LEAST(r.effective_date, bs.billing_start_date),
    reason = r.reason || ' (backdated to the paid-through date by migration 041)'
FROM public.customer_billing_start bs
WHERE bs.customer_id = r.customer_id
  AND r.source_key LIKE 'legacy-rate-window:%'
  AND bs.billing_start_date < r.effective_date;


-- ---------------------------------------------------------------------------
-- 4. Clear the old reconstruction
-- ---------------------------------------------------------------------------
-- Deleted:
--   * every estimated opening balance
--   * every reconstructed monthly charge (rebuilt in step 5)
--   * the ledger credits for LEGACY payments, because paid-through already
--     accounts for them
--
-- Kept: reconnection fees, waivers, adjustments, payment voids, and every
-- payment taken in SPCL since the cutover.

DELETE FROM public.account_ledger_entries
WHERE source_key LIKE 'legacy-opening-balance:%';

DELETE FROM public.account_ledger_entries
WHERE source_key LIKE 'monthly-charge:%';

DELETE FROM public.account_ledger_entries ledger
USING public.payments p
WHERE ledger.payment_id = p.payment_id
  AND ledger.entry_type = 'monthly_payment'
  AND p.legacy_payment_id IS NOT NULL;


-- ---------------------------------------------------------------------------
-- 5. Rebuild the charges from the paid-through date
-- ---------------------------------------------------------------------------
-- Not capped to one year: a customer genuinely two years behind should show
-- two years. These charges are marked verified because they now trace to a
-- real Access record rather than to a guess.

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
    -- Verified where the fee is known to have applied; unverified where we are
    -- assuming today's fee applied to a month before the rate window began.
    (due.due_date >= COALESCE(bs.rate_verified_from, due.due_date)),
    'monthly-charge:' || c.customer_id::TEXT || ':' || due.due_date::TEXT
FROM public.customers c
JOIN public.customer_billing_start bs ON bs.customer_id = c.customer_id
CROSS JOIN LATERAL GENERATE_SERIES(
    DATE_TRUNC('month', bs.billing_start_date),
    DATE_TRUNC('month', (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE),
    INTERVAL '1 month'
) month_value
CROSS JOIN LATERAL (
    SELECT public.spcl_anniversary_date(c.activation_date, month_value::DATE) AS due_date
) due
JOIN LATERAL (
    SELECT r.customer_rate_history_id, r.monthly_fee
    FROM public.customer_rate_history r
    WHERE r.customer_id = c.customer_id
      AND r.effective_date <= due.due_date
    ORDER BY r.effective_date DESC, r.customer_rate_history_id DESC
    LIMIT 1
) rate ON TRUE
WHERE c.activation_date IS NOT NULL
  AND c.monthly_fee IS NOT NULL
  AND rate.monthly_fee > 0
  AND due.due_date > bs.billing_start_date
  AND due.due_date > COALESCE(c.reactivation_date, c.activation_date)
  AND due.due_date <= (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE
  AND (
      c.status NOT IN ('disconnected', 'pending_reconnection', 'closed', 'archived')
      OR c.deactivation_date IS NULL
      OR due.due_date < c.deactivation_date
  )
ON CONFLICT (source_key) DO NOTHING;


-- ---------------------------------------------------------------------------
-- 6. Teach the ongoing generator about the paid-through floor
-- ---------------------------------------------------------------------------
-- Same function as migration 026 with one addition: a customer is never
-- charged for an anniversary on or before their billing_start_date. Without
-- this, the next nightly run would put the deleted months straight back.

CREATE OR REPLACE FUNCTION public.spcl_generate_monthly_charges(as_of_date DATE)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
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

-- ---------------------------------------------------------------------------
-- 6b. Same floor for the single-customer rebuild from migration 040
-- ---------------------------------------------------------------------------
-- spcl_regenerate_customer_charges deletes and rebuilds one customer's charges
-- after head office corrects an activation date. Left as migration 040 wrote
-- it, that rebuild would ignore the paid-through floor and re-inflate exactly
-- the balance this migration just fixed - for one customer, silently, weeks
-- from now. It gets the same floor.

CREATE OR REPLACE FUNCTION public.spcl_regenerate_customer_charges(
    target_customer INTEGER,
    as_of_date DATE
)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
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
          c.status NOT IN ('disconnected', 'pending_reconnection', 'closed', 'archived')
          OR c.deactivation_date IS NULL
          OR due.due_date < c.deactivation_date
      )
    ON CONFLICT (source_key) DO NOTHING;

    GET DIAGNOSTICS inserted_count = ROW_COUNT;

    RETURN inserted_count;
END;
$$;


-- Step 5 already generated everything through today. Move the watermark so the
-- next page load is a no-op rather than a second pass over the same months.
UPDATE public.billing_generation_state
SET generated_through = (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
    updated_at = CURRENT_TIMESTAMP
WHERE singleton = TRUE;


-- ---------------------------------------------------------------------------
-- 7. Record what changed
-- ---------------------------------------------------------------------------

INSERT INTO public.legacy_balance_rebuild (
    customer_id, balance_before, balance_after, paid_through,
    billing_start_date, basis, activation_date_before, activation_date_after
)
SELECT
    c.customer_id,
    b.outstanding_balance,
    s.outstanding_balance,
    bs.paid_through,
    bs.billing_start_date,
    -- 35 legacy records have no activation date at all, so they never get a
    -- billing start and are never charged. Recorded rather than skipped.
    COALESCE(bs.basis, 'no_activation_date'),
    f.old_activation_date,
    CASE WHEN f.customer_id IS NOT NULL THEN c.activation_date END
FROM public.customers c
JOIN public.customer_billing_status s ON s.customer_id = c.customer_id
LEFT JOIN balance_before b ON b.customer_id = c.customer_id
LEFT JOIN public.customer_billing_start bs ON bs.customer_id = c.customer_id
LEFT JOIN activation_fix f ON f.customer_id = c.customer_id
ON CONFLICT (customer_id) DO UPDATE SET
    balance_before         = EXCLUDED.balance_before,
    balance_after          = EXCLUDED.balance_after,
    paid_through           = EXCLUDED.paid_through,
    billing_start_date     = EXCLUDED.billing_start_date,
    basis                  = EXCLUDED.basis,
    activation_date_before = EXCLUDED.activation_date_before,
    activation_date_after  = EXCLUDED.activation_date_after,
    rebuilt_at             = CURRENT_TIMESTAMP;


-- ---------------------------------------------------------------------------
-- 8. Prove it worked
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    delinquent_before INTEGER;
    delinquent_after  INTEGER;
    owed_before       NUMERIC;
    owed_after        NUMERIC;
    worst             NUMERIC;
    still_estimated   INTEGER;
BEGIN
    SELECT COUNT(*), COALESCE(SUM(outstanding_balance), 0)
    INTO delinquent_before, owed_before
    FROM balance_before WHERE outstanding_balance > 0;

    SELECT COUNT(*), COALESCE(SUM(outstanding_balance), 0)
    INTO delinquent_after, owed_after
    FROM public.customer_billing_status WHERE is_delinquent;

    SELECT COALESCE(MAX(outstanding_balance), 0)
    INTO worst FROM public.customer_billing_status;

    SELECT COUNT(*) INTO still_estimated
    FROM public.account_ledger_entries WHERE is_verified = FALSE;

    RAISE NOTICE 'Owed before rebuild: %', owed_before;
    RAISE NOTICE 'Delinquent after rebuild: % customers owing %',
        delinquent_after, owed_after;
    RAISE NOTICE 'Largest single balance now: %', worst;
    RAISE NOTICE 'Ledger rows still marked estimated: %', still_estimated;

    -- The largest legitimate balance is a $30,000/month commercial account
    -- that has never paid. Anything past $2M is the old lifetime-billing bug.
    IF worst > 2000000 THEN
        RAISE EXCEPTION
            'Rebuild left a balance of % - that is still not credible, stopping', worst;
    END IF;
END $$;

