-- 073: accelerate the contains-style searches used by customer pickers.
--
-- Plain B-tree indexes cannot serve ILIKE '%text%'. Without trigram indexes,
-- each keystroke scans the customer table for name, telephone and the textual
-- form of the account number.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_customers_name_trgm
ON public.customers USING GIN (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_customers_telephone_trgm
ON public.customers USING GIN (telephone gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_customers_id_text_trgm
ON public.customers USING GIN ((customer_id::TEXT) gin_trgm_ops);
