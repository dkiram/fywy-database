/** Records payments and serves receipt, history, and daily-ledger data. */
import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import type { PoolClient } from "pg";
import { pool } from "../db.js";

const paymentsRouter = Router();

const recordablePaymentTypes = [
  "Monthly Fee",
  "Reconnection Fee",
  "Installation Fee",
] as const;

// Router-local helpers keep untrusted path/body/query values out of SQL until validated.
function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session.employee) {
    return res.status(401).json({ error: "Not authenticated." });
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

async function loadReceipt(client: PoolClient, paymentId: number) {
  // Only new-system payments have receipt numbers and guaranteed customer links.
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
      c.customer_id,
      c.name AS customer_name,
      c.address AS customer_address,
      c.telephone AS customer_telephone
    FROM public.payments pay
    INNER JOIN public.customers c
      ON pay.customer_id = c.customer_id
    WHERE pay.payment_id = $1
      AND pay.receipt_number IS NOT NULL;
    `,
    [paymentId]
  );

  return result.rows[0] ?? null;
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
        SELECT customer_id
        FROM public.customers
        WHERE customer_id = $1
        FOR SHARE;
        `,
        [customerId]
      );

      if (customerResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Customer not found." });
      }

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
          recorded_at
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
          CURRENT_TIMESTAMP
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
        ]
      );

      const paymentId = Number(paymentResult.rows[0].payment_id);
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
          note,
        ]
      );

      const receipt = await loadReceipt(client, paymentId);
      await client.query("COMMIT");

      res.status(201).json({ payment: receipt });
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

paymentsRouter.get("/payments/daily-summary", requireAuth, async (req, res) => {
  // Branch employees see only their location; head-office/admin employees see all locations.
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
  if (employee.role === "branch" && employee.locationId === null) {
    return res.status(409).json({
      error: "Your employee account needs a branch before viewing totals.",
    });
  }

  const locationId = employee.role === "branch" ? employee.locationId : null;
  const locationName = employee.role === "branch" ? employee.locationName ?? "" : "";

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
            c.name AS customer_name,
            CASE
              WHEN pay.recorded_by_employee_id IS NULL THEN 'imported'
              ELSE 'new_system'
            END AS source
          FROM public.payments pay
          LEFT JOIN public.customers c
            ON pay.customer_id = c.customer_id
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
