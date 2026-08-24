-- 054_pause_billing_during_service_outages.sql
--
-- A monthly service charge is valid only when the account was active on that
-- charge's due date. The older generator compared every due date with the
-- customer's current status plus one deactivation/reactivation pair. That
-- cannot represent a second outage and can therefore charge a customer while
-- service is disconnected or awaiting reconnection.
--
-- The account status history is the durable service timeline. A BEFORE INSERT
-- guard makes every current and future monthly-charge path obey that timeline,
-- including the global generator and the single-customer rebuild function.
-- This migration deliberately does not delete or offset existing money; it
-- exposes suspect old charges in a review view so an Admin can make and audit
-- the financial decision.

BEGIN;

CREATE INDEX IF NOT EXISTS idx_account_status_history_customer_effective
ON public.account_status_history (
    customer_id,
    effective_date DESC,
    changed_at DESC,
    account_status_history_id DESC
);

CREATE OR REPLACE FUNCTION public.spcl_customer_service_active_on(
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
            SELECT history.to_status = 'active'
            FROM public.account_status_history history
            WHERE history.customer_id = target_customer
              AND history.effective_date <= service_date
            ORDER BY
                history.effective_date DESC,
                history.changed_at DESC,
                history.account_status_history_id DESC
            LIMIT 1
        ),
        (
            SELECT
                customer.activation_date IS NOT NULL
                AND service_date >= customer.activation_date
                AND NOT (
                    customer.deactivation_date IS NOT NULL
                    AND service_date >= customer.deactivation_date
                    AND (
                        customer.reactivation_date IS NULL
                        OR service_date < customer.reactivation_date
                    )
                )
            FROM public.customers customer
            WHERE customer.customer_id = target_customer
        ),
        FALSE
    );
$$;

COMMENT ON FUNCTION public.spcl_customer_service_active_on(INTEGER, DATE) IS
    'Returns whether the account service workflow was active on a date, using '
    'the latest status-history event on or before that date and legacy dates '
    'only when no historical event exists yet.';

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

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_offline_monthly_charge
ON public.account_ledger_entries;

CREATE TRIGGER trg_prevent_offline_monthly_charge
BEFORE INSERT ON public.account_ledger_entries
FOR EACH ROW
EXECUTE FUNCTION public.spcl_prevent_offline_monthly_charge();

CREATE OR REPLACE VIEW public.customer_offline_monthly_charge_review AS
SELECT
    ledger.customer_id,
    COUNT(*)::INTEGER AS charge_count,
    SUM(ledger.amount)::NUMERIC(14,2) AS charge_amount,
    MIN(COALESCE(ledger.due_date, ledger.effective_date)) AS first_charge_date,
    MAX(COALESCE(ledger.due_date, ledger.effective_date)) AS last_charge_date
FROM public.account_ledger_entries ledger
WHERE ledger.entry_type = 'monthly_charge'
  AND NOT public.spcl_customer_service_active_on(
      ledger.customer_id,
      COALESCE(ledger.due_date, ledger.effective_date)
  )
GROUP BY ledger.customer_id;

COMMENT ON VIEW public.customer_offline_monthly_charge_review IS
    'Existing monthly charges that overlap a non-active account-status date. '
    'Review before applying a waiver; this view never changes ledger money.';

COMMIT;
