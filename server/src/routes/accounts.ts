/** Implements account-status queues, history, and controlled lifecycle transitions. */
import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import type { PoolClient } from "pg";
import { pool } from "../db.js";

// MVP 3 account-operations API.
//
// This router owns the service-status state machine:
// active -> disconnected -> pending_reconnection -> active.
// Every successful transition updates the customer, appends immutable status
// history, and writes an audit log inside one database transaction.
const accountsRouter = Router();

// Keep this union aligned with the database checks in migration 024.
type AccountStatus =
  | "active"
  | "disconnected"
  | "pending_reconnection"
  | "closed"
  | "archived";

function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session.employee) {
    return res.status(401).json({ error: "Not authenticated." });
  }
  next();
}

// Only management roles may disconnect or reconnect service. Branch users can
// still place disconnected customers into the reconnection review queue.
function requireAccountManager(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const employee = req.session.employee;
  if (!employee) {
    return res.status(401).json({ error: "Not authenticated." });
  }
  if (!['admin', 'head_office'].includes(employee.role)) {
    return res.status(403).json({
      error: "Only Admin and Head Office can change account service status.",
    });
  }
  next();
}

// Query/body values arrive as unknown; normalize optional text in one place.
function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

// Reject malformed route IDs before they are passed to PostgreSQL.
function parseCustomerId(req: Request, res: Response) {
  const value = req.params.customerId;
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    res.status(400).json({ error: "Invalid customer ID." });
    return null;
  }
  return Number(value);
}

// Shared history writer used by account transitions and application activation.
// Passing the caller's transaction client guarantees history cannot be saved
// without the corresponding customer/application change.
async function insertStatusHistory(
  client: PoolClient,
  values: {
    customerId: number;
    fromStatus: AccountStatus | null;
    toStatus: AccountStatus;
    reason: string;
    employeeId: number;
    applicationId?: number | null;
    effectiveDate?: string;
  }
) {
  const result = await client.query(
    `
    INSERT INTO public.account_status_history (
      customer_id,
      from_status,
      to_status,
      reason,
      effective_date,
      changed_by_employee_id,
      application_id,
      changed_at
    )
    VALUES (
      $1,
      $2,
      $3,
      $4,
      COALESCE(
        NULLIF($7, '')::DATE,
        (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE
      ),
      $5,
      $6,
      CURRENT_TIMESTAMP
    )
    RETURNING
      account_status_history_id,
      customer_id,
      from_status,
      to_status,
      reason,
      effective_date,
      changed_by_employee_id,
      application_id,
      changed_at;
    `,
    [
      values.customerId,
      values.fromStatus,
      values.toStatus,
      values.reason,
      values.employeeId,
      values.applicationId ?? null,
      values.effectiveDate ?? "",
    ]
  );

  return result.rows[0];
}

// Apply one permitted account-status transition atomically. Endpoint wrappers
// below provide the allowed starting states, destination, and audit wording.
async function transitionAccount(
  req: Request,
  res: Response,
  options: {
    action: string;
    allowedFrom: AccountStatus[];
    toStatus: AccountStatus;
    updateDateColumn?: "deactivation_date" | "reactivation_date";
  }
) {
  const customerId = parseCustomerId(req, res);
  if (customerId === null) return;

  const reason = cleanText(req.body.reason);
  if (reason.length < 3) {
    return res.status(400).json({
      error: "A reason of at least 3 characters is required.",
    });
  }
  if (reason.length > 500) {
    return res.status(400).json({
      error: "The reason must be 500 characters or fewer.",
    });
  }

  const employee = req.session.employee!;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Lock the customer so two employees cannot transition the same account
    // from a stale status at the same time.
    const customerResult = await client.query(
      `
      SELECT customer_id, status
      FROM public.customers
      WHERE customer_id = $1
      FOR UPDATE;
      `,
      [customerId]
    );
    const customer = customerResult.rows[0];

    if (!customer) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Customer not found." });
    }

    if (!options.allowedFrom.includes(customer.status as AccountStatus)) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: `This account cannot move from ${customer.status} to ${options.toStatus}.`,
      });
    }

    const dateAssignment = options.updateDateColumn
      ? `, ${options.updateDateColumn} =
          (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE`
      : "";

    // Deactivation/reactivation dates are maintained only on the transitions
    // that represent those real-world events.
    const updatedResult = await client.query(
      `
      UPDATE public.customers
      SET status = $1
          ${dateAssignment}
      WHERE customer_id = $2
      RETURNING
        customer_id,
        status,
        deactivation_date,
        reactivation_date;
      `,
      [options.toStatus, customerId]
    );

    const history = await insertStatusHistory(client, {
      customerId,
      fromStatus: customer.status,
      toStatus: options.toStatus,
      reason,
      employeeId: employee.employeeId,
    });

    // audit_logs is the staff-facing activity trail; account_status_history is
    // the complete status timeline shown on the customer profile.
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
        $1, $2, $3, 'customer', $4,
        'status', $5, $6, $7, CURRENT_TIMESTAMP
      );
      `,
      [
        employee.employeeId,
        `${employee.firstName} ${employee.lastName}`,
        options.action,
        String(customerId),
        customer.status,
        options.toStatus,
        reason,
      ]
    );

    await client.query("COMMIT");
    res.json({
      customer: updatedResult.rows[0],
      statusHistory: history,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(`Could not ${options.action.toLowerCase()}:`, error);
    res.status(500).json({ error: `Could not ${options.action.toLowerCase()}.` });
  } finally {
    client.release();
  }
}

// Paginated work queue used by the Account Operations page. The default
// "attention" view groups disconnected and pending-reconnection accounts.
accountsRouter.get("/account-operations", requireAuth, async (req, res) => {
  const search = cleanText(req.query.search);
  const searchPattern = `%${search}%`;
  const view = cleanText(req.query.view) || "attention";
  const requestedPage = Math.max(
    Number.parseInt(cleanText(req.query.page), 10) || 1,
    1
  );
  const limit = 10;

  const viewClauses: Record<string, string> = {
    attention: "c.status IN ('disconnected', 'pending_reconnection')",
    pending_reconnection: "c.status = 'pending_reconnection'",
    disconnected: "c.status = 'disconnected'",
    active: "c.status = 'active'",
    all: "TRUE",
  };
  const viewClause = viewClauses[view] ?? viewClauses.attention;

  try {
    // Count first so the API can clamp out-of-range page numbers safely.
    const countResult = await pool.query(
      `
      SELECT COUNT(*)::INTEGER AS total
      FROM public.customers c
      WHERE ${viewClause}
        AND (
          $1 = ''
          OR c.customer_id::TEXT ILIKE $2
          OR COALESCE(c.name, '') ILIKE $2
          OR COALESCE(c.telephone, '') ILIKE $2
          OR COALESCE(c.address, '') ILIKE $2
        );
      `,
      [search, searchPattern]
    );
    const total = countResult.rows[0].total as number;
    const totalPages = Math.max(Math.ceil(total / limit), 1);
    const page = Math.min(requestedPage, totalPages);
    const offset = (page - 1) * limit;

    const [accountsResult, summaryResult] = await Promise.all([
      pool.query(
        `
        SELECT
          c.customer_id,
          c.name,
          c.address,
          c.telephone,
          c.status,
          c.monthly_fee,
          c.activation_date,
          c.deactivation_date,
          c.reactivation_date,
          p.name AS package_name,
          latest.reason AS latest_status_reason,
          latest.effective_date AS latest_status_date
        FROM public.customers c
        LEFT JOIN public.packages p
          ON c.package_id = p.package_id
        LEFT JOIN LATERAL (
          -- Attach only the newest status note to each queue row.
          SELECT reason, effective_date
          FROM public.account_status_history history
          WHERE history.customer_id = c.customer_id
          ORDER BY history.changed_at DESC, history.account_status_history_id DESC
          LIMIT 1
        ) latest ON TRUE
        WHERE ${viewClause}
          AND (
            $1 = ''
            OR c.customer_id::TEXT ILIKE $2
            OR COALESCE(c.name, '') ILIKE $2
            OR COALESCE(c.telephone, '') ILIKE $2
            OR COALESCE(c.address, '') ILIKE $2
          )
        ORDER BY
          CASE WHEN c.status = 'pending_reconnection' THEN 0 ELSE 1 END,
          latest.effective_date DESC NULLS LAST,
          c.customer_id DESC
        LIMIT $3
        OFFSET $4;
        `,
        [search, searchPattern, limit, offset]
      ),
      pool.query(
        `
        SELECT
          COUNT(*) FILTER (WHERE status = 'active')::INTEGER AS active,
          COUNT(*) FILTER (WHERE status = 'disconnected')::INTEGER AS disconnected,
          COUNT(*) FILTER (
            WHERE status = 'pending_reconnection'
          )::INTEGER AS pending_reconnection
        FROM public.customers;
        `
      ),
    ]);

    res.json({
      accounts: accountsResult.rows,
      summary: summaryResult.rows[0],
      pagination: { page, limit, total, totalPages },
    });
  } catch (error) {
    console.error("Could not load account operations:", error);
    res.status(500).json({ error: "Could not load account operations." });
  }
});

// Return the full immutable status timeline for one customer profile.
accountsRouter.get(
  "/customers/:customerId/account-history",
  requireAuth,
  async (req, res) => {
    const customerId = parseCustomerId(req, res);
    if (customerId === null) return;

    try {
      const customerResult = await pool.query(
        `SELECT customer_id FROM public.customers WHERE customer_id = $1;`,
        [customerId]
      );
      if (customerResult.rows.length === 0) {
        return res.status(404).json({ error: "Customer not found." });
      }

      const result = await pool.query(
        `
        SELECT
          history.account_status_history_id,
          history.customer_id,
          history.from_status,
          history.to_status,
          history.reason,
          history.effective_date,
          history.application_id,
          history.changed_at,
          employee.first_name AS changed_by_first_name,
          employee.last_name AS changed_by_last_name
        FROM public.account_status_history history
        LEFT JOIN public.employees employee
          ON history.changed_by_employee_id = employee.employee_id
        WHERE history.customer_id = $1
        ORDER BY history.changed_at DESC, history.account_status_history_id DESC;
        `,
        [customerId]
      );

      res.json({ statusHistory: result.rows });
    } catch (error) {
      console.error("Could not load account history:", error);
      res.status(500).json({ error: "Could not load account history." });
    }
  }
);

// Management action: active -> disconnected.
accountsRouter.post(
  "/customers/:customerId/deactivate",
  requireAuth,
  requireAccountManager,
  (req, res) =>
    transitionAccount(req, res, {
      action: "Deactivated customer account",
      allowedFrom: ["active"],
      toStatus: "disconnected",
      updateDateColumn: "deactivation_date",
    })
);

// Branch or management action: disconnected -> pending_reconnection.
// This deliberately does not reconnect service automatically after payment.
accountsRouter.post(
  "/customers/:customerId/request-reconnection",
  requireAuth,
  (req, res) =>
    transitionAccount(req, res, {
      action: "Requested customer reconnection",
      allowedFrom: ["disconnected"],
      toStatus: "pending_reconnection",
    })
);

// Management approval: pending_reconnection -> active.
accountsRouter.post(
  "/customers/:customerId/reconnect",
  requireAuth,
  requireAccountManager,
  (req, res) =>
    transitionAccount(req, res, {
      action: "Reconnected customer account",
      allowedFrom: ["pending_reconnection"],
      toStatus: "active",
      updateDateColumn: "reactivation_date",
    })
);

export { insertStatusHistory };
export default accountsRouter;
