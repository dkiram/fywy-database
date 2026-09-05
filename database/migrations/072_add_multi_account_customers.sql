-- 072: group multiple service accounts under one customer display.
--
-- Each row in customers remains a complete, independently billed service
-- account. The group supplies only the durable person/household relationship;
-- payments, billing dates, balances, OLT assignments and lifecycle state stay
-- attached to the individual customer_id exactly as they are today.

CREATE TABLE IF NOT EXISTS public.customer_account_groups (
    account_group_id BIGSERIAL PRIMARY KEY,
    display_name TEXT NOT NULL,
    created_by_employee_id BIGINT
        REFERENCES public.employees(employee_id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (BTRIM(display_name) <> '')
);

ALTER TABLE public.customers
ADD COLUMN IF NOT EXISTS account_group_id BIGINT
    REFERENCES public.customer_account_groups(account_group_id)
    ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_customers_account_group
ON public.customers (account_group_id, customer_id)
WHERE account_group_id IS NOT NULL;

-- This is an explicit intake decision, not a fuzzy-match suggestion. It tells
-- activation to create a new service account and group it with the selected
-- existing customer instead of overwriting or reusing that customer's account.
ALTER TABLE public.applications
ADD COLUMN IF NOT EXISTS additional_service_for_customer_id INTEGER
    REFERENCES public.customers(customer_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_applications_additional_service_customer
ON public.applications (additional_service_for_customer_id)
WHERE additional_service_for_customer_id IS NOT NULL;

COMMENT ON TABLE public.customer_account_groups IS
'A customer-facing grouping of independently billed service accounts.';

COMMENT ON COLUMN public.customers.account_group_id IS
'Optional customer-facing group. Operational and financial records remain scoped to customer_id.';

COMMENT ON COLUMN public.applications.additional_service_for_customer_id IS
'Existing customer selected at intake when this application is for a new, separately billed service account for the same person.';
