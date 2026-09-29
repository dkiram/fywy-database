/**
 * Keeps a Reconnection Fee payment from ever turning into account credit.
 *
 * A Reconnection Fee receipt posts a `reconnection_payment` credit. The fee
 * it pays for is a separate `reconnection_fee` debit, and that debit is only
 * posted when the app itself moves an account to disconnected. Legacy Access
 * cut-offs, the scripted/bulk disconnections, OLT-side cut-offs and anyone
 * reconnected outside the app never got one, so the receipt had nothing to
 * pay and landed as credit - on an account that owed 0.00, the whole fee
 * became a credit that silently absorbed the next month's bill.
 *
 * The rule: a reconnection payment may pay down what is owed, but it never
 * pushes the account below where it stood. Whatever part of it has no fee
 * to pay gets that fee posted alongside it, in the same transaction.
 *
 *   feeNeeded   the package fee (or the receipt, if the package has none)
 *               minus any fee already on the ledger that no earlier
 *               reconnection payment has paid.
 *   excess      the part of the receipt beyond the current outstanding
 *               balance - the part that would otherwise become credit.
 *
 * The posted fee is the larger of the two, never more than the receipt.
 * Suspended accounts are left alone: their fee is posted when the
 * suspension ends, and the counter quote already nets any credit against it.
 */
import type { PoolClient } from "pg";

const toCents = (value: string) => {
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = value.replace(/^-/, "").split(".");
  const result = BigInt(whole || "0") * 100n + BigInt(fraction.slice(0, 2).padEnd(2, "0"));
  return negative ? -result : result;
};

// Only ever called with a non-negative amount.
const fromCents = (cents: bigint) => `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;

const max = (...values: bigint[]) => values.reduce((a, b) => (b > a ? b : a));
const min = (...values: bigint[]) => values.reduce((a, b) => (b < a ? b : a));

/** Decimal strings in, decimal string out, exact to the cent. */
export function reconnectionFeeToPost(input: {
  amount: string;
  balanceBefore: string;
  unpaidFeeOnLedger: string;
  packageFee: string | null;
}): string {
  const amount = toCents(input.amount);
  if (amount <= 0n) return "0.00";
  const packageFee = input.packageFee === null ? 0n : toCents(input.packageFee);
  const price = packageFee > 0n ? min(amount, packageFee) : amount;
  const feeNeeded = max(price - max(toCents(input.unpaidFeeOnLedger), 0n), 0n);
  const excess = amount - max(toCents(input.balanceBefore), 0n);
  return fromCents(min(max(feeNeeded, excess, 0n), amount));
}

export async function postReconnectionFeeForPayment(
  client: PoolClient,
  input: {
    customerId: number;
    paymentId: number;
    amount: string;
    /** Signed ledger balance read before this payment's credit was posted. */
    balanceBefore: string;
    employeeId: number;
  },
): Promise<string | null> {
  const context = await client.query(
    `
    SELECT
      c.status,
      package.reconnection_fee::TEXT AS package_fee,
      GREATEST(
        COALESCE(SUM(e.amount) FILTER (
          WHERE e.entry_type IN ('reconnection_fee', 'suspension_reconnection_fee')
        ), 0)
        + COALESCE(SUM(e.amount) FILTER (
          WHERE e.entry_type IN ('reconnection_payment', 'payment_void')
            AND e.payment_id <> $2
            AND pay.payment_type = 'Reconnection Fee'
        ), 0),
        0
      )::TEXT AS unpaid_fee
    FROM public.customers c
    LEFT JOIN public.packages package ON package.package_id = c.package_id
    LEFT JOIN public.account_ledger_entries e ON e.customer_id = c.customer_id
    LEFT JOIN public.payments pay ON pay.payment_id = e.payment_id
    WHERE c.customer_id = $1
    GROUP BY c.status, package.reconnection_fee;
    `,
    [input.customerId, input.paymentId],
  );
  const row = context.rows[0] as { status: string; package_fee: string | null; unpaid_fee: string } | undefined;
  if (!row || row.status === "suspended") return null;

  const fee = reconnectionFeeToPost({
    amount: input.amount,
    balanceBefore: input.balanceBefore,
    unpaidFeeOnLedger: row.unpaid_fee,
    packageFee: row.package_fee,
  });
  if (toCents(fee) <= 0n) return null;

  await client.query(
    `
    INSERT INTO public.account_ledger_entries (
      customer_id, entry_type, amount, effective_date, due_date, grace_end_date,
      description, payment_id, created_by_employee_id, reason, source_key
    ) VALUES (
      $1, 'reconnection_fee', $2::NUMERIC,
      (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
      (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
      (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
      'Reconnection fee', $3, $4,
      'Posted with the reconnection fee payment: no unpaid fee was on the ledger for it, so the payment would otherwise have become credit.',
      'reconnection-fee:payment:' || $3::TEXT
    )
    ON CONFLICT (source_key) DO NOTHING;
    `,
    [input.customerId, fee, input.paymentId, input.employeeId],
  );
  return fee;
}
