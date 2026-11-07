-- Refunds preserve the collection and post a separate, approved cash outflow.
BEGIN;
CREATE TABLE public.application_refunds (
  application_refund_id BIGSERIAL PRIMARY KEY,
  application_id BIGINT NOT NULL REFERENCES public.applications(application_id),
  payment_id BIGINT NOT NULL REFERENCES public.payments(payment_id),
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  returned_on DATE NOT NULL,
  location_id SMALLINT NOT NULL REFERENCES public.locations(location_id),
  location_name TEXT NOT NULL,
  requested_by_employee_id BIGINT NOT NULL REFERENCES public.employees(employee_id),
  cashier_name TEXT NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by_employee_id BIGINT REFERENCES public.employees(employee_id),
  reviewed_at TIMESTAMPTZ,
  review_note TEXT,
  CHECK ((status = 'pending' AND reviewed_at IS NULL AND reviewed_by_employee_id IS NULL)
    OR (status <> 'pending' AND reviewed_at IS NOT NULL AND reviewed_by_employee_id IS NOT NULL))
);
CREATE INDEX application_refunds_history ON public.application_refunds(application_id, application_refund_id DESC);
CREATE INDEX application_refunds_payment ON public.application_refunds(payment_id);
CREATE UNIQUE INDEX application_refunds_one_live ON public.application_refunds(application_id)
 WHERE status IN ('pending', 'approved');
ALTER TABLE public.payments ADD COLUMN application_refund_id BIGINT UNIQUE
 REFERENCES public.application_refunds(application_refund_id);
ALTER TABLE public.payments ADD CONSTRAINT payments_refund_outflow CHECK (
 application_refund_id IS NULL OR
 (payment_type = 'Refund' AND amount_paid < 0 AND customer_id IS NULL AND application_id IS NOT NULL AND voided_at IS NULL)
);
DROP INDEX public.payments_application_active_unique;
CREATE UNIQUE INDEX payments_application_active_unique ON public.payments(application_id)
 WHERE application_id IS NOT NULL AND voided_at IS NULL AND application_refund_id IS NULL;

-- Protect money already handed back from being voided or altered through another workflow.
CREATE FUNCTION public.protect_application_refund_payment() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.application_refund_id IS NOT NULL OR EXISTS (
   SELECT 1 FROM public.application_refunds r WHERE r.payment_id = OLD.payment_id AND r.status IN ('pending', 'approved')
 ) THEN
   IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Refund-linked payments cannot be deleted'; END IF;
   IF NEW.amount_paid IS DISTINCT FROM OLD.amount_paid OR NEW.voided_at IS DISTINCT FROM OLD.voided_at
     OR NEW.application_id IS DISTINCT FROM OLD.application_id OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
     OR NEW.application_refund_id IS DISTINCT FROM OLD.application_refund_id
     OR NEW.payment_date IS DISTINCT FROM OLD.payment_date OR NEW.location_id IS DISTINCT FROM OLD.location_id
     OR NEW.location IS DISTINCT FROM OLD.location OR NEW.recorded_by_employee_id IS DISTINCT FROM OLD.recorded_by_employee_id
     OR NEW.cashier_name IS DISTINCT FROM OLD.cashier_name OR NEW.payment_type IS DISTINCT FROM OLD.payment_type
   THEN RAISE EXCEPTION 'Refund-linked payments cannot be changed'; END IF;
 END IF;
 IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER protect_application_refund_payment BEFORE UPDATE OR DELETE ON public.payments
 FOR EACH ROW EXECUTE FUNCTION public.protect_application_refund_payment();
COMMIT;
