/** Automatically reconnects fully cleared pending accounts on their Huawei ONTs. */
import type { PoolClient } from "pg";
import { pool } from "../db.js";
import { OLT_AUTOMATION_LOCK_ID } from "./automationLock.js";
import { getAutomaticReconnectionPolicy } from "./controlPolicy.js";
import {
  changeOntActivationState,
  OltControlError,
  OltVerificationError,
  saveOltConfiguration,
} from "./verifyOnt.js";

const AUTOMATION_ACTOR = "SPCL Automatic Reconnection";
const MINUTE = 60_000;
const RETRY_MINUTES = 15;
const MAX_ATTEMPTS = 3;

type QueueCandidate = {
  customer_id: number;
  pending_status_history_id: number;
  customer_ont_assignment_id: number | null;
  management_ip: string | null;
  ont_serial: string | null;
  mapping_status: string | null;
};

type ReconnectionJob = {
  olt_reconnection_automation_job_id: number;
  customer_id: number;
  pending_status_history_id: number;
  current_status_history_id: number | null;
  attempt_count: number;
  customer_name: string;
  customer_status: string;
  ready_for_reconnection: boolean;
  customer_ont_assignment_id: number | null;
  management_ip: string | null;
  frame_number: number | null;
  slot_number: number | null;
  pon_port_number: number | null;
  ont_id: number | null;
  ont_serial: string | null;
  ont_description_override: string | null;
  mapping_status: string | null;
};

type DueSave = {
  olt_reconnection_automation_job_id: number;
  management_ip: string;
};

function enabled(value: string | undefined) {
  return value?.trim().toLowerCase() === "true";
}

function isEnabled() {
  return enabled(process.env.HUAWEI_OLT_RECONNECTION_AUTOMATION_ENABLED);
}

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function configuration() {
  return {
    maxPerTick: boundedInteger(
      process.env.HUAWEI_OLT_RECONNECTION_AUTOMATION_MAX_PER_TICK,
      10,
      1,
      100
    ),
    saveDelayMinutes: boundedInteger(
      process.env.HUAWEI_OLT_AUTOMATION_SAVE_DELAY_MINUTES,
      120,
      1,
      1440
    ),
  };
}

function mappingReady(candidate: QueueCandidate | ReconnectionJob) {
  return Boolean(
    candidate.customer_ont_assignment_id &&
      candidate.mapping_status === "verified" &&
      candidate.ont_serial &&
      candidate.management_ip
  );
}

async function setJobStatus(
  client: PoolClient,
  jobId: number,
  status: string,
  message: string,
  completed = false
) {
  await client.query(
    `UPDATE public.olt_reconnection_automation_jobs
     SET status = $2,
         message = $3,
         completed_at = CASE WHEN $4 THEN CURRENT_TIMESTAMP ELSE NULL END,
         updated_at = CURRENT_TIMESTAMP
     WHERE olt_reconnection_automation_job_id = $1;`,
    [jobId, status, message, completed]
  );
}

async function enqueueClearedPendingAccounts(client: PoolClient) {
  const candidates = await client.query<QueueCandidate>(
    `SELECT
       customer.customer_id,
       latest.account_status_history_id AS pending_status_history_id,
       assignment.customer_ont_assignment_id,
       host(olt.management_ip) AS management_ip,
       assignment.ont_serial,
       assignment.mapping_status
     FROM public.customers customer
     JOIN public.customer_billing_status billing USING (customer_id)
     JOIN LATERAL (
       SELECT history.account_status_history_id
       FROM public.account_status_history history
       WHERE history.customer_id = customer.customer_id
         AND history.to_status = 'pending_reconnection'
       ORDER BY history.changed_at DESC, history.account_status_history_id DESC
       LIMIT 1
     ) latest ON TRUE
     LEFT JOIN public.customer_ont_assignments assignment
       ON assignment.customer_id = customer.customer_id
      AND assignment.ended_at IS NULL
     LEFT JOIN public.olts olt ON olt.olt_id = assignment.olt_id
     WHERE customer.status = 'pending_reconnection'
       AND customer.hidden_from_app = FALSE
       AND NULLIF(BTRIM(customer.name), '') IS NOT NULL
       AND billing.ready_for_reconnection
     ORDER BY latest.account_status_history_id;`
  );

  for (const candidate of candidates.rows) {
    // The same account-action rollout policy protects unattended writes. A
    // customer outside the rollout remains in the normal manual queue.
    if (!getAutomaticReconnectionPolicy(candidate.customer_id).integrated) continue;

    await client.query(
      `INSERT INTO public.olt_reconnection_automation_jobs (
         customer_id, pending_status_history_id
       ) VALUES ($1, $2)
       ON CONFLICT (pending_status_history_id) DO UPDATE
       SET status = 'pending',
           next_attempt_at = CURRENT_TIMESTAMP,
           message = NULL,
           completed_at = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE olt_reconnection_automation_jobs.status = 'waiting_balance'
          OR olt_reconnection_automation_jobs.status = 'blocked_policy'
          OR (
            olt_reconnection_automation_jobs.status = 'blocked_mapping'
            AND $3::BOOLEAN
          )
          OR (
            olt_reconnection_automation_jobs.status = 'blocked_action'
            AND NOT EXISTS (
              SELECT 1
              FROM public.olt_action_attempts attempt
              WHERE attempt.customer_id = $1
                AND attempt.outcome IN ('requested', 'uncertain')
            )
          );`,
      [
        candidate.customer_id,
        candidate.pending_status_history_id,
        mappingReady(candidate),
      ]
    );
  }
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

async function loadJob(jobId: number) {
  const result = await pool.query<ReconnectionJob>(
    `SELECT
       job.olt_reconnection_automation_job_id,
       job.customer_id,
       job.pending_status_history_id,
       latest.account_status_history_id AS current_status_history_id,
       job.attempt_count,
       customer.name AS customer_name,
       customer.status AS customer_status,
       billing.ready_for_reconnection,
       assignment.customer_ont_assignment_id,
       host(olt.management_ip) AS management_ip,
       assignment.frame_number,
       assignment.slot_number,
       assignment.pon_port_number,
       assignment.ont_id,
       assignment.ont_serial,
       assignment.ont_description_override,
       assignment.mapping_status
     FROM public.olt_reconnection_automation_jobs job
     JOIN public.customers customer ON customer.customer_id = job.customer_id
     JOIN public.customer_billing_status billing
       ON billing.customer_id = customer.customer_id
     LEFT JOIN LATERAL (
       SELECT history.account_status_history_id
       FROM public.account_status_history history
       WHERE history.customer_id = customer.customer_id
       ORDER BY history.changed_at DESC, history.account_status_history_id DESC
       LIMIT 1
     ) latest ON TRUE
     LEFT JOIN public.customer_ont_assignments assignment
       ON assignment.customer_id = customer.customer_id
      AND assignment.ended_at IS NULL
     LEFT JOIN public.olts olt ON olt.olt_id = assignment.olt_id
     WHERE job.olt_reconnection_automation_job_id = $1
       AND job.status = 'pending';`,
    [jobId]
  );
  return result.rows[0] ?? null;
}

async function processJob(jobId: number) {
  const job = await loadJob(jobId);
  if (!job) return;

  if (
    job.customer_status !== "pending_reconnection" ||
    Number(job.current_status_history_id) !== Number(job.pending_status_history_id)
  ) {
    await pool.query(
      `UPDATE public.olt_reconnection_automation_jobs
       SET status = 'cancelled', completed_at = CURRENT_TIMESTAMP,
           message = 'Account left Pending Reconnection before automation ran.',
           updated_at = CURRENT_TIMESTAMP
       WHERE olt_reconnection_automation_job_id = $1 AND status = 'pending';`,
      [jobId]
    );
    return;
  }
  if (!job.ready_for_reconnection) {
    await pool.query(
      `UPDATE public.olt_reconnection_automation_jobs
       SET status = 'waiting_balance',
           message = 'The outstanding balance is not clear; no OLT command was sent.',
           updated_at = CURRENT_TIMESTAMP
       WHERE olt_reconnection_automation_job_id = $1 AND status = 'pending';`,
      [jobId]
    );
    return;
  }
  if (!getAutomaticReconnectionPolicy(job.customer_id).integrated) {
    await pool.query(
      `UPDATE public.olt_reconnection_automation_jobs
       SET status = 'blocked_policy',
           message = 'Automatic OLT account actions are not enabled for this customer.',
           updated_at = CURRENT_TIMESTAMP
       WHERE olt_reconnection_automation_job_id = $1 AND status = 'pending';`,
      [jobId]
    );
    return;
  }
  if (!mappingReady(job)) {
    await pool.query(
      `UPDATE public.olt_reconnection_automation_jobs
       SET status = 'blocked_mapping',
           message = 'A current verified OLT mapping and serial are required; no command was sent.',
           updated_at = CURRENT_TIMESTAMP
       WHERE olt_reconnection_automation_job_id = $1 AND status = 'pending';`,
      [jobId]
    );
    return;
  }

  const assignmentId = Number(job.customer_ont_assignment_id);
  const unresolved = await pool.query(
    `SELECT olt_action_attempt_id
     FROM public.olt_action_attempts
     WHERE customer_ont_assignment_id = $1
       AND outcome IN ('requested', 'uncertain')
     ORDER BY requested_at DESC
     LIMIT 1;`,
    [assignmentId]
  );
  if (unresolved.rows.length > 0) {
    await pool.query(
      `UPDATE public.olt_reconnection_automation_jobs
       SET status = 'blocked_action', message = $2, updated_at = CURRENT_TIMESTAMP
       WHERE olt_reconnection_automation_job_id = $1 AND status = 'pending';`,
      [jobId, `ONT action #${unresolved.rows[0].olt_action_attempt_id} must be resolved first.`]
    );
    return;
  }

  const claimed = await pool.query<{ attempt_count: number }>(
    `UPDATE public.olt_reconnection_automation_jobs
     SET attempt_count = attempt_count + 1,
         last_attempt_at = CURRENT_TIMESTAMP,
         next_attempt_at = CURRENT_TIMESTAMP + make_interval(mins => $2),
         message = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE olt_reconnection_automation_job_id = $1
       AND status = 'pending'
       AND attempt_count < $3
     RETURNING attempt_count;`,
    [jobId, RETRY_MINUTES, MAX_ATTEMPTS]
  );
  if (claimed.rows.length === 0) return;
  const attemptCount = Number(claimed.rows[0].attempt_count);
  const reason = "Automatic reconnection after the full balance and reconnection fee cleared";

  let attemptId: number;
  try {
    const attempt = await pool.query(
      `INSERT INTO public.olt_action_attempts (
         customer_id, customer_ont_assignment_id, requested_by_employee_id,
         action, reason, management_ip, frame_number, slot_number,
         pon_port_number, ont_id, expected_ont_serial, workflow,
         account_status_before, account_status_after
       ) VALUES (
         $1, $2, NULL, 'activate', $3, $4::INET, $5, $6, $7, $8, $9,
         'account_transition', 'pending_reconnection', 'active'
       )
       RETURNING olt_action_attempt_id;`,
      [
        job.customer_id,
        assignmentId,
        reason,
        job.management_ip,
        job.frame_number,
        job.slot_number,
        job.pon_port_number,
        job.ont_id,
        job.ont_serial,
      ]
    );
    attemptId = Number(attempt.rows[0].olt_action_attempt_id);
    await pool.query(
      `UPDATE public.olt_reconnection_automation_jobs
       SET olt_action_attempt_id = $2, updated_at = CURRENT_TIMESTAMP
       WHERE olt_reconnection_automation_job_id = $1;`,
      [jobId, attemptId]
    );
  } catch (error: unknown) {
    const conflict = typeof error === "object" && error && "code" in error && error.code === "23505";
    await pool.query(
      `UPDATE public.olt_reconnection_automation_jobs
       SET status = 'blocked_action', message = $2, updated_at = CURRENT_TIMESTAMP
       WHERE olt_reconnection_automation_job_id = $1;`,
      [jobId, conflict ? "Another ONT action began first." : "Could not create the durable ONT action journal."]
    );
    return;
  }

  const client = await pool.connect();
  let liveResult: Awaited<ReturnType<typeof changeOntActivationState>> | undefined;
  try {
    await client.query("BEGIN");
    await client.query(
      `SELECT customer_id FROM public.customers WHERE customer_id = $1 FOR UPDATE;`,
      [job.customer_id]
    );
    const currentResult = await client.query(
      `SELECT
         customer.status,
         billing.ready_for_reconnection,
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
      [job.customer_id, assignmentId]
    );
    const current = currentResult.rows[0];
    if (!current || current.status !== "pending_reconnection") {
      const message = "Account left Pending Reconnection before the OLT action; no command was sent.";
      await client.query(
        `UPDATE public.olt_action_attempts
         SET outcome = 'blocked', result_message = $2, completed_at = CURRENT_TIMESTAMP
         WHERE olt_action_attempt_id = $1 AND outcome = 'requested';`,
        [attemptId, message]
      );
      await setJobStatus(client, jobId, "cancelled", message, true);
      await client.query("COMMIT");
      return;
    }
    if (current.ready_for_reconnection !== true) {
      const message = "The outstanding balance stopped being clear before the OLT action; no command was sent.";
      await client.query(
        `UPDATE public.olt_action_attempts
         SET outcome = 'blocked', result_message = $2, completed_at = CURRENT_TIMESTAMP
         WHERE olt_action_attempt_id = $1 AND outcome = 'requested';`,
        [attemptId, message]
      );
      await setJobStatus(client, jobId, "waiting_balance", message);
      await client.query("COMMIT");
      return;
    }
    if (
      current.mapping_status !== "verified" ||
      String(current.ont_serial ?? "").toUpperCase() !== String(job.ont_serial).toUpperCase() ||
      (current.ont_description_override ?? null) !==
        (job.ont_description_override ?? null)
    ) {
      const message = "The verified OLT mapping changed before activation; no command was sent.";
      await client.query(
        `UPDATE public.olt_action_attempts
         SET outcome = 'blocked', result_message = $2, completed_at = CURRENT_TIMESTAMP
         WHERE olt_action_attempt_id = $1 AND outcome = 'requested';`,
        [attemptId, message]
      );
      await setJobStatus(client, jobId, "blocked_mapping", message);
      await client.query("COMMIT");
      return;
    }

    liveResult = await changeOntActivationState(
      {
        managementIp: String(job.management_ip),
        frameNumber: Number(job.frame_number),
        slotNumber: Number(job.slot_number),
        ponPortNumber: Number(job.pon_port_number),
        ontId: Number(job.ont_id),
      },
      {
        ontSerial: String(job.ont_serial),
        customerName: job.ont_description_override ?? job.customer_name,
      },
      "activate"
    );

    const historyResult = await client.query(
      `INSERT INTO public.account_status_history (
         customer_id, from_status, to_status, reason, effective_date,
         changed_by_employee_id, changed_at
       ) VALUES (
         $1, 'pending_reconnection', 'active', $2,
         (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
         NULL, CURRENT_TIMESTAMP
       )
       RETURNING account_status_history_id;`,
      [job.customer_id, reason]
    );
    const historyId = Number(historyResult.rows[0].account_status_history_id);
    await client.query(
      `UPDATE public.customers
       SET status = 'active',
           reactivation_date = (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE
       WHERE customer_id = $1;`,
      [job.customer_id]
    );
    await client.query(
      `UPDATE public.reconnection_requests
       SET status = 'approved',
           reviewed_by_employee_id = NULL,
           reviewed_at = CURRENT_TIMESTAMP,
           review_note = 'Automatically resolved after the full balance cleared and live OLT activation was confirmed.',
           account_status_history_id = $2
       WHERE customer_id = $1 AND status = 'pending';`,
      [job.customer_id, historyId]
    );

    const attemptOutcome = liveResult.changed ? "succeeded" : "no_change";
    const message = liveResult.changed
      ? "Automatically activated and confirmed on the live OLT; account marked active."
      : "ONT was already active; live state confirmed and account synchronized to active.";
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
    await client.query(
      `UPDATE public.olt_reconnection_automation_jobs
       SET status = 'succeeded',
           message = $2,
           completed_at = CURRENT_TIMESTAMP,
           management_ip = $3::INET,
           save_status = CASE WHEN $4 THEN 'pending' ELSE 'not_needed' END,
           save_next_attempt_at = CASE
             WHEN $4 THEN CURRENT_TIMESTAMP + make_interval(mins => $5)
             ELSE NULL
           END,
           updated_at = CURRENT_TIMESTAMP
       WHERE olt_reconnection_automation_job_id = $1;`,
      [jobId, message, job.management_ip, liveResult.changed, configuration().saveDelayMinutes]
    );
    await client.query(
      `INSERT INTO public.audit_logs (
         employee_id, actor_name, action, entity_type, entity_id,
         field_name, old_value, new_value, reason, occurred_at, source_key
       ) VALUES (
         NULL, $1, 'Automatically reconnected cleared customer',
         'customer', $2, 'status', 'pending_reconnection', 'active', $3,
         CURRENT_TIMESTAMP, $4
       )
       ON CONFLICT (source_key) DO NOTHING;`,
      [AUTOMATION_ACTOR, String(job.customer_id), message, `automatic-reconnection:${jobId}`]
    );
    await client.query("COMMIT");
    console.log(`Automatically reconnected customer ${job.customer_id}; job ${jobId}.`);
  } catch (error) {
    await client.query("ROLLBACK");
    const uncertain = Boolean(liveResult) ||
      (error instanceof OltControlError && error.outcome === "uncertain");
    const blocked = error instanceof OltControlError && error.outcome === "blocked";
    const attemptOutcome = uncertain
      ? "uncertain"
      : blocked
        ? "blocked"
        : error instanceof OltControlError
          ? error.outcome
          : "failed";
    const message = liveResult
      ? "The ONT reached Active, but the account database update did not commit. Do not retry automatically; reconcile both systems."
      : error instanceof OltVerificationError
        ? error.message
        : "Automatic reconnection failed before completion.";
    try {
      await finalizeAttempt(attemptId, attemptOutcome, message, liveResult);
      if (uncertain) {
        await pool.query(
          `UPDATE public.olt_reconnection_automation_jobs
           SET status = 'uncertain', message = $2, completed_at = CURRENT_TIMESTAMP,
               updated_at = CURRENT_TIMESTAMP
           WHERE olt_reconnection_automation_job_id = $1;`,
          [jobId, message]
        );
      } else if (blocked) {
        await pool.query(
          `UPDATE public.olt_reconnection_automation_jobs
           SET status = 'blocked_identity', message = $2, updated_at = CURRENT_TIMESTAMP
           WHERE olt_reconnection_automation_job_id = $1;`,
          [jobId, message]
        );
      } else {
        const finalAttempt = attemptCount >= MAX_ATTEMPTS;
        await pool.query(
          `UPDATE public.olt_reconnection_automation_jobs
           SET status = CASE WHEN $2 THEN 'failed' ELSE 'pending' END,
               message = $3,
               completed_at = CASE WHEN $2 THEN CURRENT_TIMESTAMP ELSE NULL END,
               updated_at = CURRENT_TIMESTAMP
           WHERE olt_reconnection_automation_job_id = $1;`,
          [jobId, finalAttempt, message]
        );
      }
    } catch (journalError) {
      console.error(`Could not finalize automatic reconnection job ${jobId}:`, journalError);
    }
    console.error(`Automatic reconnection failed for customer ${job.customer_id}: ${message}`);
  } finally {
    client.release();
  }
}

async function processDueSaves(client: PoolClient) {
  const due = await client.query<DueSave>(
    `SELECT DISTINCT ON (management_ip)
       olt_reconnection_automation_job_id,
       host(management_ip) AS management_ip
     FROM public.olt_reconnection_automation_jobs
     WHERE save_status = 'pending'
       AND save_attempt_count < $1
       AND save_next_attempt_at <= CURRENT_TIMESTAMP
     ORDER BY management_ip, save_next_attempt_at, olt_reconnection_automation_job_id
     LIMIT 20;`,
    [MAX_ATTEMPTS]
  );

  for (const save of due.rows) {
    const claimed = await client.query<{ save_attempt_count: number }>(
      `UPDATE public.olt_reconnection_automation_jobs
       SET save_attempt_count = save_attempt_count + 1,
           save_last_attempt_at = CURRENT_TIMESTAMP,
           save_next_attempt_at = CURRENT_TIMESTAMP + make_interval(mins => $2),
           save_error_message = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE management_ip = $1::INET
         AND save_status = 'pending'
         AND save_next_attempt_at <= CURRENT_TIMESTAMP
       RETURNING save_attempt_count;`,
      [save.management_ip, RETRY_MINUTES]
    );
    if (claimed.rows.length === 0) continue;

    try {
      await saveOltConfiguration(save.management_ip);
      await client.query("BEGIN");
      await client.query(
        `UPDATE public.olt_reconnection_automation_jobs
         SET save_status = 'succeeded',
             save_completed_at = CURRENT_TIMESTAMP,
             save_error_message = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE management_ip = $1::INET
           AND save_status = 'pending';`,
        [save.management_ip]
      );
      await client.query(
        `INSERT INTO public.audit_logs (
           employee_id, actor_name, action, entity_type, entity_id,
           field_name, old_value, new_value, reason, occurred_at, source_key
         ) VALUES (
           NULL, $1, 'Saved OLT configuration after automatic reconnection',
           'olt', $2, 'configuration', NULL, 'saved', $3,
           CURRENT_TIMESTAMP, $4
         )
         ON CONFLICT (source_key) DO NOTHING;`,
        [
          AUTOMATION_ACTOR,
          save.management_ip,
          "Persisted confirmed automatic ONT activations after the configured delay",
          `automatic-reconnection-save:${save.olt_reconnection_automation_job_id}`,
        ]
      );
      await client.query("COMMIT");
      console.log(`Saved OLT ${save.management_ip} after automatic reconnection.`);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      const message = error instanceof Error
        ? error.message.slice(0, 1000)
        : "Unknown OLT configuration-save failure.";
      await client.query(
        `UPDATE public.olt_reconnection_automation_jobs
         SET save_status = CASE WHEN save_attempt_count >= $2 THEN 'failed' ELSE 'pending' END,
             save_completed_at = CASE
               WHEN save_attempt_count >= $2 THEN CURRENT_TIMESTAMP ELSE NULL
             END,
             save_error_message = $3,
             updated_at = CURRENT_TIMESTAMP
         WHERE management_ip = $1::INET
           AND save_status = 'pending'
           AND save_last_attempt_at IS NOT NULL;`,
        [save.management_ip, MAX_ATTEMPTS, message]
      );
      console.error(`Could not save OLT ${save.management_ip} after automatic reconnection: ${message}`);
    }
  }
}

export async function runAutomaticReconnections() {
  if (!isEnabled()) return { ran: false, reason: "disabled" };

  const lockClient = await pool.connect();
  try {
    const lock = await lockClient.query(
      `SELECT pg_try_advisory_lock($1) AS acquired;`,
      [OLT_AUTOMATION_LOCK_ID]
    );
    if (!lock.rows[0]?.acquired) return { ran: false, reason: "already_running" };

    await lockClient.query(
      `SELECT public.spcl_generate_monthly_charges(
        (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE
      );`
    );
    await enqueueClearedPendingAccounts(lockClient);
    const jobs = await lockClient.query<{ olt_reconnection_automation_job_id: number }>(
      `SELECT olt_reconnection_automation_job_id
       FROM public.olt_reconnection_automation_jobs
       WHERE status = 'pending'
         AND attempt_count < $1
         AND next_attempt_at <= CURRENT_TIMESTAMP
       ORDER BY next_attempt_at, olt_reconnection_automation_job_id
       LIMIT $2;`,
      [MAX_ATTEMPTS, configuration().maxPerTick]
    );
    for (const job of jobs.rows) {
      await processJob(Number(job.olt_reconnection_automation_job_id));
    }
    await processDueSaves(lockClient);
    return { ran: true, processed: jobs.rows.length };
  } catch (error) {
    console.error("Automatic OLT reconnection tick failed:", error);
    return { ran: false, reason: "failed" };
  } finally {
    await lockClient
      .query(`SELECT pg_advisory_unlock($1);`, [OLT_AUTOMATION_LOCK_ID])
      .catch(() => undefined);
    lockClient.release();
  }
}

let timer: NodeJS.Timeout | null = null;
let tickInProgress = false;

async function tick() {
  if (tickInProgress || !isEnabled()) return;
  tickInProgress = true;
  try {
    await runAutomaticReconnections();
  } finally {
    tickInProgress = false;
  }
}

export function startReconnectionAutomation() {
  console.log(
    isEnabled()
      ? `Automatic cleared-account OLT reconnection enabled; up to ${configuration().maxPerTick} customers per minute.`
      : "Automatic cleared-account OLT reconnection is disabled."
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
