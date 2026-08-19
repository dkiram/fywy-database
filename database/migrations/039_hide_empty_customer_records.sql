-- 039_hide_empty_customer_records.sql
--
-- Keeps blank customer rows in the database but out of the app.
--
-- The Access import brought over 37 customers with no name. Seven of those are
-- real people whose name simply was never typed - they have an address, a
-- phone number, a monthly fee, and in one case sixteen payments. Those stay
-- visible, because hiding a paying customer means the cashier cannot find them
-- when they walk in to pay.
--
-- The other thirty have nothing at all: no name, no address, no telephone, no
-- monthly fee, and no payment has ever been recorded against them. Those are
-- the ones this hides.
--
-- Nothing is deleted. The rows keep their customer_id, so anything that ever
-- referenced them still resolves, and a customer profile opened directly by id
-- still loads. Setting hidden_from_app back to FALSE brings one back.

ALTER TABLE public.customers
    ADD COLUMN IF NOT EXISTS hidden_from_app BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.customers.hidden_from_app IS
    'TRUE hides this customer from lists, searches, counts and reports. The '
    'row stays in the database and remains reachable by customer_id. Used for '
    'blank records inherited from Access, not for disconnection - a '
    'disconnected customer is still a customer and uses status instead.';


UPDATE public.customers c
SET hidden_from_app = TRUE
WHERE NULLIF(TRIM(COALESCE(c.name, '')), '') IS NULL
  AND NULLIF(TRIM(COALESCE(c.address, '')), '') IS NULL
  AND NULLIF(TRIM(COALESCE(c.telephone, '')), '') IS NULL
  AND c.monthly_fee IS NULL
  AND NOT EXISTS (
        SELECT 1 FROM public.payments p
         WHERE p.customer_id = c.customer_id
  );


-- A blank row is one thing; a customer with a name or a payment is another.
-- If the criteria above ever match more than a handful, something is wrong
-- with the data rather than with the criteria, and hiding real customers
-- silently is exactly the failure worth stopping for.

DO $$
DECLARE
    hidden_count  INTEGER;
    with_payments INTEGER;
    with_name     INTEGER;
BEGIN
    SELECT count(*) INTO hidden_count
      FROM public.customers WHERE hidden_from_app = TRUE;

    SELECT count(*) INTO with_payments
      FROM public.customers c
     WHERE c.hidden_from_app = TRUE
       AND EXISTS (SELECT 1 FROM public.payments p
                    WHERE p.customer_id = c.customer_id);

    SELECT count(*) INTO with_name
      FROM public.customers
     WHERE hidden_from_app = TRUE
       AND NULLIF(TRIM(COALESCE(name, '')), '') IS NOT NULL;

    RAISE NOTICE 'hidden % blank customer records', hidden_count;

    IF with_payments > 0 THEN
        RAISE EXCEPTION
            '% hidden customers have payment history - refusing to hide a '
            'customer who has paid', with_payments;
    END IF;

    IF with_name > 0 THEN
        RAISE EXCEPTION
            '% hidden customers have a name - refusing to hide a named '
            'customer', with_name;
    END IF;

    IF hidden_count > 100 THEN
        RAISE EXCEPTION
            'this would hide % customers, which is far more than the 30 blank '
            'records expected - stopping rather than emptying the customer '
            'list', hidden_count;
    END IF;
END $$;
