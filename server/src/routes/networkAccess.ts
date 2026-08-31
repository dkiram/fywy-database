/** Manages the saved customer-to-OLT mapping used by future network actions. */
import { isIP } from "node:net";
import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import type { PoolClient } from "pg";
import { pool } from "../db.js";
import { normalizeExactCustomerName } from "../huawei/matchOntCustomers.js";
import {
  changeOntActivationState,
  OltControlError,
  OltVerificationError,
  readOntFromOlt,
  type OntControlAction,
} from "../huawei/verifyOnt.js";
import { getTestOntControlPolicy } from "../huawei/controlPolicy.js";

const networkAccessRouter = Router();

// "Verify with OLT" normally opens a fresh CLI session every time. Setting
// HUAWEI_OLT_VERIFY_CACHE_SECONDS lets it reuse a port scan that recent
// instead - meant for turning on during a bulk delinquency/OLT sweep so
// hundreds of verifies for one port collapse into one read, then turning off
// again. A control action through the app always drops the cached scan for
// that port; only a change made directly on the OLT could read stale here.
const VERIFY_CACHE_MS = (() => {
  const parsed = Number.parseInt(
    process.env.HUAWEI_OLT_VERIFY_CACHE_SECONDS ?? "",
    10
  );
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 3600
    ? parsed * 1000
    : 0;
})();

function getOntControlAvailability(customerId: number, assignment: any) {
  const { enabled, allowlisted } = getTestOntControlPolicy(customerId);
  const mappingReady =
    assignment?.mapping_status === "verified" && !!assignment?.ont_serial;
  return {
    enabled,
    allowlisted,
    available: enabled && allowlisted && mappingReady,
    reason: !enabled
      ? "Live ONT controls are disabled."
      : !allowlisted
        ? "This customer is not allowlisted for the test phase."
        : !mappingReady
          ? "Verify this mapping and ONT serial before using live controls."
          : null,
  };
}

function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session.employee) {
    return res.status(401).json({ error: "Not authenticated." });
  }
  next();
}

function requireNetworkManager(req: Request, res: Response, next: NextFunction) {
  const employee = req.session.employee;
  if (!employee) return res.status(401).json({ error: "Not authenticated." });
  if (!["admin", "head_office"].includes(employee.role)) {
    return res.status(403).json({
      error: "Only Admin and Head Office can edit OLT information.",
    });
  }
  next();
}

function parseCustomerId(req: Request, res: Response) {
  const value = req.params.customerId;
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    res.status(400).json({ error: "Invalid customer ID." });
    return null;
  }
  return Number(value);
}

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function parseWholeNumber(value: unknown, label: string, max: number) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) return { error: `${label} must be a whole number.` };
  const number = Number(text);
  if (!Number.isSafeInteger(number) || number < 0 || number > max) {
    return { error: `${label} must be between 0 and ${max}.` };
  }
  return { value: number };
}

const currentAssignmentSelect = `
  SELECT
    assignment.customer_ont_assignment_id,
    assignment.customer_id,
    assignment.olt_id,
    olt.name AS olt_name,
    host(olt.management_ip) AS management_ip,
    assignment.frame_number,
    assignment.slot_number,
    assignment.pon_port_number,
    assignment.ont_id,
    assignment.ont_serial,
    assignment.ont_description_override,
    assignment.description_override_reason,
    assignment.description_overridden_at,
    customer.name AS customer_name,
    customer.status AS customer_status,
    assignment.source,
    assignment.mapping_status,
    assignment.verified_at,
    assignment.active_from,
    assignment.updated_at,
    verifier.first_name AS verified_by_first_name,
    verifier.last_name AS verified_by_last_name
  FROM public.customer_ont_assignments assignment
  JOIN public.customers customer ON customer.customer_id = assignment.customer_id
  JOIN public.olts olt ON olt.olt_id = assignment.olt_id
  LEFT JOIN public.employees verifier
    ON verifier.employee_id = assignment.verified_by_employee_id
  WHERE assignment.customer_id = $1
    AND assignment.ended_at IS NULL
`;

function expectedOntDescription(assignment: any) {
  return String(
    assignment?.ont_description_override ?? assignment?.customer_name ?? ""
  );
}

// Avoid running two interactive CLI sessions for the same imported mapping.
// This is process-local; PostgreSQL row checks below remain the final guard.
const verificationsInProgress = new Set<number>();
const ontActionsInProgress = new Set<number>();

// The profile card uses this small list to reuse an existing OLT instead of
// making staff retype a shared management address for every customer.
networkAccessRouter.get("/olts", requireAuth, async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        olt_id,
        name,
        host(management_ip) AS management_ip
      FROM public.olts
      WHERE is_active = TRUE
      ORDER BY name;
    `);
    res.json({ olts: result.rows });
  } catch (error) {
    console.error("Could not load OLTs:", error);
    res.status(500).json({ error: "Could not load OLTs." });
  }
});

networkAccessRouter.get(
  "/customers/:customerId/network-access",
  requireAuth,
  async (req, res) => {
    const customerId = parseCustomerId(req, res);
    if (customerId === null) return;
    try {
      const result = await pool.query(`${currentAssignmentSelect};`, [customerId]);
      const networkAccess = result.rows[0] ?? null;
      res.json({
        networkAccess,
        ontControl: getOntControlAvailability(customerId, networkAccess),
      });
    } catch (error) {
      console.error("Could not load customer OLT information:", error);
      res.status(500).json({ error: "Could not load OLT information." });
    }
  }
);

async function insertAudit(
  client: PoolClient,
  values: {
    employeeId: number;
    actorName: string;
    customerId: number;
    action: string;
    oldValue: unknown;
    newValue: unknown;
    reason: string | null;
  }
) {
  await client.query(
    `
    INSERT INTO public.audit_logs (
      employee_id, actor_name, action, entity_type, entity_id,
      field_name, old_value, new_value, reason, occurred_at
    ) VALUES ($1, $2, $3, 'customer', $4, 'network_access', $5, $6, $7,
      CURRENT_TIMESTAMP);
    `,
    [
      values.employeeId,
      values.actorName,
      values.action,
      String(values.customerId),
      values.oldValue == null ? null : JSON.stringify(values.oldValue),
      values.newValue == null ? null : JSON.stringify(values.newValue),
      values.reason,
    ]
  );
}

networkAccessRouter.put(
  "/customers/:customerId/network-access",
  requireAuth,
  requireNetworkManager,
  async (req, res) => {
    const customerId = parseCustomerId(req, res);
    if (customerId === null) return;

    const oltName = cleanText(req.body.oltName);
    const managementIp = cleanText(req.body.managementIp);
    const reason = cleanText(req.body.reason) || null;

    if (oltName.length < 2 || oltName.length > 120) {
      return res.status(400).json({ error: "OLT name must be 2–120 characters." });
    }
    if (isIP(managementIp) === 0) {
      return res.status(400).json({ error: "Enter a valid OLT management IP address." });
    }
    if (reason && reason.length > 500) {
      return res.status(400).json({ error: "The optional change note must be 500 characters or fewer." });
    }

    const frame = parseWholeNumber(req.body.frameNumber, "Frame", 255);
    const slot = parseWholeNumber(req.body.slotNumber, "Card / slot", 255);
    const ponPort = parseWholeNumber(req.body.ponPortNumber, "PON port", 255);
    const ontId = parseWholeNumber(req.body.ontId, "Virtual port / ONT ID", 4095);
    // Check each parsed value separately so TypeScript can safely narrow the
    // result before the values are passed to PostgreSQL below.
    if ("error" in frame) return res.status(400).json({ error: frame.error });
    if ("error" in slot) return res.status(400).json({ error: slot.error });
    if ("error" in ponPort) return res.status(400).json({ error: ponPort.error });
    if ("error" in ontId) return res.status(400).json({ error: ontId.error });

    const employee = req.session.employee!;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const customerResult = await client.query(
        `SELECT customer_id, status FROM public.customers WHERE customer_id = $1 FOR UPDATE;`,
        [customerId]
      );
      if (customerResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Customer not found." });
      }
      if (customerResult.rows[0].status === "terminated") {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: "OLT information cannot be added to a terminated subscription.",
        });
      }

      // OLT names and management addresses are shared inventory. Reuse the
      // existing row, but refuse a conflicting address instead of silently
      // changing every customer's target.
      let oltResult = await client.query(
        `SELECT olt_id, name, host(management_ip) AS management_ip
         FROM public.olts WHERE normalized_name = UPPER(TRIM($1)) FOR UPDATE;`,
        [oltName]
      );
      if (oltResult.rows.length > 0 && oltResult.rows[0].management_ip !== managementIp) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: `${oltResult.rows[0].name} already uses management IP ${oltResult.rows[0].management_ip}.`,
        });
      }
      if (oltResult.rows.length === 0) {
        oltResult = await client.query(
          `
          INSERT INTO public.olts (
            name, management_ip, created_by_employee_id
          ) VALUES ($1, $2::INET, $3)
          RETURNING olt_id, name, host(management_ip) AS management_ip;
          `,
          [oltName, managementIp, employee.employeeId]
        );
      }
      const olt = oltResult.rows[0];

      // Lock only the assignment row here. Applying FOR UPDATE to the joined
      // profile query would also try to lock the nullable verifier join.
      await client.query(
        `SELECT customer_ont_assignment_id
         FROM public.customer_ont_assignments
         WHERE customer_id = $1 AND ended_at IS NULL
         FOR UPDATE;`,
        [customerId]
      );
      const currentResult = await client.query(`${currentAssignmentSelect};`, [customerId]);
      const current = currentResult.rows[0] ?? null;

      if (current) {
        await client.query(
          `UPDATE public.customer_ont_assignments
           SET ended_at = CURRENT_TIMESTAMP,
               updated_at = CURRENT_TIMESTAMP,
               updated_by_employee_id = $2
           WHERE customer_ont_assignment_id = $1;`,
          [current.customer_ont_assignment_id, employee.employeeId]
        );
      }

      // Name the customer standing on this location instead of failing with an
      // anonymous unique-violation. The current customer's own row was ended
      // just above, so re-saving an unchanged location never trips this.
      const locationHolderResult = await client.query(
        `
        SELECT holder.customer_id, holder.name, holder.status
        FROM public.customer_ont_assignments occupying
        JOIN public.customers holder
          ON holder.customer_id = occupying.customer_id
        WHERE occupying.ended_at IS NULL
          AND occupying.olt_id = $1
          AND occupying.frame_number = $2
          AND occupying.slot_number = $3
          AND occupying.pon_port_number = $4
          AND occupying.ont_id = $5
        LIMIT 1;
        `,
        [olt.olt_id, frame.value, slot.value, ponPort.value, ontId.value]
      );
      if (locationHolderResult.rows.length > 0) {
        await client.query("ROLLBACK");
        const holder = locationHolderResult.rows[0];
        const location = `${frame.value}/${slot.value}/${ponPort.value}/${ontId.value}`;
        return res.status(409).json({
          error:
            `${olt.name} ${location} is already assigned to customer #${holder.customer_id} ` +
            `${holder.name} (${String(holder.status).replace(/_/g, " ")}). ` +
            `Remove the OLT information from that customer first, then save it here.`,
          conflict: {
            customerId: Number(holder.customer_id),
            customerName: holder.name,
            customerStatus: holder.status,
            oltName: olt.name,
            location,
          },
        });
      }

      await client.query(
        `
        INSERT INTO public.customer_ont_assignments (
          customer_id, olt_id, frame_number, slot_number, pon_port_number,
          ont_id, source,
          mapping_status, created_by_employee_id, updated_by_employee_id
        ) VALUES (
          $1, $2, $3, $4, $5, $6, 'manual',
          'unverified', $7, $7
        );
        `,
        [
          customerId,
          olt.olt_id,
          frame.value,
          slot.value,
          ponPort.value,
          ontId.value,
          employee.employeeId,
        ]
      );

      const savedResult = await client.query(`${currentAssignmentSelect};`, [customerId]);
      const saved = savedResult.rows[0];
      await insertAudit(client, {
        employeeId: employee.employeeId,
        actorName: `${employee.firstName} ${employee.lastName}`,
        customerId,
        action: current ? "Changed customer OLT information" : "Added customer OLT information",
        oldValue: current,
        newValue: saved,
        reason,
      });

      await client.query("COMMIT");
      res.json({ networkAccess: saved });
    } catch (error: unknown) {
      await client.query("ROLLBACK");
      if (typeof error === "object" && error && "code" in error && error.code === "23505") {
        // The named check above catches this in practice; this remains for a
        // genuine race between two staff saving the same location at once.
        return res.status(409).json({
          error:
            "That OLT location was taken by another customer a moment ago. " +
            "Reload the page to see who holds it.",
        });
      }
      console.error("Could not save customer OLT information:", error);
      res.status(500).json({ error: "Could not save OLT information." });
    } finally {
      client.release();
    }
  }
);

// Releases a customer's current OLT location so it can be given to somebody
// else. The row is ENDED, never deleted: customer_ont_assignments is the
// history of who occupied a port, and olt_action_attempts references it with
// ON DELETE RESTRICT. Ending the row clears both partial unique indexes (the
// location and the ONT serial), which is what frees the port for the next
// customer.
networkAccessRouter.delete(
  "/customers/:customerId/network-access",
  requireAuth,
  requireNetworkManager,
  async (req, res) => {
    const customerId = parseCustomerId(req, res);
    if (customerId === null) return;

    const reason = cleanText(req.body?.reason) || null;
    if (reason && reason.length > 500) {
      return res
        .status(400)
        .json({ error: "The optional change note must be 500 characters or fewer." });
    }

    const employee = req.session.employee!;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `SELECT customer_ont_assignment_id
         FROM public.customer_ont_assignments
         WHERE customer_id = $1 AND ended_at IS NULL
         FOR UPDATE;`,
        [customerId]
      );
      const currentResult = await client.query(`${currentAssignmentSelect};`, [customerId]);
      const current = currentResult.rows[0] ?? null;
      if (!current) {
        await client.query("ROLLBACK");
        return res
          .status(404)
          .json({ error: "This customer has no OLT information to remove." });
      }

      // An action is committed to the journal before the OLT is contacted, so a
      // 'requested' row means a write may be in flight against this exact
      // location right now. Releasing it underneath that is not safe.
      const inFlightResult = await client.query(
        `SELECT olt_action_attempt_id
         FROM public.olt_action_attempts
         WHERE customer_ont_assignment_id = $1 AND outcome = 'requested'
         LIMIT 1;`,
        [current.customer_ont_assignment_id]
      );
      if (inFlightResult.rows.length > 0) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error:
            "A live OLT action is still running for this mapping. " +
            "Wait for it to finish before removing the OLT information.",
        });
      }

      await client.query(
        `UPDATE public.customer_ont_assignments
         SET ended_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP,
             updated_by_employee_id = $2
         WHERE customer_ont_assignment_id = $1;`,
        [current.customer_ont_assignment_id, employee.employeeId]
      );

      await insertAudit(client, {
        employeeId: employee.employeeId,
        actorName: `${employee.firstName} ${employee.lastName}`,
        customerId,
        action: "Removed customer OLT information",
        oldValue: current,
        newValue: null,
        reason,
      });

      await client.query("COMMIT");
      res.json({
        networkAccess: null,
        ontControl: getOntControlAvailability(customerId, null),
        released: {
          oltName: current.olt_name,
          location:
            `${current.frame_number}/${current.slot_number}/` +
            `${current.pon_port_number}/${current.ont_id}`,
        },
      });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Could not remove customer OLT information:", error);
      res.status(500).json({ error: "Could not remove OLT information." });
    } finally {
      client.release();
    }
  }
);

networkAccessRouter.post(
  "/customers/:customerId/network-access/verify",
  requireAuth,
  requireNetworkManager,
  async (req, res) => {
    const customerId = parseCustomerId(req, res);
    if (customerId === null) return;
    const employee = req.session.employee!;

    const initialResult = await pool.query(`${currentAssignmentSelect};`, [customerId]);
    const initial = initialResult.rows[0] ?? null;
    if (!initial) {
      return res.status(404).json({ error: "No current OLT mapping exists for this customer." });
    }
    const assignmentId = Number(initial.customer_ont_assignment_id);
    if (verificationsInProgress.has(assignmentId)) {
      return res.status(409).json({ error: "This OLT mapping is already being verified." });
    }

    verificationsInProgress.add(assignmentId);
    try {
      const liveOnt = await readOntFromOlt(
        {
          managementIp: initial.management_ip,
          frameNumber: Number(initial.frame_number),
          slotNumber: Number(initial.slot_number),
          ponPortNumber: Number(initial.pon_port_number),
          ontId: Number(initial.ont_id),
        },
        { cacheMaxAgeMs: VERIFY_CACHE_MS }
      );

      const serialMatches =
        !initial.ont_serial ||
        String(initial.ont_serial).trim().toUpperCase() === liveOnt?.ontSerial;
      const descriptionMatches =
        !!liveOnt?.description &&
        normalizeExactCustomerName(liveOnt.description) ===
          normalizeExactCustomerName(expectedOntDescription(initial));
      let verified = !!liveOnt && serialMatches && descriptionMatches;
      let serialAssignedElsewhere = false;
      const mismatchReasons: string[] = [];
      if (!liveOnt) mismatchReasons.push("ONT ID was not found at the saved location");
      if (liveOnt && !serialMatches) mismatchReasons.push("ONT serial does not match");
      if (liveOnt && !descriptionMatches) mismatchReasons.push("customer description does not match");

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const lockResult = await client.query(
          `SELECT * FROM public.customer_ont_assignments
           WHERE customer_ont_assignment_id = $1
             AND customer_id = $2
             AND ended_at IS NULL
           FOR UPDATE;`,
          [assignmentId, customerId]
        );
        const locked = lockResult.rows[0];
        if (
          !locked ||
          Number(locked.olt_id) !== Number(initial.olt_id) ||
          Number(locked.frame_number) !== Number(initial.frame_number) ||
          Number(locked.slot_number) !== Number(initial.slot_number) ||
          Number(locked.pon_port_number) !== Number(initial.pon_port_number) ||
          Number(locked.ont_id) !== Number(initial.ont_id) ||
          String(locked.ont_description_override ?? "") !==
            String(initial.ont_description_override ?? "")
        ) {
          await client.query("ROLLBACK");
          return res.status(409).json({
            error: "The OLT mapping changed while verification was running. Please try again.",
          });
        }

        let reconciledAttemptIds: number[] = [];
        let clearedAccountAttempts: Array<{
          attemptId: number;
          action: OntControlAction;
          resolution: "failed" | "confirmed";
        }> = [];
        let resumedReconnectionJobIds: number[] = [];
        if (liveOnt && serialMatches) {
          // Name the customer holding the serial. Almost always the previous
          // occupant of this port whose mapping was never released, which is
          // exactly what the reviewer needs to know to clear the conflict.
          const serialConflict = await client.query(
            `SELECT conflicting.customer_ont_assignment_id,
                    holder.customer_id,
                    holder.name AS customer_name,
                    holder.status AS customer_status,
                    conflictOlt.name AS olt_name,
                    conflicting.frame_number,
                    conflicting.slot_number,
                    conflicting.pon_port_number,
                    conflicting.ont_id
             FROM public.customer_ont_assignments conflicting
             JOIN public.customers holder
               ON holder.customer_id = conflicting.customer_id
             JOIN public.olts conflictOlt
               ON conflictOlt.olt_id = conflicting.olt_id
             WHERE conflicting.ended_at IS NULL
               AND conflicting.customer_ont_assignment_id <> $1
               AND conflicting.ont_serial IS NOT NULL
               AND UPPER(TRIM(conflicting.ont_serial)) = UPPER(TRIM($2))
             LIMIT 1
             FOR UPDATE OF conflicting;`,
            [assignmentId, liveOnt.ontSerial]
          );
          if (serialConflict.rows.length > 0) {
            const holder = serialConflict.rows[0];
            serialAssignedElsewhere = true;
            verified = false;
            mismatchReasons.push(
              `ONT serial ${liveOnt.ontSerial} is already assigned to customer ` +
                `#${holder.customer_id} ${holder.customer_name} ` +
                `(${String(holder.customer_status).replace(/_/g, " ")}, on ` +
                `${holder.olt_name} ${holder.frame_number}/${holder.slot_number}/` +
                `${holder.pon_port_number}/${holder.ont_id}) — remove the OLT ` +
                `information from that customer, then verify again`
            );
          }
        }

        if (verified && liveOnt) {
          // If an earlier write reached Huawei but its immediate confirmation
          // timed out, a later read-only verification can safely resolve that
          // journal entry only when the requested state now matches live data.
          const reconciledResult = await client.query(
            `UPDATE public.olt_action_attempts
             SET outcome = 'succeeded',
                 after_control_flag = $2,
                 after_run_state = $3,
                 result_message =
                   'Resolved by a subsequent read-only live OLT verification.',
                 completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP)
             WHERE customer_ont_assignment_id = $1
               AND outcome = 'uncertain'
               -- Account-transition uncertainty also includes an uncommitted
               -- customer status and must be reconciled by an administrator,
               -- not silently cleared by an equipment-only verification.
               AND workflow = 'test_control'
               AND (
                 (action = 'deactivate' AND $2 = 'deactivated')
                 OR (action = 'activate' AND $2 = 'active')
               )
             RETURNING olt_action_attempt_id;`,
            [assignmentId, liveOnt.controlFlag, liveOnt.runState]
          );
          reconciledAttemptIds = reconciledResult.rows.map((row) =>
            Number(row.olt_action_attempt_id)
          );

          // An account-transition attempt that remains unresolved normally
          // blocks every later action. When this read-only check proves the
          // live ONT is still in the *opposite* state, the requested write did
          // not take effect. It is therefore safe to mark that attempt failed
          // and let staff retry the normal workflow. This never changes the
          // customer account status and never sends a Huawei command.
          const clearedResult = await client.query(
            `UPDATE public.olt_action_attempts
             SET outcome = 'failed',
                 after_control_flag = $2,
                 after_run_state = $3,
                 result_message =
                   'Resolved by a subsequent read-only live OLT verification: the requested state was not present, so the account action may be retried.',
                 completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP)
             WHERE customer_ont_assignment_id = $1
               AND workflow = 'account_transition'
               AND account_status_applied_at IS NULL
               AND (
                 outcome = 'uncertain'
                 OR (
                   outcome = 'requested'
                   AND requested_at <= CURRENT_TIMESTAMP - INTERVAL '10 minutes'
                 )
               )
               AND (
                 (action = 'activate' AND $2 = 'deactivated')
                 OR (action = 'deactivate' AND $2 = 'active')
               )
             RETURNING olt_action_attempt_id, action;`,
            [assignmentId, liveOnt.controlFlag, liveOnt.runState]
          );
          clearedAccountAttempts = clearedResult.rows.map((row) => ({
            attemptId: Number(row.olt_action_attempt_id),
            action: row.action as OntControlAction,
            resolution: "failed" as const,
          }));

          // A prior account write may also be safely closed when both Huawei
          // and the current account workflow already reflect it. Pending
          // Reconnection is a legitimate later stage after a confirmed
          // deactivation, so an old deactivation journal must not prevent the
          // customer's subsequent activation.
          const confirmedResult = await client.query(
            `UPDATE public.olt_action_attempts
             SET outcome = 'succeeded',
                 after_control_flag = $2,
                 after_run_state = $3,
                 result_message =
                   CASE
                     WHEN action = 'activate' AND $4 = 'pending_reconnection'
                       THEN 'Resolved by a subsequent read-only live OLT verification: Huawei is already Active; the automatic reconnection queue will synchronize the account workflow.'
                     ELSE 'Resolved by a subsequent read-only live OLT verification: Huawei and the current account workflow already reflect the requested state.'
                   END,
                 account_status_applied_at = CASE
                   WHEN action = 'activate' AND $4 = 'pending_reconnection'
                     THEN account_status_applied_at
                   ELSE COALESCE(account_status_applied_at, CURRENT_TIMESTAMP)
                 END,
                 completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP)
             WHERE customer_ont_assignment_id = $1
               AND workflow = 'account_transition'
               AND (
                 outcome = 'uncertain'
                 OR (
                   outcome = 'requested'
                   AND requested_at <= CURRENT_TIMESTAMP - INTERVAL '10 minutes'
                 )
               )
               AND (
                 (
                   action = 'activate'
                   AND $2 = 'active'
                   AND ($4 = 'active' OR $4 = 'pending_reconnection')
                 )
                 OR (
                   action = 'deactivate'
                   AND $2 = 'deactivated'
                   AND ($4 = 'disconnected' OR $4 = 'pending_reconnection')
                 )
               )
             RETURNING olt_action_attempt_id, action;`,
            [
              assignmentId,
              liveOnt.controlFlag,
              liveOnt.runState,
              initial.customer_status,
            ]
          );
          clearedAccountAttempts.push(
            ...confirmedResult.rows.map((row) => ({
              attemptId: Number(row.olt_action_attempt_id),
              action: row.action as OntControlAction,
              resolution: "confirmed" as const,
            }))
          );
          reconciledAttemptIds.push(
            ...clearedAccountAttempts.map((attempt) => attempt.attemptId)
          );

          // A queue job can be left blocked after its worker or API process
          // disappears mid-action. Once this exact read-only verification has
          // resolved every journal blocker, resume the existing job instead of
          // requiring a database edit. If Huawei already shows Active, retain
          // a delayed save request because the interrupted activation may have
          // changed running configuration before the process disappeared.
          const confirmedActivation = clearedAccountAttempts.some(
            (attempt) =>
              attempt.action === "activate" &&
              attempt.resolution === "confirmed" &&
              liveOnt.controlFlag === "active" &&
              initial.customer_status === "pending_reconnection"
          );
          if (clearedAccountAttempts.length > 0) {
            const saveDelay = Number.parseInt(
              process.env.HUAWEI_OLT_AUTOMATION_SAVE_DELAY_MINUTES ?? "",
              10
            );
            const saveDelayMinutes =
              Number.isInteger(saveDelay) && saveDelay >= 1 && saveDelay <= 1440
                ? saveDelay
                : 120;
            const resumedJobs = await client.query(
              `UPDATE public.olt_reconnection_automation_jobs job
               SET status = 'pending',
                   next_attempt_at = CURRENT_TIMESTAMP,
                   -- One explicit live-check click grants one bounded retry,
                   -- even when the stranded action consumed attempt three.
                   attempt_count = LEAST(job.attempt_count, 2),
                   completed_at = NULL,
                   message = 'Live OLT verification resolved the prior action; automatic reconnection resumed.',
                   management_ip = CASE
                     WHEN $3::BOOLEAN THEN $4::INET
                     ELSE job.management_ip
                   END,
                   save_status = CASE
                     WHEN $3::BOOLEAN THEN 'pending'
                     ELSE job.save_status
                   END,
                   save_attempt_count = CASE
                     WHEN $3::BOOLEAN THEN 0
                     ELSE job.save_attempt_count
                   END,
                   save_next_attempt_at = CASE
                     WHEN $3::BOOLEAN
                       THEN CURRENT_TIMESTAMP + make_interval(mins => $5)
                     ELSE job.save_next_attempt_at
                   END,
                   save_last_attempt_at = CASE
                     WHEN $3::BOOLEAN THEN NULL
                     ELSE job.save_last_attempt_at
                   END,
                   save_completed_at = CASE
                     WHEN $3::BOOLEAN THEN NULL
                     ELSE job.save_completed_at
                   END,
                   save_error_message = CASE
                     WHEN $3::BOOLEAN THEN NULL
                     ELSE job.save_error_message
                   END,
                   updated_at = CURRENT_TIMESTAMP
               WHERE job.customer_id = $1
                 AND job.status IN ('blocked_action', 'uncertain')
                 AND NOT EXISTS (
                   SELECT 1
                   FROM public.olt_action_attempts unresolved
                   WHERE unresolved.customer_ont_assignment_id = $2
                     AND unresolved.outcome IN ('requested', 'uncertain')
                 )
               RETURNING job.olt_reconnection_automation_job_id;`,
              [
                customerId,
                assignmentId,
                confirmedActivation,
                initial.management_ip,
                saveDelayMinutes,
              ]
            );
            resumedReconnectionJobIds = resumedJobs.rows.map((row) =>
              Number(row.olt_reconnection_automation_job_id)
            );
          }
        }

        await client.query(
          `UPDATE public.customer_ont_assignments
           SET mapping_status = $2,
               ont_serial = CASE
                 WHEN $2 = 'verified' THEN COALESCE(ont_serial, $3)
                 ELSE ont_serial
               END,
               verified_at = CASE WHEN $2 = 'verified' THEN CURRENT_TIMESTAMP ELSE NULL END,
               -- Cast the shared parameter explicitly: inside a CASE,
               -- PostgreSQL can otherwise infer an untyped staff ID as TEXT.
               verified_by_employee_id = CASE
                 WHEN $2 = 'verified' THEN $4::BIGINT
                 ELSE NULL::BIGINT
               END,
               updated_by_employee_id = $4::BIGINT,
               updated_at = CURRENT_TIMESTAMP
           WHERE customer_ont_assignment_id = $1;`,
          [
            assignmentId,
            verified ? "verified" : "mismatch",
            liveOnt?.ontSerial ?? null,
            employee.employeeId,
          ]
        );

        const savedResult = await client.query(`${currentAssignmentSelect};`, [customerId]);
        const saved = savedResult.rows[0];
        // A routine re-check that still matches and resolved nothing new is
        // not worth a permanent Activity History record — staff can verify a
        // mapping as often as they like without flooding the shared, capped
        // activity feed. Only a mismatch, or a first-time confirmation, or an
        // uncertain OLT action getting resolved, is worth recording.
        const isRoutineRecheck =
          verified && initial.mapping_status === "verified" && reconciledAttemptIds.length === 0;
        if (!isRoutineRecheck) {
          await insertAudit(client, {
            employeeId: employee.employeeId,
            actorName: `${employee.firstName} ${employee.lastName}`,
            customerId,
            action: verified ? "Verified customer OLT information" : "OLT mapping mismatch",
            oldValue: initial,
            newValue: {
              ...saved,
              liveControlFlag: liveOnt?.controlFlag ?? null,
              liveRunState: liveOnt?.runState ?? null,
              mismatchReasons,
              reconciledAttemptIds,
              clearedAccountAttempts,
            },
            reason: verified
              ? "Read-only live OLT verification"
              : mismatchReasons.join("; "),
          });
        }
        await client.query("COMMIT");

        const failedAttempt = clearedAccountAttempts.find(
          (attempt) => attempt.resolution === "failed"
        );
        const confirmedAttempt = clearedAccountAttempts.find(
          (attempt) => attempt.resolution === "confirmed"
        );
        const clearedAttemptMessage = failedAttempt
          ? ` ONT action #${failedAttempt.attemptId} was cleared because Huawei confirmed its requested ${
              failedAttempt.action === "activate" ? "activation" : "deactivation"
            } did not occur. You can safely retry the account action.`
          : confirmedAttempt
            ? confirmedAttempt.action === "activate" &&
              initial.customer_status === "pending_reconnection"
              ? ` ONT action #${confirmedAttempt.attemptId} was reconciled because Huawei is already Active. The automatic queue resumed and will synchronize the account.`
              : ` ONT action #${confirmedAttempt.attemptId} was reconciled because Huawei and the account workflow already reflect its requested ${
                  confirmedAttempt.action === "activate" ? "activation" : "deactivation"
                }. You can safely continue the account workflow.`
            : "";

        return res.json({
          verification: {
            status: verified ? "verified" : "mismatch",
            message: verified
              ? `The saved customer mapping matches the live OLT.${clearedAttemptMessage}`
              : mismatchReasons.join("; "),
            checkedAt: new Date().toISOString(),
            live: liveOnt
              ? {
                  controlFlag: liveOnt.controlFlag,
                  runState: liveOnt.runState,
                  description: liveOnt.description,
                }
              : null,
            overrideEligible: Boolean(
              liveOnt?.description &&
                serialMatches &&
                !serialAssignedElsewhere &&
                !descriptionMatches
            ),
            reconciledAttemptIds,
            clearedAccountAttempts,
            resumedReconnectionJobIds,
          },
          networkAccess: saved,
        });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      if (error instanceof OltVerificationError) {
        console.warn(`OLT verification ${error.kind} error for customer ${customerId}.`);
        return res.status(error.kind === "configuration" ? 503 : 502).json({
          error: error.message,
          code: `olt_${error.kind}_error`,
        });
      }
      console.error("Could not verify customer OLT information:", error);
      return res.status(500).json({ error: "Could not verify OLT information." });
    } finally {
      verificationsInProgress.delete(assignmentId);
    }
  }
);

networkAccessRouter.post(
  "/customers/:customerId/network-access/description-override",
  requireAuth,
  requireNetworkManager,
  async (req, res) => {
    const customerId = parseCustomerId(req, res);
    if (customerId === null) return;

    const employee = req.session.employee!;
    const submittedReason = cleanText(req.body.reason);
    const adminMayOmitReason = employee.role === "admin";
    if (
      submittedReason.length > 500 ||
      (!adminMayOmitReason && submittedReason.length < 3) ||
      (submittedReason.length > 0 && submittedReason.length < 3)
    ) {
      return res.status(400).json({
        error: adminMayOmitReason
          ? "Leave the reason blank or enter between 3 and 500 characters."
          : "A reason between 3 and 500 characters is required.",
      });
    }
    const reason =
      submittedReason || "Admin confirmed without an additional reason.";
    const requiredConfirmation = `OVERRIDE DESCRIPTION ${customerId}`;
    if (cleanText(req.body.confirmation) !== requiredConfirmation) {
      return res.status(400).json({
        error: `Type ${requiredConfirmation} exactly to confirm.`,
      });
    }

    const initialResult = await pool.query(`${currentAssignmentSelect};`, [customerId]);
    const initial = initialResult.rows[0] ?? null;
    if (!initial) {
      return res.status(404).json({ error: "No current OLT mapping exists for this customer." });
    }

    const assignmentId = Number(initial.customer_ont_assignment_id);
    if (
      verificationsInProgress.has(assignmentId) ||
      ontActionsInProgress.has(assignmentId)
    ) {
      return res.status(409).json({
        error: "This OLT mapping already has an operation in progress.",
      });
    }

    verificationsInProgress.add(assignmentId);
    try {
      // The browser never supplies the description being accepted. Re-read it
      // from Huawei now so stale or altered page data cannot authorize one.
      const liveOnt = await readOntFromOlt({
        managementIp: initial.management_ip,
        frameNumber: Number(initial.frame_number),
        slotNumber: Number(initial.slot_number),
        ponPortNumber: Number(initial.pon_port_number),
        ontId: Number(initial.ont_id),
      });
      if (!liveOnt?.description?.trim()) {
        return res.status(409).json({
          error: "The live ONT or its Huawei description was not found. Nothing was overridden.",
        });
      }
      if (
        initial.ont_serial &&
        String(initial.ont_serial).trim().toUpperCase() !== liveOnt.ontSerial
      ) {
        return res.status(409).json({
          error: "The live ONT serial differs from the saved serial. Nothing was overridden.",
        });
      }
      if (
        normalizeExactCustomerName(liveOnt.description) ===
        normalizeExactCustomerName(initial.customer_name ?? "")
      ) {
        return res.status(409).json({
          error: "The live Huawei description already matches the customer name. Use normal verification.",
        });
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const lockedResult = await client.query(
          `SELECT *
           FROM public.customer_ont_assignments
           WHERE customer_ont_assignment_id = $1
             AND customer_id = $2
             AND ended_at IS NULL
           FOR UPDATE;`,
          [assignmentId, customerId]
        );
        const locked = lockedResult.rows[0];
        if (
          !locked ||
          Number(locked.olt_id) !== Number(initial.olt_id) ||
          Number(locked.frame_number) !== Number(initial.frame_number) ||
          Number(locked.slot_number) !== Number(initial.slot_number) ||
          Number(locked.pon_port_number) !== Number(initial.pon_port_number) ||
          Number(locked.ont_id) !== Number(initial.ont_id) ||
          String(locked.ont_serial ?? "").trim().toUpperCase() !==
            String(initial.ont_serial ?? "").trim().toUpperCase()
        ) {
          await client.query("ROLLBACK");
          return res.status(409).json({
            error: "The OLT mapping changed during the live check. Nothing was overridden.",
          });
        }

        // These explicit checks are intentionally repeated under the row
        // lock. A description exception can never resolve an occupied OLT
        // location or a serial assigned to another current customer.
        const locationConflict = await client.query(
          `SELECT customer_ont_assignment_id
           FROM public.customer_ont_assignments
           WHERE ended_at IS NULL
             AND customer_ont_assignment_id <> $1
             AND olt_id = $2
             AND frame_number = $3
             AND slot_number = $4
             AND pon_port_number = $5
             AND ont_id = $6
           LIMIT 1
           FOR UPDATE;`,
          [
            assignmentId,
            initial.olt_id,
            initial.frame_number,
            initial.slot_number,
            initial.pon_port_number,
            initial.ont_id,
          ]
        );
        const serialConflict = await client.query(
          `SELECT customer_ont_assignment_id
           FROM public.customer_ont_assignments
           WHERE ended_at IS NULL
             AND customer_ont_assignment_id <> $1
             AND ont_serial IS NOT NULL
             AND UPPER(TRIM(ont_serial)) = UPPER(TRIM($2))
           LIMIT 1
           FOR UPDATE;`,
          [assignmentId, liveOnt.ontSerial]
        );
        if (locationConflict.rows.length > 0 || serialConflict.rows.length > 0) {
          await client.query("ROLLBACK");
          return res.status(409).json({
            error:
              locationConflict.rows.length > 0
                ? "That OLT location is assigned to another current customer. Nothing was overridden."
                : "That ONT serial is assigned to another current customer. Nothing was overridden.",
          });
        }

        await client.query(
          `UPDATE public.customer_ont_assignments
           SET ont_serial = COALESCE(ont_serial, $2),
               ont_description_override = $3,
               description_override_reason = $4,
               description_overridden_at = CURRENT_TIMESTAMP,
               description_overridden_by_employee_id = $5::BIGINT,
               mapping_status = 'verified',
               verified_at = CURRENT_TIMESTAMP,
               verified_by_employee_id = $5::BIGINT,
               updated_by_employee_id = $5::BIGINT,
               updated_at = CURRENT_TIMESTAMP
           WHERE customer_ont_assignment_id = $1;`,
          [
            assignmentId,
            liveOnt.ontSerial,
            liveOnt.description.trim(),
            reason,
            employee.employeeId,
          ]
        );

        const savedResult = await client.query(`${currentAssignmentSelect};`, [customerId]);
        const saved = savedResult.rows[0];
        await insertAudit(client, {
          employeeId: employee.employeeId,
          actorName: `${employee.firstName} ${employee.lastName}`,
          customerId,
          action: "Confirmed Huawei ONT description override",
          oldValue: initial,
          newValue: {
            ...saved,
            liveControlFlag: liveOnt.controlFlag,
            liveRunState: liveOnt.runState,
          },
          reason,
        });
        await client.query("COMMIT");

        return res.json({
          networkAccess: saved,
          verification: {
            status: "verified",
            message:
              "The live location and serial matched. This exact Huawei description is now the approved identity for future checks.",
            checkedAt: new Date().toISOString(),
            live: {
              controlFlag: liveOnt.controlFlag,
              runState: liveOnt.runState,
              description: liveOnt.description,
            },
            overrideEligible: false,
          },
        });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      if (error instanceof OltVerificationError) {
        return res.status(error.kind === "configuration" ? 503 : 502).json({
          error: error.message,
          code: `olt_${error.kind}_error`,
        });
      }
      console.error("Could not confirm ONT description override:", error);
      return res.status(500).json({
        error: "Could not confirm the ONT description override.",
      });
    } finally {
      verificationsInProgress.delete(assignmentId);
    }
  }
);

networkAccessRouter.post(
  "/customers/:customerId/network-access/ont-control",
  requireAuth,
  requireNetworkManager,
  async (req, res) => {
    const customerId = parseCustomerId(req, res);
    if (customerId === null) return;

    const action = cleanText(req.body.action) as OntControlAction;
    if (!(["deactivate", "activate"] as string[]).includes(action)) {
      return res.status(400).json({ error: "Choose activate or deactivate." });
    }
    const reason = cleanText(req.body.reason);
    if (reason.length < 3 || reason.length > 500) {
      return res.status(400).json({
        error: "A reason between 3 and 500 characters is required.",
      });
    }
    const requiredConfirmation = `${action.toUpperCase()} ${customerId}`;
    if (cleanText(req.body.confirmation) !== requiredConfirmation) {
      return res.status(400).json({
        error: `Type ${requiredConfirmation} exactly to confirm.`,
      });
    }

    const initialResult = await pool.query(`${currentAssignmentSelect};`, [customerId]);
    const initial = initialResult.rows[0] ?? null;
    if (!initial) {
      return res.status(404).json({ error: "No current OLT mapping exists for this customer." });
    }
    const availability = getOntControlAvailability(customerId, initial);
    if (!availability.enabled) {
      return res.status(503).json({ error: availability.reason });
    }
    if (!availability.allowlisted) {
      return res.status(403).json({ error: availability.reason });
    }
    if (!availability.available) {
      return res.status(409).json({ error: availability.reason });
    }

    const assignmentId = Number(initial.customer_ont_assignment_id);
    const unresolvedResult = await pool.query(
      `SELECT olt_action_attempt_id, outcome
       FROM public.olt_action_attempts
       WHERE customer_ont_assignment_id = $1
         AND outcome IN ('requested', 'uncertain')
       ORDER BY requested_at DESC
       LIMIT 1;`,
      [assignmentId]
    );
    if (unresolvedResult.rows.length > 0) {
      const unresolved = unresolvedResult.rows[0];
      return res.status(409).json({
        error:
          unresolved.outcome === "uncertain"
            ? `ONT action #${unresolved.olt_action_attempt_id} has an uncertain outcome. Check PuTTY before another command.`
            : `ONT action #${unresolved.olt_action_attempt_id} is still in progress.`,
      });
    }
    if (
      verificationsInProgress.has(assignmentId) ||
      ontActionsInProgress.has(assignmentId)
    ) {
      return res.status(409).json({
        error: "This OLT mapping already has an operation in progress.",
      });
    }

    const employee = req.session.employee!;
    let attemptId: number;
    try {
      const attemptResult = await pool.query(
        `INSERT INTO public.olt_action_attempts (
           customer_id, customer_ont_assignment_id, requested_by_employee_id,
           action, reason, management_ip, frame_number, slot_number,
           pon_port_number, ont_id, expected_ont_serial
         ) VALUES ($1, $2, $3::BIGINT, $4, $5, $6::INET, $7, $8, $9, $10, $11)
         RETURNING olt_action_attempt_id;`,
        [
          customerId,
          assignmentId,
          employee.employeeId,
          action,
          reason,
          initial.management_ip,
          initial.frame_number,
          initial.slot_number,
          initial.pon_port_number,
          initial.ont_id,
          initial.ont_serial,
        ]
      );
      attemptId = Number(attemptResult.rows[0].olt_action_attempt_id);
    } catch (error: unknown) {
      if (typeof error === "object" && error && "code" in error && error.code === "23505") {
        return res.status(409).json({ error: "An ONT action is already in progress." });
      }
      throw error;
    }
    let liveResult:
      | Awaited<ReturnType<typeof changeOntActivationState>>
      | undefined;

    ontActionsInProgress.add(assignmentId);
    try {
      liveResult = await changeOntActivationState(
        {
          managementIp: initial.management_ip,
          frameNumber: Number(initial.frame_number),
          slotNumber: Number(initial.slot_number),
          ponPortNumber: Number(initial.pon_port_number),
          ontId: Number(initial.ont_id),
        },
        {
          ontSerial: String(initial.ont_serial),
          customerName: expectedOntDescription(initial),
        },
        action
      );

      const outcome = liveResult.changed ? "succeeded" : "no_change";
      const resultMessage = liveResult.changed
        ? `ONT ${action} completed and was confirmed by a live read.`
        : `ONT was already ${action === "deactivate" ? "deactivated" : "active"}; no command was needed.`;

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const lockResult = await client.query(
          `SELECT customer_ont_assignment_id
           FROM public.customer_ont_assignments
           WHERE customer_ont_assignment_id = $1
             AND customer_id = $2
             AND ended_at IS NULL
             AND ont_serial = $3
             AND ont_description_override IS NOT DISTINCT FROM $4
           FOR UPDATE;`,
          [
            assignmentId,
            customerId,
            initial.ont_serial,
            initial.ont_description_override,
          ]
        );
        if (lockResult.rows.length === 0) {
          throw new Error("The customer OLT mapping changed during the live operation.");
        }

        // The live preflight re-verified the saved serial and customer name.
        await client.query(
          `UPDATE public.customer_ont_assignments
           SET mapping_status = 'verified',
               verified_at = CURRENT_TIMESTAMP,
               verified_by_employee_id = $2::BIGINT,
               updated_by_employee_id = $2::BIGINT,
               updated_at = CURRENT_TIMESTAMP
           WHERE customer_ont_assignment_id = $1;`,
          [assignmentId, employee.employeeId]
        );
        await client.query(
          `UPDATE public.olt_action_attempts
           SET outcome = $2,
               before_control_flag = $3,
               before_run_state = $4,
               after_control_flag = $5,
               after_run_state = $6,
               result_message = $7,
               completed_at = CURRENT_TIMESTAMP
           WHERE olt_action_attempt_id = $1;`,
          [
            attemptId,
            outcome,
            liveResult.before.controlFlag,
            liveResult.before.runState,
            liveResult.after.controlFlag,
            liveResult.after.runState,
            resultMessage,
          ]
        );
        await insertAudit(client, {
          employeeId: employee.employeeId,
          actorName: `${employee.firstName} ${employee.lastName}`,
          customerId,
          action: liveResult.changed
            ? action === "deactivate"
              ? "Deactivated customer ONT"
              : "Activated customer ONT"
            : action === "deactivate"
              ? "Confirmed customer ONT already deactivated"
              : "Confirmed customer ONT already active",
          oldValue: {
            controlFlag: liveResult.before.controlFlag,
            runState: liveResult.before.runState,
            attemptId,
          },
          newValue: {
            controlFlag: liveResult.after.controlFlag,
            runState: liveResult.after.runState,
            attemptId,
          },
          reason,
        });
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }

      return res.json({
        action: {
          action,
          outcome,
          message: resultMessage,
          before: {
            controlFlag: liveResult.before.controlFlag,
            runState: liveResult.before.runState,
          },
          after: {
            controlFlag: liveResult.after.controlFlag,
            runState: liveResult.after.runState,
          },
          attemptId,
        },
      });
    } catch (error) {
      const outcome = liveResult
        ? "uncertain"
        : error instanceof OltControlError
          ? error.outcome
          : "failed";
      const message = liveResult
        ? "The ONT state changed, but the app could not finish recording the result. Check PuTTY before retrying."
        : error instanceof OltVerificationError
          ? error.message
          : "The ONT action failed before it could be completed.";

      try {
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
      } catch (journalError) {
        console.error("Could not finalize OLT action journal:", journalError);
      }

      console.error(`OLT ${action} attempt ${attemptId} ended as ${outcome}.`);
      return res.status(outcome === "blocked" ? 409 : 502).json({
        error: message,
        code: `olt_action_${outcome}`,
        attemptId,
      });
    } finally {
      ontActionsInProgress.delete(assignmentId);
    }
  }
);

export default networkAccessRouter;
