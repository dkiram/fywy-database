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
  if (!["admin", "head_office"].includes(employee.role)) {
    return res.status(403).json({
      error: "Only Admin and Head Office can manage account operations.",
    });
  }
  next();
}

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const employee = req.session.employee;
  if (!employee) {
    return res.status(401).json({ error: "Not authenticated." });
  }
  if (employee.role !== "admin") {
    return res.status(403).json({
      error: "Only administrators can review waiver requests.",
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
    requireClearedBalance?: boolean;
    chargeReconnectionFee?: boolean;
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

    // Reconnection can be requested or approved only after the full recurring
    // balance and reconnection fee have been paid or waived.
    if (options.requireClearedBalance) {
      await client.query(
        `SELECT public.spcl_generate_monthly_charges(
          (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE
        );`
      );
      const balanceResult = await client.query(
        `SELECT outstanding_balance FROM public.customer_billing_status WHERE customer_id = $1;`,
        [customerId]
      );
      const outstandingBalance = Number(balanceResult.rows[0]?.outstanding_balance ?? 0);
      if (outstandingBalance > 0) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: `Reconnection requires the full outstanding balance. J$${outstandingBalance.toFixed(2)} remains unpaid.`,
        });
      }
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

    // Each actual deactivation creates one reconnection-fee debit. Using the
    // immutable status-history ID makes this safe even after later reconnects.
    if (options.toStatus === "disconnected" && options.chargeReconnectionFee !== false) {
      await client.query(
        `
        INSERT INTO public.account_ledger_entries (
          customer_id, entry_type, amount, effective_date, due_date,
          grace_end_date, description, created_by_employee_id, source_key
        )
        SELECT
          c.customer_id, 'reconnection_fee', package.reconnection_fee,
          (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
          (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
          (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
          'Reconnection fee required after deactivation', $2,
          'reconnection-fee:status-history:' || $3::TEXT
        FROM public.customers c
        JOIN public.packages package ON package.package_id = c.package_id
        WHERE c.customer_id = $1 AND package.reconnection_fee > 0
        ON CONFLICT (source_key) DO NOTHING;
        `,
        [customerId, employee.employeeId, history.account_status_history_id]
      );
    }

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
accountsRouter.get("/account-operations", requireAuth, requireAccountManager, async (req, res) => {
  const search = cleanText(req.query.search);
  const searchPattern = `%${search}%`;
  const view = cleanText(req.query.view) || "attention";
  const isAdmin = req.session.employee!.role === "admin";

  // Active and all-account views reveal SPCL's complete customer volume, so
  // they are deliberately reserved for administrators.
  if (!isAdmin && ["active", "all"].includes(view)) {
    return res.status(403).json({
      error: "Only administrators can view complete customer totals.",
    });
  }
  const requestedPage = Math.max(
    Number.parseInt(cleanText(req.query.page), 10) || 1,
    1
  );
  const limit = 10;

  const viewClauses: Record<string, string> = {
    attention: `c.status IN ('disconnected', 'pending_reconnection')
      AND NULLIF(BTRIM(c.name), '') IS NOT NULL`,
    pending_reconnection: "c.status = 'pending_reconnection'",
    disconnected: "c.status = 'disconnected'",
    active: "c.status = 'active'",
    all: "TRUE",
  };
  const viewClause = viewClauses[view] ?? viewClauses.attention;

  try {
    // Keep the queue balance current through today's activation anniversaries.
    await pool.query(
      `SELECT public.spcl_generate_monthly_charges(
        (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE
      );`
    );
    // Count first so the API can clamp out-of-range page numbers safely.
    const countResult = await pool.query(
      `
      SELECT COUNT(*)::INTEGER AS total
      FROM public.customers c
      WHERE c.hidden_from_app = FALSE
        AND (${viewClause})
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
          latest.effective_date AS latest_status_date,
          billing.outstanding_balance,
          billing.credit_balance,
          billing.ready_for_reconnection,
          billing.is_delinquent,
          billing.eligible_for_disconnection,
          billing.is_on_hold,
          billing.hold_expires_on
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
        LEFT JOIN public.customer_billing_status billing
          ON billing.customer_id = c.customer_id
        WHERE c.hidden_from_app = FALSE
          AND (${viewClause})
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
          )::INTEGER AS pending_reconnection,
          (SELECT COUNT(*)::INTEGER FROM public.customer_billing_status
            WHERE is_delinquent) AS delinquent,
          (SELECT COUNT(*)::INTEGER FROM public.customer_billing_status
            WHERE eligible_for_disconnection) AS eligible_for_disconnection
        FROM public.customers
        WHERE hidden_from_app = FALSE;
        `
      ),
    ]);

    const summary = { ...summaryResult.rows[0] };
    if (!isAdmin) delete summary.active;

    res.json({
      accounts: accountsResult.rows,
      summary,
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

// Return the live balance, exception state, and recent ledger evidence used by
// the customer-profile account panel. Imported estimates are explicitly marked.
accountsRouter.get(
  "/customers/:customerId/billing-status",
  requireAuth,
  async (req, res) => {
    const customerId = parseCustomerId(req, res);
    if (customerId === null) return;

    try {
      await pool.query(
        `SELECT public.spcl_generate_monthly_charges(
          (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE
        );`
      );
      const [statusResult, ledgerResult] = await Promise.all([
        pool.query(
          `
          SELECT billing.*, c.status AS account_status
          FROM public.customer_billing_status billing
          JOIN public.customers c USING (customer_id)
          WHERE billing.customer_id = $1;
          `,
          [customerId]
        ),
        pool.query(
          `
          SELECT account_ledger_entry_id, entry_type, amount, effective_date,
            due_date, description, reason, is_verified
          FROM public.account_ledger_entries
          WHERE customer_id = $1
          ORDER BY effective_date DESC, account_ledger_entry_id DESC
          LIMIT 24;
          `,
          [customerId]
        ),
      ]);

      if (statusResult.rows.length === 0) {
        return res.status(404).json({ error: "Customer not found." });
      }
      res.json({ billing: statusResult.rows[0], ledger: ledgerResult.rows });
    } catch (error) {
      console.error("Could not load customer billing status:", error);
      res.status(500).json({ error: "Could not load customer billing status." });
    }
  }
);

// A dated management pass postpones disconnection but never erases the debt.
accountsRouter.post(
  "/customers/:customerId/disconnection-holds",
  requireAuth,
  requireAccountManager,
  async (req, res) => {
    const customerId = parseCustomerId(req, res);
    if (customerId === null) return;
    const expiresOn = cleanText(req.body.expiresOn);
    const reason = cleanText(req.body.reason);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expiresOn)) {
      return res.status(400).json({ error: "Choose a valid hold expiry date." });
    }
    if (reason.length < 3 || reason.length > 500) {
      return res.status(400).json({ error: "A reason between 3 and 500 characters is required." });
    }

    const employee = req.session.employee!;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const customerResult = await client.query(
        `SELECT customer_id FROM public.customers WHERE customer_id = $1 FOR UPDATE;`,
        [customerId]
      );
      if (customerResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Customer not found." });
      }
      const dateCheck = await client.query(
        `SELECT $1::DATE >= (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE AS valid;`,
        [expiresOn]
      );
      if (!dateCheck.rows[0].valid) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "The hold expiry cannot be in the past." });
      }

      // Retire any older active pass so the profile has one unambiguous expiry.
      await client.query(
        `UPDATE public.disconnection_holds SET status = 'released', released_by_employee_id = $2,
          released_at = CURRENT_TIMESTAMP WHERE customer_id = $1 AND status = 'active';`,
        [customerId, employee.employeeId]
      );
      const holdResult = await client.query(
        `
        INSERT INTO public.disconnection_holds (
          customer_id, expires_on, reason, approved_by_employee_id
        ) VALUES ($1, $2::DATE, $3, $4)
        RETURNING disconnection_hold_id, customer_id, starts_on, expires_on, reason, status;
        `,
        [customerId, expiresOn, reason, employee.employeeId]
      );
      await client.query(
        `INSERT INTO public.audit_logs (
          employee_id, actor_name, action, entity_type, entity_id,
          field_name, old_value, new_value, reason, occurred_at
        ) VALUES ($1, $2, 'Approved disconnection hold', 'customer', $3,
          'disconnection_hold', NULL, $4, $5, CURRENT_TIMESTAMP);`,
        [employee.employeeId, `${employee.firstName} ${employee.lastName}`, String(customerId), expiresOn, reason]
      );
      await client.query("COMMIT");
      res.status(201).json({ hold: holdResult.rows[0] });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Could not approve disconnection hold:", error);
      res.status(500).json({ error: "Could not approve disconnection hold." });
    } finally {
      client.release();
    }
  }
);

// Management submits the exact proposed discount. No balance changes until an
// administrator reviews the durable request and explicitly approves it.
accountsRouter.post(
  "/customers/:customerId/waiver-requests",
  requireAuth,
  requireAccountManager,
  async (req, res) => {
    const customerId = parseCustomerId(req, res);
    if (customerId === null) return;
    const amountText = String(req.body.amount ?? "").trim();
    const reason = cleanText(req.body.reason);
    if (!/^\d+(\.\d{1,2})?$/.test(amountText) || Number(amountText) <= 0) {
      return res.status(400).json({ error: "Enter a waiver amount greater than zero." });
    }
    if (reason.length < 3 || reason.length > 500) {
      return res.status(400).json({ error: "A reason between 3 and 500 characters is required." });
    }

    const amount = Number(amountText).toFixed(2);
    const employee = req.session.employee!;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const customerResult = await client.query(
        `SELECT customer_id FROM public.customers WHERE customer_id = $1 FOR UPDATE;`,
        [customerId]
      );
      if (customerResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Customer not found." });
      }

      await client.query(
        `SELECT public.spcl_generate_monthly_charges(
          (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE
        );`
      );
      const billingResult = await client.query(
        `SELECT outstanding_balance FROM public.customer_billing_status WHERE customer_id = $1;`,
        [customerId]
      );
      const outstandingBalance = Number(billingResult.rows[0]?.outstanding_balance ?? 0);
      if (outstandingBalance <= 0) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "This customer has no outstanding balance to waive." });
      }
      if (Number(amount) > outstandingBalance) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: `The waiver cannot exceed the J$${outstandingBalance.toFixed(2)} outstanding balance.`,
        });
      }

      const existingResult = await client.query(
        `SELECT waiver_request_id FROM public.waiver_requests
         WHERE customer_id = $1 AND status = 'pending';`,
        [customerId]
      );
      if (existingResult.rows.length > 0) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "This customer already has a pending discount request." });
      }

      const requestResult = await client.query(
        `INSERT INTO public.waiver_requests (
          customer_id, amount, reason, requested_by_employee_id
        ) VALUES ($1, $2, $3, $4)
        RETURNING waiver_request_id, customer_id, amount, reason, status, requested_at;`,
        [customerId, amount, reason, employee.employeeId]
      );
      const waiverRequest = requestResult.rows[0];
      await client.query(
        `INSERT INTO public.audit_logs (
          employee_id, actor_name, action, entity_type, entity_id,
          field_name, old_value, new_value, reason, occurred_at
        ) VALUES ($1, $2, 'Requested balance waiver', 'customer', $3,
          'waiver_request', NULL, $4, $5, CURRENT_TIMESTAMP);`,
        [
          employee.employeeId,
          `${employee.firstName} ${employee.lastName}`,
          String(customerId),
          `J$${amount}; request #${waiverRequest.waiver_request_id}`,
          reason,
        ]
      );
      await client.query("COMMIT");
      res.status(201).json({ waiverRequest });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Could not submit waiver request:", error);
      res.status(500).json({ error: "Could not submit waiver request." });
    } finally {
      client.release();
    }
  }
);

accountsRouter.get(
  "/customers/:customerId/waiver-requests",
  requireAuth,
  requireAccountManager,
  async (req, res) => {
    const customerId = parseCustomerId(req, res);
    if (customerId === null) return;
    try {
      const result = await pool.query(
        `SELECT request.waiver_request_id, request.customer_id, request.amount,
            request.reason, request.status, request.requested_at, request.reviewed_at,
            request.review_note, request.reversed_at, request.reversal_note,
            CONCAT_WS(' ', requester.first_name, requester.last_name) AS requested_by_name,
            CONCAT_WS(' ', reviewer.first_name, reviewer.last_name) AS reviewed_by_name,
            CONCAT_WS(' ', reverser.first_name, reverser.last_name) AS reversed_by_name
         FROM public.waiver_requests request
         LEFT JOIN public.employees requester
           ON requester.employee_id = request.requested_by_employee_id
         LEFT JOIN public.employees reviewer
           ON reviewer.employee_id = request.reviewed_by_employee_id
         LEFT JOIN public.employees reverser
           ON reverser.employee_id = request.reversed_by_employee_id
         WHERE request.customer_id = $1
         ORDER BY request.requested_at DESC
         LIMIT 10;`,
        [customerId]
      );
      res.json({ waiverRequests: result.rows });
    } catch (error) {
      console.error("Could not load customer waiver requests:", error);
      res.status(500).json({ error: "Could not load waiver requests." });
    }
  }
);

// Admin-only queue used by the approval panel on Account Operations.
accountsRouter.get("/waiver-requests", requireAuth, requireAdmin, async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT request.waiver_request_id, request.customer_id, request.amount,
          request.reason, request.status, request.requested_at,
          customer.name AS customer_name,
          customer.telephone,
          billing.outstanding_balance,
          CONCAT_WS(' ', requester.first_name, requester.last_name) AS requested_by_name
       FROM public.waiver_requests request
       JOIN public.customers customer ON customer.customer_id = request.customer_id
       LEFT JOIN public.customer_billing_status billing ON billing.customer_id = request.customer_id
       LEFT JOIN public.employees requester
         ON requester.employee_id = request.requested_by_employee_id
       WHERE request.status = 'pending'
       ORDER BY request.requested_at ASC
       LIMIT 100;`
    );
    res.json({ waiverRequests: result.rows });
  } catch (error) {
    console.error("Could not load waiver approval queue:", error);
    res.status(500).json({ error: "Could not load waiver approval queue." });
  }
});

accountsRouter.post(
  "/waiver-requests/:requestId/review",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const requestIdText = String(req.params.requestId ?? "");
    if (!/^\d+$/.test(requestIdText)) {
      return res.status(400).json({ error: "Invalid waiver request ID." });
    }
    const decision = cleanText(req.body.decision);
    const reviewNote = cleanText(req.body.reviewNote);
    if (!['approve', 'reject'].includes(decision)) {
      return res.status(400).json({ error: "Choose approve or reject." });
    }
    if (reviewNote.length > 500 || (decision === "reject" && reviewNote.length < 3)) {
      return res.status(400).json({ error: "A rejection reason between 3 and 500 characters is required." });
    }

    const requestId = Number(requestIdText);
    const employee = req.session.employee!;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const requestResult = await client.query(
        `SELECT waiver_request_id, customer_id, amount, reason, status
         FROM public.waiver_requests
         WHERE waiver_request_id = $1
         FOR UPDATE;`,
        [requestId]
      );
      const waiverRequest = requestResult.rows[0];
      if (!waiverRequest) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Waiver request not found." });
      }
      if (waiverRequest.status !== "pending") {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "This waiver request has already been reviewed." });
      }

      if (decision === "reject") {
        await client.query(
          `UPDATE public.waiver_requests
           SET status = 'rejected', reviewed_by_employee_id = $2,
               reviewed_at = CURRENT_TIMESTAMP, review_note = $3
           WHERE waiver_request_id = $1;`,
          [requestId, employee.employeeId, reviewNote]
        );
        await client.query(
          `INSERT INTO public.audit_logs (
            employee_id, actor_name, action, entity_type, entity_id,
            field_name, old_value, new_value, reason, occurred_at
          ) VALUES ($1, $2, 'Rejected balance waiver request', 'customer', $3,
            'waiver_request', 'pending', $4, $5, CURRENT_TIMESTAMP);`,
          [
            employee.employeeId,
            `${employee.firstName} ${employee.lastName}`,
            String(waiverRequest.customer_id),
            `rejected; request #${requestId}`,
            reviewNote,
          ]
        );
        await client.query("COMMIT");
        return res.json({ waiverRequestId: requestId, status: "rejected" });
      }

      const customerResult = await client.query(
        `SELECT customer_id, status, deactivation_date, reactivation_date
         FROM public.customers WHERE customer_id = $1 FOR UPDATE;`,
        [waiverRequest.customer_id]
      );
      const customer = customerResult.rows[0];
      if (!customer) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Customer not found." });
      }
      await client.query(
        `SELECT public.spcl_generate_monthly_charges(
          (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE
        );`
      );
      const billingResult = await client.query(
        `SELECT outstanding_balance FROM public.customer_billing_status WHERE customer_id = $1;`,
        [waiverRequest.customer_id]
      );
      const outstandingBalance = Number(billingResult.rows[0]?.outstanding_balance ?? 0);
      if (outstandingBalance <= 0 || Number(waiverRequest.amount) > outstandingBalance) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: outstandingBalance <= 0
            ? "The customer no longer has an outstanding balance. Reject this request instead."
            : `The current outstanding balance is J$${outstandingBalance.toFixed(2)}. Reject this request and submit a lower amount.`,
        });
      }

      const waiverResult = await client.query(
        `INSERT INTO public.account_ledger_entries (
          customer_id, entry_type, amount, effective_date, description,
          created_by_employee_id, reason
        ) VALUES ($1, 'waiver', -ABS($2::NUMERIC),
          (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
          'Admin-approved permanent balance waiver', $3, $4)
        RETURNING account_ledger_entry_id, amount, effective_date, reason;`,
        [waiverRequest.customer_id, waiverRequest.amount, employee.employeeId, waiverRequest.reason]
      );
      const waiver = waiverResult.rows[0];

      await client.query(
        `UPDATE public.waiver_requests
         SET status = 'approved', reviewed_by_employee_id = $2,
             reviewed_at = CURRENT_TIMESTAMP, review_note = $3,
             waiver_ledger_entry_id = $4
         WHERE waiver_request_id = $1;`,
        [requestId, employee.employeeId, reviewNote || null, waiver.account_ledger_entry_id]
      );

      let statusHistory = null;
      const refreshedBillingResult = await client.query(
        `SELECT ready_for_reconnection FROM public.customer_billing_status WHERE customer_id = $1;`,
        [waiverRequest.customer_id]
      );
      if (customer.status === "disconnected" && refreshedBillingResult.rows[0]?.ready_for_reconnection) {
        const queueReason = "Outstanding balance cleared by Admin-approved waiver; awaiting reconnection approval";
        await client.query(
          `UPDATE public.customers SET status = 'pending_reconnection' WHERE customer_id = $1;`,
          [waiverRequest.customer_id]
        );
        statusHistory = await insertStatusHistory(client, {
          customerId: waiverRequest.customer_id,
          fromStatus: "disconnected",
          toStatus: "pending_reconnection",
          reason: queueReason,
          employeeId: employee.employeeId,
        });
      }

      await client.query(
        `INSERT INTO public.audit_logs (
          employee_id, actor_name, action, entity_type, entity_id,
          field_name, old_value, new_value, reason, occurred_at
        ) VALUES ($1, $2, 'Approved and applied balance waiver', 'customer', $3,
          'account_balance', 'pending request', $4, $5, CURRENT_TIMESTAMP);`,
        [
          employee.employeeId,
          `${employee.firstName} ${employee.lastName}`,
          String(waiverRequest.customer_id),
          `-${Number(waiverRequest.amount).toFixed(2)}; request #${requestId}`,
          waiverRequest.reason,
        ]
      );
      await client.query("COMMIT");
      res.json({
        waiverRequestId: requestId,
        status: "approved",
        waiver,
        statusHistory,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Could not review waiver request:", error);
      res.status(500).json({ error: "Could not review waiver request." });
    } finally {
      client.release();
    }
  }
);

accountsRouter.post(
  "/waiver-requests/:requestId/reverse",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const requestIdText = String(req.params.requestId ?? "");
    if (!/^\d+$/.test(requestIdText)) {
      return res.status(400).json({ error: "Invalid waiver request ID." });
    }
    const reversalNote = cleanText(req.body.reason);
    if (reversalNote.length < 3 || reversalNote.length > 500) {
      return res.status(400).json({ error: "A reversal reason between 3 and 500 characters is required." });
    }

    const requestId = Number(requestIdText);
    const employee = req.session.employee!;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const requestResult = await client.query(
        `SELECT waiver_request_id, customer_id, amount, reason, status,
            waiver_ledger_entry_id
         FROM public.waiver_requests
         WHERE waiver_request_id = $1
         FOR UPDATE;`,
        [requestId]
      );
      const waiverRequest = requestResult.rows[0];
      if (!waiverRequest) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Waiver request not found." });
      }
      if (waiverRequest.status !== "approved") {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "Only an approved, unreversed discount can be reversed." });
      }

      const customerResult = await client.query(
        `SELECT customer_id, status, deactivation_date, reactivation_date
         FROM public.customers WHERE customer_id = $1 FOR UPDATE;`,
        [waiverRequest.customer_id]
      );
      const customer = customerResult.rows[0];
      if (!customer) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Customer not found." });
      }

      const originalResult = await client.query(
        `SELECT account_ledger_entry_id, customer_id, amount, entry_type
         FROM public.account_ledger_entries
         WHERE account_ledger_entry_id = $1
         FOR UPDATE;`,
        [waiverRequest.waiver_ledger_entry_id]
      );
      const originalWaiver = originalResult.rows[0];
      if (
        !originalWaiver ||
        originalWaiver.entry_type !== "waiver" ||
        Number(originalWaiver.customer_id) !== Number(waiverRequest.customer_id) ||
        Number(originalWaiver.amount) >= 0
      ) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "The original waiver ledger entry is unavailable or invalid." });
      }

      const reversalResult = await client.query(
        `INSERT INTO public.account_ledger_entries (
          customer_id, entry_type, amount, effective_date, description,
          created_by_employee_id, reason, source_key
        ) VALUES ($1, 'adjustment', ABS($2::NUMERIC),
          (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
          'Reversal of Admin-approved balance waiver', $3, $4, $5)
        RETURNING account_ledger_entry_id, amount, effective_date, reason;`,
        [
          waiverRequest.customer_id,
          originalWaiver.amount,
          employee.employeeId,
          reversalNote,
          `waiver-reversal:request:${requestId}`,
        ]
      );
      const reversal = reversalResult.rows[0];

      await client.query(
        `UPDATE public.waiver_requests
         SET status = 'reversed', reversed_by_employee_id = $2,
             reversed_at = CURRENT_TIMESTAMP, reversal_note = $3,
             reversal_ledger_entry_id = $4
         WHERE waiver_request_id = $1;`,
        [requestId, employee.employeeId, reversalNote, reversal.account_ledger_entry_id]
      );

      let statusHistory = null;
      const billingResult = await client.query(
        `SELECT outstanding_balance FROM public.customer_billing_status WHERE customer_id = $1;`,
        [waiverRequest.customer_id]
      );
      const outstandingBalance = Number(billingResult.rows[0]?.outstanding_balance ?? 0);
      let customerStatus = customer.status as AccountStatus;
      if (customerStatus === "pending_reconnection" && outstandingBalance > 0) {
        await client.query(
          `UPDATE public.customers SET status = 'disconnected' WHERE customer_id = $1;`,
          [waiverRequest.customer_id]
        );
        statusHistory = await insertStatusHistory(client, {
          customerId: Number(waiverRequest.customer_id),
          fromStatus: "pending_reconnection",
          toStatus: "disconnected",
          reason: "Approved discount reversed; account balance is outstanding again",
          employeeId: employee.employeeId,
        });
        customerStatus = "disconnected";
      }

      await client.query(
        `INSERT INTO public.audit_logs (
          employee_id, actor_name, action, entity_type, entity_id,
          field_name, old_value, new_value, reason, occurred_at
        ) VALUES ($1, $2, 'Reversed approved balance waiver', 'customer', $3,
          'account_balance', $4, $5, $6, CURRENT_TIMESTAMP);`,
        [
          employee.employeeId,
          `${employee.firstName} ${employee.lastName}`,
          String(waiverRequest.customer_id),
          `-${Math.abs(Number(originalWaiver.amount)).toFixed(2)}; request #${requestId}`,
          `Restored ${Number(reversal.amount).toFixed(2)}; reversal entry #${reversal.account_ledger_entry_id}`,
          reversalNote,
        ]
      );
      await client.query("COMMIT");
      res.json({
        waiverRequestId: requestId,
        status: "reversed",
        reversal,
        customer: { ...customer, status: customerStatus },
        outstandingBalance: outstandingBalance.toFixed(2),
        statusHistory,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Could not reverse approved waiver:", error);
      res.status(500).json({ error: "Could not reverse approved discount." });
    } finally {
      client.release();
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

// A cleared account enters the queue immediately. An unpaid account creates an
// Admin-reviewed request and remains disconnected until that request is approved.
accountsRouter.post(
  "/customers/:customerId/request-reconnection",
  requireAuth,
  async (req, res) => {
    const customerId = parseCustomerId(req, res);
    if (customerId === null) return;
    const reason = cleanText(req.body.reason);
    if (reason.length < 3 || reason.length > 500) {
      return res.status(400).json({ error: "A reason between 3 and 500 characters is required." });
    }

    const employee = req.session.employee!;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const customerResult = await client.query(
        `SELECT customer_id, status FROM public.customers WHERE customer_id = $1 FOR UPDATE;`,
        [customerId]
      );
      const customer = customerResult.rows[0];
      if (!customer) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Customer not found." });
      }
      if (customer.status !== "disconnected") {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "Only disconnected accounts can request reconnection." });
      }

      await client.query(
        `SELECT public.spcl_generate_monthly_charges(
          (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE
        );`
      );
      const billingResult = await client.query(
        `SELECT outstanding_balance FROM public.customer_billing_status WHERE customer_id = $1;`,
        [customerId]
      );
      const outstandingBalance = Number(billingResult.rows[0]?.outstanding_balance ?? 0);

      if (outstandingBalance > 0) {
        const existingResult = await client.query(
          `SELECT reconnection_request_id FROM public.reconnection_requests
           WHERE customer_id = $1 AND status = 'pending';`,
          [customerId]
        );
        if (existingResult.rows.length > 0) {
          await client.query("ROLLBACK");
          return res.status(409).json({ error: "This customer already has a pending reconnection request." });
        }

        const requestResult = await client.query(
          `INSERT INTO public.reconnection_requests (
            customer_id, outstanding_balance_snapshot, reason, requested_by_employee_id
          ) VALUES ($1, $2, $3, $4)
          RETURNING reconnection_request_id, customer_id,
            outstanding_balance_snapshot, reason, status, requested_at;`,
          [customerId, outstandingBalance.toFixed(2), reason, employee.employeeId]
        );
        const reconnectionRequest = requestResult.rows[0];
        await client.query(
          `INSERT INTO public.audit_logs (
            employee_id, actor_name, action, entity_type, entity_id,
            field_name, old_value, new_value, reason, occurred_at
          ) VALUES ($1, $2, 'Requested unpaid reconnection review', 'customer', $3,
            'reconnection_request', 'disconnected', $4, $5, CURRENT_TIMESTAMP);`,
          [
            employee.employeeId,
            `${employee.firstName} ${employee.lastName}`,
            String(customerId),
            `Pending Admin review; outstanding J$${outstandingBalance.toFixed(2)}; request #${reconnectionRequest.reconnection_request_id}`,
            reason,
          ]
        );
        await client.query("COMMIT");
        return res.status(202).json({ approvalRequired: true, reconnectionRequest });
      }

      const updatedResult = await client.query(
        `UPDATE public.customers SET status = 'pending_reconnection'
         WHERE customer_id = $1
         RETURNING customer_id, status, deactivation_date, reactivation_date;`,
        [customerId]
      );
      const statusHistory = await insertStatusHistory(client, {
        customerId,
        fromStatus: "disconnected",
        toStatus: "pending_reconnection",
        reason,
        employeeId: employee.employeeId,
      });
      await client.query(
        `INSERT INTO public.audit_logs (
          employee_id, actor_name, action, entity_type, entity_id,
          field_name, old_value, new_value, reason, occurred_at
        ) VALUES ($1, $2, 'Requested customer reconnection', 'customer', $3,
          'status', 'disconnected', 'pending_reconnection', $4, CURRENT_TIMESTAMP);`,
        [employee.employeeId, `${employee.firstName} ${employee.lastName}`, String(customerId), reason]
      );
      await client.query("COMMIT");
      res.json({ approvalRequired: false, customer: updatedResult.rows[0], statusHistory });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Could not request customer reconnection:", error);
      res.status(500).json({ error: "Could not request customer reconnection." });
    } finally {
      client.release();
    }
  }
);

// Managers can remove an account from the pending queue without creating a
// second reconnection fee; the existing disconnection remains in force.
accountsRouter.post(
  "/customers/:customerId/cancel-reconnection",
  requireAuth,
  requireAccountManager,
  (req, res) =>
    transitionAccount(req, res, {
      action: "Cancelled pending customer reconnection",
      allowedFrom: ["pending_reconnection"],
      toStatus: "disconnected",
      chargeReconnectionFee: false,
    })
);

accountsRouter.get(
  "/customers/:customerId/reconnection-requests",
  requireAuth,
  async (req, res) => {
    const customerId = parseCustomerId(req, res);
    if (customerId === null) return;
    try {
      const result = await pool.query(
        `SELECT request.reconnection_request_id, request.customer_id,
            request.outstanding_balance_snapshot, request.reason, request.status,
            request.requested_at, request.reviewed_at, request.review_note,
            CONCAT_WS(' ', requester.first_name, requester.last_name) AS requested_by_name,
            CONCAT_WS(' ', reviewer.first_name, reviewer.last_name) AS reviewed_by_name
         FROM public.reconnection_requests request
         LEFT JOIN public.employees requester
           ON requester.employee_id = request.requested_by_employee_id
         LEFT JOIN public.employees reviewer
           ON reviewer.employee_id = request.reviewed_by_employee_id
         WHERE request.customer_id = $1
         ORDER BY request.requested_at DESC
         LIMIT 10;`,
        [customerId]
      );
      res.json({ reconnectionRequests: result.rows });
    } catch (error) {
      console.error("Could not load customer reconnection requests:", error);
      res.status(500).json({ error: "Could not load reconnection requests." });
    }
  }
);

accountsRouter.get("/reconnection-requests", requireAuth, requireAdmin, async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT request.reconnection_request_id, request.customer_id,
          request.outstanding_balance_snapshot, request.reason, request.status,
          request.requested_at, customer.name AS customer_name, customer.telephone,
          customer.status AS customer_status, billing.outstanding_balance,
          CONCAT_WS(' ', requester.first_name, requester.last_name) AS requested_by_name
       FROM public.reconnection_requests request
       JOIN public.customers customer ON customer.customer_id = request.customer_id
       LEFT JOIN public.customer_billing_status billing ON billing.customer_id = request.customer_id
       LEFT JOIN public.employees requester
         ON requester.employee_id = request.requested_by_employee_id
       WHERE request.status = 'pending'
       ORDER BY request.requested_at ASC
       LIMIT 100;`
    );
    res.json({ reconnectionRequests: result.rows });
  } catch (error) {
    console.error("Could not load reconnection approval queue:", error);
    res.status(500).json({ error: "Could not load reconnection approval queue." });
  }
});

accountsRouter.post(
  "/reconnection-requests/:requestId/review",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const requestIdText = String(req.params.requestId ?? "");
    if (!/^\d+$/.test(requestIdText)) {
      return res.status(400).json({ error: "Invalid reconnection request ID." });
    }
    const decision = cleanText(req.body.decision);
    const reviewNote = cleanText(req.body.reviewNote);
    if (!["approve", "reject"].includes(decision)) {
      return res.status(400).json({ error: "Choose approve or reject." });
    }
    if (reviewNote.length > 500 || (decision === "reject" && reviewNote.length < 3)) {
      return res.status(400).json({ error: "A rejection reason between 3 and 500 characters is required." });
    }

    const requestId = Number(requestIdText);
    const employee = req.session.employee!;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const requestResult = await client.query(
        `SELECT reconnection_request_id, customer_id, outstanding_balance_snapshot,
            reason, status
         FROM public.reconnection_requests
         WHERE reconnection_request_id = $1
         FOR UPDATE;`,
        [requestId]
      );
      const reconnectionRequest = requestResult.rows[0];
      if (!reconnectionRequest) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Reconnection request not found." });
      }
      if (reconnectionRequest.status !== "pending") {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "This reconnection request has already been reviewed." });
      }

      if (decision === "reject") {
        await client.query(
          `UPDATE public.reconnection_requests
           SET status = 'rejected', reviewed_by_employee_id = $2,
               reviewed_at = CURRENT_TIMESTAMP, review_note = $3
           WHERE reconnection_request_id = $1;`,
          [requestId, employee.employeeId, reviewNote]
        );
        await client.query(
          `INSERT INTO public.audit_logs (
            employee_id, actor_name, action, entity_type, entity_id,
            field_name, old_value, new_value, reason, occurred_at
          ) VALUES ($1, $2, 'Rejected unpaid reconnection request', 'customer', $3,
            'reconnection_request', 'pending', $4, $5, CURRENT_TIMESTAMP);`,
          [
            employee.employeeId,
            `${employee.firstName} ${employee.lastName}`,
            String(reconnectionRequest.customer_id),
            `rejected; request #${requestId}`,
            reviewNote,
          ]
        );
        await client.query("COMMIT");
        return res.json({ reconnectionRequestId: requestId, status: "rejected" });
      }

      const customerResult = await client.query(
        `SELECT customer_id, status FROM public.customers WHERE customer_id = $1 FOR UPDATE;`,
        [reconnectionRequest.customer_id]
      );
      const customer = customerResult.rows[0];
      if (!customer) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Customer not found." });
      }
      if (customer.status !== "disconnected") {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "The account is no longer disconnected. Reject this stale request." });
      }

      await client.query(
        `SELECT public.spcl_generate_monthly_charges(
          (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE
        );`
      );
      const billingResult = await client.query(
        `SELECT outstanding_balance FROM public.customer_billing_status WHERE customer_id = $1;`,
        [reconnectionRequest.customer_id]
      );
      const outstandingBalance = Number(billingResult.rows[0]?.outstanding_balance ?? 0);
      const updatedResult = await client.query(
        `UPDATE public.customers SET status = 'pending_reconnection'
         WHERE customer_id = $1
         RETURNING customer_id, status, deactivation_date, reactivation_date;`,
        [reconnectionRequest.customer_id]
      );
      const statusReason = outstandingBalance > 0
        ? `Admin approved queue entry with J$${outstandingBalance.toFixed(2)} still outstanding: ${reconnectionRequest.reason}`
        : `Admin approved reconnection queue entry after balance was cleared: ${reconnectionRequest.reason}`;
      const statusHistory = await insertStatusHistory(client, {
        customerId: Number(reconnectionRequest.customer_id),
        fromStatus: "disconnected",
        toStatus: "pending_reconnection",
        reason: statusReason,
        employeeId: employee.employeeId,
      });
      await client.query(
        `UPDATE public.reconnection_requests
         SET status = 'approved', reviewed_by_employee_id = $2,
             reviewed_at = CURRENT_TIMESTAMP, review_note = $3,
             account_status_history_id = $4
         WHERE reconnection_request_id = $1;`,
        [requestId, employee.employeeId, reviewNote || null, statusHistory.account_status_history_id]
      );
      await client.query(
        `INSERT INTO public.audit_logs (
          employee_id, actor_name, action, entity_type, entity_id,
          field_name, old_value, new_value, reason, occurred_at
        ) VALUES ($1, $2, 'Approved unpaid reconnection queue request', 'customer', $3,
          'status', 'disconnected', $4, $5, CURRENT_TIMESTAMP);`,
        [
          employee.employeeId,
          `${employee.firstName} ${employee.lastName}`,
          String(reconnectionRequest.customer_id),
          `pending_reconnection; request #${requestId}; outstanding J$${outstandingBalance.toFixed(2)}`,
          reconnectionRequest.reason,
        ]
      );
      await client.query("COMMIT");
      res.json({
        reconnectionRequestId: requestId,
        status: "approved",
        customer: updatedResult.rows[0],
        outstandingBalance: outstandingBalance.toFixed(2),
        statusHistory,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Could not review reconnection request:", error);
      res.status(500).json({ error: "Could not review reconnection request." });
    } finally {
      client.release();
    }
  }
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
      requireClearedBalance: true,
    })
);

export { insertStatusHistory };
export default accountsRouter;
