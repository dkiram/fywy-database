/**
 * Keeps a Monthly Fee payment and the month it pays for on the same ledger.
 *
 * The ledger has no link between a payment and a charge: a payment is a
 * credit, a charge is a debit, and the balance is the sum. That is fine while
 * the nightly generator raises every month the customer pays for. It stops
 * being fine in two situations found in the Sept 2026 credit audit (1,488
 * accounts, J$5M sitting as "credit" that customers were never ahead by):
 *
 *   1. The month was never billed. Migration 041 seeded each legacy account's
 *      billing_start_date from Access's "Month Paid For", and where Access was
 *      ahead of reality the generator skipped months the customer really
 *      owed. The customer then paid them at the counter and the money became
 *      a credit instead of clearing the month. The counter payment is the
 *      better evidence - customer and cashier agreed on it with the money on
 *      the desk - so we raise the charge for that month right here.
 *
 *   2. A cut-off month normally requires a warning. An explicit cashier
 *      override accepts the payment without inventing a service charge.
 *      The full accepted receipt remains a ledger credit, including any excess
 *      over the outstanding balance.
 *
 *   3. The month was billed AND already settled. Found in the Sept 2026
 *      settled-twice sweep (182 accounts, 163 of them in September alone):
 *      the 28 Aug clean-slate forgave August on 2,128 accounts, the customer
 *      still believes August is what they owe, the cashier types August, and
 *      the money lands as credit because the August charge has nothing left
 *      on it. The month the customer actually owes is September. Same
 *      warning-and-override shape as a cut-off month, with the open month
 *      named so the cashier can just fix the tag.
 *
 * Called inside the payment transaction, before the payment is written, so a
 * refusal costs nothing and a raised charge commits with the payment or not
 * at all.
 */
import type { PoolClient } from "pg";

export type MonthChargeRefusal = "disconnected" | "settled";

export type MonthChargeOutcome =
  | { kind: "ok"; reason: "already_charged" | "not_past" | "suspended" | "no_activation_date" | "no_rate" }
  | { kind: "overridden"; code: MonthChargeRefusal; message: string }
  | { kind: "charged"; dueDate: string; amount: string }
  | { kind: "refused"; code: MonthChargeRefusal; message: string };

type MonthChargeInput = {
  customerId: number;
  /** YYYY-MM as typed on the payment form. */
  monthPaid: string;
  employeeId: number;
  /** Cashier has seen the warning and wants the receipt taken as credit anyway. Covers both refusal kinds. */
  overrideDisconnectedMonth?: boolean;
};

const MONTH_LABEL = new Intl.DateTimeFormat("en-JM", { month: "long", year: "numeric", timeZone: "UTC" });

function describeMonth(monthStart: string) {
  return MONTH_LABEL.format(new Date(`${monthStart}T00:00:00Z`));
}

const DATE_LABEL = new Intl.DateTimeFormat("en-JM", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

function describeSettled(row: {
  month_start: string;
  owing_due_date: string | null;
  owing_entry_type: string | null;
  owing_service_month: string | null;
}) {
  const paid = describeMonth(row.month_start);
  if (row.owing_due_date === null) {
    return (
      `${paid} is already settled on this account and nothing is owing. Recording this ` +
      "payment as " + paid + " would leave the money sitting as credit. If the customer " +
      "is paying ahead, tag the next unbilled month instead."
    );
  }
  const owing = row.owing_service_month
    ? `${describeMonth(row.owing_service_month)} (due ${DATE_LABEL.format(new Date(`${row.owing_due_date}T00:00:00Z`))})`
    : `a ${row.owing_entry_type?.replace(/_/g, " ") ?? "charge"} due ${DATE_LABEL.format(new Date(`${row.owing_due_date}T00:00:00Z`))}`;
  return (
    `${paid} is already settled on this account. The oldest amount still owing is ${owing}. ` +
    "Record this payment against what the customer actually owes, or override to take it as credit."
  );
}

function describeStatus(status: string | null) {
  switch (status) {
    case "disconnected":
    case "pending_reconnection":
      return "disconnected";
    case "offline":
      return "offline (no service)";
    case "terminated":
      return "terminated";
    case "closed":
    case "archived":
      return status;
    default:
      return "not in service";
  }
}

export async function ensureMonthlyChargeForPayment(
  client: PoolClient,
  input: MonthChargeInput,
): Promise<MonthChargeOutcome> {
  // The receipt labels the service month. Due days 1–15 bill that service in
  // the following month; days 16–31 bill it in the same month. Use the mapped
  // anniversary for charge identity, service history and rates everywhere.
  const lookup = await client.query(
    `
    WITH me AS (
      SELECT c.customer_id,
             c.activation_date,
             ($2 || '-01')::DATE AS month_start,
             (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE AS today
      FROM public.customers c
      WHERE c.customer_id = $1
    ),
    due AS (
      SELECT me.*,
             CASE WHEN me.activation_date IS NULL THEN NULL
                  ELSE public.spcl_anniversary_date(me.activation_date,
                    (me.month_start + CASE WHEN EXTRACT(DAY FROM me.activation_date)<=15
                      THEN INTERVAL '1 month' ELSE INTERVAL '0 months' END)::DATE)
             END AS due_date
      FROM me
    )
    SELECT
      d.month_start::TEXT AS month_start,
      d.due_date::TEXT AS due_date,
      d.due_date <= d.today AS is_past,
      EXISTS (
        SELECT 1 FROM public.account_ledger_entries ch
        WHERE ch.customer_id = d.customer_id
          AND ch.entry_type = 'monthly_charge'
          AND COALESCE(ch.due_date, ch.effective_date) = d.due_date
      ) AS has_charge,
      -- The billing view applies every credit to the debits oldest-first and
      -- names the first one not fully covered. A charge due before that one
      -- has nothing left on it, whether it was paid or forgiven.
      (bs.oldest_unpaid_due_date IS NULL OR d.due_date < bs.oldest_unpaid_due_date) AS already_settled,
      bs.oldest_unpaid_due_date::TEXT AS owing_due_date,
      owing.entry_type AS owing_entry_type,
      -- Map the open charge back to the service month the cashier should type.
      CASE WHEN owing.entry_type = 'monthly_charge' THEN
        DATE_TRUNC('month', bs.oldest_unpaid_due_date
          - CASE WHEN EXTRACT(DAY FROM d.activation_date) <= 15 THEN INTERVAL '1 month' ELSE INTERVAL '0 months' END)::DATE::TEXT
      END AS owing_service_month,
      CASE WHEN d.due_date IS NULL THEN NULL
           ELSE public.spcl_customer_service_active_on(d.customer_id, d.due_date)
      END AS service_on,
      (
        SELECT h.to_status
        FROM public.account_status_history h
        WHERE h.customer_id = d.customer_id
          AND h.effective_date <= COALESCE(d.due_date, d.month_start)
        ORDER BY h.effective_date DESC, h.changed_at DESC, h.account_status_history_id DESC
        LIMIT 1
      ) AS status_then,
      rate.customer_rate_history_id,
      rate.monthly_fee::TEXT AS monthly_fee
    FROM due d
    LEFT JOIN public.customer_billing_status bs ON bs.customer_id = d.customer_id
    LEFT JOIN LATERAL (
      SELECT o.entry_type
      FROM public.account_ledger_entries o
      WHERE o.customer_id = d.customer_id
        AND o.amount > 0
        AND o.due_date = bs.oldest_unpaid_due_date
      ORDER BY o.account_ledger_entry_id
      LIMIT 1
    ) owing ON TRUE
    LEFT JOIN LATERAL (
      SELECT r.customer_rate_history_id, r.monthly_fee
      FROM public.customer_rate_history r
      WHERE r.customer_id = d.customer_id
        AND r.effective_date <= COALESCE(d.due_date, d.month_start)
      ORDER BY r.effective_date DESC, r.customer_rate_history_id DESC
      LIMIT 1
    ) rate ON TRUE;
    `,
    [input.customerId, input.monthPaid],
  );
  const row = lookup.rows[0] as
    | {
        month_start: string;
        due_date: string | null;
        is_past: boolean;
        has_charge: boolean;
        already_settled: boolean;
        owing_due_date: string | null;
        owing_entry_type: string | null;
        owing_service_month: string | null;
        service_on: boolean | null;
        status_then: string | null;
        customer_rate_history_id: string | number | null;
        monthly_fee: string | null;
      }
    | undefined;
  if (!row) throw new Error(`Customer ${input.customerId} not found while checking the paid month.`);

  if (row.has_charge) {
    if (!row.already_settled) return { kind: "ok", reason: "already_charged" };
    return {
      kind: input.overrideDisconnectedMonth ? "overridden" : "refused",
      code: "settled",
      message: describeSettled(row),
    };
  }

  // Cut-off months require explicit acknowledgement before taking payment. A suspension is the one "off" status that still bills
  // (J$500 holding charges), so a suspended month is accepted as-is.
  if (row.service_on === false) {
    if (row.status_then === "suspended") return { kind: "ok", reason: "suspended" };
    return {
      kind: input.overrideDisconnectedMonth ? "overridden" : "refused",
      code: "disconnected",
      message:
        `This account was ${describeStatus(row.status_then)} in ${describeMonth(row.month_start)}, ` +
        "and SPCL does not bill months a customer was cut off. Record this payment " +
        "against the months the customer actually owes, or as a Reconnection Fee.",
    };
  }

  // No activation date means no anniversary and no generator either; nothing
  // to align the payment with. Legacy edge case, left as before.
  if (row.service_on === null || row.due_date === null) return { kind: "ok", reason: "no_activation_date" };

  // A service month can be in the past while its mapped bill is not due yet.
  // Leave that future charge to the generator so advance payments stay credit.
  if (!row.is_past) return { kind: "ok", reason: "not_past" };

  if (row.customer_rate_history_id === null || row.monthly_fee === null || Number(row.monthly_fee) <= 0) {
    return { kind: "ok", reason: "no_rate" };
  }

  // Rule 1: a past month with no charge that the customer is paying for was
  // owed. Raise it with the generator's own source_key so the nightly run can
  // never double it, at the rate that was in force on its due date.
  const inserted = await client.query(
    `
    INSERT INTO public.account_ledger_entries (
      customer_id, entry_type, amount, effective_date, due_date, grace_end_date,
      description, customer_rate_history_id, created_by_employee_id, reason,
      is_verified, source_key
    ) VALUES (
      $1::INTEGER, 'monthly_charge', $2::NUMERIC, $3::DATE, $3::DATE, $3::DATE + 10,
      'Monthly service charge for activation anniversary',
      $4, $5,
      'Raised when the month was paid at the counter: it had not been billed because the legacy paid-through date was later than the customer''s real position.',
      TRUE,
      'monthly-charge:' || ($1::INTEGER)::TEXT || ':' || ($3::DATE)::TEXT
    )
    ON CONFLICT (source_key) DO NOTHING
    RETURNING account_ledger_entry_id;
    `,
    [input.customerId, row.monthly_fee, row.due_date, row.customer_rate_history_id, input.employeeId],
  );
  // The 054 trigger drops a charge it disagrees with, silently. We asked it
  // the same question a moment ago, so this should never trip - but a payment
  // must not go through believing a charge exists when it does not.
  if ((inserted.rowCount ?? 0) === 0) {
    throw new Error(
      `Could not raise the ${describeMonth(row.month_start)} charge for customer ${input.customerId}; the service timeline rejected it.`,
    );
  }
  return { kind: "charged", dueDate: row.due_date, amount: row.monthly_fee };
}

/** Decimal strings stay exact even for the largest accepted receipt amounts. */
export function paymentBalanceDeduction(amount: string, _balance: string, _isPastMonthlyPayment: boolean): string {
  const cents = (value: string) => {
    const negative = value.startsWith("-");
    const [whole, fraction = ""] = value.replace(/^-/, "").split(".");
    const result = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"));
    return negative ? -result : result;
  };
  // A month label cannot discard money collected. Discounts may have already
  // cleared the debt; the rest of the receipt must remain as account credit.
  const applied = cents(amount);
  return `${applied / 100n}.${String(applied % 100n).padStart(2, "0")}`;
}
