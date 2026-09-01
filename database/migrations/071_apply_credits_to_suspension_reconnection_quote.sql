-- 071: let account credit cover the fee quoted for ending a suspension.
--
-- customer_billing_status.outstanding_balance is deliberately floored at
-- zero, while credit_balance is shown separately. Adding the suspension fee
-- to outstanding_balance therefore ignored money already sitting in the
-- customer's favour. Use the signed balance, add the fee, then floor only the
-- final amount due at zero.

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
JOIN public.customer_billing_status billing
  ON billing.customer_id = episode.customer_id
LEFT JOIN public.packages package
  ON package.package_id = customer.package_id
CROSS JOIN public.suspension_terms terms
WHERE episode.ended_on IS NULL
  AND customer.status = 'suspended';

COMMENT ON VIEW public.customer_suspension_status IS
    'One row per currently-suspended customer: when it started, what coming '
    'back costs today after applying account credit, and the date after which '
    'that price rises.';
