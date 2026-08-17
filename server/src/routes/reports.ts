/** Produces allowlisted operational reports with consistent date filtering and columns. */
import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { pool } from "../db.js";

// MVP 4 report endpoints return detailed, filterable rows. The dashboard uses
// separate aggregate endpoints and links here when an employee needs detail.
const reportsRouter = Router();

function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session.employee) return res.status(401).json({ error: "Not authenticated." });
  next();
}

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function validDate(value: string) {
  return value === "" || /^\d{4}-\d{2}-\d{2}$/.test(value);
}

type ReportResult = {
  rows: Record<string, unknown>[];
  total: number;
  totals?: Record<string, unknown>;
};

reportsRouter.get("/reports/:reportKey", requireAuth, async (req, res) => {
  const reportKey = cleanText(req.params.reportKey);
  const search = cleanText(req.query.search);
  const searchPattern = `%${search}%`;
  const from = cleanText(req.query.from);
  const to = cleanText(req.query.to);
  const requestedPage = Math.max(Number.parseInt(cleanText(req.query.page), 10) || 1, 1);
  const limit = 25;

  // Daily cross-company collection totals are administrator-only. Hiding the
  // report card in the client is not sufficient because URLs can be typed.
  if (reportKey === "payments-by-date" && req.session.employee?.role !== "admin") {
    return res.status(403).json({ error: "Only Admin can view Payments by Date." });
  }

  if (!validDate(from) || !validDate(to)) {
    return res.status(400).json({ error: "Choose valid report dates." });
  }
  if (from && to && from > to) {
    return res.status(400).json({ error: "The start date must be before the end date." });
  }

  try {
    // Materialize any anniversary charges due through today before a balance
    // report is read; the operation is idempotent for repeated report loads.
    await pool.query(
      `SELECT public.spcl_generate_monthly_charges(
        (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE
      );`
    );
    // Each key maps to static SQL so query parameters can never inject table or
    // column names. Counts are fetched before rows to clamp the requested page.
    let countSql = "";
    let rowsSql = "";
    let totalsSql = "";
    let values: unknown[] = [search, searchPattern, from, to];

    switch (reportKey) {
      case "payments-by-date":
        // Search does not apply to a date aggregate, so bind only its dates.
        values = [from, to];
        countSql = `
          SELECT COUNT(*)::INTEGER AS total FROM (
            SELECT payment_date FROM public.payments
            WHERE ($1 = '' OR payment_date >= $1::DATE)
              AND ($2 = '' OR payment_date <= $2::DATE)
              AND voided_at IS NULL
            GROUP BY payment_date
          ) grouped;`;
        rowsSql = `
          SELECT payment_date, COUNT(*)::INTEGER AS payment_count,
            COALESCE(SUM(amount_paid), 0)::NUMERIC(14,2) AS total_amount
          FROM public.payments
          WHERE ($1 = '' OR payment_date >= $1::DATE)
            AND ($2 = '' OR payment_date <= $2::DATE)
            AND voided_at IS NULL
          GROUP BY payment_date
          ORDER BY payment_date DESC NULLS LAST
          LIMIT $3 OFFSET $4;`;
        totalsSql = `
          SELECT COUNT(*)::INTEGER AS payment_count,
            COALESCE(SUM(amount_paid), 0)::NUMERIC(14,2) AS total_amount
          FROM public.payments
          WHERE ($1 = '' OR payment_date >= $1::DATE)
            AND ($2 = '' OR payment_date <= $2::DATE)
            AND voided_at IS NULL;`;
        break;

      case "payments-by-location":
        countSql = `
          SELECT COUNT(*)::INTEGER AS total FROM (
            SELECT COALESCE(NULLIF(TRIM(location), ''), 'Unknown')
            FROM public.payments
            WHERE ($3 = '' OR payment_date >= $3::DATE)
              AND ($4 = '' OR payment_date <= $4::DATE)
              AND voided_at IS NULL
              AND ($1 = '' OR COALESCE(location, '') ILIKE $2)
            GROUP BY 1
          ) grouped;`;
        rowsSql = `
          SELECT COALESCE(NULLIF(TRIM(location), ''), 'Unknown') AS location,
            COUNT(*)::INTEGER AS payment_count,
            COALESCE(SUM(amount_paid), 0)::NUMERIC(14,2) AS total_amount
          FROM public.payments
          WHERE ($3 = '' OR payment_date >= $3::DATE)
            AND ($4 = '' OR payment_date <= $4::DATE)
            AND voided_at IS NULL
            AND ($1 = '' OR COALESCE(location, '') ILIKE $2)
          GROUP BY 1
          ORDER BY total_amount DESC, location
          LIMIT $5 OFFSET $6;`;
        totalsSql = `
          SELECT COUNT(*)::INTEGER AS payment_count,
            COALESCE(SUM(amount_paid), 0)::NUMERIC(14,2) AS total_amount
          FROM public.payments
          WHERE ($3 = '' OR payment_date >= $3::DATE)
            AND ($4 = '' OR payment_date <= $4::DATE)
            AND voided_at IS NULL
            AND ($1 = '' OR COALESCE(location, '') ILIKE $2);`;
        break;

      case "pending-service":
        countSql = `
          SELECT COUNT(*)::INTEGER AS total
          FROM public.service_tickets t JOIN public.customers c USING (customer_id)
          WHERE t.status IN ('open', 'assigned', 'in_progress')
            AND ($3 = '' OR t.reported_date >= $3::DATE)
            AND ($4 = '' OR t.reported_date <= $4::DATE)
            AND ($1 = '' OR c.name ILIKE $2 OR c.customer_id::TEXT ILIKE $2 OR t.issue_summary ILIKE $2);`;
        rowsSql = `
          SELECT t.service_ticket_id, t.customer_id, c.name AS customer_name,
            t.issue_summary, t.priority, t.status, t.reported_date,
            CONCAT_WS(' ', e.first_name, e.last_name) AS technician,
            t.pole_box_number, t.port_number
          FROM public.service_tickets t
          JOIN public.customers c USING (customer_id)
          LEFT JOIN public.employees e ON e.employee_id = t.assigned_employee_id
          WHERE t.status IN ('open', 'assigned', 'in_progress')
            AND ($3 = '' OR t.reported_date >= $3::DATE)
            AND ($4 = '' OR t.reported_date <= $4::DATE)
            AND ($1 = '' OR c.name ILIKE $2 OR c.customer_id::TEXT ILIKE $2 OR t.issue_summary ILIKE $2)
          ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
            t.reported_date, t.service_ticket_id
          LIMIT $5 OFFSET $6;`;
        break;

      case "disconnected-customers":
        // This report has no date filter; its date columns are factual account
        // events rather than a report-period selection.
        values = [search, searchPattern];
        countSql = `
          SELECT COUNT(*)::INTEGER AS total FROM public.customers c
          WHERE c.status IN ('disconnected', 'pending_reconnection')
            AND ($1 = '' OR c.name ILIKE $2 OR c.customer_id::TEXT ILIKE $2 OR COALESCE(c.telephone, '') ILIKE $2);`;
        rowsSql = `
          SELECT c.customer_id, c.name AS customer_name, c.telephone, c.address,
            c.status, c.monthly_fee, c.deactivation_date,
            MAX(p.payment_date) AS last_payment_date,
            COALESCE(SUM(p.amount_paid), 0)::NUMERIC(14,2) AS lifetime_payments
          FROM public.customers c
          LEFT JOIN public.payments p ON p.customer_id = c.customer_id
            AND p.voided_at IS NULL
          WHERE c.status IN ('disconnected', 'pending_reconnection')
            AND ($1 = '' OR c.name ILIKE $2 OR c.customer_id::TEXT ILIKE $2 OR COALESCE(c.telephone, '') ILIKE $2)
          GROUP BY c.customer_id
          ORDER BY c.deactivation_date DESC NULLS LAST, c.customer_id DESC
          LIMIT $3 OFFSET $4;`;
        break;

      case "delinquent-customers":
        // Delinquency is based on the oldest unpaid anniversary charge after
        // its ten-day grace period; active holds are shown but remain in debt.
        values = [search, searchPattern];
        countSql = `
          SELECT COUNT(*)::INTEGER AS total
          FROM public.customer_billing_status billing
          JOIN public.customers c USING (customer_id)
          WHERE billing.is_delinquent
            AND ($1 = '' OR c.name ILIKE $2 OR c.customer_id::TEXT ILIKE $2
              OR COALESCE(c.telephone, '') ILIKE $2);`;
        rowsSql = `
          SELECT c.customer_id, c.name AS customer_name, c.telephone, c.status,
            billing.outstanding_balance, billing.oldest_unpaid_due_date,
            billing.grace_end_date, billing.scheduled_disconnection_date,
            billing.eligible_for_disconnection, billing.is_on_hold,
            billing.hold_expires_on, billing.unverified_entries,
            MAX(p.payment_date) AS last_payment_date
          FROM public.customer_billing_status billing
          JOIN public.customers c USING (customer_id)
          LEFT JOIN public.payments p ON p.customer_id = c.customer_id
            AND p.voided_at IS NULL
          WHERE billing.is_delinquent
            AND ($1 = '' OR c.name ILIKE $2 OR c.customer_id::TEXT ILIKE $2
              OR COALESCE(c.telephone, '') ILIKE $2)
          GROUP BY c.customer_id, billing.customer_id, billing.outstanding_balance,
            billing.oldest_unpaid_due_date, billing.grace_end_date,
            billing.scheduled_disconnection_date, billing.eligible_for_disconnection,
            billing.is_on_hold, billing.hold_expires_on, billing.unverified_entries
          ORDER BY billing.eligible_for_disconnection DESC,
            billing.scheduled_disconnection_date, billing.outstanding_balance DESC
          LIMIT $3 OFFSET $4;`;
        totalsSql = `
          SELECT COUNT(*)::INTEGER AS delinquent_count,
            COALESCE(SUM(billing.outstanding_balance), 0)::NUMERIC(14,2) AS outstanding_total
          FROM public.customer_billing_status billing
          JOIN public.customers c USING (customer_id)
          WHERE billing.is_delinquent
            AND ($1 = '' OR c.name ILIKE $2 OR c.customer_id::TEXT ILIKE $2
              OR COALESCE(c.telephone, '') ILIKE $2);`;
        break;

      case "applications":
        countSql = `
          SELECT COUNT(*)::INTEGER AS total FROM public.applications a
          WHERE ($3 = '' OR a.application_date >= $3::DATE)
            AND ($4 = '' OR a.application_date <= $4::DATE)
            AND ($1 = '' OR a.name ILIKE $2 OR a.application_id::TEXT ILIKE $2 OR COALESCE(a.telephone, '') ILIKE $2);`;
        rowsSql = `
          SELECT a.application_id, a.name AS applicant_name, a.telephone,
            a.application_date, a.status, p.name AS package_name,
            a.monthly_fee, a.activation_date, a.customer_id
          FROM public.applications a
          LEFT JOIN public.packages p ON p.package_id = a.package_id
          WHERE ($3 = '' OR a.application_date >= $3::DATE)
            AND ($4 = '' OR a.application_date <= $4::DATE)
            AND ($1 = '' OR a.name ILIKE $2 OR a.application_id::TEXT ILIKE $2 OR COALESCE(a.telephone, '') ILIKE $2)
          ORDER BY a.application_date DESC, a.application_id DESC
          LIMIT $5 OFFSET $6;`;
        break;

      case "pole-box-usage":
        // Date filters do not apply to current infrastructure usage.
        values = [search, searchPattern];
        countSql = `
          SELECT COUNT(*)::INTEGER AS total FROM public.pole_box_usage
          WHERE ($1 = '' OR box_number ILIKE $2 OR COALESCE(location_description, '') ILIKE $2);`;
        rowsSql = `
          SELECT pole_box_id, box_number, location_description, status, capacity,
            occupied_ports, available_ports, active_connections,
            connected_customers, duplicate_assignments, over_capacity
          FROM public.pole_box_usage
          WHERE ($1 = '' OR box_number ILIKE $2 OR COALESCE(location_description, '') ILIKE $2)
          ORDER BY CASE WHEN duplicate_assignments > 0 OR over_capacity THEN 0 ELSE 1 END, box_number
          LIMIT $3 OFFSET $4;`;
        break;

      default:
        return res.status(404).json({ error: "Report not found." });
    }

    const countResult = await pool.query(countSql, values);
    const total = countResult.rows[0].total as number;
    const totalPages = Math.max(Math.ceil(total / limit), 1);
    const page = Math.min(requestedPage, totalPages);
    const offset = (page - 1) * limit;
    const rowValues = [...values, limit, offset];

    const rowsResult = await pool.query(rowsSql, rowValues);
    let totals: Record<string, unknown> | undefined;
    if (totalsSql) {
      const totalsResult = await pool.query(totalsSql, values);
      totals = totalsResult.rows[0];
    }
    const result: ReportResult = { rows: rowsResult.rows, total, totals };
    res.json({ ...result, pagination: { page, limit, total, totalPages } });
  } catch (error) {
    console.error(`Could not load ${reportKey} report:`, error);
    res.status(500).json({ error: "Could not load report." });
  }
});

export default reportsRouter;
