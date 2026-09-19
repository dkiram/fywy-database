/** Implements service-ticket search, assignment, updates, history, and audit logging. */
import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import type { PoolClient } from "pg";
import { pool } from "../db.js";
import { parseAppointment, formatAppointment, APPOINTMENT_ERROR } from "../appointments.js";

// MVP 4 service-ticket workflow. Tickets are current work records, while the
// reports router only summarizes/filter records created here.
const serviceTicketsRouter = Router();

const ticketStatuses = [
  "open",
  "assigned",
  "in_progress",
  "completed",
  // A visit that happened but produced no fix: nobody home, no answer on the
  // phone, gate locked. Closed like completed and cancelled, but it means the
  // job still has to be rescheduled, which is why the attention view keeps it.
  "unresolved",
  "cancelled",
] as const;
type TicketStatus = (typeof ticketStatuses)[number];

/**
 * Repairs belong to a customer; installations belong to an applicant who is
 * not a customer yet (migration 079). Same rail, same queue on the phone,
 * separate caps - they are different days' work drawn from different lists.
 */
const jobTypes = ["repair", "installation"] as const;
export type JobType = (typeof jobTypes)[number];

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
 * Where a technician stands against the job cap (migrations 076 and 077).
 *
 * The cap is a latch, not a ceiling: once somebody is holding a full load,
 * nothing more is added until they are holding none. Finishing three of ten
 * frees nothing. `field_queue_locked_at` is what tells a batch still being filled
 * (one to six open, latch clear) from one being worked through (one to six
 * open, latch set) - the two look identical from a count alone, which is why
 * the state is stored rather than recomputed here.
 *
 * The limit comes from the database function so this and the trigger that
 * maintains the latch cannot disagree about where the cap sits.
 */
export async function readTechnicianQueue(
  client: PoolClient,
  employeeId: number,
  jobType: JobType
) {
  const result = await client.query(
    `
    SELECT
      public.technician_queue_limit() AS job_limit,
      CONCAT_WS(' ', e.first_name, e.last_name) AS name,
      EXISTS (
        SELECT 1 FROM public.technician_queue_state s
        WHERE s.employee_id = e.employee_id AND s.job_type = $2
      ) AS gate_shut,
      (
        SELECT COUNT(*)::INTEGER
        FROM public.service_tickets t
        WHERE t.assigned_employee_id = e.employee_id
          AND t.job_type = $2
          AND t.status IN ('assigned', 'in_progress')
      ) AS open_jobs
    FROM public.employees e
    WHERE e.employee_id = $1;
    `,
    [employeeId, jobType]
  );

  const row = result.rows[0];
  if (!row) return null;

  const openJobs = Number(row.open_jobs);
  const jobLimit = Number(row.job_limit);

  return {
    name: row.name as string,
    jobType,
    openJobs,
    jobLimit,
    canTakeWork: row.gate_shut === false && openJobs < jobLimit,
  };
}

/**
 * Says why the queue is closed, in terms of what the office has to do about
 * it - including the one thing that gets through it.
 *
 * Naming the urgent route in the refusal matters. Without it the only visible
 * options are "wait" and "give it to somebody else", and a fault that really
 * cannot wait ends up being forced through by inventing a spare technician or
 * by closing somebody's jobs early to unlock them.
 */
export function queueFullMessage(queue: {
  name: string;
  jobType: JobType;
  openJobs: number;
  jobLimit: number;
}) {
  // Named, because the two gates are separate: being told "Andre already has
  // ten jobs" while looking at an empty installation queue would read as a
  // bug rather than as the repair queue being full.
  const kind = queue.jobType === "installation" ? "installations" : "repairs";

  const standing =
    queue.openJobs >= queue.jobLimit
      ? `${queue.name} already has ${queue.jobLimit} ${kind}.`
      : `${queue.name} still has ${queue.openJobs} of ${queue.jobLimit} ${kind} to finish.`;

  return (
    `${standing} The next batch goes out once that queue is clear. ` +
    `If this one cannot wait, set it to Urgent and it goes through anyway.`
  );
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
  async (req, res) => {
    // Which queue the caller is filling. The applications page asks about
    // installations, the tickets page about repairs, and a technician full of
    // one is still free for the other.
    const jobType: JobType =
      cleanText(req.query.jobType) === "installation" ? "installation" : "repair";

    try {
      // Each technician's load comes down with the list. Without it the
      // dropdown offers names the server is about to refuse, and whoever is
      // assigning finds out only after choosing.
      const result = await pool.query(`
        SELECT
          e.employee_id,
          e.first_name,
          e.last_name,
          e.role,
          EXISTS (
            SELECT 1 FROM public.technician_queue_state s
            WHERE s.employee_id = e.employee_id AND s.job_type = $1
          ) AS gate_shut,
          (
            SELECT COUNT(*)::INTEGER
            FROM public.service_tickets t
            WHERE t.assigned_employee_id = e.employee_id
              AND t.job_type = $1
              AND t.status IN ('assigned', 'in_progress')
          ) AS open_jobs,
          public.technician_queue_limit() AS job_limit
        FROM public.employees e
        WHERE e.is_active = TRUE
          AND e.role = 'technician'
        ORDER BY e.last_name, e.first_name;
      `, [jobType]);

      res.json({
        jobType,
        employees: result.rows.map((row) => ({
          ...row,
          can_take_work:
            row.gate_shut === false &&
            Number(row.open_jobs) < Number(row.job_limit),
        })),
      });
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

  // One day. What it asks depends on the view beside it: the chip picks the
  // status, the date asks when a ticket moved INTO that status. So Open plus a
  // date is "what came in that day", Assigned is "what we dispatched", and
  // Completed is "what we finished".
  const onDate = cleanText(req.query.onDate);

  // This screen is the repair queue. Installations live on the same rail but
  // belong to the applications page, and letting them wash into here would
  // put applicants who have no customer record into a list built around
  // customers - which is the clutter this was meant to avoid.
  const listJobType = cleanText(req.query.jobType) || "repair";

  if (!validDate(onDate)) {
    return res.status(400).json({ error: "Choose a valid date." });
  }

  const viewClauses: Record<string, string> = {
    // Jobs a technician has agreed a time for (migration 080). Not a status:
    // the ticket is still 'assigned' and still theirs, it just has an
    // appointment on it. Starting or finishing the job clears the time and
    // takes it off this tab.
    //
    // This took the slot Needs Attention used to have. That view was the four
    // active statuses rolled together, and with a chip per status and a
    // Rescheduled tab beside them it had stopped answering a question the
    // others could not.
    rescheduled: "t.status = 'assigned' AND t.rescheduled_for IS NOT NULL",
    open: "t.status = 'open'",
    assigned: "t.status = 'assigned'",
    in_progress: "t.status = 'in_progress'",
    completed: "t.status = 'completed'",
    unresolved: "t.status = 'unresolved'",
    cancelled: "t.status = 'cancelled'",
    all: "TRUE",
  };
  // The statuses each view's date looks for a move INTO. Keyed by the same
  // names as viewClauses above so a chip and its date can never drift apart,
  // and read with Object.hasOwn so that a view of "__proto__" arriving in the
  // query string resolves to the default instead of to Object.prototype.
  //
  // Needs Attention is not excluded. It names four statuses instead of one,
  // but "which tickets landed in the attention pile that day" is a question
  // with an answer, and giving one chip no date filter when every other chip
  // has one is harder to explain than just answering it.
  const viewTransitionStatuses: Record<string, string[]> = {
    // A reschedule is not a status move, so the date on this chip means
    // something different from every other: not "when did it get here" but
    // "what is booked for that day". Handled below, where the date clause is
    // built; the entry here only keeps the chip a valid view name.
    rescheduled: [],
    open: ["open"],
    assigned: ["assigned"],
    in_progress: ["in_progress"],
    completed: ["completed"],
    unresolved: ["unresolved"],
    cancelled: ["cancelled"],
    all: ["open", "assigned", "in_progress", "completed", "unresolved", "cancelled"],
  };
  // Open is the default now that Needs Attention is gone: it is the pile the
  // office has to act on, since anything assigned is already on a phone.
  const safeView = Object.hasOwn(viewTransitionStatuses, view) ? view : "open";
  const viewClause = viewClauses[safeView] ?? viewClauses.open;
  // Built from the map above, never from the request, so no status name
  // reaches the SQL as text from the query string.
  const transitionList = viewTransitionStatuses[safeView]
    .map((status) => `'${status}'`)
    .join(", ");
  const limit = 10;

  try {
    const params = [search, searchPattern, customerId, onDate];
    const whereSql = `
      WHERE ${onDate && safeView !== "rescheduled" ? "TRUE" : viewClause}
        ${listJobType === "all" ? "" : `AND t.job_type = '${listJobType === "installation" ? "installation" : "repair"}'`}
        AND ($3::INTEGER IS NULL OR t.customer_id = $3)
        -- The day a ticket moved into the status the chip names, read from the
        -- history rather than from the ticket, because the ticket cannot
        -- answer it. A ticket carries only where it is now, not when it got
        -- there: completed_at is set only for 'completed' and is NULL for
        -- cancelled and unresolved, service_date is often NULL on an
        -- unresolved job since nobody got through the gate, and updated_at
        -- moves every time anyone edits a note months later.
        -- service_ticket_history is append-only and records the moment each
        -- status was actually set.
        --
        -- from_status IS DISTINCT FROM to_status is what separates a real
        -- move from a note. Adding a note without changing the status still
        -- writes a history row, and that row carries the status the ticket
        -- already had - so without this test, a note typed on a job in
        -- December would read as a job completed in December, which is the
        -- exact drift that ruled updated_at out above. IS DISTINCT FROM
        -- rather than <> so that a 'created' row, whose from_status is NULL,
        -- still counts as the ticket arriving in its first status.
        --
        -- When a date is set the view clause above is dropped for TRUE and
        -- this takes over the filtering, because the two ask about different
        -- moments. The chip alone means "where is it now"; the chip with a
        -- date means "when did it get there", and a ticket assigned on Tuesday
        -- is still the answer to "what did we dispatch Tuesday" after the
        -- technician starts it on Wednesday and it stops being 'assigned'.
        --
        -- Jamaica time, not UTC: a job closed at 7pm on the 5th is closed on
        -- the 5th to the person who closed it, and would otherwise be found
        -- under the 6th.
        AND (
          NULLIF($4, '')::DATE IS NULL
          ${
            safeView === "rescheduled"
              // The Rescheduled chip's date is the appointment itself: "what
              // is booked for Tuesday", which is the question the office
              // actually asks of this tab. Every other chip's date is a move
              // in the history, and a reschedule is not a move.
              ? `OR (t.rescheduled_for AT TIME ZONE 'America/Jamaica')::DATE
                    = NULLIF($4, '')::DATE`
              : `OR EXISTS (
            SELECT 1
            FROM public.service_ticket_history h
            WHERE h.service_ticket_id = t.service_ticket_id
              AND h.to_status IN (${transitionList})
              AND h.from_status IS DISTINCT FROM h.to_status
              AND (h.changed_at AT TIME ZONE 'America/Jamaica')::DATE
                  = NULLIF($4, '')::DATE
          )`
          }
        )
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
          t.rescheduled_for,
          t.updated_at
        FROM public.service_tickets t
        LEFT JOIN public.customers c ON c.customer_id = t.customer_id
        LEFT JOIN public.employees assignee
          ON assignee.employee_id = t.assigned_employee_id
        ${whereSql}
        ORDER BY
          ${
            // Soonest appointment first on the Rescheduled tab. Priority is
            // the wrong order for a list of agreed times: the nine o'clock is
            // the nine o'clock whether the fault is urgent or not.
            safeView === "rescheduled" ? "t.rescheduled_for ASC," : ""
          }
          CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
          t.reported_date ASC,
          t.service_ticket_id ASC
        LIMIT $5 OFFSET $6;
        `,
        [...params, limit, offset]
      ),
      pool.query(
        `
        SELECT
          COUNT(*) FILTER (WHERE status = 'assigned' AND rescheduled_for IS NOT NULL)::INTEGER AS rescheduled,
          COUNT(*) FILTER (WHERE status = 'open')::INTEGER AS open,
          COUNT(*) FILTER (WHERE status = 'assigned')::INTEGER AS assigned,
          COUNT(*) FILTER (WHERE status = 'in_progress')::INTEGER AS in_progress,
          COUNT(*) FILTER (WHERE status = 'completed')::INTEGER AS completed,
          COUNT(*) FILTER (WHERE status = 'unresolved')::INTEGER AS unresolved
        FROM public.service_tickets
        WHERE ($1::INTEGER IS NULL OR customer_id = $1)
          ${listJobType === "all" ? "" : `AND job_type = '${listJobType === "installation" ? "installation" : "repair"}'`};
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
          --
          -- The history needs the same care, for the same reason. A note added
          -- to an already-completed ticket writes a row whose to_status is
          -- still 'completed', and being the newest such row it would win this
          -- ORDER BY - crediting the completion to whoever last edited a note,
          -- which is precisely what reading the ticket was avoiding. Only a
          -- row that actually changed the status is a completion.
          (
            SELECT CONCAT_WS(' ', e.first_name, e.last_name)
            FROM public.service_ticket_history h
            LEFT JOIN public.employees e ON e.employee_id = h.changed_by_employee_id
            WHERE h.service_ticket_id = t.service_ticket_id
              AND h.to_status = 'completed'
              AND h.from_status IS DISTINCT FROM h.to_status
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

    // The job-cap latch (migrations 076 and 077). Checked inside the
    // transaction so two people assigning at once cannot both find room in
    // the same last slot.
    //
    // Urgent goes through regardless, and there is no limit on how many -
    // the cap exists to stop work being trickled at somebody all day, and a
    // genuine emergency is not that. An urgent job lands on top of a full
    // load rather than replacing one, and the latch stays shut behind it, so
    // the exception cannot be used to keep feeding them ordinary work.
    if (assignedEmployeeId !== null && priority !== "urgent") {
      // This screen only ever raises repairs; an installation is dispatched
      // from the applications router against its own separate cap.
      const queue = await readTechnicianQueue(client, assignedEmployeeId, "repair");

      if (queue && !queue.canTakeWork) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: queueFullMessage(queue) });
      }
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

      // The office rescheduling on the customer's behalf - they rang the desk
      // instead of the technician. Same rules as the phone (migration 080):
      // it is a time on an assigned ticket, not a status of its own, so the
      // job stays on the technician's list and inside their cap.
      const rescheduleRequested =
        req.body.rescheduledFor !== undefined && req.body.rescheduledFor !== null && req.body.rescheduledFor !== "";
      const rescheduledFor = rescheduleRequested ? parseAppointment(req.body.rescheduledFor) : null;

      if (rescheduleRequested && rescheduledFor === null) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: APPOINTMENT_ERROR });
      }
      // A rescheduled job is by definition assigned to somebody who will go.
      if (rescheduleRequested) status = "assigned";

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

      // The cap applies to handing somebody NEW work, not to editing a ticket
      // they already hold. Checking on every save would make a full
      // technician's tickets uneditable - the office could not correct an
      // address or raise a priority on the very jobs it is waiting to see
      // finished.
      const assigneeChanged =
        assignedEmployeeId !== null &&
        Number(assignedEmployeeId) !== Number(current.assigned_employee_id ?? -1);

      // `priority` here is what the ticket will be AFTER this save, not what
      // it was, so raising a queued job to Urgent and assigning it in the same
      // edit is one action rather than two.
      if (assigneeChanged && priority !== "urgent") {
        const queue = await readTechnicianQueue(
          client, assignedEmployeeId, current.job_type as JobType
        );

        if (queue && !queue.canTakeWork) {
          await client.query("ROLLBACK");
          return res.status(409).json({ error: queueFullMessage(queue) });
        }
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
      // Unresolved asks for the reason but not a date: a technician who never
      // got through the gate has no "work performed on" to record, and the
      // database agrees (migration 074).
      if (status === "unresolved" && resolutionNotes.length < 3) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Unresolved tickets need a note saying what happened." });
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
          -- An appointment only means something while the job is waiting for
          -- it. Any change of status from here clears it, same as from the
          -- phone, so a job the office re-opens does not come back carrying
          -- one from a previous life.
          rescheduled_for = CASE
            WHEN $12::TIMESTAMPTZ IS NOT NULL THEN $12::TIMESTAMPTZ
            WHEN $4 <> status THEN NULL
            ELSE rescheduled_for
          END,
          updated_by_employee_id = $10,
          updated_at = CURRENT_TIMESTAMP
        WHERE service_ticket_id = $11
        RETURNING *;
        `,
        [issueSummary, description, priority, status, assignedEmployeeId, poleBoxNumber, portNumber, serviceDate, resolutionNotes, employee.employeeId, ticketId, rescheduledFor]
      );

      const statusChanged = status !== current.status;
      const historyNote = rescheduledFor
        ? `Rescheduled for ${formatAppointment(rescheduledFor)} by the office` + (updateNote ? ` — ${updateNote}` : "")
        : updateNote || (status === "completed" ? resolutionNotes : `Ticket updated by ${employee.firstName} ${employee.lastName}`);
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
