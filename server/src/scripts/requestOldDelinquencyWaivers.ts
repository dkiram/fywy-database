/**
 * Creates pending discount requests for the narrow one-time legacy-balance fix.
 *
 * This never applies a waiver. It uses the existing two-person workflow so an
 * administrator must still review every request before money changes.
 *
 * Preview (always rolls back):
 *   npm run reconcile:old-delinquency-waivers -- --requested-by <username>
 *
 * Apply after reviewing the preview count:
 *   npm run reconcile:old-delinquency-waivers -- --requested-by <username> \
 *     --apply --expected-count <count> \
 *     --confirmation "REQUEST <count> ONE-TIME WAIVERS"
 */
import type { PoolClient } from "pg";
import { pool } from "../db.js";

const WAIVER_REASON = "one time waiver for new system";
const ELIGIBLE_REQUESTER_ROLES = ["admin", "head_office", "branch"];

type Requester = {
  employee_id: string;
  first_name: string;
  last_name: string;
  username: string;
  role: string;
};

type Candidate = {
  customer_id: number;
  customer_name: string;
  monthly_fee: string;
  outstanding_balance: string;
  first_charge_due_date: string;
  fifo_oldest_unpaid_due_date: string;
};

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() : undefined;
}

function positiveInteger(value: string | undefined) {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function usage() {
  return [
    "Preview:",
    "  npm run reconcile:old-delinquency-waivers -- --requested-by <username>",
    "",
    "Apply after reviewing the preview:",
    "  npm run reconcile:old-delinquency-waivers -- --requested-by <username> --apply \\",
    "    --expected-count <count> --confirmation \"REQUEST <count> ONE-TIME WAIVERS\"",
  ].join("\n");
}

// A missed payment counts as "old" when every one of the six most recent
// monthly charges that has come due is paid in full and the account still owes
// exactly one monthly fee. That remaining fee therefore belongs to a charge
// more than six months back.
//
// The ledger's oldest-unpaid date cannot date the gap: payments apply
// oldest-first (FIFO), so a customer who missed one month years ago and has
// paid every month since shows the *newest* charge as unpaid. Only the
// payment-by-month history says whether the gap is old or current.
//
// The paid-for month is stronger evidence than the receipt date: a late or
// early counter visit should not turn a continuous payment run into a false
// gap. The UI requires month_paid for every new monthly-fee payment.
const ELIGIBLE_CUSTOMERS_SQL = `
  WITH settings AS (
    SELECT
      (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE AS today
  ),
  possible AS (
    SELECT
      c.customer_id,
      c.name AS customer_name,
      rate.monthly_fee,
      billing.outstanding_balance,
      billing.oldest_unpaid_due_date
    FROM public.customers c
    JOIN public.customer_billing_status billing USING (customer_id)
    CROSS JOIN settings
    JOIN LATERAL (
      SELECT history.monthly_fee
      FROM public.customer_rate_history history
      WHERE history.customer_id = c.customer_id
        AND history.effective_date <= settings.today
      ORDER BY history.effective_date DESC,
        history.customer_rate_history_id DESC
      LIMIT 1
    ) rate ON TRUE
    WHERE c.status = 'active'
      AND c.hidden_from_app = FALSE
      AND ($2::INTEGER[] IS NULL OR c.customer_id = ANY($2::INTEGER[]))
      AND billing.is_delinquent
      AND rate.monthly_fee > 0
      -- the real balance is exactly one monthly fee ...
      AND billing.outstanding_balance = rate.monthly_fee
      -- ... and it is entirely explained by unpaid monthly charges: no
      -- reconnection fee, adjustment, opening balance or waiver in the mix.
      AND (
        SELECT COALESCE(SUM(entry.amount), 0)
        FROM public.account_ledger_entries entry
        WHERE entry.customer_id = c.customer_id
          AND entry.entry_type IN ('monthly_charge', 'monthly_payment')
      ) = rate.monthly_fee
      AND NOT EXISTS (
        SELECT 1
        FROM public.waiver_requests request
        WHERE request.customer_id = c.customer_id
          AND (
            request.status = 'pending'
            OR LOWER(TRIM(request.reason)) = LOWER($1)
          )
      )
  ),
  recent_charges AS (
    SELECT
      possible.customer_id,
      DATE_TRUNC('month', charge.due_date)::DATE AS charge_month,
      charge.amount AS charge_amount,
      ROW_NUMBER() OVER (
        PARTITION BY possible.customer_id
        ORDER BY charge.due_date DESC, charge.account_ledger_entry_id DESC
      ) AS recency
    FROM possible
    CROSS JOIN settings
    JOIN public.account_ledger_entries charge
      ON charge.customer_id = possible.customer_id
      AND charge.entry_type = 'monthly_charge'
      AND charge.due_date <= settings.today
  ),
  paid_months AS (
    SELECT
      possible.customer_id,
      DATE_TRUNC('month', payment.month_paid)::DATE AS paid_month,
      SUM(payment.amount_paid)::NUMERIC(14,2) AS amount_paid
    FROM possible
    JOIN public.payments payment ON payment.customer_id = possible.customer_id
    WHERE payment.voided_at IS NULL
      AND COALESCE(payment.payment_type, payment.legacy_payment_type) = 'Monthly Fee'
      AND payment.amount_paid > 0
      AND payment.month_paid IS NOT NULL
    GROUP BY possible.customer_id, DATE_TRUNC('month', payment.month_paid)::DATE
  ),
  recent_coverage AS (
    SELECT
      recent_charges.customer_id,
      COUNT(*) AS recent_months,
      COUNT(*) FILTER (
        WHERE paid_months.amount_paid = recent_charges.charge_amount
      ) AS paid_in_full_months
    FROM recent_charges
    LEFT JOIN paid_months
      ON paid_months.customer_id = recent_charges.customer_id
      AND paid_months.paid_month = recent_charges.charge_month
    WHERE recent_charges.recency <= 6
    GROUP BY recent_charges.customer_id
  )
  SELECT
    possible.customer_id,
    possible.customer_name,
    possible.monthly_fee,
    possible.outstanding_balance,
    possible.oldest_unpaid_due_date AS fifo_oldest_unpaid_due_date,
    (
      SELECT MIN(charge.due_date)
      FROM public.account_ledger_entries charge
      WHERE charge.customer_id = possible.customer_id
        AND charge.entry_type = 'monthly_charge'
    ) AS first_charge_due_date
  FROM possible
  JOIN recent_coverage USING (customer_id)
  WHERE recent_coverage.recent_months = 6
    AND recent_coverage.paid_in_full_months = 6
  ORDER BY possible.customer_id;
`;

async function findRequester(client: PoolClient, username: string): Promise<Requester> {
  const result = await client.query<Requester>(
    `SELECT employee_id, first_name, last_name, username, role
     FROM public.employees
     WHERE LOWER(username) = LOWER($1)
       AND is_active = TRUE
     LIMIT 1;`,
    [username]
  );
  const requester = result.rows[0];
  if (!requester) {
    const choices = await client.query<{ username: string; role: string }>(
      `SELECT username, role
       FROM public.employees
       WHERE is_active = TRUE
         AND username IS NOT NULL
         AND role = ANY($1)
       ORDER BY username;`,
      [ELIGIBLE_REQUESTER_ROLES]
    );
    const list = choices.rows
      .map((row) => `  ${row.username} (${row.role})`)
      .join("\n");
    throw new Error(
      `No active employee has username "${username}". Use one of:\n${list}`
    );
  }
  if (!ELIGIBLE_REQUESTER_ROLES.includes(requester.role)) {
    throw new Error(
      `${requester.username} has role "${requester.role}", which cannot request discounts.`
    );
  }
  return requester;
}

async function eligibleCustomers(client: PoolClient, customerIds: number[] | null = null) {
  const result = await client.query<Candidate>(ELIGIBLE_CUSTOMERS_SQL, [
    WAIVER_REASON,
    customerIds,
  ]);
  return result.rows;
}

async function lockCustomers(client: PoolClient, customerIds: number[]) {
  if (customerIds.length === 0) return;
  await client.query(
    `SELECT customer_id
     FROM public.customers
     WHERE customer_id = ANY($1::INTEGER[])
     ORDER BY customer_id
     FOR UPDATE;`,
    [customerIds]
  );
}

function printCandidates(candidates: Candidate[]) {
  console.table(
    candidates.map((candidate) => ({
      customer: candidate.customer_id,
      name: candidate.customer_name,
      monthly_fee: candidate.monthly_fee,
      outstanding: candidate.outstanding_balance,
      first_charge_due: candidate.first_charge_due_date,
      fifo_oldest_unpaid: candidate.fifo_oldest_unpaid_due_date,
    }))
  );
  console.log(`Eligible customers: ${candidates.length}`);
  console.log(`Request note: ${WAIVER_REASON}`);
}

async function run() {
  const username = argument("--requested-by") ?? "";
  const apply = process.argv.includes("--apply");
  const expectedCount = positiveInteger(argument("--expected-count"));
  const confirmation = argument("--confirmation") ?? "";

  if (!username) {
    throw new Error(`--requested-by is required.\n\n${usage()}`);
  }
  if (apply && expectedCount === null) {
    throw new Error(`--expected-count is required in apply mode.\n\n${usage()}`);
  }
  if (!apply && (argument("--expected-count") || argument("--confirmation"))) {
    throw new Error("--expected-count and --confirmation are only used with --apply.");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Prevent two copies of this one-time batch from running simultaneously.
    await client.query("SELECT pg_advisory_xact_lock(8391, 20260827);");

    const requester = await findRequester(client, username);

    // Keep billing current, but a preview rolls this generation back below.
    await client.query(
      `SELECT public.spcl_generate_monthly_charges(
        (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE
      );`
    );

    const initialCandidates = await eligibleCustomers(client);
    await lockCustomers(
      client,
      initialCandidates.map((candidate) => candidate.customer_id)
    );

    // Customer locks wait for in-flight payments/account edits, then this
    // second query evaluates the committed state rather than a stale preview.
    const candidates = await eligibleCustomers(
      client,
      initialCandidates.map((candidate) => candidate.customer_id)
    );
    printCandidates(candidates);

    if (!apply) {
      await client.query("ROLLBACK");
      console.log("DRY RUN: no charges or discount requests were saved.");
      if (candidates.length > 0) {
        console.log(
          `To apply this exact set, use --apply --expected-count ${candidates.length} ` +
            `--confirmation "REQUEST ${candidates.length} ONE-TIME WAIVERS".`
        );
      }
      return;
    }

    if (candidates.length !== expectedCount) {
      throw new Error(
        `Expected ${expectedCount} eligible customers, but found ${candidates.length}. ` +
          "Nothing was saved; run the preview again."
      );
    }
    const expectedConfirmation = `REQUEST ${candidates.length} ONE-TIME WAIVERS`;
    if (confirmation !== expectedConfirmation) {
      throw new Error(
        `Confirmation did not match "${expectedConfirmation}". Nothing was saved.`
      );
    }
    if (candidates.length === 0) {
      throw new Error("There are no eligible customers, so there is nothing to apply.");
    }

    for (const candidate of candidates) {
      const request = await client.query<{ waiver_request_id: string }>(
        `INSERT INTO public.waiver_requests (
          customer_id, amount, reason, requested_by_employee_id
        ) VALUES ($1, $2, $3, $4)
        RETURNING waiver_request_id;`,
        [candidate.customer_id, candidate.monthly_fee, WAIVER_REASON, requester.employee_id]
      );
      const requestId = request.rows[0].waiver_request_id;

      await client.query(
        `INSERT INTO public.audit_logs (
          employee_id, actor_name, action, entity_type, entity_id,
          field_name, old_value, new_value, reason, occurred_at, source_key
        ) VALUES ($1, $2, 'Requested balance waiver', 'customer', $3,
          'waiver_request', NULL, $4, $5, CURRENT_TIMESTAMP, $6);`,
        [
          requester.employee_id,
          `${requester.first_name} ${requester.last_name}`,
          String(candidate.customer_id),
          `J$${candidate.monthly_fee}; request #${requestId}`,
          WAIVER_REASON,
          `one-time-new-system-waiver-request:${candidate.customer_id}`,
        ]
      );
    }

    await client.query("COMMIT");
    console.log(
      `Created ${candidates.length} pending discount request(s). ` +
        "No balance changed; Admin approval is still required."
    );
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

run()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "Unknown reconciliation error.");
    process.exitCode = 1;
  })
  .finally(() => pool.end());
