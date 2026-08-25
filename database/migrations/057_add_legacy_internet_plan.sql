-- Adds a legacy 5 Mbps internet plan so long-time customers can stay on their
-- old rate. Not part of the standard published catalog from
-- 028_add_speed_package_catalog.sql, but reachable through Manage
-- Subscription on the customer profile page like any other active package.
INSERT INTO public.packages (
    package_id, name, installation_fee, default_monthly_charge,
    reconnection_fee, service_type, plan_tier, speed_mbps,
    is_active, display_order
)
VALUES (
    10, 'Old Internet (5 Mbps)', 7000, 2500,
    1500, 'internet', 'Legacy', 5,
    TRUE, 40
)
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
