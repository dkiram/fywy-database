BEGIN;
SET LOCAL lock_timeout='5s';
-- Keep accepted monthly receipts and the ledger equal while older API builds
-- still cap past-month deductions. The API uses the same payment:<id> key and
-- ON CONFLICT DO NOTHING, so its later insert cannot duplicate this credit.
-- Imported legacy payments retain their paid-through reconstruction semantics.
CREATE OR REPLACE FUNCTION public.spcl_record_full_monthly_receipt()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.customer_id IS NULL OR NEW.payment_type IS DISTINCT FROM 'Monthly Fee'
     OR NEW.amount_paid IS NULL OR NEW.amount_paid <= 0 OR NEW.voided_at IS NOT NULL
     OR NEW.legacy_payment_id IS NOT NULL OR NEW.source_staging_id IS NOT NULL
     OR NEW.recorded_at IS NULL THEN
    RETURN NEW;
  END IF;
  PERFORM 1 FROM public.customers WHERE customer_id=NEW.customer_id FOR UPDATE;
  INSERT INTO public.account_ledger_entries (
    customer_id, entry_type, amount, effective_date, description, payment_id,
    created_by_employee_id, reason, source_key
  ) VALUES (
    NEW.customer_id, 'monthly_payment', -NEW.amount_paid,
    (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
    'Monthly fee payment', NEW.payment_id, NEW.recorded_by_employee_id,
    'Full receipt credited; any amount beyond outstanding debt remains as credit.',
    'payment:' || NEW.payment_id::TEXT
  ) ON CONFLICT (source_key) DO NOTHING;
  RETURN NEW;
END $$;

CREATE OR REPLACE TRIGGER trg_full_monthly_receipt_credit
AFTER INSERT ON public.payments
FOR EACH ROW EXECUTE FUNCTION public.spcl_record_full_monthly_receipt();

INSERT INTO public.customers(customer_id,name,status,monthly_fee,activation_date,hidden_from_app)
VALUES(-2147483000,'Reconciliation validation - rolled back','active',2500,DATE '2026-01-04',TRUE);
INSERT INTO public.payments(payment_id,customer_id,payment_type,amount_paid,payment_date,month_paid,recorded_at,recorded_by_employee_id)
VALUES(-2147483000,-2147483000,'Monthly Fee',2500,DATE '2026-09-15',DATE '2026-08-01',CURRENT_TIMESTAMP,2);
-- Simulate the older API attempting a capped ledger deduction.
INSERT INTO public.account_ledger_entries(customer_id,entry_type,amount,effective_date,description,payment_id,source_key)
VALUES(-2147483000,'monthly_payment',-1000,DATE '2026-09-15','Older API duplicate attempt',-2147483000,'payment:-2147483000')
ON CONFLICT(source_key) DO NOTHING;
INSERT INTO public.payments(payment_id,customer_id,payment_type,amount_paid,payment_date,month_paid,recorded_at,recorded_by_employee_id)
VALUES(-2147482999,-2147483000,'Monthly Fee',500,DATE '2026-09-15',DATE '2026-08-01',CURRENT_TIMESTAMP,2);
INSERT INTO public.payments(payment_id,customer_id,payment_type,amount_paid,payment_date,month_paid,recorded_at,legacy_payment_id)
VALUES(-2147482998,-2147483000,'Monthly Fee',2500,DATE '2026-09-15',DATE '2026-08-01',CURRENT_TIMESTAMP,-2147483000);
INSERT INTO public.payments(payment_id,customer_id,payment_type,amount_paid,payment_date,recorded_at)
VALUES(-2147482997,-2147483000,'Reconnection Fee',1500,DATE '2026-09-15',CURRENT_TIMESTAMP);
DO $$ BEGIN
 IF (SELECT COUNT(*) FROM public.account_ledger_entries WHERE customer_id=-2147483000)<>2
 OR (SELECT SUM(amount) FROM public.account_ledger_entries WHERE customer_id=-2147483000)<>-3000 THEN
  RAISE EXCEPTION 'Full receipt, legacy skip, service fee skip or duplicate protection failed';
 END IF;
END $$;
-- Simulate existing API void behavior: its first original row must be full value.
INSERT INTO public.account_ledger_entries(customer_id,entry_type,amount,effective_date,description,payment_id,source_key)
SELECT customer_id,'payment_void',-amount,DATE '2026-09-15','Test void',payment_id,'payment-void:'||payment_id::TEXT
FROM public.account_ledger_entries WHERE payment_id=-2147483000 AND entry_type='monthly_payment'
ORDER BY account_ledger_entry_id LIMIT 1;
DO $$ BEGIN
 IF (SELECT SUM(amount) FROM public.account_ledger_entries WHERE customer_id=-2147483000)<>-500 THEN
  RAISE EXCEPTION 'Void did not reverse the full original receipt';
 END IF;
END $$;
SELECT 'PASS: full credit, older API deduplication, legacy/service exclusions and full void reversal' AS validation;
ROLLBACK;
