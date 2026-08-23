/** Automatically disconnects billing-eligible customers from their Huawei ONTs. */
import type { PoolClient } from "pg";
import { pool } from "../db.js";
import {
  changeOntActivationState,
  OltControlError,
  OltVerificationError,
} from "./verifyOnt.js";

const AUTOMATION_ACTOR = "SPCL Automatic Delinquency Scheduler";
const AUTOMATION_LOCK_ID = 56802026;
const MINUTE = 60_000;

type Candidate = {
  customer_id: number;
  customer_name: string;
  outstanding_balance: string;
  scheduled_disconnection_date: string;
  customer_ont_assignment_id: number | null;
  management_ip: string | null;
  frame_number: number | null;
  slot_number: number | null;
  pon_port_number: number | null;
  ont_id: number | null;
  ont_serial: string | null;
  mapping_status: string | null;
  candidate_count: number;
};

type ItemResult = "disconnected" | "skipped" | "failed";

function isEnabled() {
  return process.env.HUAWEI_OLT_AUTOMATION_ENABLED?.trim().toLowerCase() === "true";
}

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function configuration() {
  return {
    hour: boundedInteger(process.env.HUAWEI_OLT_AUTOMATION_HOUR, 9, 0, 23),
    minute: boundedInteger(process.env.HUAWEI_OLT_AUTOMATION_MINUTE, 0, 0, 59),
    maxPerRun: boundedInteger(process.env.HUAWEI_OLT_AUTOMATION_MAX_PER_RUN, 100, 1, 500),
  };
}

function jamaicaClock() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Jamaica",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
}

function mappingReady(candidate: Candidate) {
  return Boolean(
    candidate.customer_ont_assignment_id &&
      candidate.mapping_status === "verified" &&
      candidate.ont_serial &&
      candidate.management_ip
  );
}

async function finishItem(
  client: PoolClient,
  itemId: number,
  outcome: string,
  message: string,
  attemptId?: number
) {
  await client.query(
    `UPDATE public.olt_automation_run_items
     SET outcome = $2,
         message = $3,
         olt_action_attempt_id = COALESCE($4, olt_action_attempt_id),
         completed_at = CURRENT_TIMESTAMP
     WHERE olt_automation_run_item_id = $1;`,
    [itemId, outcome, message, attemptId ?? null]
  );
}

async function finalizeAttempt(
  attemptId: number,
  outcome: string,
  message: string,
  liveResult?: Awaited<ReturnType<typeof changeOntActivationState>>
) {
  await pool.query(
    `UPDATE public.olt_action_attempts
     SET outcome = $2,
         before_control_flag = $3,
         before_run_state = $4,
         after_control_flag = $5,
         after_run_state = $6,
         result_message = $7,
         completed_at = CURRENT_TIMESTAMP
     WHERE olt_action_attempt_id = $1
       AND outcome = 'requested';`,
    [
      attemptId,
      outcome,
      liveResult?.before.controlFlag ?? null,
      liveResult?.before.runState ?? null,
      liveResult?.after.controlFlag ?? null,
      liveResult?.after.runState ?? null,
      message,
    ]
  );
}

async function processCandidate(runId: number, candidate: Candidate): Promise<ItemResult> {
  const itemResult = await pool.query(
    `INSERT INTO public.olt_automation_run_items (
       olt_automation_run_id, customer_id, customer_ont_assignment_id,
       outstanding_balance, scheduled_disconnection_date
     ) VALUES ($1, $2, $3, $4, $5)
     RETURNING olt_automation_run_item_id;`,
    [
      runId,
      candidate.customer_id,
      candidate.customer_ont_assignment_id,
      candidate.outstanding_balance,
      candidate.scheduled_disconnection_date,
    ]
  );
  const itemId = Number(itemResult.rows[0].olt_automation_run_item_id);

  if (!mappingReady(candidate)) {
    await pool.query(
      `UPDATE public.olt_automation_run_items
       SET outcome = 'skipped_mapping',
           message = 'No current verified OLT mapping and serial; no command was sent.',
           completed_at = CURRENT_TIMESTAMP
       WHERE olt_automation_run_item_id = $1;`,
      [itemId]
    );
    return "skipped";
  }

  const assignmentId = Number(candidate.customer_ont_assignment_id);
  const unresolved = await pool.query(
    `SELECT olt_action_attempt_id
     FROM public.olt_action_attempts
     WHERE customer_ont_assignment_id = $1
       AND outcome IN ('requested', 'uncertain')
     LIMIT 1;`,
    [assignmentId]
  );
  if (unresolved.rows.length > 0) {
    await pool.query(
      `UPDATE public.olt_automation_run_items
       SET outcome = 'skipped_unresolved',
           message = $2,
           completed_at = CURRENT_TIMESTAMP
       WHERE olt_automation_run_item_id = $1;`,
      [itemId, `Existing ONT action #${unresolved.rows[0].olt_action_attempt_id} must be resolved first.`]
    );
    return "skipped";
  }

  const reason = `Automatic delinquency disconnection scheduled for ${candidate.scheduled_disconnection_date}`;
  let attemptId: number;
  try {
    const attemptResult = await pool.query(
      `INSERT INTO public.olt_action_attempts (
         customer_id, customer_ont_assignment_id, requested_by_employee_id,
         action, reason, management_ip, frame_number, slot_number,
         pon_port_number, ont_id, expected_ont_serial, workflow,
         account_status_before, account_status_after
       ) VALUES (
         $1, $2, NULL, 'deactivate', $3, $4::INET, $5, $6, $7, $8, $9,
         'account_transition', 'active', 'disconnected'
       )
       RETURNING olt_action_attempt_id;`,
      [
        candidate.customer_id,
        assignmentId,
        reason,
        candidate.management_ip,
        candidate.frame_number,
        candidate.slot_number,
        candidate.pon_port_number,
        candidate.ont_id,
        candidate.ont_serial,
      ]
    );
    attemptId = Number(attemptResult.rows[0].olt_action_attempt_id);
    await pool.query(
      `UPDATE public.olt_automation_run_items
       SET olt_action_attempt_id = $2
       WHERE olt_automation_run_item_id = $1;`,
      [itemId, attemptId]
    );
  } catch (error: unknown) {
    const message =
      typeof error === "object" && error && "code" in error && error.code === "23505"
        ? "Another ONT action began first; no automatic command was sent."
        : "Could not create the durable ONT action journal; no command was sent.";
    await pool.query(
      `UPDATE public.olt_automation_run_items
       SET outcome = 'skipped_unresolved', message = $2, completed_at = CURRENT_TIMESTAMP
       WHERE olt_automation_run_item_id = $1;`,
      [itemId, message]
    );
    return "skipped";
  }

  const client = await pool.connect();
  let liveResult: Awaited<ReturnType<typeof changeOntActivationState>> | undefined;
  try {
    await client.query("BEGIN");

    // This row lock is deliberate: payment recording also locks the customer,
    // so a cashier cannot clear the balance halfway through an automatic OLT
    // command. Whichever transaction starts second waits and then re-checks.
    await client.query(
      `SELECT customer_id
       FROM public.customers
       WHERE customer_id = $1
       FOR UPDATE;`,
      [candidate.customer_id]
    );

    // This is intentionally a second SQL statement. If a payment transaction
    // held the customer first, PostgreSQL waits above; the new statement below
    // then receives a fresh READ COMMITTED snapshot containing that payment.
    const currentResult = await client.query(
      `SELECT
         customer.status,
         billing.eligible_for_disconnection,
         billing.outstanding_balance,
         assignment.customer_ont_assignment_id,
         assignment.mapping_status,
         assignment.ont_serial
       FROM public.customers customer
       JOIN public.customer_billing_status billing USING (customer_id)
       JOIN public.customer_ont_assignments assignment
         ON assignment.customer_id = customer.customer_id
        AND assignment.ended_at IS NULL
       WHERE customer.customer_id = $1
         AND assignment.customer_ont_assignment_id = $2
       FOR UPDATE OF assignment;`,
      [candidate.customer_id, assignmentId]
    );
    const current = currentResult.rows[0];
    if (
      !current ||
      current.status !== "active" ||
      current.eligible_for_disconnection !== true ||
      current.mapping_status !== "verified" ||
      String(current.ont_serial ?? "").toUpperCase() !== String(candidate.ont_serial).toUpperCase()
    ) {
      const message = "Customer was no longer safely eligible immediately before the OLT action; no command was sent.";
      await client.query(
        `UPDATE public.olt_action_attempts
         SET outcome = 'blocked', result_message = $2, completed_at = CURRENT_TIMESTAMP
         WHERE olt_action_attempt_id = $1 AND outcome = 'requested';`,
        [attemptId, message]
      );
      await finishItem(client, itemId, "skipped_not_eligible", message, attemptId);
      await client.query("COMMIT");
      return "skipped";
    }

    liveResult = await changeOntActivationState(
      {
        managementIp: String(candidate.management_ip),
        frameNumber: Number(candidate.frame_number),
        slotNumber: Number(candidate.slot_number),
        ponPortNumber: Number(candidate.pon_port_number),
        ontId: Number(candidate.ont_id),
      },
      {
        ontSerial: String(candidate.ont_serial),
        customerName: candidate.customer_name,
      },
      "deactivate"
    );

    const historyResult = await client.query(
      `INSERT INTO public.account_status_history (
         customer_id, from_status, to_status, reason, effective_date,
         changed_by_employee_id, changed_at
       ) VALUES (
         $1, 'active', 'disconnected', $2,
         (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
         NULL, CURRENT_TIMESTAMP
       )
       RETURNING account_status_history_id;`,
      [candidate.customer_id, reason]
    );
    const historyId = Number(historyResult.rows[0].account_status_history_id);

    await client.query(
      `UPDATE public.customers
       SET status = 'disconnected',
           deactivation_date = (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE
       WHERE customer_id = $1;`,
      [candidate.customer_id]
    );
    await client.query(
      `INSERT INTO public.account_ledger_entries (
         customer_id, entry_type, amount, effective_date, due_date,
         grace_end_date, description, created_by_employee_id, source_key
       )
       SELECT
         customer.customer_id, 'reconnection_fee', package.reconnection_fee,
         (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
         (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
         (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
         'Reconnection fee required after automatic delinquency deactivation',
         NULL, 'reconnection-fee:status-history:' || $2::TEXT
       FROM public.customers customer
       JOIN public.packages package ON package.package_id = customer.package_id
       WHERE customer.customer_id = $1 AND package.reconnection_fee > 0
       ON CONFLICT (source_key) DO NOTHING;`,
      [candidate.customer_id, historyId]
    );

    const attemptOutcome = liveResult.changed ? "succeeded" : "no_change";
    const itemOutcome = liveResult.changed ? "disconnected" : "already_deactivated";
    const message = liveResult.changed
      ? "Automatically deactivated and confirmed on the live OLT; account marked disconnected."
      : "ONT was already deactivated; live state confirmed and account marked disconnected.";
    await client.query(
      `UPDATE public.olt_action_attempts
       SET outcome = $2,
           before_control_flag = $3,
           before_run_state = $4,
           after_control_flag = $5,
           after_run_state = $6,
           result_message = $7,
           account_status_applied_at = CURRENT_TIMESTAMP,
           completed_at = CURRENT_TIMESTAMP
       WHERE olt_action_attempt_id = $1 AND outcome = 'requested';`,
      [
        attemptId,
        attemptOutcome,
        liveResult.before.controlFlag,
        liveResult.before.runState,
        liveResult.after.controlFlag,
        liveResult.after.runState,
        message,
      ]
    );
    await finishItem(client, itemId, itemOutcome, message, attemptId);
    await client.query(
      `INSERT INTO public.audit_logs (
         employee_id, actor_name, action, entity_type, entity_id,
         field_name, old_value, new_value, reason, occurred_at
       ) VALUES (
         NULL, $1, 'Automatically disconnected delinquent customer',
         'customer', $2, 'status', 'active', 'disconnected', $3,
         CURRENT_TIMESTAMP
       );`,
      [AUTOMATION_ACTOR, String(candidate.customer_id), reason]
    );
    await client.query("COMMIT");
    return "disconnected";
  } catch (error) {
    await client.query("ROLLBACK");
    const outcome = liveResult
      ? "uncertain"
      : error instanceof OltControlError
        ? error.outcome
        : error instanceof OltVerificationError
          ? "blocked"
          : "failed";
    const message = liveResult
      ? "Huawei reached the requested state, but the account transaction did not commit. Do not retry automatically."
      : error instanceof OltVerificationError
        ? error.message
        : "Automatic OLT disconnection failed before completion.";
    try {
      await finalizeAttempt(attemptId, outcome, message, liveResult);
      await pool.query(
        `UPDATE public.olt_automation_run_items
         SET outcome = $2, message = $3, completed_at = CURRENT_TIMESTAMP
         WHERE olt_automation_run_item_id = $1 AND outcome = 'pending';`,
        [itemId, outcome === "uncertain" ? "uncertain" : "failed", message]
      );
    } catch (journalError) {
      console.error(`Could not finalize automatic OLT journal for customer ${candidate.customer_id}:`, journalError);
    }
    console.error(`Automatic OLT disconnection failed for customer ${candidate.customer_id}: ${message}`);
    return "failed";
  } finally {
    client.release();
  }
}

export async function runAutomaticDelinquentDisconnect() {
  if (!isEnabled()) return { ran: false, reason: "disabled" };

  const lockClient = await pool.connect();
  let runId: number | null = null;
  try {
    const lock = await lockClient.query(
      `SELECT pg_try_advisory_lock($1) AS acquired;`,
      [AUTOMATION_LOCK_ID]
    );
    if (!lock.rows[0]?.acquired) return { ran: false, reason: "already_running" };

    const clock = jamaicaClock();
    const existing = await lockClient.query(
      `SELECT olt_automation_run_id
       FROM public.olt_automation_runs
       WHERE billing_date = $1
       LIMIT 1;`,
      [clock.date]
    );
    if (existing.rows.length > 0) return { ran: false, reason: "already_ran_today" };

    await lockClient.query(
      `SELECT public.spcl_generate_monthly_charges($1::DATE);`,
      [clock.date]
    );
    const { maxPerRun } = configuration();
    const candidates = await lockClient.query<Candidate>(
      `SELECT
         customer.customer_id,
         customer.name AS customer_name,
         billing.outstanding_balance,
         billing.scheduled_disconnection_date,
         assignment.customer_ont_assignment_id,
         host(olt.management_ip) AS management_ip,
         assignment.frame_number,
         assignment.slot_number,
         assignment.pon_port_number,
         assignment.ont_id,
         assignment.ont_serial,
         assignment.mapping_status,
         COUNT(*) OVER()::INTEGER AS candidate_count
       FROM public.customer_billing_status billing
       JOIN public.customers customer USING (customer_id)
       LEFT JOIN public.customer_ont_assignments assignment
         ON assignment.customer_id = customer.customer_id
        AND assignment.ended_at IS NULL
       LEFT JOIN public.olts olt ON olt.olt_id = assignment.olt_id
       WHERE billing.eligible_for_disconnection
         AND customer.hidden_from_app = FALSE
         AND (
           customer.source_staging_id IS NULL
           OR billing.scheduled_disconnection_date IS NULL
           OR billing.scheduled_disconnection_date >= DATE '2025-01-01'
         )
       ORDER BY
         CASE WHEN assignment.mapping_status = 'verified' AND assignment.ont_serial IS NOT NULL THEN 0 ELSE 1 END,
         billing.scheduled_disconnection_date,
         customer.customer_id
       LIMIT $1;`,
      [maxPerRun]
    );
    const candidateCount = Number(candidates.rows[0]?.candidate_count ?? 0);
    const selectedCount = candidates.rows.length;
    const runResult = await lockClient.query(
      `INSERT INTO public.olt_automation_runs (
         billing_date, candidate_count, selected_count, remaining_count
       ) VALUES ($1, $2, $3, $4)
       RETURNING olt_automation_run_id;`,
      [clock.date, candidateCount, selectedCount, Math.max(candidateCount - selectedCount, 0)]
    );
    runId = Number(runResult.rows[0].olt_automation_run_id);

    let disconnected = 0;
    let skipped = 0;
    let failed = 0;
    for (const candidate of candidates.rows) {
      const result = await processCandidate(runId, candidate);
      if (result === "disconnected") disconnected += 1;
      else if (result === "skipped") skipped += 1;
      else failed += 1;
    }

    await lockClient.query(
      `UPDATE public.olt_automation_runs
       SET status = 'completed',
           disconnected_count = $2,
           skipped_count = $3,
           failed_count = $4,
           completed_at = CURRENT_TIMESTAMP
       WHERE olt_automation_run_id = $1;`,
      [runId, disconnected, skipped, failed]
    );
    console.log(
      `Automatic OLT run ${runId} completed: ${disconnected} disconnected, ${skipped} skipped, ${failed} failed.`
    );
    return { ran: true, runId, candidateCount, selectedCount, disconnected, skipped, failed };
  } catch (error) {
    console.error("Automatic delinquency OLT run failed:", error);
    if (runId !== null) {
      await pool.query(
        `UPDATE public.olt_automation_runs
         SET status = 'failed', error_message = $2, completed_at = CURRENT_TIMESTAMP
         WHERE olt_automation_run_id = $1 AND status = 'running';`,
        [runId, error instanceof Error ? error.message.slice(0, 1000) : "Unknown automation failure"]
      ).catch((journalError) => console.error("Could not finalize failed automation run:", journalError));
    }
    return { ran: false, reason: "failed" };
  } finally {
    await lockClient.query(`SELECT pg_advisory_unlock($1);`, [AUTOMATION_LOCK_ID]).catch(() => undefined);
    lockClient.release();
  }
}

let timer: NodeJS.Timeout | null = null;
let tickInProgress = false;

async function tick() {
  if (tickInProgress || !isEnabled()) return;
  const clock = jamaicaClock();
  const { hour, minute } = configuration();
  if (clock.hour < hour || (clock.hour === hour && clock.minute < minute)) return;
  tickInProgress = true;
  try {
    await runAutomaticDelinquentDisconnect();
  } finally {
    tickInProgress = false;
  }
}

export function startDelinquentAutomation() {
  const config = configuration();
  console.log(
    isEnabled()
      ? `Automatic delinquent OLT disconnection enabled for ${String(config.hour).padStart(2, "0")}:${String(config.minute).padStart(2, "0")} Jamaica time; maximum ${config.maxPerRun} customers per day.`
      : "Automatic delinquent OLT disconnection is disabled."
  );
  const startupTimer = setTimeout(() => void tick(), 15_000);
  startupTimer.unref();
  timer = setInterval(() => void tick(), MINUTE);
  timer.unref();
  return () => {
    clearTimeout(startupTimer);
    if (timer) clearInterval(timer);
    timer = null;
  };
}
