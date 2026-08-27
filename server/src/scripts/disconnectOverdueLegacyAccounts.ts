/**
 * One-time cleanup: mark legacy accounts that should have been disconnected in
 * 2025 (or earlier) but are still `active` and still accruing monthly charges.
 *
 * Accounts that have a current ONT assignment are LEFT ALONE and only listed:
 * those get disconnected through the normal OLT workflow so the Huawei command
 * and the status change happen together. Accounts with no ONT assignment have
 * no automated path, so this marks them `disconnected` directly.
 *
 * It never touches money. Existing monthly charges stay on the ledger; once the
 * backdated `disconnected` status-history row exists, migration 054's trigger
 * stops new ones and the old ones surface in
 * `customer_offline_monthly_charge_review` for a separate decision.
 *
 * Preview (always rolls back):
 *   npm run disconnect:overdue-legacy -- --performed-by <username>
 *
 * Apply after reviewing the preview count:
 *   npm run disconnect:overdue-legacy -- --performed-by <username> --apply \
 *     --expected-count <count> \
 *     --confirmation "DISCONNECT <count> LEGACY OVERDUE ACCOUNTS"
 */
import type { PoolClient } from "pg";
import { pool } from "../db.js";

const ELIGIBLE_PERFORMER_ROLES = ["admin", "head_office"];
const DEFAULT_SCHEDULED_BEFORE = "2026-01-01";
const STATUS_REASON =
  "Bulk cleanup: overdue 2025 disconnection never actioned; no ONT assignment";

type Performer = {
  employee_id: string;
  first_name: string;
  last_name: string;
  username: string;
  role: string;
};

type Candidate = {
  customer_id: number;
  customer_name: string | null;
  pole_box_number: string | null;
  port_number: string | null;
  outstanding_balance: string;
  scheduled_disconnection_date: string;
  oldest_unpaid_due_date: string | null;
  has_olt_mapping: boolean;
  offline_charge_amount: string;
  offline_charge_count: number;
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

function isIsoDate(value: string | undefined): value is string {
  return !!value && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function usage() {
  return [
    "Preview:",
    "  npm run disconnect:overdue-legacy -- --performed-by <username>",
    "",
    "Options:",
    `  --scheduled-before <YYYY-MM-DD>   only accounts whose scheduled disconnection`,
    `                                   is before this date (default ${DEFAULT_SCHEDULED_BEFORE})`,
    "  --effective-date <scheduled|today>  date recorded for the disconnection",
    "                                   (default: scheduled = the missed disconnection date)",
    "",
    "Apply after reviewing the preview:",
    "  npm run disconnect:overdue-legacy -- --performed-by <username> --apply \\",
    "    --expected-count <count> \\",
    '    --confirmation "DISCONNECT <count> LEGACY OVERDUE ACCOUNTS"',
  ].join("\n");
}

// $1 scheduled-before date, $2 optional customer_id[] filter for the locked recheck.
const CANDIDATES_SQL = `
  SELECT
    c.customer_id,
    c.name AS customer_name,
    NULLIF(TRIM(c.pole_box_number), '') AS pole_box_number,
    NULLIF(TRIM(c.port_number), '') AS port_number,
    billing.outstanding_balance,
    billing.scheduled_disconnection_date,
    billing.oldest_unpaid_due_date,
    (ont.customer_ont_assignment_id IS NOT NULL) AS has_olt_mapping,
    COALESCE(offline.charge_amount, 0)::TEXT AS offline_charge_amount,
    COALESCE(offline.charge_count, 0) AS offline_charge_count
  FROM public.customers c
  JOIN public.customer_billing_status billing USING (customer_id)
  LEFT JOIN public.customer_ont_assignments ont
    ON ont.customer_id = c.customer_id
    AND ont.ended_at IS NULL
  LEFT JOIN LATERAL (
    SELECT
      SUM(le.amount) AS charge_amount,
      COUNT(*) AS charge_count
    FROM public.account_ledger_entries le
    WHERE le.customer_id = c.customer_id
      AND le.entry_type = 'monthly_charge'
      AND COALESCE(le.due_date, le.effective_date)
          >= billing.scheduled_disconnection_date
  ) offline ON TRUE
  WHERE c.status = 'active'
    AND c.hidden_from_app = FALSE
    AND c.source_staging_id IS NOT NULL
    AND ($2::INTEGER[] IS NULL OR c.customer_id = ANY($2::INTEGER[]))
    AND billing.is_delinquent
    AND billing.is_on_hold = FALSE
    AND billing.outstanding_balance > 0
    AND billing.scheduled_disconnection_date IS NOT NULL
    AND billing.scheduled_disconnection_date < $1::DATE
    AND NOT EXISTS (
      SELECT 1 FROM public.waiver_requests w
      WHERE w.customer_id = c.customer_id
        AND w.status = 'pending'
    )
  ORDER BY has_olt_mapping, c.customer_id;
`;

async function findPerformer(client: PoolClient, username: string): Promise<Performer> {
  const result = await client.query<Performer>(
    `SELECT employee_id, first_name, last_name, username, role
     FROM public.employees
     WHERE LOWER(username) = LOWER($1)
       AND is_active = TRUE
     LIMIT 1;`,
    [username]
  );
  const performer = result.rows[0];
  if (!performer) {
    const choices = await client.query<{ username: string; role: string }>(
      `SELECT username, role
       FROM public.employees
       WHERE is_active = TRUE
         AND username IS NOT NULL
         AND role = ANY($1)
       ORDER BY username;`,
      [ELIGIBLE_PERFORMER_ROLES]
    );
    const list = choices.rows.map((row) => `  ${row.username} (${row.role})`).join("\n");
    throw new Error(`No active employee has username "${username}". Use one of:\n${list}`);
  }
  if (!ELIGIBLE_PERFORMER_ROLES.includes(performer.role)) {
    throw new Error(
      `${performer.username} has role "${performer.role}", which cannot disconnect accounts.`
    );
  }
  return performer;
}

async function candidates(
  client: PoolClient,
  scheduledBefore: string,
  customerIds: number[] | null = null
) {
  const result = await client.query<Candidate>(CANDIDATES_SQL, [scheduledBefore, customerIds]);
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

function printGroup(title: string, rows: Candidate[]) {
  console.log(`\n${title}: ${rows.length}`);
  if (rows.length === 0) return;
  console.table(
    rows.map((row) => ({
      customer: row.customer_id,
      name: row.customer_name,
      balance: row.outstanding_balance,
      should_have_gone: row.scheduled_disconnection_date,
      oldest_unpaid: row.oldest_unpaid_due_date,
      charges_since_then: `${row.offline_charge_count} / J$${row.offline_charge_amount}`,
      pole_box: row.pole_box_number,
      port: row.port_number,
    }))
  );
}

async function run() {
  const username = argument("--performed-by") ?? "";
  const apply = process.argv.includes("--apply");
  const expectedCount = positiveInteger(argument("--expected-count"));
  const confirmation = argument("--confirmation") ?? "";

  const scheduledBeforeArg = argument("--scheduled-before");
  if (scheduledBeforeArg && !isIsoDate(scheduledBeforeArg)) {
    throw new Error("--scheduled-before must be YYYY-MM-DD.");
  }
  const scheduledBefore = scheduledBeforeArg ?? DEFAULT_SCHEDULED_BEFORE;

  const effectiveMode = argument("--effective-date") ?? "today";
  if (effectiveMode !== "scheduled" && effectiveMode !== "today") {
    throw new Error('--effective-date must be "scheduled" or "today".');
  }

  if (!username) {
    throw new Error(`--performed-by is required.\n\n${usage()}`);
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
    // Stop a second copy of this one-time batch from running at the same time.
    await client.query("SELECT pg_advisory_xact_lock(8391, 20260828);");

    const performer = await findPerformer(client, username);

    // Evaluate against current billing. A preview rolls this back below.
    await client.query(
      `SELECT public.spcl_generate_monthly_charges(
        (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE
      );`
    );

    const initial = await candidates(client, scheduledBefore);
    await lockCustomers(
      client,
      initial.map((row) => row.customer_id)
    );
    // Re-read committed state now that the customer rows are locked.
    const rows = await candidates(
      client,
      scheduledBefore,
      initial.map((row) => row.customer_id)
    );

    const withOlt = rows.filter((row) => row.has_olt_mapping);
    const toDisconnect = rows.filter((row) => !row.has_olt_mapping);

    printGroup("HAS ONT ASSIGNMENT — left active for you to sync to the OLT", withOlt);
    printGroup("NO ONT ASSIGNMENT — will be marked disconnected", toDisconnect);

    const totalOfflineCharges = toDisconnect.reduce(
      (sum, row) => sum + Number(row.offline_charge_amount),
      0
    );
    console.log(
      `\nCutoff: scheduled disconnection before ${scheduledBefore}. ` +
        `Disconnection date recorded: ${effectiveMode}.`
    );
    console.log(
      `Monthly charges already raised on/after the missed disconnection date for ` +
        `the ${toDisconnect.length} to disconnect: J$${totalOfflineCharges.toFixed(2)} ` +
        `(not reversed by this script; review in customer_offline_monthly_charge_review).`
    );

    const expectedConfirmation = `DISCONNECT ${toDisconnect.length} LEGACY OVERDUE ACCOUNTS`;

    if (!apply) {
      await client.query("ROLLBACK");
      console.log("\nDRY RUN: nothing was changed.");
      if (toDisconnect.length > 0) {
        console.log(
          `To apply: --apply --expected-count ${toDisconnect.length} ` +
            `--confirmation "${expectedConfirmation}"` +
            (scheduledBeforeArg ? ` --scheduled-before ${scheduledBefore}` : "") +
            (effectiveMode === "today" ? " --effective-date today" : "")
        );
      }
      return;
    }

    if (toDisconnect.length !== expectedCount) {
      throw new Error(
        `Expected ${expectedCount} accounts, but found ${toDisconnect.length}. ` +
          "Nothing was changed; run the preview again."
      );
    }
    if (confirmation !== expectedConfirmation) {
      throw new Error(`Confirmation did not match "${expectedConfirmation}". Nothing was changed.`);
    }
    if (toDisconnect.length === 0) {
      throw new Error("There are no matching accounts, so there is nothing to do.");
    }

    const actorName = `${performer.first_name} ${performer.last_name}`;
    let changed = 0;

    // "today" records the disconnection now. "scheduled" backdates it to the
    // missed disconnection date, but never before this account's most recent
    // status-history event and never into the future, so the service timeline
    // stays monotonic and migration 054's trigger still stops new charges.
    //
    // $1 customer_id, $2 scheduled date, $3 reason, $4 employee id,
    // $5 source_key, $6 mode, $7 actor name.
    const APPLY_ONE_SQL = `
      WITH eff AS (
        SELECT CASE
          WHEN $6 = 'today'
            THEN (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE
          ELSE LEAST(
            (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
            GREATEST(
              $2::DATE,
              (SELECT MAX(h.effective_date)
                 FROM public.account_status_history h
                WHERE h.customer_id = $1)
            )
          )
        END AS on_date
      ),
      upd AS (
        UPDATE public.customers c
        SET status = 'disconnected',
            deactivation_date = (SELECT on_date FROM eff)
        WHERE c.customer_id = $1
          AND c.status = 'active'
        RETURNING c.customer_id
      ),
      hist AS (
        INSERT INTO public.account_status_history (
          customer_id, from_status, to_status, reason,
          effective_date, changed_by_employee_id, source_key
        )
        SELECT $1, 'active', 'disconnected', $3,
               (SELECT on_date FROM eff), $4::BIGINT, $5
        WHERE EXISTS (SELECT 1 FROM upd)
        ON CONFLICT (source_key) DO NOTHING
        RETURNING 1
      ),
      aud AS (
        INSERT INTO public.audit_logs (
          employee_id, actor_name, action, entity_type, entity_id,
          field_name, old_value, new_value, reason, occurred_at, source_key
        )
        SELECT $4::BIGINT, $7, 'Marked disconnected (overdue 2025 cleanup)',
               'customer', $1::TEXT, 'status', 'active', 'disconnected', $3,
               CURRENT_TIMESTAMP, $5
        WHERE EXISTS (SELECT 1 FROM upd)
        ON CONFLICT (source_key) DO NOTHING
        RETURNING 1
      )
      SELECT customer_id FROM upd;
    `;

    for (const row of toDisconnect) {
      const result = await client.query(APPLY_ONE_SQL, [
        row.customer_id,
        row.scheduled_disconnection_date,
        STATUS_REASON,
        performer.employee_id,
        `bulk-2025-overdue-disconnect:${row.customer_id}`,
        effectiveMode,
        actorName,
      ]);
      if (result.rowCount && result.rowCount > 0) changed += 1;
    }

    await client.query("COMMIT");
    console.log(
      `\nMarked ${changed} account(s) disconnected. ${withOlt.length} account(s) with an ` +
        `ONT assignment were left active for the OLT sync. No balances were changed.`
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
    console.error(error instanceof Error ? error.message : "Unknown disconnection-cleanup error.");
    process.exitCode = 1;
  })
  .finally(() => pool.end());
