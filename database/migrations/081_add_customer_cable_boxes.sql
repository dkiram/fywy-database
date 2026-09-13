-- Store extra boxes per account; the package includes the first cable box.
-- Existing rates and all payment/ledger records remain untouched.
ALTER TABLE public.customers
  ADD COLUMN additional_cable_boxes INTEGER NOT NULL DEFAULT 0
  CHECK (additional_cable_boxes >= 0);
