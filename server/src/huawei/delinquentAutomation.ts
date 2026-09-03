/** Automatically disconnects billing-eligible customers from their Huawei ONTs. */
import type { PoolClient } from "pg";
import { pool } from "../db.js";
import { OLT_AUTOMATION_LOCK_ID } from "./automationLock.js";
import { disconnectionDayBlock } from "./jamaicaDisconnectionCalendar.js";
import {
  changeOntActivationState,
  OltControlError,
  OltVerificationError,
  saveOltConfiguration,
} from "./verifyOnt.js";

const AUTOMATION_ACTOR = "SPCL Automatic Delinquency Scheduler";
const MINUTE = 60_000;
const SAVE_RETRY_MINUTES = 15;
const MAX_SAVE_ATTEMPTS = 3;

type Candidate = {
  customer_id: number;
  customer_name: string;
  outstanding_balance: string;
  grace_end_date: string;
  customer_ont_assignment_id: number | null;
  management_ip: string | null;
  frame_number: number | null;
  slot_number: number | null;
  pon_port_number: number | null;
  ont_id: number | null;
  ont_serial: string | null;
  ont_description_override: string | null;
  mapping_status: string | null;
  candidate_count: number;
};

type ItemResult = "disconnected" | "skipped" | "failed";

type ConfigurationSaveJob = {
  olt_automation_save_job_id: number;
  olt_automation_run_id: number;
  management_ip: string;
  attempt_count: number;
};

type AutomaticRunOptions = {
  /**
   * Allows an explicitly confirmed one-time continuation after today's normal
   * scheduled run. By default the candidate query still excludes every
   * customer already journaled today. retrySafeSkippedRunId is the narrow
   * exception for a prior preflight-only batch that contacted no OLTs.
   */
  allowAdditionalRunToday?: boolean;
  maxPerRunOverride?: number;
  /**
   * Optional hard ceiling on grace_end_date (YYYY-MM-DD). When set, only
   * accounts whose grace period ended on or before this date are eligible. The
   * one-time continuation batch uses
   * this to stay strictly inside an explicitly confirmed window regardless of
   * how the oldest-first ordering happens to fall.
   */
  maxGraceEndDate?: string;
  /**
   * Explicit one-time override for legacy balances that still contain an
   * unverified imported ledger entry. Scheduled runs never set this, so their
   * existing billing-safety gate remains closed.
   */
  includeUnverifiedLedgerEntries?: boolean;
  /**
   * Restrict selection itself to customers with a current verified mapping,
   * serial, and OLT. The live identity check still runs before every write.
   */
  requireVerifiedMapping?: boolean;
  /**
   * Retry only the customers from one earlier run whose final locked preflight
   * blocked before Huawei was contacted. This is narrower than bypassing the
   * same-day journal guard and preserves both run records for audit.
   */
  retrySafeSkippedRunId?: number;
};

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
    maxPerRun: boundedInteger(process.env.HUAWEI_OLT_AUTOMATION_MAX_PER_RUN, 300, 1, 500),
    saveDelayMinutes: boundedInteger(
      process.env.HUAWEI_OLT_AUTOMATION_SAVE_DELAY_MINUTES,
      120,
      1,
      1440
    ),
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

async function processDueConfigurationSaves() {
  const lockClient = await pool.connect();
  try {
    const lock = await lockClient.query(
      `SELECT pg_try_advisory_lock($1) AS acquired;`,
      [OLT_AUTOMATION_LOCK_ID]
    );
    if (!lock.rows[0]?.acquired) return;

    const jobs = await lockClient.query<ConfigurationSaveJob>(
      `SELECT
         olt_automation_save_job_id,
         olt_automation_run_id,
         host(management_ip) AS management_ip,
         attempt_count
       FROM public.olt_automation_save_jobs
       WHERE status = 'pending'
         AND attempt_count < $1
         AND next_attempt_at <= CURRENT_TIMESTAMP
       ORDER BY next_attempt_at, olt_automation_save_job_id
       LIMIT 20;`,
      [MAX_SAVE_ATTEMPTS]
    );

    for (const job of jobs.rows) {
      const attemptResult = await lockClient.query<{ attempt_count: number }>(
        `UPDATE public.olt_automation_save_jobs
         SET attempt_count = attempt_count + 1,
             last_attempt_at = CURRENT_TIMESTAMP,
             next_attempt_at = CURRENT_TIMESTAMP + make_interval(mins => $2),
             error_message = NULL
         WHERE olt_automation_save_job_id = $1
           AND status = 'pending'
         RETURNING attempt_count;`,
        [job.olt_automation_save_job_id, SAVE_RETRY_MINUTES]
      );
      if (attemptResult.rows.length === 0) continue;
      const attemptCount = Number(attemptResult.rows[0].attempt_count);

      try {
        await saveOltConfiguration(job.management_ip);
        await lockClient.query("BEGIN");
        await lockClient.query(
          `UPDATE public.olt_automation_save_jobs
           SET status = 'succeeded',
               completed_at = CURRENT_TIMESTAMP,
               error_message = NULL
           WHERE olt_automation_save_job_id = $1
             AND status = 'pending';`,
          [job.olt_automation_save_job_id]
        );
        await lockClient.query(
          `INSERT INTO public.audit_logs (
             employee_id, actor_name, action, entity_type, entity_id,
             field_name, old_value, new_value, reason, occurred_at, source_key
           ) VALUES (
             NULL, $1, 'Saved OLT configuration', 'olt', $2,
             'configuration', NULL,
             json_build_object(
               'automationRunId', $3::BIGINT,
               'savedAt', CURRENT_TIMESTAMP
             )::TEXT,
             $4, CURRENT_TIMESTAMP, $5
           )
           ON CONFLICT (source_key) DO NOTHING;`,
          [
            AUTOMATION_ACTOR,
            job.management_ip,
            job.olt_automation_run_id,
            `Persisted confirmed automatic disconnections after the configured ${configuration().saveDelayMinutes}-minute delay`,
            `olt-automation-save:${job.olt_automation_run_id}:${job.management_ip}`,
          ]
        );
        await lockClient.query("COMMIT");
        console.log(
          `Saved OLT ${job.management_ip} configuration for automatic run ${job.olt_automation_run_id}.`
        );
      } catch (error) {
        await lockClient.query("ROLLBACK").catch(() => undefined);
        const message =
          error instanceof Error
            ? error.message.slice(0, 1000)
            : "Unknown OLT configuration-save failure.";
        const finalAttempt = attemptCount >= MAX_SAVE_ATTEMPTS;
        await lockClient.query(
          `UPDATE public.olt_automation_save_jobs
           SET status = CASE WHEN $2 THEN 'failed' ELSE 'pending' END,
               completed_at = CASE WHEN $2 THEN CURRENT_TIMESTAMP ELSE NULL END,
               error_message = $3
           WHERE olt_automation_save_job_id = $1;`,
          [job.olt_automation_save_job_id, finalAttempt, message]
        );
        console.error(
          `Could not save OLT ${job.management_ip} configuration for automatic run ${job.olt_automation_run_id} (attempt ${attemptCount}/${MAX_SAVE_ATTEMPTS}): ${message}`
        );
      }
    }
  } catch (error) {
    console.error("Could not process delayed OLT configuration saves:", error);
  } finally {
    await lockClient
      .query(`SELECT pg_advisory_unlock($1);`, [OLT_AUTOMATION_LOCK_ID])
      .catch(() => undefined);
    lockClient.release();
  }
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

async function processCandidate(
  runId: number,
  candidate: Candidate,
  options: AutomaticRunOptions
): Promise<ItemResult> {
  const itemResult = await pool.query(
    `INSERT INTO public.olt_automation_run_items (
       olt_automation_run_id, customer_id, customer_ont_assignment_id,
       outstanding_balance, grace_end_date
     ) VALUES ($1, $2, $3, $4, $5)
     RETURNING olt_automation_run_item_id;`,
    [
      runId,
      candidate.customer_id,
      candidate.customer_ont_assignment_id,
      candidate.outstanding_balance,
      candidate.grace_end_date,
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

  const reason = `Automatic delinquency disconnection after grace ended ${candidate.grace_end_date}`;
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
         billing.unverified_entries,
         assignment.customer_ont_assignment_id,
         assignment.mapping_status,
         assignment.ont_serial,
         assignment.ont_description_override
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
      (
        Number(current.unverified_entries) > 0 &&
        options.includeUnverifiedLedgerEntries !== true
      ) ||
      current.mapping_status !== "verified" ||
      String(current.ont_serial ?? "").toUpperCase() !== String(candidate.ont_serial).toUpperCase() ||
      (current.ont_description_override ?? null) !==
        (candidate.ont_description_override ?? null)
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
        customerName:
          candidate.ont_description_override ?? candidate.customer_name,
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

export async function runAutomaticDelinquentDisconnect(options: AutomaticRunOptions = {}) {
  if (!isEnabled()) return { ran: false, reason: "disabled" };

  const clock = jamaicaClock();
  const dayBlock = disconnectionDayBlock(clock.date);
  if (dayBlock.blocked) {
    return {
      ran: false,
      reason: "non_disconnection_day",
      blockedReason: dayBlock.reason,
    };
  }

  const lockClient = await pool.connect();
  let runId: number | null = null;
  try {
    const lock = await lockClient.query(
      `SELECT pg_try_advisory_lock($1) AS acquired;`,
      [OLT_AUTOMATION_LOCK_ID]
    );
    if (!lock.rows[0]?.acquired) return { ran: false, reason: "already_running" };

    const existing = await lockClient.query(
      `SELECT olt_automation_run_id
       FROM public.olt_automation_runs
       WHERE billing_date = $1
       LIMIT 1;`,
      [clock.date]
    );
    if (existing.rows.length > 0 && !options.allowAdditionalRunToday) {
      return { ran: false, reason: "already_ran_today" };
    }

    await lockClient.query(
      `SELECT public.spcl_generate_monthly_charges($1::DATE);`,
      [clock.date]
    );
    const configuredMaximum = configuration().maxPerRun;
    const maxPerRun = options.maxPerRunOverride === undefined
      ? configuredMaximum
      : boundedInteger(String(options.maxPerRunOverride), configuredMaximum, 1, 500);
    const candidates = await lockClient.query<Candidate>(
      `SELECT
         customer.customer_id,
         customer.name AS customer_name,
         billing.outstanding_balance,
         billing.grace_end_date,
         assignment.customer_ont_assignment_id,
         host(olt.management_ip) AS management_ip,
         assignment.frame_number,
         assignment.slot_number,
         assignment.pon_port_number,
         assignment.ont_id,
         assignment.ont_serial,
         assignment.ont_description_override,
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
         -- Estimated legacy ledger balances remain visible to staff, but are
         -- not authoritative enough for an unattended disconnection.
         AND ($4::BOOLEAN OR billing.unverified_entries = 0)
         -- An explicitly confirmed one-time run can require an actionable
         -- mapping up front instead of spending its cap on known safe skips.
         AND (
           NOT $5::BOOLEAN
           OR (
             assignment.customer_ont_assignment_id IS NOT NULL
             AND assignment.mapping_status = 'verified'
             AND NULLIF(TRIM(assignment.ont_serial), '') IS NOT NULL
             AND olt.management_ip IS NOT NULL
           )
         )
         -- A deliberately requested continuation normally excludes every
         -- account journaled earlier that day. The only exception is an
         -- explicitly named run whose locked preflight blocked before Huawei
         -- was contacted; both journals remain intact for audit.
         AND (
           (
             $6::BIGINT IS NULL
             AND NOT EXISTS (
               SELECT 1
               FROM public.olt_automation_run_items earlier_item
               JOIN public.olt_automation_runs earlier_run
                 ON earlier_run.olt_automation_run_id = earlier_item.olt_automation_run_id
               WHERE earlier_run.billing_date = $2
                 AND earlier_item.customer_id = customer.customer_id
             )
           )
           OR (
             $6::BIGINT IS NOT NULL
             AND EXISTS (
               SELECT 1
               FROM public.olt_automation_run_items retry_item
               JOIN public.olt_automation_runs retry_run
                 ON retry_run.olt_automation_run_id = retry_item.olt_automation_run_id
               JOIN public.olt_action_attempts retry_attempt
                 ON retry_attempt.olt_action_attempt_id = retry_item.olt_action_attempt_id
               WHERE retry_item.olt_automation_run_id = $6
                 AND retry_run.billing_date = $2
                 AND retry_item.customer_id = customer.customer_id
                 AND retry_item.outcome = 'skipped_not_eligible'
                 AND retry_attempt.outcome = 'blocked'
                 AND retry_attempt.before_control_flag IS NULL
                 AND retry_attempt.after_control_flag IS NULL
                 AND retry_attempt.result_message =
                   'Customer was no longer safely eligible immediately before the OLT action; no command was sent.'
             )
           )
         )
         AND (
           customer.source_staging_id IS NULL
           OR billing.grace_end_date >= DATE '2025-01-01'
         )
         -- Optional hard ceiling for an explicitly confirmed continuation run.
         -- eligible_for_disconnection already guarantees a grace-end date.
         AND (
           $3::DATE IS NULL
           OR billing.grace_end_date <= $3::DATE
         )
       ORDER BY
         CASE WHEN assignment.mapping_status = 'verified' AND assignment.ont_serial IS NOT NULL THEN 0 ELSE 1 END,
         billing.grace_end_date,
         customer.customer_id
       LIMIT $1;`,
      [
        maxPerRun,
        clock.date,
        options.maxGraceEndDate ?? null,
        options.includeUnverifiedLedgerEntries === true,
        options.requireVerifiedMapping === true,
        options.retrySafeSkippedRunId ?? null,
      ]
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
      const result = await processCandidate(runId, candidate, options);
      if (result === "disconnected") disconnected += 1;
      else if (result === "skipped") skipped += 1;
      else failed += 1;
    }

    // Complete the run and create its per-OLT save jobs atomically. If the API
    // restarts during the two-hour wait, the jobs remain due in PostgreSQL.
    await lockClient.query("BEGIN");
    try {
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
      await lockClient.query(
        `INSERT INTO public.olt_automation_save_jobs (
           olt_automation_run_id, management_ip, next_attempt_at
         )
         SELECT DISTINCT
           run.olt_automation_run_id,
           attempt.management_ip,
           run.completed_at + make_interval(mins => $2)
         FROM public.olt_automation_runs run
         JOIN public.olt_automation_run_items item
           ON item.olt_automation_run_id = run.olt_automation_run_id
         JOIN public.olt_action_attempts attempt
           ON attempt.olt_action_attempt_id = item.olt_action_attempt_id
         WHERE run.olt_automation_run_id = $1
           AND item.outcome = 'disconnected'
           AND attempt.outcome = 'succeeded'
         ON CONFLICT (olt_automation_run_id, management_ip) DO NOTHING;`,
        [runId, configuration().saveDelayMinutes]
      );
      await lockClient.query("COMMIT");
    } catch (error) {
      await lockClient.query("ROLLBACK");
      throw error;
    }
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
    await lockClient.query(`SELECT pg_advisory_unlock($1);`, [OLT_AUTOMATION_LOCK_ID]).catch(() => undefined);
    lockClient.release();
  }
}

let timer: NodeJS.Timeout | null = null;
let tickInProgress = false;

async function tick() {
  if (tickInProgress || !isEnabled()) return;
  tickInProgress = true;
  try {
    // Delayed saves are checked regardless of today's disconnection time. A
    // save due after midnight must not wait for the next batch's start time.
    await processDueConfigurationSaves();
    const clock = jamaicaClock();
    const { hour, minute } = configuration();
    if (clock.hour < hour || (clock.hour === hour && clock.minute < minute)) return;
    await runAutomaticDelinquentDisconnect();
  } finally {
    tickInProgress = false;
  }
}

export function startDelinquentAutomation() {
  const config = configuration();
  console.log(
    isEnabled()
      ? `Automatic delinquent OLT disconnection enabled for ${String(config.hour).padStart(2, "0")}:${String(config.minute).padStart(2, "0")} Jamaica time; maximum ${config.maxPerRun} customers per day; Sunday 00:00 and Jamaican public holidays are blocked; affected OLTs save ${config.saveDelayMinutes} minutes after each run.`
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
