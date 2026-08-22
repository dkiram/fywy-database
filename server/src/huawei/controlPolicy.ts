/** Centralizes the two independent Huawei ONT write safety policies. */

function enabled(value: string | undefined) {
  return value?.trim().toLowerCase() === "true";
}

function customerIds(value: string | undefined) {
  return new Set(
    (value ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter((item) => /^\d+$/.test(item))
      .map(Number)
  );
}

// The profile-card controls are intentionally limited to supervised testing.
export function getTestOntControlPolicy(customerId: number) {
  const isEnabled = enabled(process.env.HUAWEI_OLT_WRITES_ENABLED);
  const allowlisted = customerIds(process.env.HUAWEI_OLT_WRITE_CUSTOMER_IDS).has(customerId);
  return { enabled: isEnabled, allowlisted };
}

// Normal account deactivation/reconnection has its own gate and allowlist.
// This prevents enabling a one-customer equipment test from changing the
// behavior of the staff-facing Account Operations workflow.
export function getAccountOntControlPolicy(customerId: number) {
  const isEnabled = enabled(process.env.HUAWEI_OLT_ACCOUNT_ACTIONS_ENABLED);
  const allowlisted = customerIds(
    process.env.HUAWEI_OLT_ACCOUNT_ACTION_CUSTOMER_IDS
  ).has(customerId);
  return {
    enabled: isEnabled,
    allowlisted,
    integrated: isEnabled && allowlisted,
  };
}
