/** Manages pole-box inventory and combines it with live customer port usage. */
import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { pool } from "../db.js";

// MVP 4 infrastructure inventory. Customer assignments remain the source of
// truth for occupied ports while this router manages box-level metadata.
const poleBoxesRouter = Router();

function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session.employee) return res.status(401).json({ error: "Not authenticated." });
  next();
}

function requireManager(req: Request, res: Response, next: NextFunction) {
  const employee = req.session.employee;
  if (!employee) return res.status(401).json({ error: "Not authenticated." });
  if (!["admin", "head_office"].includes(employee.role)) {
    return res.status(403).json({ error: "Only Admin and Head Office can manage pole boxes." });
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

// Shared CTE calculates current occupancy directly from customer assignments.
// Duplicate port counts expose legacy conflicts instead of hiding them.
const usageCte = `
  WITH assignment_groups AS (
    SELECT
      UPPER(TRIM(pole_box_number)) AS normalized_box_number,
      UPPER(TRIM(port_number)) AS normalized_port_number,
      COUNT(*)::INTEGER AS assignment_count
    FROM public.customers
    WHERE NULLIF(TRIM(pole_box_number), '') IS NOT NULL
      AND NULLIF(TRIM(port_number), '') IS NOT NULL
    GROUP BY 1, 2
  ),
  assignment_stats AS (
    SELECT
      UPPER(TRIM(c.pole_box_number)) AS normalized_box_number,
      COUNT(*)::INTEGER AS connected_customers,
      COUNT(*) FILTER (WHERE c.status = 'active')::INTEGER AS active_connections,
      COUNT(DISTINCT NULLIF(UPPER(TRIM(c.port_number)), ''))::INTEGER AS occupied_ports
    FROM public.customers c
    WHERE NULLIF(TRIM(c.pole_box_number), '') IS NOT NULL
    GROUP BY 1
  ),
  duplicate_stats AS (
    SELECT normalized_box_number,
      COALESCE(SUM(assignment_count - 1), 0)::INTEGER AS duplicate_assignments
    FROM assignment_groups
    WHERE assignment_count > 1
    GROUP BY normalized_box_number
  ),
  pole_usage AS (
    SELECT
      pb.pole_box_id,
      pb.box_number,
      pb.location_description,
      pb.capacity,
      pb.status,
      pb.notes,
      pb.created_at,
      pb.updated_at,
      COALESCE(a.connected_customers, 0)::INTEGER AS connected_customers,
      COALESCE(a.active_connections, 0)::INTEGER AS active_connections,
      COALESCE(a.occupied_ports, 0)::INTEGER AS occupied_ports,
      COALESCE(d.duplicate_assignments, 0)::INTEGER AS duplicate_assignments,
      CASE WHEN pb.capacity IS NULL THEN NULL
           ELSE GREATEST(pb.capacity - COALESCE(a.occupied_ports, 0), 0)
      END::INTEGER AS available_ports,
      (pb.capacity IS NOT NULL AND COALESCE(a.occupied_ports, 0) > pb.capacity) AS over_capacity
    FROM public.pole_boxes pb
    LEFT JOIN assignment_stats a USING (normalized_box_number)
    LEFT JOIN duplicate_stats d USING (normalized_box_number)
  )
`;

poleBoxesRouter.get("/pole-boxes", requireAuth, async (req, res) => {
  const search = cleanText(req.query.search);
  const searchPattern = `%${search}%`;
  const view = cleanText(req.query.view) || "all";
  const requestedPage = Math.max(Number.parseInt(cleanText(req.query.page), 10) || 1, 1);
  const limit = 12;
  const viewClauses: Record<string, string> = {
    all: "TRUE",
    attention: "(duplicate_assignments > 0 OR over_capacity OR status = 'maintenance')",
    available: "(available_ports > 0 AND status = 'active')",
    full: "(capacity IS NOT NULL AND occupied_ports >= capacity)",
    maintenance: "status = 'maintenance'",
    retired: "status = 'retired'",
  };
  const viewClause = viewClauses[view] ?? viewClauses.all;

  try {
    const countResult = await pool.query(
      `${usageCte}
       SELECT COUNT(*)::INTEGER AS total FROM pole_usage
       WHERE ${viewClause}
         AND ($1 = '' OR box_number ILIKE $2 OR COALESCE(location_description, '') ILIKE $2);`,
      [search, searchPattern]
    );
    const total = countResult.rows[0].total as number;
    const totalPages = Math.max(Math.ceil(total / limit), 1);
    const page = Math.min(requestedPage, totalPages);
    const offset = (page - 1) * limit;

    const [boxesResult, summaryResult] = await Promise.all([
      pool.query(
        `${usageCte}
         SELECT * FROM pole_usage
         WHERE ${viewClause}
           AND ($1 = '' OR box_number ILIKE $2 OR COALESCE(location_description, '') ILIKE $2)
         ORDER BY
           CASE WHEN duplicate_assignments > 0 OR over_capacity THEN 0 ELSE 1 END,
           NULLIF(REGEXP_REPLACE(box_number, '[^0-9]', '', 'g'), '')::BIGINT NULLS LAST,
           box_number
         LIMIT $3 OFFSET $4;`,
        [search, searchPattern, limit, offset]
      ),
      pool.query(
        `${usageCte}
         SELECT
           COUNT(*)::INTEGER AS total_boxes,
           COALESCE(SUM(active_connections), 0)::INTEGER AS active_connections,
           COUNT(*) FILTER (WHERE duplicate_assignments > 0)::INTEGER AS boxes_with_duplicates,
           COUNT(*) FILTER (WHERE over_capacity)::INTEGER AS over_capacity,
           COUNT(*) FILTER (WHERE status = 'maintenance')::INTEGER AS maintenance
         FROM pole_usage;`
      ),
    ]);

    res.json({
      poleBoxes: boxesResult.rows,
      summary: summaryResult.rows[0],
      pagination: { page, limit, total, totalPages },
    });
  } catch (error) {
    console.error("Could not load pole boxes:", error);
    res.status(500).json({ error: "Could not load pole boxes." });
  }
});

poleBoxesRouter.get("/pole-boxes/:poleBoxId", requireAuth, async (req, res) => {
  const poleBoxId = parsePositiveId(req.params.poleBoxId);
  if (poleBoxId === null) return res.status(400).json({ error: "Invalid pole-box ID." });

  try {
    const boxResult = await pool.query(
      `${usageCte} SELECT * FROM pole_usage WHERE pole_box_id = $1;`,
      [poleBoxId]
    );
    const box = boxResult.rows[0];
    if (!box) return res.status(404).json({ error: "Pole box not found." });

    const [customersResult, ticketsResult] = await Promise.all([
      pool.query(
        `
        SELECT customer_id, name, address, telephone, status, port_number
        FROM public.customers
        WHERE UPPER(TRIM(pole_box_number)) = UPPER(TRIM($1))
          AND hidden_from_app = FALSE
        ORDER BY NULLIF(REGEXP_REPLACE(COALESCE(port_number, ''), '[^0-9]', '', 'g'), '')::BIGINT NULLS LAST,
          port_number, customer_id;
        `,
        [box.box_number]
      ),
      pool.query(
        `
        SELECT service_ticket_id, customer_id, issue_summary, status, priority, reported_date
        FROM public.service_tickets
        WHERE UPPER(TRIM(COALESCE(pole_box_number, ''))) = UPPER(TRIM($1))
        ORDER BY reported_date DESC, service_ticket_id DESC
        LIMIT 10;
        `,
        [box.box_number]
      ),
    ]);

    res.json({ poleBox: box, customers: customersResult.rows, tickets: ticketsResult.rows });
  } catch (error) {
    console.error("Could not load pole-box details:", error);
    res.status(500).json({ error: "Could not load pole-box details." });
  }
});

poleBoxesRouter.post(
  "/pole-boxes",
  requireAuth,
  requireManager,
  async (req, res) => {
    const employee = req.session.employee!;
    const boxNumber = cleanText(req.body.boxNumber);
    const capacityText = String(req.body.capacity ?? "").trim();
    const capacity = capacityText ? Number(capacityText) : null;
    if (!boxNumber || boxNumber.length > 80) return res.status(400).json({ error: "Enter a pole-box number." });
    if (capacity !== null && (!Number.isInteger(capacity) || capacity < 1 || capacity > 512)) return res.status(400).json({ error: "Capacity must be between 1 and 512." });

    try {
      const result = await pool.query(
        `
        INSERT INTO public.pole_boxes
          (box_number, location_description, capacity, status, notes, created_by_employee_id)
        VALUES ($1, NULLIF($2, ''), $3, 'active', NULLIF($4, ''), $5)
        RETURNING *;
        `,
        [boxNumber, cleanText(req.body.locationDescription), capacity, cleanText(req.body.notes), employee.employeeId]
      );
      await pool.query(
        `INSERT INTO public.audit_logs
          (employee_id, actor_name, action, entity_type, entity_id, field_name, old_value, new_value, occurred_at)
         VALUES ($1, $2, 'Created pole box', 'pole_box', $3, 'box_number', NULL, $4, CURRENT_TIMESTAMP);`,
        [employee.employeeId, `${employee.firstName} ${employee.lastName}`, String(result.rows[0].pole_box_id), boxNumber]
      );
      res.status(201).json({ poleBox: result.rows[0] });
    } catch (error: any) {
      if (error?.code === "23505") return res.status(409).json({ error: "That pole box already exists." });
      console.error("Could not create pole box:", error);
      res.status(500).json({ error: "Could not create pole box." });
    }
  }
);

poleBoxesRouter.patch(
  "/pole-boxes/:poleBoxId",
  requireAuth,
  requireManager,
  async (req, res) => {
    const poleBoxId = parsePositiveId(req.params.poleBoxId);
    if (poleBoxId === null) return res.status(400).json({ error: "Invalid pole-box ID." });
    const employee = req.session.employee!;
    const boxNumber = cleanText(req.body.boxNumber);
    const capacityText = String(req.body.capacity ?? "").trim();
    const capacity = capacityText ? Number(capacityText) : null;
    const status = cleanText(req.body.status);
    if (!boxNumber || boxNumber.length > 80) return res.status(400).json({ error: "Enter a pole-box number." });
    const reason = cleanText(req.body.reason);
    if (capacity !== null && (!Number.isInteger(capacity) || capacity < 1 || capacity > 512)) return res.status(400).json({ error: "Capacity must be between 1 and 512." });
    if (!["active", "maintenance", "retired"].includes(status)) return res.status(400).json({ error: "Choose a valid pole-box status." });
    if (reason.length < 3 || reason.length > 500) return res.status(400).json({ error: "A reason of 3–500 characters is required." });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const currentResult = await client.query(`SELECT * FROM public.pole_boxes WHERE pole_box_id = $1 FOR UPDATE;`, [poleBoxId]);
      const current = currentResult.rows[0];
      if (!current) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Pole box not found." });
      }
      const actorName = `${employee.firstName} ${employee.lastName}`;
      const renamed = boxNumber !== current.box_number;
      if (renamed && boxNumber.toUpperCase() !== current.normalized_box_number) {
        const clash = await client.query(
          `SELECT 1 FROM public.pole_boxes WHERE normalized_box_number = UPPER($1) AND pole_box_id <> $2;`,
          [boxNumber, poleBoxId]
        );
        if (clash.rowCount) {
          await client.query("ROLLBACK");
          return res.status(409).json({ error: `Pole box ${boxNumber} already exists.` });
        }
      }
      const result = await client.query(
        `
        UPDATE public.pole_boxes SET
          box_number = $1, location_description = NULLIF($2, ''), capacity = $3, status = $4,
          notes = NULLIF($5, ''), updated_at = CURRENT_TIMESTAMP
        WHERE pole_box_id = $6 RETURNING *;
        `,
        [boxNumber, cleanText(req.body.locationDescription), capacity, status, cleanText(req.body.notes), poleBoxId]
      );

      // Customers, tickets, and applications reference a box by its number
      // (not its ID), so a rename has to carry every existing link with it.
      if (renamed) {
        const movedCustomers = await client.query(
          `UPDATE public.customers SET pole_box_number = $1
           WHERE UPPER(TRIM(pole_box_number)) = $2
           RETURNING customer_id;`,
          [boxNumber, current.normalized_box_number]
        );
        await client.query(
          `UPDATE public.service_tickets SET pole_box_number = $1 WHERE UPPER(TRIM(pole_box_number)) = $2;`,
          [boxNumber, current.normalized_box_number]
        );
        await client.query(
          `UPDATE public.applications SET pole_box_number = $1 WHERE UPPER(TRIM(pole_box_number)) = $2;`,
          [boxNumber, current.normalized_box_number]
        );
        if (movedCustomers.rowCount) {
          await client.query(
            `INSERT INTO public.audit_logs
              (employee_id, actor_name, action, entity_type, entity_id, field_name, old_value, new_value, reason, occurred_at)
             SELECT $1, $2, 'Pole box renamed', 'customer', customer_id::TEXT, 'pole_box_number', $3, $4, $5, CURRENT_TIMESTAMP
             FROM UNNEST($6::BIGINT[]) AS customer_id;`,
            [employee.employeeId, actorName, current.box_number, boxNumber, reason, movedCustomers.rows.map((row) => row.customer_id)]
          );
        }
      }

      await client.query(
        `INSERT INTO public.audit_logs
          (employee_id, actor_name, action, entity_type, entity_id, field_name, old_value, new_value, reason, occurred_at)
         VALUES ($1, $2, 'Updated pole box', 'pole_box', $3, 'metadata', $4, $5, $6, CURRENT_TIMESTAMP);`,
        [employee.employeeId, actorName, String(poleBoxId), JSON.stringify({ boxNumber: current.box_number, capacity: current.capacity, status: current.status }), JSON.stringify({ boxNumber, capacity, status }), reason]
      );
      await client.query("COMMIT");
      res.json({ poleBox: result.rows[0] });
    } catch (error: any) {
      await client.query("ROLLBACK");
      if (error?.code === "23505") return res.status(409).json({ error: `Pole box ${boxNumber} already exists.` });
      console.error("Could not update pole box:", error);
      res.status(500).json({ error: "Could not update pole box." });
    } finally {
      client.release();
    }
  }
);

// Deleting only removes the inventory record. Boxes that still have customers
// are refused so nobody is left pointing at a box that no longer exists.
poleBoxesRouter.delete(
  "/pole-boxes/:poleBoxId",
  requireAuth,
  requireManager,
  async (req, res) => {
    const poleBoxId = parsePositiveId(req.params.poleBoxId);
    if (poleBoxId === null) return res.status(400).json({ error: "Invalid pole-box ID." });
    const employee = req.session.employee!;
    const reason = cleanText(req.body?.reason);
    if (reason.length < 3 || reason.length > 500) return res.status(400).json({ error: "A reason of 3–500 characters is required." });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const currentResult = await client.query(`SELECT * FROM public.pole_boxes WHERE pole_box_id = $1 FOR UPDATE;`, [poleBoxId]);
      const current = currentResult.rows[0];
      if (!current) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Pole box not found." });
      }
      const assignedResult = await client.query(
        `SELECT COUNT(*)::INTEGER AS total FROM public.customers WHERE UPPER(TRIM(pole_box_number)) = $1;`,
        [current.normalized_box_number]
      );
      const assigned = assignedResult.rows[0].total as number;
      if (assigned > 0) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: `${assigned} customer${assigned === 1 ? " is" : "s are"} still assigned to ${current.box_number}. Move them to another box (or rename this one) before deleting it.`,
        });
      }
      await client.query(`DELETE FROM public.pole_boxes WHERE pole_box_id = $1;`, [poleBoxId]);
      await client.query(
        `INSERT INTO public.audit_logs
          (employee_id, actor_name, action, entity_type, entity_id, field_name, old_value, new_value, reason, occurred_at)
         VALUES ($1, $2, 'Deleted pole box', 'pole_box', $3, 'box_number', $4, NULL, $5, CURRENT_TIMESTAMP);`,
        [employee.employeeId, `${employee.firstName} ${employee.lastName}`, String(poleBoxId), JSON.stringify(current), reason]
      );
      await client.query("COMMIT");
      res.json({ deleted: true, boxNumber: current.box_number });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Could not delete pole box:", error);
      res.status(500).json({ error: "Could not delete pole box." });
    } finally {
      client.release();
    }
  }
);

export default poleBoxesRouter;
