-- 040_regenerate_customer_charges.sql
--
-- Lets one customer's monthly charges be rebuilt after their activation date
-- is corrected.
--
-- Activation date is the billing anchor: spcl_generate_monthly_charges derives
-- every due date from it, and each charge is keyed
-- 'monthly-charge:<customer>:<due date>' with ON CONFLICT DO NOTHING. Move the
-- anchor without cleaning up and the next run writes a second set of charges on
-- the new anniversary while the old set stays exactly where it was. The
-- customer silently owes twice, and nobody finds out until they argue about a
-- bill.
--
-- So the date can only be corrected together with a rebuild. This function is
-- that rebuild, scoped to one customer.
--
-- It deliberately does NOT touch the global billing watermark. Rewinding that
-- would re-run generation for all eleven thousand customers to fix one, which
-- is both slow and a much wider blast radius than the problem deserves.

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
    -- A waiver is a decision somebody made about real money on this account.
    -- The waiver credit itself is a separate ledger entry and would survive the
    -- delete, but it was granted against a specific charge on a specific date -
    -- rebuild the charges underneath it and the credit no longer answers to
    -- anything. Refuse plainly rather than leave a dangling adjustment.
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

    -- The same one-year reconstruction window the global generator uses, so a
    -- rebuilt customer is indistinguishable from one that was never edited.
    generation_start := (as_of_date - INTERVAL '1 year')::DATE;

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
    WHERE c.customer_id = target_customer
      AND c.activation_date IS NOT NULL
      AND c.monthly_fee IS NOT NULL
      AND rate.monthly_fee > 0
      AND due.due_date > COALESCE(c.reactivation_date, c.activation_date)
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

COMMENT ON FUNCTION public.spcl_regenerate_customer_charges(INTEGER, DATE) IS
    'Rebuilds one customer''s monthly charges from their current activation '
    'date, over the same one-year window the global generator uses. Called '
    'after an activation date correction. Refuses if any charge has been '
    'waived. Does not touch billing_generation_state.';
