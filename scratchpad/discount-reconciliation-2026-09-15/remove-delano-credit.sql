-- Explicitly requested removal of J$2,500 credit; valid August receipt stays.
BEGIN;
SET LOCAL lock_timeout='10s';
LOCK TABLE public.customers,public.payments,public.account_ledger_entries,public.audit_logs
 IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.account_ledger_entries
   WHERE source_key='delano-credit-removal-20260915:14754') THEN
   RAISE EXCEPTION 'Credit removal already applied'; END IF;
 IF (SELECT SUM(amount) FROM public.account_ledger_entries WHERE customer_id=14754) IS DISTINCT FROM -2500::numeric THEN
   RAISE EXCEPTION 'Balance changed; refresh before removing credit'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.payments WHERE payment_id=442287 AND customer_id=14754
   AND amount_paid=2500 AND month_paid=DATE '2026-08-01' AND voided_at IS NULL) THEN
   RAISE EXCEPTION 'Valid August receipt changed'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.payments WHERE payment_id=442123 AND customer_id=14754 AND voided_at IS NOT NULL) THEN
   RAISE EXCEPTION 'Prior void changed'; END IF;
END $$;
INSERT INTO public.account_ledger_entries(customer_id,entry_type,amount,effective_date,
 description,created_by_employee_id,reason,is_verified,source_key)
VALUES(14754,'adjustment',2500,DATE '2026-09-15','Management removal of remaining account credit',2,
 'User requested removal of the remaining J$2,500 credit. Valid August receipt 442287 is preserved; historical paid-through schedule is not changed.',TRUE,
 'delano-credit-removal-20260915:14754');
INSERT INTO public.audit_logs(employee_id,actor_name,action,entity_type,entity_id,
 field_name,old_value,new_value,reason,source_key)
SELECT 2,CONCAT_WS(' ',first_name,last_name),'Removed account credit as instructed','customer','14754',
 'balance','-2500.00','0.00','Explicit user instruction; August receipt remains valid.',
 'delano-credit-removal-20260915:14754' FROM public.employees WHERE employee_id=2;
DO $$ BEGIN
 IF (SELECT SUM(amount) FROM public.account_ledger_entries WHERE customer_id=14754) IS DISTINCT FROM 0::numeric THEN
   RAISE EXCEPTION 'Expected zero balance after removal'; END IF;
END $$;
COMMIT;
