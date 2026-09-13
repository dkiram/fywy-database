-- Offer the legacy bundle in Manage Subscription for existing customers.
-- Existing customer rates and payment history are unchanged.
INSERT INTO public.packages (
    package_id, name, installation_fee, default_monthly_charge,
    reconnection_fee, service_type, plan_tier, speed_mbps,
    is_active, display_order, available_for_new_applications
)
VALUES (
    11, 'Old Cable & Internet - 5Mbps', 11000, 4000,
    1500, 'cable_internet', 'Legacy', 5,
    TRUE, 41, FALSE
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
    display_order = EXCLUDED.display_order,
    available_for_new_applications = EXCLUDED.available_for_new_applications;
