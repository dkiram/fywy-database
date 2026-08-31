-- Disconnection eligibility follows the ledger grace period directly. The old
-- calculated date delayed every eligible account until a monthly 20th and is
-- no longer part of the billing model.

-- Keep the automation journal useful without retaining a planned cutoff date.
-- Existing outcomes, timestamps, balances, OLT attempts, and the factual
-- customer deactivation history are preserved; older run rows simply have no
-- grace-end snapshot because it cannot be reconstructed reliably from a 20th.
ALTER TABLE public.olt_automation_run_items
    ADD COLUMN grace_end_date DATE;

COMMENT ON COLUMN public.olt_automation_run_items.grace_end_date IS
  'Grace-period end used when this customer was selected for automatic disconnection.';

ALTER TABLE public.olt_automation_run_items
    DROP COLUMN scheduled_disconnection_date;

-- Keep the billing view's identity intact because customer_suspension_status
-- depends on it. Replace the obsolete output in the same column position with
-- the first date on which grace has actually ended. CREATE OR REPLACE can then
-- update the eligibility rule without dropping either view.
ALTER VIEW public.customer_billing_status
    RENAME COLUMN scheduled_disconnection_date TO disconnection_eligible_on;

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
         ELSE o.grace_end_date + 1
    END AS disconnection_eligible_on,
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
LEFT JOIN active_holds h USING (customer_id);

DROP FUNCTION public.spcl_scheduled_disconnection(DATE);
