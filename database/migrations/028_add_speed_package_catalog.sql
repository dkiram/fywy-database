-- Adds the published FYWY internet speeds without rewriting customer rates.
-- Package rows are the current catalog; customer_rate_history remains the
-- source of truth for what each customer was actually billed over time.
ALTER TABLE public.packages
ADD COLUMN IF NOT EXISTS service_type TEXT,
ADD COLUMN IF NOT EXISTS plan_tier TEXT,
ADD COLUMN IF NOT EXISTS speed_mbps INTEGER,
ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE,
ADD COLUMN IF NOT EXISTS display_order SMALLINT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'packages_service_type_check'
          AND conrelid = 'public.packages'::REGCLASS
    ) THEN
        ALTER TABLE public.packages
        ADD CONSTRAINT packages_service_type_check
        CHECK (service_type IN ('cable', 'internet', 'cable_internet'));
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'packages_speed_mbps_check'
          AND conrelid = 'public.packages'::REGCLASS
    ) THEN
        ALTER TABLE public.packages
        ADD CONSTRAINT packages_speed_mbps_check
        CHECK (speed_mbps IS NULL OR speed_mbps > 0);
    END IF;
END;
$$;

-- Keep the three legacy identifiers stable because customers and applications
-- already reference them. IDs 2 and 3 become the published 10 Mbps tiers.
INSERT INTO public.packages (
    package_id, name, installation_fee, default_monthly_charge,
    reconnection_fee, service_type, plan_tier, speed_mbps,
    is_active, display_order
)
VALUES
    (1, 'Cable Only', 4500, 2500, 1500, 'cable', 'Cable', NULL, TRUE, 10),
    (2, 'Internet — Starter (10 Mbps)', 7000, 3000, 1500, 'internet', 'Starter', 10, TRUE, 20),
    (4, 'Internet — Family (25 Mbps)', 7000, 4000, 1500, 'internet', 'Family', 25, TRUE, 21),
    (5, 'Internet — Power (50 Mbps)', 7000, 5000, 1500, 'internet', 'Power', 50, TRUE, 22),
    (6, 'Internet — Business (100 Mbps)', 7000, 7500, 1500, 'internet', 'Business', 100, TRUE, 23),
    (3, 'Cable & Internet — Starter (10 Mbps)', 11000, 4500, 1500, 'cable_internet', 'Starter', 10, TRUE, 30),
    (7, 'Cable & Internet — Family (25 Mbps)', 11000, 5500, 1500, 'cable_internet', 'Family', 25, TRUE, 31),
    (8, 'Cable & Internet — Power (50 Mbps)', 11000, 6500, 1500, 'cable_internet', 'Power', 50, TRUE, 32),
    (9, 'Cable & Internet — Business (100 Mbps)', 11000, 9000, 1500, 'cable_internet', 'Business', 100, TRUE, 33)
ON CONFLICT (package_id) DO UPDATE SET
    name = EXCLUDED.name,
    installation_fee = EXCLUDED.installation_fee,
    default_monthly_charge = EXCLUDED.default_monthly_charge,
    reconnection_fee = EXCLUDED.reconnection_fee,
    service_type = EXCLUDED.service_type,
    plan_tier = EXCLUDED.plan_tier,
    speed_mbps = EXCLUDED.speed_mbps,
    is_active = EXCLUDED.is_active,
    display_order = EXCLUDED.display_order;

-- Any unexpected legacy catalog rows stay referenceable for historical data,
-- but are not offered for new applications or subscription changes.
UPDATE public.packages
SET is_active = FALSE
WHERE package_id NOT IN (1, 2, 3, 4, 5, 6, 7, 8, 9);

-- Record the package beside every effective-dated rate so later reporting can
-- explain which speed/service produced a charge without altering old ledgers.
ALTER TABLE public.customer_rate_history
ADD COLUMN IF NOT EXISTS package_id SMALLINT
    REFERENCES public.packages(package_id) ON DELETE RESTRICT;

UPDATE public.customer_rate_history history
SET package_id = customer.package_id
FROM public.customers customer
WHERE customer.customer_id = history.customer_id
  AND history.package_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_customer_rate_history_package
ON public.customer_rate_history (package_id);
