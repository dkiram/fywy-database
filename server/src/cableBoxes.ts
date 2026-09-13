import type { PoolClient } from "pg";

export const CABLE_BOX_MONTHLY_FEE = 1000;
export function hasCable(serviceType: unknown): boolean {
  return serviceType === "cable" || serviceType === "cable_internet";
}

export class CableBoxError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

// Caller owns the transaction. Lock the account and require the displayed count
// so retries or concurrent staff changes cannot silently change the count twice.
async function changeCableBox(
  client: PoolClient,
  customerId: number,
  expectedCount: unknown,
  employee: { employeeId: number; firstName: string; lastName: string },
  delta: 1 | -1,
) {
  if (typeof expectedCount !== "number" || !Number.isSafeInteger(expectedCount) || expectedCount < 0) {
    throw new CableBoxError(400, "Invalid cable box count.");
  }
  const result = await client.query(
    `SELECT c.package_id, c.monthly_fee, c.additional_cable_boxes, c.status, p.service_type
     FROM public.customers c LEFT JOIN public.packages p ON p.package_id = c.package_id
     WHERE c.customer_id = $1 FOR UPDATE OF c;`, [customerId],
  );
  const customer = result.rows[0];
  if (!customer) throw new CableBoxError(404, "Customer not found.");
  if (customer.status === "terminated" || !hasCable(customer.service_type)) {
    throw new CableBoxError(409, "Additional boxes require a cable subscription that has not been terminated.");
  }
  if (customer.additional_cable_boxes !== expectedCount) {
    throw new CableBoxError(409, "The cable box count changed. Refresh this profile before changing boxes.");
  }
  if (customer.monthly_fee == null || !Number.isFinite(Number(customer.monthly_fee))) {
    throw new CableBoxError(409, "Set the customer's monthly rate before changing cable boxes.");
  }
  if (delta === -1 && expectedCount === 0) {
    throw new CableBoxError(409, "The included cable box cannot be removed. Every cable subscription keeps at least one box.");
  }
  const additionalCableBoxes = expectedCount + delta;
  const newRate = Number(customer.monthly_fee) + delta * CABLE_BOX_MONTHLY_FEE;
  if (newRate < 0) throw new CableBoxError(409, "Removing a box would make the monthly rate negative. Correct the customer's rate first.");
  const monthlyFee = newRate.toFixed(2);
  const action = delta === 1 ? "Added" : "Removed";
  const reason = `${action} cable box: ${additionalCableBoxes} additional box(es), monthly rate ${delta === 1 ? "increased" : "decreased"} by J$${CABLE_BOX_MONTHLY_FEE}`;
  await client.query(
    `UPDATE public.customers SET additional_cable_boxes = $1, monthly_fee = $2 WHERE customer_id = $3;`,
    [additionalCableBoxes, monthlyFee, customerId],
  );
  await client.query(
    `INSERT INTO public.customer_rate_history (
      customer_id, package_id, monthly_fee, effective_date, reason, changed_by_employee_id, is_legacy_estimate
    ) VALUES ($1, $2, $3, (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE, $4, $5, FALSE);`,
    [customerId, customer.package_id, monthlyFee, reason, employee.employeeId],
  );
  await client.query(
    `INSERT INTO public.audit_logs (
      employee_id, actor_name, action, entity_type, entity_id, field_name, old_value, new_value, reason, occurred_at
    ) VALUES ($1, $2, $7, 'customer', $3, 'additional_cable_boxes', $4, $5, $6, CURRENT_TIMESTAMP);`,
    [employee.employeeId, `${employee.firstName} ${employee.lastName}`, String(customerId),
      `${expectedCount} @ J$${customer.monthly_fee}`, `${additionalCableBoxes} @ J$${monthlyFee}`, reason, `${action} customer cable box`],
  );
  return { additionalCableBoxes, monthlyFee };
}

export function addCableBox(...args: ParametersWithoutDelta) {
  return changeCableBox(...args, 1);
}

export function removeCableBox(...args: ParametersWithoutDelta) {
  return changeCableBox(...args, -1);
}

type ParametersWithoutDelta = [
  client: PoolClient,
  customerId: number,
  expectedCount: unknown,
  employee: { employeeId: number; firstName: string; lastName: string },
];
