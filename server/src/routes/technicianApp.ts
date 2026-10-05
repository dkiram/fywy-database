/** Serves the standalone technician phone app: passcode sign-in, job queue, and field updates. */
import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import bcrypt from "bcrypt";
import { pool } from "../db.js";
import {
  checkLoginAllowed,
  recordFailedLogin,
  clearFailedLogins,
} from "../loginThrottle.js";
import { parseAppointment, formatAppointment, APPOINTMENT_ERROR } from "../appointments.js";

/**
 * Everything a technician's phone can reach, and nothing else.
 *
 * The whole router is mounted under /api/tech and every route below asks for
 * `req.session.technician`, which the staff login never sets. A technician
 * session therefore cannot read a customer search, a payment, or the OLT —
 * not because those routes check a role, but because they ask for a
 * different identity entirely. See express-session.d.ts.
 */
const technicianAppRouter = Router();

/**
 * How long a phone stays signed in without being used.
 *
 * Far longer than the hour staff get, and for the opposite reason: a counter
 * machine sits in a branch where anyone can walk up to it, while a phone is
 * in one person's pocket behind their own screen lock. A technician who has
 * to re-enter a passcode at the start of every job stops using the app and
 * goes back to phoning the office, so the idle window has to outlast a
 * holiday, not a shift.
 */
const TECHNICIAN_SESSION_DAYS = (() => {
  const configured = Number.parseInt(
    process.env.TECHNICIAN_SESSION_DAYS ?? "",
    10
  );

  if (Number.isFinite(configured) && configured >= 1 && configured <= 180) {
    return configured;
  }

  if (process.env.TECHNICIAN_SESSION_DAYS) {
    console.warn(
      `TECHNICIAN_SESSION_DAYS is "${process.env.TECHNICIAN_SESSION_DAYS}", ` +
        `which is not a number of days between 1 and 180. Falling back to 30.`
    );
  }

  return 30;
})();

/** Failed passcode attempts before the credential itself locks. */
const PASSCODE_MAX_ATTEMPTS = 5;

/** How long a locked credential stays locked. */
const PASSCODE_LOCK_MINUTES = 15;

/**
 * How many finished jobs the phone gets back.
 *
 * The Finished tab answers "did that one save?" and "what did I write on the
 * Barrett job", both of which are about the last few hours. A technician's
 * whole history is neither useful on a phone nor free: every row carries the
 * customer, the address and up to five history notes, fetched again on every
 * refresh over whatever signal exists at the side of a road.
 *
 * A fixed count rather than a time window, so somebody back from leave still
 * sees their last fifteen instead of an empty tab.
 */
const FINISHED_JOBS_SHOWN = 15;

/**
 * Identifies this deploy to the phones.
 *
 * A home-screen web app on iOS does not reload when reopened; it restores the
 * page it had, and keeps running whatever build it loaded last week. Nothing
 * in the browser tells it a deploy happened. So the API tells it: this value
 * goes down with every queue refresh, the phone remembers the first one it
 * saw, and reloads itself the first time a different one arrives.
 *
 * The process start time is a good enough marker because the API restarts on
 * every deploy, in the same compose restart that swaps the client build in.
 * It is not a version and does not pretend to be one - it only has to differ
 * from the last one.
 */
const DEPLOY_MARK = String(Date.now());

/** Statuses a technician is allowed to move a job into from the phone. */
const technicianStatuses = ["in_progress", "completed", "unresolved"] as const;
type TechnicianStatus = (typeof technicianStatuses)[number];

/**
 * Statuses a job can be in for the phone to still change it.
 *
 * 'unresolved' is here so a technician who tapped the wrong button — or who
 * got through on a second try ten minutes later — can carry on with the job
 * instead of phoning the office to have it reopened. 'completed' is not:
 * once work is signed off, correcting it is an office decision with an
 * audit trail behind it.
 */
const editableStatuses = ["assigned", "in_progress", "unresolved"];

function requireTechnician(req: Request, res: Response, next: NextFunction) {
  if (!req.session.technician) {
    return res.status(401).json({ error: "Not signed in." });
  }
  next();
}

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function parsePositiveId(value: unknown) {
  const text = String(value ?? "").trim();
  return /^\d+$/.test(text) && Number(text) > 0 ? Number(text) : null;
}

/**
 * Normalises a login code as it was typed.
 *
 * Phone keyboards add spaces, autocapitalise inconsistently, and a code read
 * off a printed card often arrives with the dash somebody wrote in to make it
 * legible. None of that is a wrong code.
 */
function normaliseLoginCode(value: unknown) {
  return String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

/** Best-effort login history, mirroring how the staff login records its own. */
async function recordPhoneLoginFailure(
  loginCode: string,
  reason:
    | "unknown_username"
    | "wrong_password"
    | "inactive_account"
    | "rate_limited"
    | "access_revoked"
    | "access_locked",
  employeeId: number | null = null,
  actorName: string | null = null
) {
  try {
    await pool.query(
      `INSERT INTO public.login_sessions
         (employee_id, username_attempted, actor_name, outcome, failure_reason)
       VALUES ($1, $2, $3, 'failed', $4);`,
      [employeeId, loginCode.slice(0, 100) || "(blank)", actorName, reason]
    );
  } catch (error) {
    console.error("Could not record technician login failure:", error);
  }
}

async function recordPhoneLoginSuccess(
  employeeId: number,
  loginCode: string,
  actorName: string,
  sessionId: string
): Promise<number | null> {
  try {
    const result = await pool.query(
      `INSERT INTO public.login_sessions
         (employee_id, username_attempted, actor_name, outcome, session_sid, last_seen_at)
       VALUES ($1, $2, $3, 'success', $4, CURRENT_TIMESTAMP)
       RETURNING login_session_id;`,
      [employeeId, loginCode, actorName, sessionId]
    );
    return result.rows[0]?.login_session_id ?? null;
  } catch (error) {
    console.error("Could not record technician login:", error);
    return null;
  }
}

technicianAppRouter.post("/tech/login", async (req, res) => {
  const loginCode = normaliseLoginCode(req.body?.loginCode);
  const passcode = String(req.body?.passcode ?? "");

  if (!loginCode || !passcode) {
    return res
      .status(400)
      .json({ error: "Enter your technician code and passcode." });
  }

  // The same generic message for every failure below. A technician who typos
  // learns nothing they need, and neither does anyone working through codes.
  const rejection = "That technician code or passcode is not right.";

  try {
    // The in-memory throttle runs first, before the database and before
    // bcrypt, exactly as the staff login does.
    const throttle = checkLoginAllowed(`tech:${loginCode}`, req.ip);

    if (!throttle.allowed) {
      res.setHeader("Retry-After", String(throttle.retryAfterSeconds));
      await recordPhoneLoginFailure(loginCode, "rate_limited");
      return res.status(429).json({
        error: throttle.message,
        retryAfterSeconds: throttle.retryAfterSeconds,
      });
    }

    const result = await pool.query(
      `
      SELECT
        a.employee_id,
        a.login_code,
        a.passcode_hash,
        a.failed_attempts,
        a.locked_until,
        a.revoked_at,
        e.first_name,
        e.last_name,
        e.is_active
      FROM public.technician_phone_access a
      JOIN public.employees e ON e.employee_id = a.employee_id
      WHERE a.login_code = $1
      -- The unique index on login_code covers live credentials only, so a code
      -- reissued to a second technician after the first left can legitimately
      -- appear twice: once live, once revoked. Prefer the live row, but still
      -- return a revoked one when that is all there is, so the sign-in can say
      -- "revoked" rather than "no such code".
      ORDER BY (a.revoked_at IS NULL) DESC
      LIMIT 1;
      `,
      [loginCode]
    );

    const access = result.rows[0];

    if (!access) {
      recordFailedLogin(`tech:${loginCode}`, req.ip);
      await recordPhoneLoginFailure(loginCode, "unknown_username");
      return res.status(401).json({ error: rejection });
    }

    const fullName = `${access.first_name} ${access.last_name}`;

    if (access.revoked_at) {
      await recordPhoneLoginFailure(
        loginCode,
        "access_revoked",
        access.employee_id,
        fullName
      );
      return res.status(401).json({ error: rejection });
    }

    if (!access.is_active) {
      await recordPhoneLoginFailure(
        loginCode,
        "inactive_account",
        access.employee_id,
        fullName
      );
      return res.status(403).json({
        error: "This technician is no longer active. Contact the office.",
      });
    }

    // The database-backed lock, which unlike the in-memory throttle survives a
    // container restart. A six-digit passcode is short enough to be worth
    // guessing at, so this is the counter that actually has to hold.
    if (access.locked_until && new Date(access.locked_until) > new Date()) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil(
          (new Date(access.locked_until).getTime() - Date.now()) / 1000
        )
      );
      res.setHeader("Retry-After", String(retryAfterSeconds));
      await recordPhoneLoginFailure(
        loginCode,
        "access_locked",
        access.employee_id,
        fullName
      );
      return res.status(429).json({
        error:
          "Too many wrong passcodes. Wait a few minutes, or call the office " +
          "for a new one.",
        retryAfterSeconds,
      });
    }

    const passcodeMatches = await bcrypt.compare(
      passcode,
      access.passcode_hash
    );

    if (!passcodeMatches) {
      recordFailedLogin(`tech:${loginCode}`, req.ip);

      // Counted on the row, and locked once the count is reached. Written
      // even if the response below never reaches the phone.
      await pool.query(
        `
        UPDATE public.technician_phone_access
        SET failed_attempts = failed_attempts + 1,
            locked_until = CASE
              WHEN failed_attempts + 1 >= $2
                THEN CURRENT_TIMESTAMP + ($3 || ' minutes')::INTERVAL
              ELSE locked_until
            END
        WHERE employee_id = $1;
        `,
        [access.employee_id, PASSCODE_MAX_ATTEMPTS, String(PASSCODE_LOCK_MINUTES)]
      );

      await recordPhoneLoginFailure(
        loginCode,
        "wrong_password",
        access.employee_id,
        fullName
      );
      return res.status(401).json({ error: rejection });
    }

    clearFailedLogins(`tech:${loginCode}`);

    await pool.query(
      `
      UPDATE public.technician_phone_access
      SET failed_attempts = 0, locked_until = NULL,
          last_used_at = CURRENT_TIMESTAMP
      WHERE employee_id = $1;
      `,
      [access.employee_id]
    );

    // A phone that signs in must not inherit a staff identity left on the
    // same session, and vice versa. Only one of the two ever exists.
    delete req.session.employee;

    req.session.technician = {
      employeeId: Number(access.employee_id),
      firstName: access.first_name,
      lastName: access.last_name,
      loginCode: access.login_code,
    };

    // Per-session override of the one-hour staff cookie. `rolling` in the
    // session middleware keeps pushing this forward on every request, so the
    // app stays signed in as long as it is being used.
    req.session.cookie.maxAge =
      1000 * 60 * 60 * 24 * TECHNICIAN_SESSION_DAYS;

    req.session.loginSessionId = await recordPhoneLoginSuccess(
      Number(access.employee_id),
      access.login_code,
      fullName,
      req.sessionID
    );
    req.session.lastSeenWrittenAt = Date.now();

    res.json({ technician: req.session.technician });
  } catch (error) {
    console.error("Technician sign-in failed:", error);
    res.status(500).json({ error: "Could not sign in." });
  }
});

technicianAppRouter.get("/tech/me", requireTechnician, (req, res) => {
  res.json({ technician: req.session.technician });
});

technicianAppRouter.post("/tech/logout", async (req, res) => {
  const loginSessionId = req.session?.loginSessionId;

  if (loginSessionId) {
    try {
      await pool.query(
        `UPDATE public.login_sessions
         SET ended_at = CURRENT_TIMESTAMP, end_reason = 'logout',
             last_seen_at = CURRENT_TIMESTAMP
         WHERE login_session_id = $1 AND ended_at IS NULL;`,
        [loginSessionId]
      );
    } catch (error) {
      console.error("Could not close technician login session:", error);
    }
  }

  req.session.destroy((error) => {
    if (error) {
      console.error("Technician sign-out failed:", error);
      return res.status(500).json({ error: "Could not sign out." });
    }

    res.clearCookie(process.env.SESSION_COOKIE_NAME || "spcl.sid");
    res.json({ message: "Signed out." });
  });
});

/**
 * The queue, plus what was closed recently.
 *
 * Both lists carry the customer's name, address and telephone, because the
 * whole point of the card is that a technician can read where they are going
 * and ring ahead without opening anything. The last few history notes come
 * down with them so tapping a card to expand it is instant rather than
 * another request over a phone connection at the side of a road.
 */
technicianAppRouter.get("/tech/jobs", requireTechnician, async (req, res) => {
  const technician = req.session.technician!;

  const selectJob = `
    SELECT
      t.service_ticket_id,
      t.issue_summary,
      t.description,
      t.priority,
      t.status,
      t.reported_date,
      t.pole_box_number,
      t.port_number,
      t.service_date,
      t.resolution_notes,
      t.updated_at,
      t.rescheduled_for,
      t.job_type,
      t.application_id,
      c.customer_id,
      -- An installation has no customer yet: the person waiting at the
      -- address is an applicant. Resolving all three from whichever side
      -- exists means the card, and every line of the phone app that reads
      -- it, stays identical for both kinds of job.
      COALESCE(c.name, a.name) AS customer_name,
      COALESCE(c.address, a.address) AS address,
      COALESCE(c.telephone, a.telephone) AS telephone,
      -- What the applicant signed up for, so the technician knows what they
      -- are installing - and what to put in the van - before they leave.
      -- Installations only: a repair customer's plan says nothing about the
      -- fault, and would just be noise on the card.
      ap.name AS package_name,
      a.additional_box,
      COALESCE(notes.entries, '[]'::JSON) AS recent_notes
    FROM public.service_tickets t
    LEFT JOIN public.customers c ON c.customer_id = t.customer_id
    LEFT JOIN public.applications a ON a.application_id = t.application_id
    LEFT JOIN public.packages ap ON ap.package_id = a.package_id
    LEFT JOIN LATERAL (
      SELECT JSON_AGG(
               recent.entry ORDER BY recent.changed_at DESC, recent.history_id DESC
             ) AS entries
      FROM (
        SELECT
          h.changed_at,
          h.service_ticket_history_id AS history_id,
          JSON_BUILD_OBJECT(
            'note', h.note,
            'to_status', h.to_status,
            'changed_at', h.changed_at,
            'changed_by', CONCAT_WS(' ', e.first_name, e.last_name)
          ) AS entry
        FROM public.service_ticket_history h
        LEFT JOIN public.employees e ON e.employee_id = h.changed_by_employee_id
        WHERE h.service_ticket_id = t.service_ticket_id
        ORDER BY h.changed_at DESC, h.service_ticket_history_id DESC
        LIMIT 5
      ) AS recent
    ) AS notes ON TRUE
  `;

  try {
    const [activeResult, recentResult] = await Promise.all([
      pool.query(
        `
        ${selectJob}
        WHERE t.assigned_employee_id = $1
          AND t.status IN ('assigned', 'in_progress')
        ORDER BY
          -- In-progress work floats to the top: it is the job the technician
          -- is standing in front of right now.
          CASE t.status WHEN 'in_progress' THEN 0 ELSE 1 END,
          CASE t.priority
            WHEN 'urgent' THEN 0 WHEN 'high' THEN 1
            WHEN 'normal' THEN 2 ELSE 3
          END,
          t.reported_date ASC,
          t.service_ticket_id ASC;
        `,
        [technician.employeeId]
      ),
      pool.query(
        `
        ${selectJob}
        WHERE t.assigned_employee_id = $1
          AND t.status IN ('completed', 'unresolved', 'cancelled')
        ORDER BY t.updated_at DESC
        LIMIT ${FINISHED_JOBS_SHOWN};
        `,
        [technician.employeeId]
      ),
    ]);

    res.json({
      technician,
      jobs: activeResult.rows,
      recent: recentResult.rows,
      // Lets the phone tell "nothing new" from "the request failed" without
      // comparing the whole list.
      fetchedAt: new Date().toISOString(),
      deployMark: DEPLOY_MARK,
    });
  } catch (error) {
    console.error("Could not load technician jobs:", error);
    res.status(500).json({ error: "Could not load your jobs." });
  }
});

/**
 * The one write the phone can make: move a job along, and say what happened.
 *
 * A note on its own is allowed — a technician who is still working wants to
 * leave "waiting on the customer to move a fridge" without pretending the job
 * has changed state.
 */
technicianAppRouter.patch(
  "/tech/jobs/:ticketId",
  requireTechnician,
  async (req, res) => {
    const technician = req.session.technician!;
    const ticketId = parsePositiveId(req.params.ticketId);

    if (ticketId === null) {
      return res.status(400).json({ error: "Invalid job." });
    }

    const requestedStatus = cleanText(req.body?.status);
    const note = cleanText(req.body?.note);

    // "Come back tomorrow at nine." A time, not a status - see migration 080.
    const rescheduleRequested = req.body?.rescheduledFor !== undefined;
    const rescheduledFor = rescheduleRequested
      ? parseAppointment(req.body.rescheduledFor)
      : null;

    if (requestedStatus && !technicianStatuses.includes(requestedStatus as TechnicianStatus)) {
      return res.status(400).json({ error: "That is not a status you can set." });
    }
    if (rescheduleRequested && rescheduledFor === null) {
      return res.status(400).json({ error: APPOINTMENT_ERROR });
    }
    if (rescheduleRequested && requestedStatus) {
      return res.status(400).json({ error: "Reschedule it, or change its status - not both." });
    }

    // "I can't do this one" - out of day, needs a ladder, off sick tomorrow.
    // Sends the job back to the office's Open pile, unassigned (migration 085).
    const handBack = req.body?.handBack === true;
    if (handBack && (requestedStatus || rescheduleRequested)) {
      return res.status(400).json({ error: "Reassign it on its own." });
    }
    if (handBack && note.length < 3) {
      return res.status(400).json({
        error: "Say why it needs reassigning, so the office knows who to send.",
      });
    }

    if (!requestedStatus && !note && !rescheduleRequested && !handBack) {
      return res.status(400).json({ error: "Nothing to save." });
    }
    if (note.length > 1000) {
      return res.status(400).json({ error: "That note is too long." });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      // Locked before reading, so the office editing the same ticket in the
      // staff app cannot have its change silently overwritten by a phone
      // working from a queue that is thirty seconds old.
      const currentResult = await client.query(
        `SELECT * FROM public.service_tickets
         WHERE service_ticket_id = $1 FOR UPDATE;`,
        [ticketId]
      );
      const current = currentResult.rows[0];

      if (!current) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "That job is no longer there." });
      }

      // Ownership, checked against the row rather than against whatever the
      // phone last displayed. A reassigned job disappears from the queue on
      // the next refresh; this is what stops an update landing in between.
      if (Number(current.assigned_employee_id) !== technician.employeeId) {
        await client.query("ROLLBACK");
        return res.status(403).json({
          error: "This job is not assigned to you any more.",
        });
      }

      if (!editableStatuses.includes(current.status)) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error:
            current.status === "completed"
              ? "This job is already signed off. Call the office to reopen it."
              : "The office has closed this job.",
        });
      }

      if (handBack) {
        // Only a job they are actually holding. An unresolved one is already
        // back with the office; handing that back too would say nothing new.
        if (current.status !== "assigned" && current.status !== "in_progress") {
          await client.query("ROLLBACK");
          return res.status(409).json({ error: "This job is already back with the office." });
        }

        // Open and unassigned is where a job waiting for a technician already
        // lives, so the office's Open view, the cap trigger and both phone
        // queries all understand it without being told. Any appointment goes
        // with it: it was agreed by this technician, and whoever the office
        // sends next will agree their own.
        await client.query(
          `UPDATE public.service_tickets SET
             status = 'open',
             assigned_employee_id = NULL,
             rescheduled_for = NULL,
             handed_back_at = CURRENT_TIMESTAMP,
             handed_back_by_employee_id = $1,
             handback_reason = $2,
             updated_by_employee_id = $1,
             updated_at = CURRENT_TIMESTAMP
           WHERE service_ticket_id = $3;`,
          [technician.employeeId, note, ticketId]
        );

        const handbackNote = `Sent back by ${technician.firstName} ${technician.lastName} — ${note}`;

        await client.query(
          `INSERT INTO public.service_ticket_history
            (service_ticket_id, event_type, from_status, to_status, note, changed_by_employee_id)
           VALUES ($1, 'status_changed', $2, 'open', $3, $4);`,
          [ticketId, current.status, handbackNote, technician.employeeId]
        );

        await client.query(
          `INSERT INTO public.audit_logs
            (employee_id, actor_name, action, entity_type, entity_id, field_name, old_value, new_value, reason, occurred_at)
           VALUES ($1, $2, 'Sent a job back to the office', 'service_ticket', $3, 'status', $4, 'open', $5, CURRENT_TIMESTAMP);`,
          [
            technician.employeeId,
            `${technician.firstName} ${technician.lastName}`,
            String(ticketId),
            current.status,
            note,
          ]
        );

        await client.query("COMMIT");
        return res.json({ handedBack: true });
      }

      // Rescheduling from in_progress goes back to assigned: they are not at
      // the address any more, and the phone should show it as waiting for its
      // time rather than as work under way. A rescheduled job otherwise keeps
      // whatever status it has.
      const status = (
        rescheduleRequested ? "assigned" : requestedStatus || current.status
      ) as string;
      const closing = status === "completed" || status === "unresolved";

      if (rescheduleRequested && !editableStatuses.includes(current.status)) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "This job cannot be rescheduled from here." });
      }

      // The database refuses a completed or unresolved ticket without a reason
      // (migrations 025 and 074), so it is checked here, where the resulting
      // status is actually known.
      //
      // Deciding this from `requestedStatus` instead was wrong in one real
      // case: adding a note to a job already marked unresolved sends no
      // status at all, keeps the ticket unresolved, and overwrites the reason
      // with the new note. A two-character note there passed every check
      // above and then failed against the constraint as a 500.
      if (closing && note.length < 3) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error:
            status === "completed"
              ? "Say what you did before marking this done."
              : "Say what happened — nobody home, no answer, gate locked.",
        });
      }

      const updatedResult = await client.query(
        `
        UPDATE public.service_tickets SET
          status = $1,
          -- The note becomes the ticket's own record only when it is the
          -- reason a job ended. A running commentary belongs in the history,
          -- not in the field the office reads as "what happened here".
          resolution_notes = CASE WHEN $2 THEN $3 ELSE resolution_notes END,
          -- Completed work needs a date on it (migration 025 insists), and
          -- the only honest one is the day the technician said so.
          service_date = CASE
            WHEN $1 = 'completed'
              THEN COALESCE(service_date, (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE)
            ELSE service_date
          END,
          completed_at = CASE
            WHEN $1 = 'completed' THEN COALESCE(completed_at, CURRENT_TIMESTAMP)
            ELSE NULL
          END,
          -- Set by a reschedule; cleared by any change of status. An
          -- appointment is only meaningful while the job is waiting for it,
          -- and a ticket re-opened weeks later must not arrive carrying one
          -- from a previous life.
          rescheduled_for = CASE
            WHEN $6::TIMESTAMPTZ IS NOT NULL THEN $6::TIMESTAMPTZ
            WHEN $1 <> status THEN NULL
            ELSE rescheduled_for
          END,
          updated_by_employee_id = $4,
          updated_at = CURRENT_TIMESTAMP
        WHERE service_ticket_id = $5
        RETURNING *;
        `,
        [status, closing, note, technician.employeeId, ticketId, rescheduledFor]
      );

      const statusChanged = status !== current.status;
      const historyNote = rescheduledFor
        ? `Rescheduled for ${formatAppointment(rescheduledFor)}` + (note ? ` — ${note}` : "")
        : note ||
          `Marked ${status.replace(/_/g, " ")} by ${technician.firstName} ${technician.lastName}`;

      await client.query(
        `INSERT INTO public.service_ticket_history
          (service_ticket_id, event_type, from_status, to_status, note, changed_by_employee_id)
         VALUES ($1, $2, $3, $4, $5, $6);`,
        [
          ticketId,
          statusChanged ? "status_changed" : "updated",
          current.status,
          status,
          historyNote,
          technician.employeeId,
        ]
      );

      await client.query(
        `INSERT INTO public.audit_logs
          (employee_id, actor_name, action, entity_type, entity_id, field_name, old_value, new_value, reason, occurred_at)
         VALUES ($1, $2, $3, 'service_ticket', $4, 'status', $5, $6, $7, CURRENT_TIMESTAMP);`,
        [
          technician.employeeId,
          `${technician.firstName} ${technician.lastName}`,
          statusChanged
            ? "Changed service ticket status from the technician app"
            : "Added a technician note",
          String(ticketId),
          current.status,
          status,
          historyNote,
        ]
      );

      await client.query("COMMIT");
      res.json({ ticket: updatedResult.rows[0] });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      console.error("Could not update job from the technician app:", error);
      res.status(500).json({ error: "Could not save that. Try again." });
    } finally {
      client.release();
    }
  }
);

export default technicianAppRouter;
