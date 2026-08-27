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
        `SELECT customer_id FROM public.customers WHERE customer_id = $1 FOR UPDATE;`,
        [customerId]
      );
      if (customerResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Customer not found." });
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
        return res.status(409).json({
          error: "That OLT location is already assigned to another customer.",
        });
      }
      console.error("Could not save customer OLT information:", error);
      res.status(500).json({ error: "Could not save OLT information." });
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
      const liveOnt = await readOntFromOlt({
        managementIp: initial.management_ip,
        frameNumber: Number(initial.frame_number),
        slotNumber: Number(initial.slot_number),
        ponPortNumber: Number(initial.pon_port_number),
        ontId: Number(initial.ont_id),
      });

      const serialMatches =
        !initial.ont_serial ||
        String(initial.ont_serial).trim().toUpperCase() === liveOnt?.ontSerial;
      const descriptionMatches =
        !!liveOnt?.description &&
        normalizeExactCustomerName(liveOnt.description) ===
          normalizeExactCustomerName(initial.customer_name ?? "");
      let verified = !!liveOnt && serialMatches && descriptionMatches;
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
          Number(locked.ont_id) !== Number(initial.ont_id)
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
        if (verified && liveOnt) {
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
          if (serialConflict.rows.length > 0) {
            verified = false;
            mismatchReasons.push("ONT serial is already assigned to another customer");
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
                   'Resolved by a subsequent read-only live OLT verification: Huawei and the current account workflow already reflect the requested state.',
                 account_status_applied_at = COALESCE(account_status_applied_at, CURRENT_TIMESTAMP),
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
                   AND $4 = 'active'
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
            ? ` ONT action #${confirmedAttempt.attemptId} was reconciled because Huawei and the account workflow already reflect its requested ${
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
            reconciledAttemptIds,
            clearedAccountAttempts,
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
          customerName: String(initial.customer_name ?? ""),
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
           FOR UPDATE;`,
          [assignmentId, customerId]
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
