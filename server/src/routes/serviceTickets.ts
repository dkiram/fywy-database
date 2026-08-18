/** Implements service-ticket search, assignment, updates, history, and audit logging. */
import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import type { PoolClient } from "pg";
import { pool } from "../db.js";

// MVP 4 service-ticket workflow. Tickets are current work records, while the
// reports router only summarizes/filter records created here.
const serviceTicketsRouter = Router();

const ticketStatuses = [
  "open",
  "assigned",
  "in_progress",
  "completed",
  "cancelled",
] as const;
type TicketStatus = (typeof ticketStatuses)[number];

const ticketPriorities = ["low", "normal", "high", "urgent"] as const;
type TicketPriority = (typeof ticketPriorities)[number];

function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session.employee) {
    return res.status(401).json({ error: "Not authenticated." });
  }
  next();
}

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function validDate(value: string) {
  return value === "" || /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function parsePositiveId(value: unknown) {
  const text = String(value ?? "").trim();
  return /^\d+$/.test(text) && Number(text) > 0 ? Number(text) : null;
}

/**
 * Tickets go to technicians, and only to technicians.
 *
 * Enforced here as well as in the dropdown below, because a dropdown is a
 * suggestion: the request that actually arrives can name any employee_id,
 * whether from a page left open before this rule existed, a replayed request,
 * or someone typing into dev tools.
 *
 * The one exception is a ticket that already names a non-technician, from
 * before the rule. Re-saving such a ticket must not fail on an assignee the
 * user never chose, so the existing value is allowed through unchanged.
 */
async function validateAssignee(
  client: PoolClient,
  employeeId: number | null,
  currentAssigneeId: number | null = null
) {
  if (employeeId === null) return true;
  if (currentAssigneeId !== null && employeeId === currentAssigneeId) return true;

  const result = await client.query(
    `SELECT 1 FROM public.employees
     WHERE employee_id = $1 AND is_active = TRUE AND role = 'technician';`,
    [employeeId]
  );
  return result.rows.length > 0;
}

/**
 * The assignee dropdown.
 *
 * Technicians only. This used to return every active employee, which put
 * cashiers and head office into a list labelled "Technician" and left whoever
 * was assigning to remember, from memory, which of twenty names actually goes
 * out to a pole.
 *
 * Migration 034 made 'technician' a real role that cannot log in, so the role
 * is now a reliable answer to "does this person do field work" rather than the
 * rough permissions proxy it was when this endpoint was written.
 */
serviceTicketsRouter.get(
  "/service-ticket-assignees",
  requireAuth,
  async (_req, res) => {
    try {
      const result = await pool.query(`
        SELECT employee_id, first_name, last_name, role
        FROM public.employees
        WHERE is_active = TRUE
          AND role = 'technician'
        ORDER BY last_name, first_name;
      `);
      res.json({ employees: result.rows });
    } catch (error) {
      console.error("Could not load ticket assignees:", error);
      res.status(500).json({ error: "Could not load employees." });
    }
  }
);

// Searchable queue. customerId powers the Support History tab on a specific
// customer profile without creating a second ticket-list implementation.
serviceTicketsRouter.get("/service-tickets", requireAuth, async (req, res) => {
  const search = cleanText(req.query.search);
  const searchPattern = `%${search}%`;
  const view = cleanText(req.query.view) || "attention";
  const requestedPage = Math.max(Number.parseInt(cleanText(req.query.page), 10) || 1, 1);
  const customerIdText = cleanText(req.query.customerId);
  const customerId = customerIdText ? parsePositiveId(customerIdText) : null;
  if (customerIdText && customerId === null) {
    return res.status(400).json({ error: "Invalid customer ID." });
  }

  const viewClauses: Record<string, string> = {
    attention: "t.status IN ('open', 'assigned', 'in_progress')",
    open: "t.status IN ('open', 'assigned')",
    in_progress: "t.status = 'in_progress'",
    completed: "t.status = 'completed'",
    cancelled: "t.status = 'cancelled'",
    all: "TRUE",
  };
  const viewClause = viewClauses[view] ?? viewClauses.attention;
  const limit = 10;

  try {
    const params = [search, searchPattern, customerId];
    const whereSql = `
      WHERE ${viewClause}
        AND ($3::INTEGER IS NULL OR t.customer_id = $3)
        AND (
          $1 = ''
          OR t.service_ticket_id::TEXT ILIKE $2
          OR COALESCE(t.legacy_customer_id::TEXT, '') ILIKE $2
          OR c.customer_id::TEXT ILIKE $2
          OR COALESCE(c.name, '') ILIKE $2
          OR COALESCE(c.telephone, '') ILIKE $2
          OR t.issue_summary ILIKE $2
          OR COALESCE(t.description, '') ILIKE $2
        )
    `;

    const countResult = await pool.query(
      `SELECT COUNT(*)::INTEGER AS total
       FROM public.service_tickets t
       LEFT JOIN public.customers c ON c.customer_id = t.customer_id
       ${whereSql};`,
      params
    );
    const total = countResult.rows[0].total as number;
    const totalPages = Math.max(Math.ceil(total / limit), 1);
    const page = Math.min(requestedPage, totalPages);
    const offset = (page - 1) * limit;

    const [ticketsResult, summaryResult] = await Promise.all([
      pool.query(
        `
        SELECT
          t.service_ticket_id,
          t.customer_id,
          t.legacy_customer_id,
          c.name AS customer_name,
          c.telephone,
          c.address,
          t.issue_summary,
          t.description,
          t.priority,
          t.status,
          t.reported_date,
          t.assigned_employee_id,
          CONCAT_WS(' ', assignee.first_name, assignee.last_name) AS assigned_employee_name,
          t.pole_box_number,
          t.port_number,
          t.service_date,
          t.resolution_notes,
          t.updated_at
        FROM public.service_tickets t
        LEFT JOIN public.customers c ON c.customer_id = t.customer_id
        LEFT JOIN public.employees assignee
          ON assignee.employee_id = t.assigned_employee_id
        ${whereSql}
        ORDER BY
          CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
          t.reported_date ASC,
          t.service_ticket_id ASC
        LIMIT $4 OFFSET $5;
        `,
        [...params, limit, offset]
      ),
      pool.query(
        `
        SELECT
          COUNT(*) FILTER (WHERE status IN ('open', 'assigned', 'in_progress'))::INTEGER AS attention,
          COUNT(*) FILTER (WHERE status = 'open')::INTEGER AS open,
          COUNT(*) FILTER (WHERE status = 'assigned')::INTEGER AS assigned,
          COUNT(*) FILTER (WHERE status = 'in_progress')::INTEGER AS in_progress,
          COUNT(*) FILTER (WHERE status = 'completed')::INTEGER AS completed
        FROM public.service_tickets
        WHERE ($1::INTEGER IS NULL OR customer_id = $1);
        `,
        [customerId]
      ),
    ]);

    res.json({
      tickets: ticketsResult.rows,
      summary: summaryResult.rows[0],
      pagination: { page, limit, total, totalPages },
    });
  } catch (error) {
    console.error("Could not load service tickets:", error);
    res.status(500).json({ error: "Could not load service tickets." });
  }
});

serviceTicketsRouter.get(
  "/service-tickets/:ticketId",
  requireAuth,
  async (req, res) => {
    const ticketId = parsePositiveId(req.params.ticketId);
    if (ticketId === null) return res.status(400).json({ error: "Invalid ticket ID." });

    try {
      const ticketResult = await pool.query(
        `
        SELECT t.*, c.name AS customer_name, c.address, c.telephone,
          CONCAT_WS(' ', assignee.first_name, assignee.last_name) AS assigned_employee_name,
          assignee.role AS assigned_employee_role,
          CONCAT_WS(' ', creator.first_name, creator.last_name) AS created_by_name,
          -- Who marked it done, taken from the history rather than the ticket:
          -- updated_by_employee_id is whoever touched it last, which is not the
          -- same person once anybody edits a note after the work was finished.
          (
            SELECT CONCAT_WS(' ', e.first_name, e.last_name)
            FROM public.service_ticket_history h
            LEFT JOIN public.employees e ON e.employee_id = h.changed_by_employee_id
            WHERE h.service_ticket_id = t.service_ticket_id
              AND h.to_status = 'completed'
            ORDER BY h.changed_at DESC, h.service_ticket_history_id DESC
            LIMIT 1
          ) AS completed_by_name
        FROM public.service_tickets t
        LEFT JOIN public.customers c ON c.customer_id = t.customer_id
        LEFT JOIN public.employees assignee ON assignee.employee_id = t.assigned_employee_id
        LEFT JOIN public.employees creator  ON creator.employee_id  = t.created_by_employee_id
        WHERE t.service_ticket_id = $1;
        `,
        [ticketId]
      );
      if (ticketResult.rows.length === 0) {
        return res.status(404).json({ error: "Service ticket not found." });
      }

      const historyResult = await pool.query(
        `
        SELECT h.*, e.first_name AS changed_by_first_name, e.last_name AS changed_by_last_name
        FROM public.service_ticket_history h
        LEFT JOIN public.employees e ON e.employee_id = h.changed_by_employee_id
        WHERE h.service_ticket_id = $1
        ORDER BY h.changed_at DESC, h.service_ticket_history_id DESC;
        `,
        [ticketId]
      );
      res.json({ ticket: ticketResult.rows[0], history: historyResult.rows });
    } catch (error) {
      console.error("Could not load service ticket:", error);
      res.status(500).json({ error: "Could not load service ticket." });
    }
  }
);

serviceTicketsRouter.post("/service-tickets", requireAuth, async (req, res) => {
  const employee = req.session.employee!;
  const customerId = parsePositiveId(req.body.customerId);
  const issueSummary = cleanText(req.body.issueSummary);
  const description = cleanText(req.body.description);
  const priority = cleanText(req.body.priority) as TicketPriority;
  const reportedDate = cleanText(req.body.reportedDate);
  const assigneeText = String(req.body.assignedEmployeeId ?? "").trim();
  const assignedEmployeeId = assigneeText ? parsePositiveId(assigneeText) : null;

  if (customerId === null) return res.status(400).json({ error: "Select a customer." });
  if (issueSummary.length < 3 || issueSummary.length > 160) {
    return res.status(400).json({ error: "Problem summary must be 3–160 characters." });
  }
  if (description.length > 2000) return res.status(400).json({ error: "Details must be 2,000 characters or fewer." });
  if (!ticketPriorities.includes(priority)) return res.status(400).json({ error: "Choose a valid priority." });
  if (!validDate(reportedDate)) return res.status(400).json({ error: "Choose a valid reported date." });
  if (assigneeText && assignedEmployeeId === null) return res.status(400).json({ error: "Choose a valid technician." });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const customerResult = await client.query(
      `SELECT customer_id, name, pole_box_number, port_number FROM public.customers WHERE customer_id = $1;`,
      [customerId]
    );
    const customer = customerResult.rows[0];
    if (!customer) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Customer not found." });
    }
    if (!(await validateAssignee(client, assignedEmployeeId))) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Selected technician is unavailable." });
    }

    const status: TicketStatus = assignedEmployeeId ? "assigned" : "open";
    const ticketResult = await client.query(
      `
      INSERT INTO public.service_tickets (
        customer_id, issue_summary, description, priority, status,
        reported_date, assigned_employee_id, pole_box_number, port_number,
        created_by_employee_id, updated_by_employee_id
      ) VALUES (
        $1, $2, NULLIF($3, ''), $4, $5,
        COALESCE(NULLIF($6, '')::DATE, (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE),
        $7, NULLIF($8, ''), NULLIF($9, ''), $10, $10
      )
      RETURNING *;
      `,
      [
        customerId,
        issueSummary,
        description,
        priority,
        status,
        reportedDate,
        assignedEmployeeId,
        cleanText(req.body.poleBoxNumber) || customer.pole_box_number || "",
        cleanText(req.body.portNumber) || customer.port_number || "",
        employee.employeeId,
      ]
    );
    const ticket = ticketResult.rows[0];
    const historyNote = description || `Reported: ${issueSummary}`;

    await client.query(
      `INSERT INTO public.service_ticket_history
        (service_ticket_id, event_type, from_status, to_status, note, changed_by_employee_id)
       VALUES ($1, 'created', NULL, $2, $3, $4);`,
      [ticket.service_ticket_id, status, historyNote, employee.employeeId]
    );
    await client.query(
      `INSERT INTO public.audit_logs
        (employee_id, actor_name, action, entity_type, entity_id, field_name, old_value, new_value, reason, occurred_at)
       VALUES ($1, $2, 'Created service ticket', 'service_ticket', $3, 'status', NULL, $4, $5, CURRENT_TIMESTAMP);`,
      [employee.employeeId, `${employee.firstName} ${employee.lastName}`, String(ticket.service_ticket_id), status, issueSummary]
    );

    await client.query("COMMIT");
    res.status(201).json({ ticket });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Could not create service ticket:", error);
    res.status(500).json({ error: "Could not create service ticket." });
  } finally {
    client.release();
  }
});

serviceTicketsRouter.patch(
  "/service-tickets/:ticketId",
  requireAuth,
  async (req, res) => {
    const ticketId = parsePositiveId(req.params.ticketId);
    if (ticketId === null) return res.status(400).json({ error: "Invalid ticket ID." });
    const employee = req.session.employee!;
    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      // Lock before reading so concurrent technician updates cannot overwrite
      // one another using stale ticket state.
      const currentResult = await client.query(
        `SELECT * FROM public.service_tickets WHERE service_ticket_id = $1 FOR UPDATE;`,
        [ticketId]
      );
      const current = currentResult.rows[0];
      if (!current) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Service ticket not found." });
      }

      const issueSummary = cleanText(req.body.issueSummary) || current.issue_summary;
      const description = req.body.description === undefined ? current.description ?? "" : cleanText(req.body.description);
      const priority = (cleanText(req.body.priority) || current.priority) as TicketPriority;
      let status = (cleanText(req.body.status) || current.status) as TicketStatus;
      const assigneeWasProvided = req.body.assignedEmployeeId !== undefined;
      const assigneeText = String(req.body.assignedEmployeeId ?? "").trim();
      const assignedEmployeeId = assigneeWasProvided
        ? (assigneeText ? parsePositiveId(assigneeText) : null)
        : current.assigned_employee_id;
      const poleBoxNumber = req.body.poleBoxNumber === undefined ? current.pole_box_number ?? "" : cleanText(req.body.poleBoxNumber);
      const portNumber = req.body.portNumber === undefined ? current.port_number ?? "" : cleanText(req.body.portNumber);
      const serviceDate = req.body.serviceDate === undefined ? current.service_date?.toISOString?.().slice(0, 10) ?? current.service_date ?? "" : cleanText(req.body.serviceDate);
      const resolutionNotes = req.body.resolutionNotes === undefined ? current.resolution_notes ?? "" : cleanText(req.body.resolutionNotes);
      const updateNote = cleanText(req.body.updateNote);

      if (!ticketStatuses.includes(status)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Choose a valid status." });
      }
      if (!ticketPriorities.includes(priority)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Choose a valid priority." });
      }
      if (issueSummary.length < 3 || issueSummary.length > 160) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Problem summary must be 3–160 characters." });
      }
      if (description.length > 2000 || resolutionNotes.length > 4000 || updateNote.length > 1000) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "One or more notes are too long." });
      }
      if (!validDate(String(serviceDate))) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Choose a valid service date." });
      }
      if (assigneeWasProvided && assigneeText && assignedEmployeeId === null) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Choose a valid technician." });
      }
      // The ticket's existing assignee is passed so that a ticket assigned to
      // a non-technician before this rule existed can still be edited without
      // being blocked on a choice the user is not making now.
      if (!(await validateAssignee(client, assignedEmployeeId, current.assigned_employee_id))) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Selected technician is unavailable." });
      }

      // Assigning an open ticket moves it into Assigned unless the user chose a
      // different explicit status in the same update.
      if (!req.body.status && current.status === "open" && assignedEmployeeId) status = "assigned";
      if (status === "assigned" && !assignedEmployeeId) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Assigned tickets need a technician." });
      }
      if (status === "completed" && (!serviceDate || resolutionNotes.length < 3)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Completed tickets need a service date and resolution notes." });
      }

      const updatedResult = await client.query(
        `
        UPDATE public.service_tickets SET
          issue_summary = $1,
          description = NULLIF($2, ''),
          priority = $3,
          status = $4,
          assigned_employee_id = $5,
          pole_box_number = NULLIF($6, ''),
          port_number = NULLIF($7, ''),
          service_date = NULLIF($8, '')::DATE,
          resolution_notes = NULLIF($9, ''),
          completed_at = CASE WHEN $4 = 'completed' THEN COALESCE(completed_at, CURRENT_TIMESTAMP) ELSE NULL END,
          updated_by_employee_id = $10,
          updated_at = CURRENT_TIMESTAMP
        WHERE service_ticket_id = $11
        RETURNING *;
        `,
        [issueSummary, description, priority, status, assignedEmployeeId, poleBoxNumber, portNumber, serviceDate, resolutionNotes, employee.employeeId, ticketId]
      );

      const statusChanged = status !== current.status;
      const historyNote = updateNote || (status === "completed" ? resolutionNotes : `Ticket updated by ${employee.firstName} ${employee.lastName}`);
      await client.query(
        `INSERT INTO public.service_ticket_history
          (service_ticket_id, event_type, from_status, to_status, note, changed_by_employee_id)
         VALUES ($1, $2, $3, $4, $5, $6);`,
        [ticketId, statusChanged ? "status_changed" : "updated", current.status, status, historyNote, employee.employeeId]
      );
      await client.query(
        `INSERT INTO public.audit_logs
          (employee_id, actor_name, action, entity_type, entity_id, field_name, old_value, new_value, reason, occurred_at)
         VALUES ($1, $2, $3, 'service_ticket', $4, 'status', $5, $6, $7, CURRENT_TIMESTAMP);`,
        [employee.employeeId, `${employee.firstName} ${employee.lastName}`, statusChanged ? "Changed service ticket status" : "Updated service ticket", String(ticketId), current.status, status, historyNote]
      );

      await client.query("COMMIT");
      res.json({ ticket: updatedResult.rows[0] });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Could not update service ticket:", error);
      res.status(500).json({ error: "Could not update service ticket." });
    } finally {
      client.release();
    }
  }
);

export default serviceTicketsRouter;
