/** Queues and delivers five-day disconnection warnings without duplicates. */
import type { PoolClient } from "pg";
import { pool } from "../db.js";
import { isEmail } from "./gmailClient.js";
import { sendDisconnectionReminderEmail } from "./disconnectionReminderEmail.js";

const REMINDER_LOCK_ID = 821_005_005;
const ELIGIBILITY_VERSION = 2;
const MINUTE = 60_000;
const AUTOMATION_ACTOR = "SPCL Automatic Email Reminder Scheduler";

type QueueRow = {
  customer_email_notification_id: number;
  customer_id: number;
  due_date: string | Date;
  grace_end_date: string | Date;
};

type EligibleCustomer = {
  customer_id: number;
  customer_name: string | null;
  email: string | null;
  outstanding_balance: string;
  due_date: string | Date;
  grace_end_date: string | Date;
};

function isEnabled() {
  return process.env.EMAIL_REMINDERS_ENABLED?.trim().toLowerCase() === "true";
}

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function configuration() {
  return {
    startDate: configuredStartDate(),
    hour: boundedInteger(process.env.EMAIL_REMINDERS_HOUR, 8, 0, 23),
    minute: boundedInteger(process.env.EMAIL_REMINDERS_MINUTE, 0, 0, 59),
    batchSize: boundedInteger(process.env.EMAIL_REMINDERS_BATCH_SIZE, 20, 1, 50),
    dailyLimit: boundedInteger(process.env.EMAIL_REMINDERS_DAILY_LIMIT, 1500, 1, 1900),
    maxAttempts: boundedInteger(process.env.EMAIL_REMINDERS_MAX_ATTEMPTS, 3, 1, 5),
  };
}

function configuredStartDate() {
  const value = process.env.EMAIL_REMINDERS_START_DATE?.trim() ?? "";
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    console.error("EMAIL_REMINDERS_START_DATE must use YYYY-MM-DD; reminder delivery is locked.");
    return "9999-12-31";
  }
  const parsed = new Date(`${value}T12:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    console.error("EMAIL_REMINDERS_START_DATE is not a real calendar date; reminder delivery is locked.");
    return "9999-12-31";
  }
  return value;
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

function safeDeliveryError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (/not configured/i.test(message)) return "Email delivery is not configured on this server.";
  if (/invalid_grant|unauthorized|authentication|credentials/i.test(message)) {
    return "Gmail authorization needs attention.";
  }
  return "Gmail could not send this reminder.";
}

export async function queueFiveDayDisconnectionReminders(billingDate = jamaicaClock().date) {
  const client = await pool.connect();
  let runId: number | null = null;
  let acquired = false;
  let transactionOpen = false;
  try {
    const lock = await client.query(`SELECT pg_try_advisory_lock($1) AS acquired;`, [REMINDER_LOCK_ID]);
    acquired = Boolean(lock.rows[0]?.acquired);
    if (!acquired) return { queued: false, reason: "already_running" };

    await client.query("BEGIN");
    transactionOpen = true;
    await client.query(`SELECT public.spcl_generate_monthly_charges($1::DATE);`, [billingDate]);
    const runResult = await client.query(
      `INSERT INTO public.customer_email_notification_runs (
         notification_type, billing_date, eligibility_version
       ) VALUES ('disconnection_5_day', $1, $2)
       ON CONFLICT (notification_type, billing_date) DO UPDATE SET
         status = 'running',
         eligibility_version = EXCLUDED.eligibility_version,
         candidate_count = 0,
         queued_count = 0,
         skipped_count = 0,
         error_message = NULL,
         started_at = CURRENT_TIMESTAMP,
         completed_at = NULL
       WHERE customer_email_notification_runs.eligibility_version
               < EXCLUDED.eligibility_version
         AND customer_email_notification_runs.candidate_count = 0
         AND customer_email_notification_runs.queued_count = 0
         AND customer_email_notification_runs.skipped_count = 0
       RETURNING customer_email_notification_run_id;`,
      [billingDate, ELIGIBILITY_VERSION],
    );
    if (runResult.rows.length === 0) {
      await client.query("ROLLBACK");
      transactionOpen = false;
      return { queued: false, reason: "already_queued_today" };
    }
    runId = Number(runResult.rows[0].customer_email_notification_run_id);

    await client.query(
      `INSERT INTO public.customer_email_notifications (
         customer_email_notification_run_id, customer_id, notification_type,
         deduplication_key, recipient_email, due_date, grace_end_date,
         outstanding_balance, status, completed_at
       )
       SELECT
         $1,
         customer.customer_id,
         'disconnection_5_day',
         'disconnection-5-day:' || customer.customer_id::TEXT || ':' ||
           billing.grace_end_date::TEXT,
         NULLIF(LOWER(BTRIM(customer.email)), ''),
         billing.oldest_unpaid_due_date,
         billing.grace_end_date,
         billing.outstanding_balance,
         CASE
           WHEN customer.email IS NOT NULL
             AND LENGTH(BTRIM(customer.email)) <= 254
             AND BTRIM(customer.email) ~ '^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$'
           THEN 'pending'
           ELSE 'skipped_no_email'
         END,
         CASE
           WHEN customer.email IS NOT NULL
             AND LENGTH(BTRIM(customer.email)) <= 254
             AND BTRIM(customer.email) ~ '^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$'
           THEN NULL
           ELSE CURRENT_TIMESTAMP
         END
       FROM public.customer_billing_status billing
       JOIN public.customers customer USING (customer_id)
       WHERE customer.status = 'active'
         AND customer.hidden_from_app = FALSE
         AND billing.outstanding_balance > 0
         AND billing.oldest_unpaid_due_date = $2::DATE - 5
         AND billing.grace_end_date = $2::DATE + 5
         AND billing.is_on_hold = FALSE
       ON CONFLICT (deduplication_key) DO NOTHING;`,
      [runId, billingDate],
    );

    const counts = await client.query(
      `SELECT
         COUNT(*)::INTEGER AS candidate_count,
         COUNT(*) FILTER (WHERE status = 'pending')::INTEGER AS queued_count,
         COUNT(*) FILTER (WHERE status = 'skipped_no_email')::INTEGER AS skipped_count
       FROM public.customer_email_notifications
       WHERE customer_email_notification_run_id = $1;`,
      [runId],
    );
    const summary = counts.rows[0];
    await client.query(
      `UPDATE public.customer_email_notification_runs
       SET status = 'completed', candidate_count = $2, queued_count = $3,
           skipped_count = $4, completed_at = CURRENT_TIMESTAMP
       WHERE customer_email_notification_run_id = $1;`,
      [runId, summary.candidate_count, summary.queued_count, summary.skipped_count],
    );
    await client.query("COMMIT");
    transactionOpen = false;
    console.log(
      `Five-day email reminder run ${runId}: ${summary.queued_count} queued, ${summary.skipped_count} skipped without a usable email.`,
    );
    return { queued: true, runId, ...summary };
  } catch (error) {
    console.error("Could not queue five-day disconnection reminders:", error);
    if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
    return { queued: false, reason: "failed" };
  } finally {
    if (acquired) {
      await client.query(`SELECT pg_advisory_unlock($1);`, [REMINDER_LOCK_ID]).catch(() => undefined);
    }
    client.release();
  }
}

async function currentEligibility(client: PoolClient, item: QueueRow) {
  const result = await client.query<EligibleCustomer>(
    `SELECT
       customer.customer_id,
       customer.name AS customer_name,
       NULLIF(LOWER(BTRIM(customer.email)), '') AS email,
       billing.outstanding_balance,
       billing.oldest_unpaid_due_date AS due_date,
       billing.grace_end_date
     FROM public.customers customer
     JOIN public.customer_billing_status billing USING (customer_id)
     WHERE customer.customer_id = $1
       AND customer.status = 'active'
       AND customer.hidden_from_app = FALSE
       AND billing.outstanding_balance > 0
       AND billing.oldest_unpaid_due_date = $2::DATE
       AND billing.grace_end_date = $3::DATE
       AND billing.is_on_hold = FALSE;`,
    [item.customer_id, toIsoDate(item.due_date), toIsoDate(item.grace_end_date)],
  );
  return result.rows[0] ?? null;
}

async function finishSkipped(client: PoolClient, itemId: number, status: "skipped_no_email" | "skipped_no_longer_eligible", reason: string) {
  await client.query(
    `UPDATE public.customer_email_notifications
     SET status = $2, last_error = $3, completed_at = CURRENT_TIMESTAMP
     WHERE customer_email_notification_id = $1;`,
    [itemId, status, reason],
  );
}

async function sendQueueItem(client: PoolClient, item: QueueRow) {
  const eligible = await currentEligibility(client, item);
  if (!eligible) {
    await finishSkipped(
      client,
      item.customer_email_notification_id,
      "skipped_no_longer_eligible",
      "The account was paid, held, changed, hidden, or no longer tied to this grace-period end date.",
    );
    return;
  }
  if (!eligible.email || !isEmail(eligible.email)) {
    await finishSkipped(client, item.customer_email_notification_id, "skipped_no_email", "No usable account email was available at send time.");
    return;
  }

  await client.query(
    `UPDATE public.customer_email_notifications
     SET recipient_email = $2, outstanding_balance = $3
     WHERE customer_email_notification_id = $1;`,
    [item.customer_email_notification_id, eligible.email, eligible.outstanding_balance],
  );

  const attempt = await client.query<{ attempt_count: number }>(
    `UPDATE public.customer_email_notifications
     SET attempt_count = attempt_count + 1
     WHERE customer_email_notification_id = $1
     RETURNING attempt_count;`,
    [item.customer_email_notification_id],
  );
  const attemptCount = Number(attempt.rows[0].attempt_count);

  let sent: Awaited<ReturnType<typeof sendDisconnectionReminderEmail>>;
  try {
    sent = await sendDisconnectionReminderEmail({
      customerId: eligible.customer_id,
      customerName: eligible.customer_name,
      recipientEmail: eligible.email,
      outstandingBalance: eligible.outstanding_balance,
      dueDate: eligible.due_date,
      graceEndDate: eligible.grace_end_date,
    });
  } catch (error) {
    const config = configuration();
    const finalAttempt = attemptCount >= config.maxAttempts;
    const message = safeDeliveryError(error);
    await client.query(
      `UPDATE public.customer_email_notifications
       SET status = CASE WHEN $2 THEN 'failed' ELSE 'pending' END,
           last_error = $3,
           next_attempt_at = CURRENT_TIMESTAMP + make_interval(mins => $4),
           completed_at = CASE WHEN $2 THEN CURRENT_TIMESTAMP ELSE NULL END
       WHERE customer_email_notification_id = $1;`,
      [item.customer_email_notification_id, finalAttempt, message, Math.min(attemptCount * 5, 30)],
    );
    console.error(
      `Reminder email ${item.customer_email_notification_id} failed attempt ${attemptCount}/${config.maxAttempts}: ${message}`,
    );
    return;
  }

  await client.query(
    `UPDATE public.customer_email_notifications
     SET status = 'sent', provider_message_id = $2, last_error = NULL,
         sent_at = CURRENT_TIMESTAMP, completed_at = CURRENT_TIMESTAMP
     WHERE customer_email_notification_id = $1;`,
    [item.customer_email_notification_id, sent.providerMessageId],
  );

  try {
    await client.query(
      `INSERT INTO public.audit_logs (
         employee_id, actor_name, action, entity_type, entity_id,
         field_name, old_value, new_value, reason, occurred_at, source_key
       ) VALUES (
         NULL, $1, 'Sent five-day disconnection email', 'customer', $2,
         'email_notification', NULL, $3, $4, CURRENT_TIMESTAMP, $5
       ) ON CONFLICT (source_key) DO NOTHING;`,
      [
        AUTOMATION_ACTOR,
        String(eligible.customer_id),
        eligible.email,
        `Outstanding ${eligible.outstanding_balance}; due ${toIsoDate(eligible.due_date)}; grace ends ${toIsoDate(eligible.grace_end_date)}`,
        `email-disconnection-5-day:${eligible.customer_id}:${toIsoDate(eligible.grace_end_date)}`,
      ],
    );
  } catch (error) {
    // Delivery is already confirmed. An audit-log failure must never turn a
    // successful send back into a pending row and email the customer twice.
    console.error(`Reminder ${item.customer_email_notification_id} sent, but its audit entry failed:`, error);
  }
}

export async function processDisconnectionReminderQueue() {
  const client = await pool.connect();
  let acquired = false;
  try {
    const lock = await client.query(`SELECT pg_try_advisory_lock($1) AS acquired;`, [REMINDER_LOCK_ID]);
    acquired = Boolean(lock.rows[0]?.acquired);
    if (!acquired) return;
    const config = configuration();

    await client.query(
      `UPDATE public.customer_email_notifications
       SET status = 'pending', next_attempt_at = CURRENT_TIMESTAMP,
           last_error = 'Recovered after an interrupted send.'
       WHERE status = 'sending'
         AND last_attempted_at < CURRENT_TIMESTAMP - INTERVAL '15 minutes';`,
    );

    const sentToday = await client.query(
      `SELECT COUNT(*)::INTEGER AS count
       FROM public.customer_email_notifications
       WHERE status = 'sent'
         AND (sent_at AT TIME ZONE 'America/Jamaica')::DATE =
           (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE;`,
    );
    const remaining = Math.max(config.dailyLimit - Number(sentToday.rows[0].count), 0);
    if (remaining === 0) return;

    const selected = await client.query<QueueRow>(
      `UPDATE public.customer_email_notifications notification
       SET status = 'sending', last_attempted_at = CURRENT_TIMESTAMP,
           last_error = NULL
       FROM (
         SELECT customer_email_notification_id
         FROM public.customer_email_notifications
         WHERE status = 'pending' AND next_attempt_at <= CURRENT_TIMESTAMP
         ORDER BY next_attempt_at, customer_email_notification_id
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       ) selected
       WHERE notification.customer_email_notification_id = selected.customer_email_notification_id
       RETURNING notification.customer_email_notification_id,
         notification.customer_id, notification.due_date,
         notification.grace_end_date;`,
      [Math.min(config.batchSize, remaining)],
    );

    for (const item of selected.rows) await sendQueueItem(client, item);
  } catch (error) {
    console.error("Could not process disconnection email reminder queue:", error);
  } finally {
    if (acquired) {
      await client.query(`SELECT pg_advisory_unlock($1);`, [REMINDER_LOCK_ID]).catch(() => undefined);
    }
    client.release();
  }
}

function toIsoDate(value: string | Date) {
  if (value instanceof Date) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  return value.slice(0, 10);
}

let timer: NodeJS.Timeout | null = null;
let tickInProgress = false;

async function tick() {
  if (tickInProgress || !isEnabled()) return;
  tickInProgress = true;
  try {
    const clock = jamaicaClock();
    const config = configuration();
    if (config.startDate && clock.date < config.startDate) return;
    if (clock.hour > config.hour || (clock.hour === config.hour && clock.minute >= config.minute)) {
      await queueFiveDayDisconnectionReminders(clock.date);
    }
    await processDisconnectionReminderQueue();
  } finally {
    tickInProgress = false;
  }
}

export function startDisconnectionEmailReminders() {
  const config = configuration();
  console.log(
    isEnabled()
      ? `Five-day disconnection email reminders enabled for ${String(config.hour).padStart(2, "0")}:${String(config.minute).padStart(2, "0")} Jamaica time${config.startDate ? ` starting ${config.startDate}` : ""}; ${config.batchSize}/minute; ${config.dailyLimit}/day.`
      : "Five-day disconnection email reminders are disabled.",
  );
  const startupTimer = setTimeout(() => void tick(), 20_000);
  startupTimer.unref();
  timer = setInterval(() => void tick(), MINUTE);
  timer.unref();
  return () => {
    clearTimeout(startupTimer);
    if (timer) clearInterval(timer);
    timer = null;
  };
}
