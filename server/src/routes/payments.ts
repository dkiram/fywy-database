/** Records payments and serves receipt, history, and daily-ledger data. */
import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import type { PoolClient } from "pg";
import { pool } from "../db.js";
import { isEmail, sendReceiptEmail } from "../email/receiptEmail.js";
import {
  insertStatusHistory,
  resolvePendingReconnectionRequests,
} from "./accounts.js";
import { ensureMonthlyChargeForPayment, paymentBalanceDeduction } from "./paymentMonthCharge.js";

const paymentsRouter = Router();

// What a cashier may take money for. payment_type is a free TEXT column with
// no database constraint, so this list is the only thing standing between the
// request body and the receipt - a type not named here is rejected.
//
// The first three are per-customer: their amount comes from the customer's
// package. The rest are flat service charges added Aug 2026, priced in
// RecordPaymentDrawer.tsx. Keep the two lists in step; this one decides what
// is accepted, that one decides what is offered and what it costs.
const recordablePaymentTypes = [
  "Monthly Fee",
  "Reconnection Fee",
  "Installation Fee",
  "Password Change",
  "Modem Relocation",
  "Modem Reset",
  "Broken Ends",
  "Cable Remote",
] as const;

// Router-local helpers keep untrusted path/body/query values out of SQL until validated.
function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session.employee) {
    return res.status(401).json({ error: "Not authenticated." });
  }
  next();
}

// Voiding changes financial totals, so everyone may view the result but only
// Admin can authorize the reversal. Head Office held this until Aug 2026 and
// no longer does: reversing money taken at a counter is now a single desk's
// decision. Anyone else gets a plain 403, including through a typed URL.
function requirePaymentManager(req: Request, res: Response, next: NextFunction) {
  const employee = req.session.employee;
  if (!employee) return res.status(401).json({ error: "Not authenticated." });
  if (employee.role !== "admin") {
    return res.status(403).json({ error: "Only Admin can void payments." });
  }
  next();
}

// Permanent deletion is narrower than voiding: only the Admin role receives
// this destructive escape hatch, never Head Office or branch employees.
function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const employee = req.session.employee;
  if (!employee) return res.status(401).json({ error: "Not authenticated." });
  if (employee.role !== "admin") {
    return res.status(403).json({ error: "Only Admin can permanently delete payments." });
  }
  next();
}

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function parsePositiveId(value: unknown) {
  const text = typeof value === "string" ? value : "";
  if (!/^\d+$/.test(text)) return null;

  const id = Number(text);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

// Loads a receipt for either party a payment can belong to.
//
// Every receipt used to require a customer, because every payment had one. An
// installation fee collected at application time does not: the applicant is not
// a customer yet and may never become one. They still handed over cash at the
// counter and still need paper, so the applicant's own name and address stand
// in until activation re-points the payment at a real customer record.
//
// Imported Access rows remain excluded by the receipt_number test - no receipt
// was ever issued for those, so there is nothing to reprint.
export async function loadReceipt(client: PoolClient, paymentId: number) {
  const result = await client.query(
    `
    SELECT
      pay.payment_id,
      pay.receipt_number,
      pay.payment_type,
      pay.amount_paid,
      pay.month_paid,
      pay.payment_date,
      pay.recorded_at,
      pay.location,
      pay.cashier_name,
      pay.note,
      pay.receipt_delivery_method,
      (pay.voided_at IS NOT NULL) AS is_voided,
      pay.voided_at,
      pay.void_reason,
      CONCAT_WS(' ', voider.first_name, voider.last_name) AS voided_by_name,
      c.customer_id,
      pay.application_id,
      COALESCE(c.name, app.name) AS customer_name,
      COALESCE(c.address, app.address) AS customer_address,
      COALESCE(c.telephone, app.telephone) AS customer_telephone,
      COALESCE(c.email, app.email) AS customer_email,
      delivery.receipt_email_delivery_id,
      delivery.recipient_email AS receipt_email,
      delivery.status AS receipt_email_status,
      delivery.attempt_count AS receipt_email_attempt_count,
      delivery.last_error AS receipt_email_error,
      delivery.sent_at AS receipt_email_sent_at
    FROM public.payments pay
    LEFT JOIN public.customers c
      ON pay.customer_id = c.customer_id
    LEFT JOIN public.applications app
      ON pay.application_id = app.application_id
    LEFT JOIN public.employees voider
      ON voider.employee_id = pay.voided_by_employee_id
    LEFT JOIN LATERAL (
      SELECT attempt.*
      FROM public.receipt_email_deliveries attempt
      WHERE attempt.payment_id = pay.payment_id
      ORDER BY attempt.receipt_email_delivery_id DESC
      LIMIT 1
    ) delivery ON TRUE
    WHERE pay.payment_id = $1
      AND pay.receipt_number IS NOT NULL
      AND (c.customer_id IS NOT NULL OR app.application_id IS NOT NULL);
    `,
    [paymentId]
  );

  return result.rows[0] ?? null;
}

async function queueReceiptEmail(
  client: PoolClient,
  paymentId: number,
  recipientEmail: string,
  employeeId: number,
) {
  const result = await client.query(
    `
    INSERT INTO public.receipt_email_deliveries (
      payment_id, recipient_email, requested_by_employee_id
    ) VALUES ($1, $2, $3)
    RETURNING receipt_email_delivery_id;
    `,
    [paymentId, recipientEmail, employeeId],
  );

  return Number(result.rows[0].receipt_email_delivery_id);
}

/**
 * Sends only after the payment transaction commits. A mail outage therefore
 * produces a failed delivery and a print option, never a rolled-back payment.
 */
async function deliverQueuedReceiptEmail(
  client: PoolClient,
  deliveryId: number,
) {
  const deliveryResult = await client.query(
    `
    UPDATE public.receipt_email_deliveries
    SET status = 'sending',
        attempt_count = attempt_count + 1,
        last_attempted_at = CURRENT_TIMESTAMP,
        last_error = NULL
    WHERE receipt_email_delivery_id = $1
      AND status IN ('pending', 'failed')
    RETURNING payment_id, recipient_email;
    `,
    [deliveryId],
  );

  const delivery = deliveryResult.rows[0];
  if (!delivery) return;

  try {
    const receipt = await loadReceipt(client, Number(delivery.payment_id));
    if (!receipt) throw new Error("The payment receipt could not be loaded.");

    const sent = await sendReceiptEmail(delivery.recipient_email, receipt);
    await client.query(
      `
      UPDATE public.receipt_email_deliveries
      SET status = 'sent', provider_message_id = $2,
          sent_at = CURRENT_TIMESTAMP, last_error = NULL
      WHERE receipt_email_delivery_id = $1;
      `,
      [deliveryId, sent.providerMessageId],
    );
  } catch (error) {
    const publicMessage = receiptDeliveryError(error);
    // Log what Google actually said, not the sanitised sentence. The cashier
    // gets the friendly wording; whoever has to fix this needs the real one,
    // and until Aug 2026 only the friendly wording was ever written down - so
    // a wrong From address, a disabled API and a dead token were
    // indistinguishable in both the logs and the database.
    console.error(
      `Could not email receipt delivery #${deliveryId}: ${publicMessage}\n` +
        `  Gmail reported: ${describeMailError(error)}`,
    );
    await client.query(
      `
      UPDATE public.receipt_email_deliveries
      SET status = 'failed', last_error = $2, last_error_detail = $3
      WHERE receipt_email_delivery_id = $1;
      `,
      [deliveryId, publicMessage, describeMailError(error)],
    );
  }
}

function receiptDeliveryError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (message === "Email delivery is not configured on this server.") return message;
  if (/invalid_grant|unauthorized|authentication|credentials/i.test(message)) {
    return "Receipt email authorization needs attention. Retry after an administrator reconnects Gmail.";
  }
  return "Gmail could not send the receipt. Check the address, retry, or print it before the customer leaves.";
}

/**
 * Flattens a Google API failure into one line worth keeping.
 *
 * googleapis puts the sentence that actually identifies the problem in the
 * HTTP response body - "Invalid From header", "Gmail API has not been used in
 * project ... or it is disabled" - while error.message is frequently no more
 * than "Bad Request". Both are captured, with the status, and the whole thing
 * is capped so a stray HTML error page cannot bloat the row.
 */
function describeMailError(error: unknown) {
  const candidate = error as {
    message?: string;
    code?: unknown;
    status?: unknown;
    response?: { status?: number; data?: unknown };
  };

  const parts: string[] = [];
  const status = candidate?.response?.status ?? candidate?.status ?? candidate?.code;
  if (status !== undefined) parts.push(`status ${String(status)}`);
  if (candidate?.message) parts.push(candidate.message);

  const data = candidate?.response?.data as
    | { error?: { message?: string; errors?: { reason?: string }[] } }
    | string
    | undefined;
  if (typeof data === "string") {
    parts.push(data);
  } else if (data?.error?.message) {
    parts.push(data.error.message);
    const reason = data.error.errors?.[0]?.reason;
    if (reason) parts.push(`reason ${reason}`);
  }

  const detail = parts.length > 0 ? parts.join(" | ") : String(error);
  return detail.length > 1000 ? `${detail.slice(0, 997)}...` : detail;
}

paymentsRouter.post(
  "/customers/:customerId/payments",
  requireAuth,
  async (req, res) => {
    // Validate the cashier-entered fields before opening a database transaction.
    const customerId = parsePositiveId(req.params.customerId);
    if (customerId === null) {
      return res.status(400).json({ error: "Invalid customer ID." });
    }

    const paymentType = cleanText(req.body.paymentType);
    const amountText = String(req.body.amount ?? "").trim();
    const monthPaid = cleanText(req.body.monthPaid);
    const note = cleanText(req.body.note);
    const overrideDisconnectedMonth = req.body.overrideDisconnectedMonth === true;
    const receiptDeliveryMethod = cleanText(req.body.receiptDeliveryMethod) || "physical";
    const receiptEmail = cleanText(req.body.receiptEmail).toLowerCase();

    if (!recordablePaymentTypes.includes(paymentType as (typeof recordablePaymentTypes)[number])) {
      return res.status(400).json({ error: "Choose a valid payment type." });
    }
    if (!/^\d+(\.\d{1,2})?$/.test(amountText)) {
      return res.status(400).json({ error: "Enter a valid payment amount." });
    }

    const amount = Number(amountText);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 999999999999) {
      return res.status(400).json({ error: "Payment amount must be greater than zero." });
    }
    if (monthPaid && !/^\d{4}-(0[1-9]|1[0-2])$/.test(monthPaid)) {
      return res.status(400).json({ error: "Choose a valid billing month." });
    }
    if (paymentType === "Monthly Fee" && !monthPaid) {
      return res.status(400).json({ error: "Choose the month being paid for." });
    }
    if (note.length > 500) {
      return res.status(400).json({ error: "Payment note must be 500 characters or fewer." });
    }
    if (receiptDeliveryMethod !== "physical" && receiptDeliveryMethod !== "email") {
      return res.status(400).json({ error: "Choose email or physical receipt delivery." });
    }
    if (receiptDeliveryMethod === "email" && !isEmail(receiptEmail)) {
      return res.status(400).json({ error: "Enter a valid receipt email address." });
    }

    const employee = req.session.employee!;
    if (employee.role === "branch" && employee.locationId === null) {
      return res.status(409).json({
        error: "Your employee account needs a branch before recording payments.",
      });
    }

    const client = await pool.connect();
    try {
      // Payment, receipt number, and audit entry must either all succeed or all roll back.
      await client.query("BEGIN");

      const customerResult = await client.query(
        `
        SELECT customer_id, email, status
        FROM public.customers
        WHERE customer_id = $1
        FOR UPDATE;
        `,
        [customerId]
      );

      if (customerResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Customer not found." });
      }

      // An offline account is not receiving service and its balance is frozen.
      // Taking money against it would quietly reactivate billing expectations
      // without anyone deciding to restore service. Restore it first.
      //
      // 'suspended' deliberately does NOT belong in this check, however
      // similar the two look from the outside. A suspended customer is
      // actively billed J$500 a month and has to clear that plus the
      // reconnection fee before service can resume, so blocking their
      // payments would leave them permanently unable to come back.
      if (customerResult.rows[0].status === "offline") {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error:
            "This account is marked offline (no service). Restore it from the " +
            "Account Operations panel before recording a payment.",
        });
      }

      // Keep the cut-off warning unless the cashier explicitly overrides it.
      let overrideWarning: string | null = null;
      let raisedCharge: { dueDate: string; amount: string } | null = null;
      if (paymentType === "Monthly Fee") {
        const outcome = await ensureMonthlyChargeForPayment(client, {
          customerId,
          monthPaid,
          employeeId: employee.employeeId,
          overrideDisconnectedMonth,
        });
        if (outcome.kind === "refused") {
          await client.query("ROLLBACK");
          return res.status(409).json({ error: outcome.message, code: "DISCONNECTED_PAYMENT_MONTH" });
        }
        if (outcome.kind === "charged") raisedCharge = outcome;
        if (outcome.kind === "overridden") overrideWarning = outcome.message;
      }

      // Generate any anniversary charge due through today before deciding
      // whether the payment has completely cleared the account.
      await client.query(
        `SELECT public.spcl_generate_monthly_charges(
          (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE
        );`
      );

      // Read the current allocation context after generating charges due today.
      // The full receipt is credited even when a discount already cleared debt.
      const allocation = await client.query(
        `SELECT COALESCE(SUM(amount), 0)::TEXT AS balance,
          ($2 || '-01')::DATE < DATE_TRUNC('month', CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE AS is_past
        FROM public.account_ledger_entries WHERE customer_id = $1;`,
        [customerId, monthPaid || '2000-01'],
      );
      const appliedAmount = paymentBalanceDeduction(
        amountText, allocation.rows[0].balance,
        paymentType === "Monthly Fee" && allocation.rows[0].is_past,
      );

      const paymentResult = await client.query(
        `
        INSERT INTO public.payments (
          customer_id,
          payment_type,
          amount_paid,
          month_paid,
          payment_date,
          location,
          cashier_name,
          recorded_by_employee_id,
          location_id,
          note,
          recorded_at,
          receipt_delivery_method
        )
        VALUES (
          $1,
          $2,
          $3,
          CASE WHEN $4 = '' THEN NULL ELSE ($4 || '-01')::DATE END,
          (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
          $5,
          $6,
          $7,
          $8,
          NULLIF($9, ''),
          CURRENT_TIMESTAMP,
          $10
        )
        RETURNING payment_id;
        `,
        [
          customerId,
          paymentType,
          amountText,
          monthPaid,
          employee.locationName ?? "Unassigned location",
          `${employee.firstName} ${employee.lastName}`,
          employee.employeeId,
          employee.locationId,
          note,
          receiptDeliveryMethod,
        ]
      );

      const paymentId = Number(paymentResult.rows[0].payment_id);
      const emailDeliveryId = receiptDeliveryMethod === "email"
        ? await queueReceiptEmail(client, paymentId, receiptEmail, employee.employeeId)
        : null;
      // The generated database ID makes the receipt identifier deterministic and unique.
      await client.query(
        `
        UPDATE public.payments
        SET receipt_number =
          'SPCL-' || TO_CHAR(payment_date, 'YYYYMMDD') || '-' ||
          LPAD(payment_id::TEXT, 9, '0')
        WHERE payment_id = $1;
        `,
        [paymentId]
      );

      // Only monthly and reconnection payments affect the account balance.
      // Installation, and the flat service charges added Aug 2026 (password
      // change, modem relocation, modem reset, broken ends, cable remote), are
      // one-off work paid for at the counter. There is no matching charge on
      // the ledger for them, so posting a credit would hand the customer a
      // balance they were never owed. They stay valid receipts and appear in
      // the daily takings; they just do not touch the recurring-service ledger.
      const ledgerEntryType = paymentType === "Monthly Fee"
        ? "monthly_payment"
        : paymentType === "Reconnection Fee"
          ? "reconnection_payment"
          : null;
      if (ledgerEntryType && Number(appliedAmount) > 0) {
        await client.query(
          `
          INSERT INTO public.account_ledger_entries (
            customer_id, entry_type, amount, effective_date, description,
            payment_id, created_by_employee_id, source_key
          ) VALUES (
            $1, $2, -ABS($3::NUMERIC),
            (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
            $4, $5, $6, $7
          )
          ON CONFLICT (source_key) DO NOTHING;
          `,
          [
            customerId,
            ledgerEntryType,
            appliedAmount,
            paymentType === "Monthly Fee" ? "Monthly fee payment" : "Reconnection fee payment",
            paymentId,
            employee.employeeId,
            `payment:${paymentId}`,
          ]
        );
      }

      let reconnectionPending = false;
      const billingResult = await client.query(
        `
        SELECT c.status, billing.ready_for_reconnection
        FROM public.customers c
        JOIN public.customer_billing_status billing USING (customer_id)
        WHERE c.customer_id = $1
        FOR UPDATE OF c;
        `,
        [customerId]
      );
      const billing = billingResult.rows[0];

      // A fully paid disconnected account leaves the disconnected queue
      // automatically. The durable OLT worker handles eligible integrated
      // accounts; the manual workflow remains available as a fallback.
      if (billing?.status === "disconnected" && billing.ready_for_reconnection) {
        const queueReason = "Full outstanding balance and reconnection fee paid; queued for reconnection processing";
        await client.query(
          `UPDATE public.customers SET status = 'pending_reconnection' WHERE customer_id = $1;`,
          [customerId]
        );
        const statusHistory = await insertStatusHistory(client, {
          customerId,
          fromStatus: "disconnected",
          toStatus: "pending_reconnection",
          reason: queueReason,
          employeeId: employee.employeeId,
        });
        await resolvePendingReconnectionRequests(client, {
          customerId,
          employeeId: employee.employeeId,
          statusHistoryId: statusHistory.account_status_history_id,
          reviewNote: "Automatically resolved after payment cleared the account balance.",
        });
        await client.query(
          `
          INSERT INTO public.audit_logs (
            employee_id, actor_name, action, entity_type, entity_id,
            field_name, old_value, new_value, reason, occurred_at
          ) VALUES ($1, $2, 'Queued paid account for reconnection', 'customer', $3,
            'status', 'disconnected', 'pending_reconnection', $4, CURRENT_TIMESTAMP);
          `,
          [employee.employeeId, `${employee.firstName} ${employee.lastName}`, String(customerId), queueReason]
        );
        reconnectionPending = true;
      }

      if (raisedCharge) {
        await client.query(
          `
          INSERT INTO public.audit_logs (
            employee_id, actor_name, action, entity_type, entity_id,
            field_name, old_value, new_value, reason, occurred_at
          ) VALUES ($1, $2, 'Raised unbilled monthly charge at payment', 'customer', $3,
            'monthly_charge', NULL, $4, $5, CURRENT_TIMESTAMP);
          `,
          [
            employee.employeeId,
            `${employee.firstName} ${employee.lastName}`,
            String(customerId),
            `${raisedCharge.amount} due ${raisedCharge.dueDate}`,
            `Monthly Fee payment ${paymentId} was tagged to ${monthPaid}, which had no charge on the ledger.`,
          ]
        );
      }

      const paymentAuditNote = [
        note,
        overrideWarning ? `Disconnected month override for ${monthPaid}: ${overrideWarning}` : "",
        paymentType === "Monthly Fee"
          ? `Received J$${amountText}; applied J$${appliedAmount} to the balance. Past-month payments do not create credit.`
          : "",
      ].filter(Boolean).join("\n");

      await client.query(
        `
        INSERT INTO public.audit_logs (
          employee_id,
          actor_name,
          action,
          entity_type,
          entity_id,
          field_name,
          old_value,
          new_value,
          reason,
          occurred_at
        )
        VALUES (
          $1,
          $2,
          'Recorded payment',
          'payment',
          $3,
          'amount_paid',
          NULL,
          $4,
          NULLIF($5, ''),
          CURRENT_TIMESTAMP
        );
        `,
        [
          employee.employeeId,
          `${employee.firstName} ${employee.lastName}`,
          String(paymentId),
          amountText,
          paymentAuditNote,
        ]
      );

      await client.query("COMMIT");

      if (emailDeliveryId !== null) {
        await deliverQueuedReceiptEmail(client, emailDeliveryId);
      }

      const receipt = await loadReceipt(client, paymentId);

      res.status(201).json({ payment: receipt, reconnectionPending, raisedCharge });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Could not record payment:", error);
      res.status(500).json({ error: "Could not record payment." });
    } finally {
      client.release();
    }
  }
);

paymentsRouter.get(
  "/payments/:paymentId/receipt",
  requireAuth,
  async (req, res) => {
    // Imported payments intentionally return 404 because no official receipt was issued.
    const paymentId = parsePositiveId(req.params.paymentId);
    if (paymentId === null) {
      return res.status(400).json({ error: "Invalid payment ID." });
    }

    const client = await pool.connect();
    try {
      const receipt = await loadReceipt(client, paymentId);
      if (!receipt) {
        return res.status(404).json({
          error: "A printable receipt is not available for this imported payment.",
        });
      }

      res.json({ payment: receipt });
    } catch (error) {
      console.error("Could not load receipt:", error);
      res.status(500).json({ error: "Could not load receipt." });
    } finally {
      client.release();
    }
  }
);

paymentsRouter.post(
  "/payments/:paymentId/email-receipt",
  requireAuth,
  async (req, res) => {
    const paymentId = parsePositiveId(req.params.paymentId);
    if (paymentId === null) {
      return res.status(400).json({ error: "Invalid payment ID." });
    }

    const recipientEmail = cleanText(req.body.email).toLowerCase();
    if (!isEmail(recipientEmail)) {
      return res.status(400).json({ error: "Enter a valid receipt email address." });
    }

    const employee = req.session.employee!;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const paymentResult = await client.query(
        `
        SELECT payment_id, receipt_number, voided_at
        FROM public.payments
        WHERE payment_id = $1
        FOR UPDATE;
        `,
        [paymentId],
      );
      const payment = paymentResult.rows[0];

      if (!payment?.receipt_number) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "An emailable receipt is not available for this payment." });
      }
      if (payment.voided_at) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "A voided receipt cannot be emailed as a valid payment receipt." });
      }

      await client.query(
        `UPDATE public.payments SET receipt_delivery_method = 'email' WHERE payment_id = $1;`,
        [paymentId],
      );
      const deliveryId = await queueReceiptEmail(
        client,
        paymentId,
        recipientEmail,
        employee.employeeId,
      );

      await client.query(
        `
        INSERT INTO public.audit_logs (
          employee_id, actor_name, action, entity_type, entity_id,
          field_name, old_value, new_value, occurred_at
        ) VALUES ($1, $2, 'Requested receipt email', 'payment', $3,
          'receipt_email', NULL, $4, CURRENT_TIMESTAMP);
        `,
        [
          employee.employeeId,
          `${employee.firstName} ${employee.lastName}`,
          String(paymentId),
          recipientEmail,
        ],
      );

      await client.query("COMMIT");
      await deliverQueuedReceiptEmail(client, deliveryId);

      const receipt = await loadReceipt(client, paymentId);
      res.json({ payment: receipt });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Could not request receipt email:", error);
      res.status(500).json({ error: "Could not request receipt email." });
    } finally {
      client.release();
    }
  },
);

paymentsRouter.post(
  "/payments/:paymentId/void",
  requireAuth,
  requirePaymentManager,
  async (req, res) => {
    const paymentId = parsePositiveId(req.params.paymentId);
    if (paymentId === null) {
      return res.status(400).json({ error: "Invalid payment ID." });
    }
    const reason = cleanText(req.body.reason);
    if (reason.length < 3 || reason.length > 500) {
      return res.status(400).json({ error: "A void reason between 3 and 500 characters is required." });
    }

    const employee = req.session.employee!;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const paymentResult = await client.query(
        `
        SELECT pay.payment_id, pay.customer_id, pay.application_id,
          pay.payment_type, pay.amount_paid, pay.receipt_number,
          pay.recorded_by_employee_id, pay.voided_at
        FROM public.payments pay
        WHERE pay.payment_id = $1
        FOR UPDATE OF pay;
        `,
        [paymentId]
      );
      const payment = paymentResult.rows[0];
      if (!payment) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Payment not found." });
      }

      // Application installation fees may not have a customer yet. PostgreSQL
      // cannot lock the nullable side of a LEFT JOIN, so lock the customer in
      // a second query only when one exists. This preserves the original race
      // protection for account-status changes without breaking application
      // payments that legitimately have customer_id = NULL.
      const customerResult = payment.customer_id === null
        ? { rows: [] as { status?: string }[] }
        : await client.query(
            `SELECT status FROM public.customers
             WHERE customer_id = $1
             FOR UPDATE;`,
            [payment.customer_id]
          );
      const customerStatusAtVoid = customerResult.rows[0]?.status ?? null;

      // Access imports are historical source evidence and cannot be voided as
      // though they were cashier entries created by this application.
      if (!payment.receipt_number || payment.recorded_by_employee_id === null) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "Imported legacy payments cannot be voided here." });
      }
      if (payment.voided_at) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "This payment has already been voided." });
      }

      await client.query(
        `
        UPDATE public.payments SET
          voided_at = CURRENT_TIMESTAMP,
          voided_by_employee_id = $2,
          void_reason = $3
        WHERE payment_id = $1;
        `,
        [paymentId, employee.employeeId, reason]
      );

      // Reverse the original balance credit with a positive ledger entry. The
      // source key prevents a duplicate reversal even under concurrent retries.
      await client.query(
        `
        INSERT INTO public.account_ledger_entries (
          customer_id, entry_type, amount, effective_date, description,
          payment_id, created_by_employee_id, reason, source_key
        )
        SELECT original.customer_id, 'payment_void', -original.amount,
          (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
          'Voided payment reversal', original.payment_id, $2, $3,
          'payment-void:' || original.payment_id::TEXT
        FROM public.account_ledger_entries original
        WHERE original.payment_id = $1
          AND original.entry_type IN ('monthly_payment', 'reconnection_payment')
          AND original.amount < 0
        ORDER BY original.account_ledger_entry_id
        LIMIT 1
        ON CONFLICT (source_key) DO NOTHING;
        `,
        [paymentId, employee.employeeId, reason]
      );

      // An installation fee still sitting against an application has no
      // customer and therefore no balance to recompute. Everything below this
      // point is about a customer account, so it is skipped for those.
      let customerStatus = customerStatusAtVoid as string | null;
      let statusHistory = null;
      const billingResult = payment.customer_id === null
        ? { rows: [] as { outstanding_balance?: string }[] }
        : await client.query(
            `SELECT outstanding_balance FROM public.customer_billing_status WHERE customer_id = $1;`,
            [payment.customer_id]
          );
      const outstandingBalance = Number(billingResult.rows[0]?.outstanding_balance ?? 0);

      // If the reversed payment had qualified the account for approval, return
      // it to disconnected as soon as the balance becomes unpaid again.
      if (customerStatus === "pending_reconnection" && outstandingBalance > 0) {
        await client.query(
          `UPDATE public.customers SET status = 'disconnected' WHERE customer_id = $1;`,
          [payment.customer_id]
        );
        statusHistory = await insertStatusHistory(client, {
          customerId: Number(payment.customer_id),
          fromStatus: "pending_reconnection",
          toStatus: "disconnected",
          reason: `Payment ${payment.receipt_number} voided; account balance is unpaid again`,
          employeeId: employee.employeeId,
        });
        await client.query(
          `
          INSERT INTO public.audit_logs (
            employee_id, actor_name, action, entity_type, entity_id,
            field_name, old_value, new_value, reason, occurred_at
          ) VALUES ($1, $2, 'Returned account to disconnected after payment void',
            'customer', $3, 'status', 'pending_reconnection', 'disconnected',
            $4, CURRENT_TIMESTAMP);
          `,
          [
            employee.employeeId,
            `${employee.firstName} ${employee.lastName}`,
            String(payment.customer_id),
            `Payment ${payment.receipt_number} was voided and the account is unpaid again`,
          ]
        );
        customerStatus = "disconnected";
      }

      await client.query(
        `
        INSERT INTO public.audit_logs (
          employee_id, actor_name, action, entity_type, entity_id,
          field_name, old_value, new_value, reason, occurred_at
        ) VALUES ($1, $2, 'Voided payment', 'payment', $3,
          'payment_status', 'active', 'voided', $4, CURRENT_TIMESTAMP);
        `,
        [employee.employeeId, `${employee.firstName} ${employee.lastName}`, String(paymentId), reason]
      );

      const receipt = await loadReceipt(client, paymentId);
      await client.query("COMMIT");
      res.json({ payment: receipt, customerStatus, outstandingBalance, statusHistory });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Could not void payment:", error);
      res.status(500).json({ error: "Could not void payment." });
    } finally {
      client.release();
    }
  }
);

paymentsRouter.delete(
  "/payments/:paymentId",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const paymentId = parsePositiveId(req.params.paymentId);
    if (paymentId === null) {
      return res.status(400).json({ error: "Invalid payment ID." });
    }
    const reason = cleanText(req.body.reason);
    const confirmation = cleanText(req.body.confirmation);
    if (reason.length < 3 || reason.length > 500) {
      return res.status(400).json({ error: "A deletion reason between 3 and 500 characters is required." });
    }

    const employee = req.session.employee!;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const paymentResult = await client.query(
        `
        SELECT payment_id, customer_id, receipt_number, voided_at
        FROM public.payments
        WHERE payment_id = $1
        FOR UPDATE;
        `,
        [paymentId]
      );
      const payment = paymentResult.rows[0];
      if (!payment) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Payment not found." });
      }
      if (!payment.voided_at) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "Void the payment before permanently deleting it." });
      }
      if (!payment.receipt_number || confirmation !== payment.receipt_number) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Type the exact receipt number to confirm permanent deletion." });
      }

      // Removing both the original credit and its void reversal leaves the
      // customer's net balance unchanged. The payment FK intentionally blocks
      // deletion unless these paired ledger rows are handled in this transaction.
      await client.query(
        `DELETE FROM public.account_ledger_entries WHERE payment_id = $1;`,
        [paymentId]
      );
      await client.query(
        `DELETE FROM public.audit_logs WHERE entity_type = 'payment' AND entity_id = $1;`,
        [String(paymentId)]
      );
      await client.query(`DELETE FROM public.payments WHERE payment_id = $1;`, [paymentId]);

      // Keep one compact marker proving which admin used the destructive path.
      // The customer ID remains so Activity History can still open the profile.
      await client.query(
        `
        INSERT INTO public.audit_logs (
          employee_id, actor_name, action, entity_type, entity_id,
          field_name, old_value, new_value, reason, occurred_at
        ) VALUES ($1, $2, 'Permanently deleted voided payment',
          'customer', $3, 'deleted_payment', $4, 'deleted', $5,
          CURRENT_TIMESTAMP);
        `,
        [
          employee.employeeId,
          `${employee.firstName} ${employee.lastName}`,
          String(payment.customer_id),
          `Payment #${paymentId}; receipt ${payment.receipt_number}`,
          reason,
        ]
      );

      await client.query("COMMIT");
      res.json({ deleted: true, paymentId, receiptNumber: payment.receipt_number });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Could not permanently delete payment:", error);
      res.status(500).json({ error: "Could not permanently delete payment." });
    } finally {
      client.release();
    }
  }
);

paymentsRouter.get("/payments/daily-summary", requireAuth, requireAdmin, async (req, res) => {
  // Every office sees its own takings and nobody else's. Only an admin sees
  // the company-wide figure, because only an admin has a reason to.
  const requestedDate = cleanText(req.query.date);
  if (requestedDate && !/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
    return res.status(400).json({ error: "Choose a valid date." });
  }

  const requestedPage = Math.max(
    Number.parseInt(cleanText(req.query.page), 10) || 1,
    1
  );
  const limit = 25;

  const employee = req.session.employee!;
  const scopedToOwnOffice = employee.role !== "admin";

  if (scopedToOwnOffice && employee.locationId === null) {
    return res.status(409).json({
      error: "Your employee account needs an office before viewing totals.",
    });
  }

  const locationId = scopedToOwnOffice ? employee.locationId : null;
  const locationName = scopedToOwnOffice ? employee.locationName ?? "" : "";

  try {
    const dateResult = await pool.query(
      `
      SELECT COALESCE(
        NULLIF($1, '')::DATE,
        (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE
      ) AS selected_date;
      `,
      [requestedDate]
    );
    const selectedDate = dateResult.rows[0].selected_date;

    // Reuse one scope predicate so cards, breakdowns, and ledger rows cannot disagree.
    const whereClause = `
      WHERE pay.payment_date = $1
        AND pay.voided_at IS NULL
        AND (
          $2::SMALLINT IS NULL
          OR pay.location_id = $2
          OR (
            pay.location_id IS NULL
            AND LOWER(TRIM(COALESCE(pay.location, ''))) = LOWER(TRIM($3))
          )
        )
    `;
    const values = [selectedDate, locationId, locationName];

    const summaryResult = await pool.query(
      `
      SELECT
        COUNT(*)::INTEGER AS payment_count,
        COALESCE(SUM(pay.amount_paid), 0)::NUMERIC(14,2) AS total_amount,
        COALESCE(AVG(pay.amount_paid), 0)::NUMERIC(14,2) AS average_amount
      FROM public.payments pay
      ${whereClause};
      `,
      values
    );

    const total = summaryResult.rows[0].payment_count as number;
    const totalPages = Math.max(Math.ceil(total / limit), 1);
    const page = Math.min(requestedPage, totalPages);
    const offset = (page - 1) * limit;

    // Independent breakdown and ledger queries can run concurrently after the total is known.
    const [typeResult, locationResult, recentResult] = await Promise.all([
        pool.query(
          `
          SELECT
            COALESCE(pay.payment_type, pay.legacy_payment_type, 'Unknown') AS payment_type,
            COUNT(*)::INTEGER AS payment_count,
            COALESCE(SUM(pay.amount_paid), 0)::NUMERIC(14,2) AS total_amount
          FROM public.payments pay
          ${whereClause}
          GROUP BY COALESCE(pay.payment_type, pay.legacy_payment_type, 'Unknown')
          ORDER BY total_amount DESC, payment_type;
          `,
          values
        ),
        pool.query(
          `
          SELECT
            COALESCE(pay.location, 'Unassigned location') AS location,
            COUNT(*)::INTEGER AS payment_count,
            COALESCE(SUM(pay.amount_paid), 0)::NUMERIC(14,2) AS total_amount
          FROM public.payments pay
          ${whereClause}
          GROUP BY pay.location
          ORDER BY total_amount DESC, pay.location;
          `,
          values
        ),
        pool.query(
          `
          SELECT
            pay.payment_id,
            pay.receipt_number,
            COALESCE(pay.payment_type, pay.legacy_payment_type, 'Unknown') AS payment_type,
            pay.amount_paid,
            pay.payment_date,
            pay.recorded_at,
            pay.cashier_name,
            pay.location,
            pay.legacy_customer_id,
            c.customer_id,
            pay.application_id,
            -- An installation fee taken at the counter before activation has
            -- no customer to name, so the ledger shows the applicant instead
            -- of an empty row the office cannot account for.
            COALESCE(c.name, app.name) AS customer_name,
            CASE
              WHEN pay.recorded_by_employee_id IS NULL THEN 'imported'
              ELSE 'new_system'
            END AS source
          FROM public.payments pay
          LEFT JOIN public.customers c
            ON pay.customer_id = c.customer_id
          LEFT JOIN public.applications app
            ON pay.application_id = app.application_id
          ${whereClause}
          ORDER BY pay.recorded_at DESC NULLS LAST, pay.payment_id DESC
          LIMIT $4
          OFFSET $5;
          `,
          [...values, limit, offset]
        ),
      ]);

    res.json({
      date: selectedDate,
      scope:
        employee.role === "branch"
          ? employee.locationName ?? "Assigned branch"
          : "All locations",
      summary: summaryResult.rows[0],
      byType: typeResult.rows,
      byLocation: locationResult.rows,
      recentPayments: recentResult.rows,
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
    });
  } catch (error) {
    console.error("Could not load daily payment totals:", error);
    res.status(500).json({ error: "Could not load daily payment totals." });
  }
});

export default paymentsRouter;
