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

// Company-wide financial totals and infrastructure automation logs are only
// available to administrators. The client also hides their cards, but this
// check protects the data when a report URL is requested directly.
const ADMIN_ONLY_REPORTS = new Set([
  "payments-by-date",
  "payments-by-location",
  "nightly-disconnection-runs",
]);

// Sortable columns, per report. The client sends a column key; this maps it to
// a literal ORDER BY fragment, so a column name never arrives from the request
// as text. A key that is not listed falls back to the report's own default
// ordering rather than erroring, so an old bookmark still loads.
//
// Every entry ends in customer_id. Sorting six thousand rows across 245 pages
// on a column with ties would otherwise let the database return them in a
// different order per page, showing one customer twice and skipping another.
const REPORT_SORTS: Record<string, Record<string, string>> = {
  "delinquent-customers": {
    oldest_unpaid_due_date: "billing.oldest_unpaid_due_date %DIR% NULLS LAST, c.customer_id",
    grace_end_date: "billing.grace_end_date %DIR% NULLS LAST, c.customer_id",
    outstanding_balance: "billing.outstanding_balance %DIR%, c.customer_id",
    last_payment_date: "MAX(p.payment_date) %DIR% NULLS LAST, c.customer_id",
    customer_name: "c.name %DIR%, c.customer_id",
    customer_id: "c.customer_id %DIR%",
  },
};

function sortClause(reportKey: string, sort: string, direction: string) {
  const template = REPORT_SORTS[reportKey]?.[sort];
  if (!template) return "";
  return template.replaceAll("%DIR%", direction === "asc" ? "ASC" : "DESC");
}

type ReportResult = {
  rows: Record<string, unknown>[];
  total: number;
  totals?: Record<string, unknown>;
};

reportsRouter.get("/reports/:reportKey", requireAuth, async (req, res) => {
  const reportKey = cleanText(req.params.reportKey);

  if (
    ADMIN_ONLY_REPORTS.has(reportKey) &&
    req.session.employee!.role !== "admin"
  ) {
    return res.status(403).json({
      error: "Only Admin can view this report.",
    });
  }
  const search = cleanText(req.query.search);
  const searchPattern = `%${search}%`;
  const from = cleanText(req.query.from);
  const to = cleanText(req.query.to);
  const requestedPage = Math.max(Number.parseInt(cleanText(req.query.page), 10) || 1, 1);
  const limit = 25;
  const sort = cleanText(req.query.sort);
  const direction = cleanText(req.query.dir) === "asc" ? "asc" : "desc";
  const orderBy = sortClause(reportKey, sort, direction);

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
            c.address AS customer_address,
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
            AND c.hidden_from_app = FALSE
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
            AND c.hidden_from_app = FALSE
            AND ($1 = '' OR c.name ILIKE $2 OR c.customer_id::TEXT ILIKE $2 OR COALESCE(c.telephone, '') ILIKE $2)
          GROUP BY c.customer_id
          ORDER BY c.deactivation_date DESC NULLS LAST, c.customer_id DESC
          LIMIT $3 OFFSET $4;`;
        break;

      case "delinquent-customers":
        // Delinquency is based on the oldest unpaid anniversary charge after
        // its ten-day grace period; active holds are shown but remain in debt.
        //
        // Active accounts only. This list answers "who do we disconnect next",
        // so somebody already disconnected does not belong on it - they are on
        // the Disconnected Customers report instead, with what they owe. Their
        // debt is not forgotten, it is just not a disconnection decision.
        // hidden_from_app excludes the blank legacy shells migration 039 hid
        // from the rest of the app; chasing a customer with no name is not a
        // thing anyone can act on.
        //
        // Legacy rows whose grace period ended before 2025 are
        // retained in the database and everywhere else in the app, but are no
        // longer actionable delinquency work. New-system customers are never
        // excluded by this historical cutoff.
        values = [search, searchPattern];
        countSql = `
          SELECT COUNT(*)::INTEGER AS total
          FROM public.customer_billing_status billing
          JOIN public.customers c USING (customer_id)
          WHERE billing.is_delinquent
            AND c.status = 'active'
            AND c.hidden_from_app = FALSE
            AND (
              c.source_staging_id IS NULL
              OR billing.grace_end_date >= DATE '2025-01-01'
            )
            AND ($1 = '' OR c.name ILIKE $2 OR c.customer_id::TEXT ILIKE $2
              OR COALESCE(c.telephone, '') ILIKE $2);`;
        rowsSql = `
          SELECT c.customer_id, c.name AS customer_name, c.telephone, c.status,
            billing.outstanding_balance, billing.oldest_unpaid_due_date,
            billing.grace_end_date,
            billing.eligible_for_disconnection, billing.is_on_hold,
            billing.hold_expires_on, billing.unverified_entries,
            MAX(p.payment_date) AS last_payment_date
          FROM public.customer_billing_status billing
          JOIN public.customers c USING (customer_id)
          LEFT JOIN public.payments p ON p.customer_id = c.customer_id
            AND p.voided_at IS NULL
          WHERE billing.is_delinquent
            AND c.status = 'active'
            AND c.hidden_from_app = FALSE
            AND (
              c.source_staging_id IS NULL
              OR billing.grace_end_date >= DATE '2025-01-01'
            )
            AND ($1 = '' OR c.name ILIKE $2 OR c.customer_id::TEXT ILIKE $2
              OR COALESCE(c.telephone, '') ILIKE $2)
          GROUP BY c.customer_id, billing.customer_id, billing.outstanding_balance,
            billing.oldest_unpaid_due_date, billing.grace_end_date,
            billing.eligible_for_disconnection, billing.is_on_hold,
            billing.hold_expires_on, billing.unverified_entries
          ORDER BY ${orderBy || `billing.eligible_for_disconnection DESC,
            billing.grace_end_date, billing.outstanding_balance DESC,
            c.customer_id`}
          LIMIT $3 OFFSET $4;`;
        // Deliberately counts the customers but not the money. The total owed
        // across the company is a board-level number, not something anyone
        // needs while working a chase list, so it is not computed at all
        // rather than computed and hidden.
        totalsSql = `
          SELECT COUNT(*)::INTEGER AS delinquent_count
          FROM public.customer_billing_status billing
          JOIN public.customers c USING (customer_id)
          WHERE billing.is_delinquent
            AND c.status = 'active'
            AND c.hidden_from_app = FALSE
            AND (
              c.source_staging_id IS NULL
              OR billing.grace_end_date >= DATE '2025-01-01'
            )
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

      case "nightly-disconnection-runs":
        // One compact summary row per scheduled OLT automation run. Date range
        // controls are intentionally omitted in the client because this table
        // grows by only one row per night and should open on recent history.
        values = [search, searchPattern];
        countSql = `
          SELECT COUNT(*)::INTEGER AS total
          FROM public.olt_automation_runs run
          WHERE ($1 = '' OR run.olt_automation_run_id::TEXT ILIKE $2
            OR run.billing_date::TEXT ILIKE $2
            OR run.status ILIKE $2
            OR COALESCE(run.error_message, '') ILIKE $2);`;
        rowsSql = `
          SELECT run.olt_automation_run_id, run.billing_date, run.status,
            run.candidate_count, run.selected_count, run.disconnected_count,
            run.skipped_count, run.failed_count, run.remaining_count,
            run.started_at, run.completed_at, run.error_message
          FROM public.olt_automation_runs run
          WHERE ($1 = '' OR run.olt_automation_run_id::TEXT ILIKE $2
            OR run.billing_date::TEXT ILIKE $2
            OR run.status ILIKE $2
            OR COALESCE(run.error_message, '') ILIKE $2)
          ORDER BY run.started_at DESC, run.olt_automation_run_id DESC
          LIMIT $3 OFFSET $4;`;
        break;

      case "technician-jobs":
        // One row per technician: what they closed in the report period, split
        // by how it ended, plus what is on their phone right now.
        //
        // Counted out of service_ticket_history, not off the ticket. The ticket
        // cannot answer "when did this end": completed_at is set only for
        // 'completed' and is NULL for cancelled and unresolved, service_date is
        // usually NULL on an unresolved job because nobody got through the
        // gate, and updated_at moves again whenever somebody edits a note
        // months later. The history is append-only and records the moment each
        // status was actually set. This is the same source the service queue's
        // close-date filter reads.
        //
        // `from_status IS DISTINCT FROM to_status` is what separates a real
        // ending from a note. Adding a note without changing the status still
        // writes a history row, and that row carries the status the ticket
        // already had - so without this test, a note typed on a job in
        // December would be counted as a job closed in December.
        //
        // Jamaica time, not UTC: a job closed at 7pm on the 5th was closed on
        // the 5th to the person who closed it, and would otherwise be filed
        // under the 6th and found by nobody looking for it.
        //
        // Attribution is the ticket's assigned technician, not whoever pressed
        // the button. The office closing a job on the phone's behalf does not
        // move that job to the office's name.
        //
        // Repairs and installations are counted together. Migration 079 put
        // installations on the service-ticket rail precisely because they are
        // the same thing to the technician - an address, a name, and a job
        // that ends in done or not done - and a report about a technician's
        // day should not pretend one of them did not happen.
        //
        // A ticket that ends twice counts twice. An unresolved job is meant to
        // be re-scheduled (migration 074), so one that came back unresolved in
        // March and was completed in April is two trips, and the technician
        // made both. Each ending is filed on its own date under the status set
        // at that moment, which also keeps Completed + Unresolved + Cancelled
        // equal to Jobs Closed in every period.
        countSql = `
          SELECT COUNT(*)::INTEGER AS total FROM (
            SELECT e.employee_id
            FROM public.employees e
            LEFT JOIN LATERAL (
              SELECT h.to_status
              FROM public.service_tickets t
              JOIN public.service_ticket_history h
                ON h.service_ticket_id = t.service_ticket_id
              WHERE t.assigned_employee_id = e.employee_id
                AND h.to_status IN ('completed', 'unresolved', 'cancelled')
                AND h.from_status IS DISTINCT FROM h.to_status
                AND ($3 = '' OR (h.changed_at AT TIME ZONE 'America/Jamaica')::DATE >= $3::DATE)
                AND ($4 = '' OR (h.changed_at AT TIME ZONE 'America/Jamaica')::DATE <= $4::DATE)
            ) closing ON TRUE
            WHERE e.role = 'technician'
              AND ($1 = '' OR CONCAT_WS(' ', e.first_name, e.last_name) ILIKE $2)
            GROUP BY e.employee_id, e.is_active
            HAVING e.is_active OR COUNT(closing.to_status) > 0
          ) grouped;`;
        rowsSql = `
          SELECT
            e.employee_id,
            CONCAT_WS(' ', e.first_name, e.last_name) AS technician,
            COUNT(closing.to_status)::INTEGER AS jobs_closed,
            COUNT(*) FILTER (WHERE closing.to_status = 'completed')::INTEGER AS completed_count,
            COUNT(*) FILTER (WHERE closing.to_status = 'unresolved')::INTEGER AS unresolved_count,
            COUNT(*) FILTER (WHERE closing.to_status = 'cancelled')::INTEGER AS cancelled_count,
            -- Of the jobs the technician actually went out on, how many ended
            -- in the work being done. Cancelled is left out of both halves on
            -- purpose: a job called off by the office is not a visit that
            -- failed, and counting it against the technician would make
            -- "we no longer need this" read as "they could not do it".
            --
            -- NULL rather than zero when there is nothing to divide, so a
            -- technician who closed nothing this period shows an em dash
            -- instead of a 0% that looks like a failing score.
            CASE
              WHEN COUNT(*) FILTER (WHERE closing.to_status IN ('completed', 'unresolved')) = 0
                THEN NULL
              ELSE ROUND(
                100.0 * COUNT(*) FILTER (WHERE closing.to_status = 'completed')
                / COUNT(*) FILTER (WHERE closing.to_status IN ('completed', 'unresolved'))
              )::INTEGER
            END AS completion_rate,
            -- Deliberately outside the date range. This is the queue on the
            -- technician's phone as of now, which is what somebody deciding
            -- who to send the next job to needs, and it is why the column is
            -- labelled "Open Now" rather than sitting among the period counts
            -- as though it were one of them. Same two statuses the queue cap
            -- in migration 076 counts, so the two never disagree.
            (
              SELECT COUNT(*)::INTEGER
              FROM public.service_tickets open_t
              WHERE open_t.assigned_employee_id = e.employee_id
                AND open_t.status IN ('assigned', 'in_progress')
            ) AS open_now
          FROM public.employees e
          LEFT JOIN LATERAL (
            SELECT h.to_status
            FROM public.service_tickets t
            JOIN public.service_ticket_history h
              ON h.service_ticket_id = t.service_ticket_id
            WHERE t.assigned_employee_id = e.employee_id
              AND h.to_status IN ('completed', 'unresolved', 'cancelled')
              AND h.from_status IS DISTINCT FROM h.to_status
              AND ($3 = '' OR (h.changed_at AT TIME ZONE 'America/Jamaica')::DATE >= $3::DATE)
              AND ($4 = '' OR (h.changed_at AT TIME ZONE 'America/Jamaica')::DATE <= $4::DATE)
          ) closing ON TRUE
          WHERE e.role = 'technician'
            AND ($1 = '' OR CONCAT_WS(' ', e.first_name, e.last_name) ILIKE $2)
          GROUP BY e.employee_id, e.first_name, e.last_name, e.is_active
          -- An inactive technician is kept only while the period still has
          -- their work in it, so last month's report does not quietly lose a
          -- man who left in between. Active technicians are always listed,
          -- including the ones who closed nothing: a row of zeros is the
          -- answer to "who is not being given work", and dropping it hides
          -- exactly the person an admin opened this report to find.
          HAVING e.is_active OR COUNT(closing.to_status) > 0
          ORDER BY COUNT(closing.to_status) DESC, e.first_name, e.last_name, e.employee_id
          LIMIT $5 OFFSET $6;`;
        totalsSql = `
          SELECT
            COALESCE(SUM(jobs_closed), 0)::INTEGER AS jobs_closed,
            COALESCE(SUM(completed_count), 0)::INTEGER AS completed_count,
            COALESCE(SUM(unresolved_count), 0)::INTEGER AS unresolved_count
          FROM (
            SELECT
              COUNT(closing.to_status)::INTEGER AS jobs_closed,
              COUNT(*) FILTER (WHERE closing.to_status = 'completed')::INTEGER AS completed_count,
              COUNT(*) FILTER (WHERE closing.to_status = 'unresolved')::INTEGER AS unresolved_count
            FROM public.employees e
            LEFT JOIN LATERAL (
              SELECT h.to_status
              FROM public.service_tickets t
              JOIN public.service_ticket_history h
                ON h.service_ticket_id = t.service_ticket_id
              WHERE t.assigned_employee_id = e.employee_id
                AND h.to_status IN ('completed', 'unresolved', 'cancelled')
                AND h.from_status IS DISTINCT FROM h.to_status
                AND ($3 = '' OR (h.changed_at AT TIME ZONE 'America/Jamaica')::DATE >= $3::DATE)
                AND ($4 = '' OR (h.changed_at AT TIME ZONE 'America/Jamaica')::DATE <= $4::DATE)
            ) closing ON TRUE
            WHERE e.role = 'technician'
              AND ($1 = '' OR CONCAT_WS(' ', e.first_name, e.last_name) ILIKE $2)
            GROUP BY e.employee_id, e.is_active
            HAVING e.is_active OR COUNT(closing.to_status) > 0
          ) per_technician;`;
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
