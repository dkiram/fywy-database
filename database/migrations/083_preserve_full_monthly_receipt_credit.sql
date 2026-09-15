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
