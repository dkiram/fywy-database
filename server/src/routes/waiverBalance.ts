import type { PoolClient } from "pg";

// The caller holds the customer lock and has generated current charges. Use
// the same credit-adjusted quote as End Suspension, including its unposted fee.
// Re-read at approval so intervening payments cannot produce an excess waiver.
export async function loadWaiverBalance(client: PoolClient, customerId: number) {
  const result = await client.query(
    `SELECT customer.status, billing.outstanding_balance,
            suspension.total_due_to_reconnect
     FROM public.customers customer
     JOIN public.spcl_customer_billing_status($1::INTEGER) billing
       ON billing.customer_id = customer.customer_id
     LEFT JOIN public.spcl_customer_suspension_status($1::INTEGER) suspension
       ON suspension.customer_id = customer.customer_id
     WHERE customer.customer_id = $1;`,
    [customerId]
  );
  const row = result.rows[0];
  const includesReturnFee = row?.status === "suspended";
  const rawAmount = includesReturnFee
    ? row?.total_due_to_reconnect
    : row?.outstanding_balance;
  if (rawAmount == null || !Number.isFinite(Number(rawAmount)) || Number(rawAmount) < 0) {
    throw new Error("Could not determine the current amount available to discount.");
  }
  return {
    amount: Number(rawAmount),
    label: includesReturnFee ? "amount to reconnect, including the return fee" : "outstanding balance",
  };
}
