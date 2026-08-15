/** Builds the cross-workflow totals and recent activity shown on the dashboard. */
import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { pool } from "../db.js";

// The dashboard intentionally contains only quick operational summaries. Every
// card links to a detailed workflow or report rather than duplicating it here.
const dashboardRouter = Router();

function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session.employee) return res.status(401).json({ error: "Not authenticated." });
  next();
}

dashboardRouter.get("/dashboard", requireAuth, async (_req, res) => {
  try {
    const [summaryResult, trendResult, ticketsResult, activityResult] = await Promise.all([
      pool.query(`
        SELECT
          (SELECT COUNT(*)::INTEGER FROM public.payments
            WHERE payment_date = (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE) AS payments_today,
          (SELECT COALESCE(SUM(amount_paid), 0)::NUMERIC(14,2) FROM public.payments
            WHERE payment_date = (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE) AS payment_total_today,
          (SELECT COUNT(*)::INTEGER FROM public.applications
            WHERE status IN ('pending', 'match_review')) AS pending_applications,
          (SELECT COUNT(*)::INTEGER FROM public.service_tickets
            WHERE status IN ('open', 'assigned', 'in_progress')) AS pending_service_tickets,
          (SELECT COUNT(*)::INTEGER FROM public.customers WHERE status = 'active') AS active_customers,
          (SELECT COUNT(*)::INTEGER FROM public.customers WHERE status = 'disconnected') AS disconnected_customers,
          (SELECT COUNT(*)::INTEGER FROM public.customers WHERE status = 'pending_reconnection') AS pending_reconnections,
          (SELECT COUNT(*)::INTEGER FROM public.pole_boxes) AS pole_boxes,
          (SELECT COUNT(*)::INTEGER FROM public.pole_box_usage
            WHERE duplicate_assignments > 0 OR over_capacity) AS pole_box_alerts;
      `),
      pool.query(`
        WITH dates AS (
          SELECT GENERATE_SERIES(
            (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE - 6,
            (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
            INTERVAL '1 day'
          )::DATE AS payment_date
        )
        SELECT d.payment_date, COUNT(p.payment_id)::INTEGER AS payment_count,
          COALESCE(SUM(p.amount_paid), 0)::NUMERIC(14,2) AS total_amount
        FROM dates d
        LEFT JOIN public.payments p ON p.payment_date = d.payment_date
        GROUP BY d.payment_date
        ORDER BY d.payment_date;
      `),
      pool.query(`
        SELECT t.service_ticket_id, t.customer_id, c.name AS customer_name,
          t.issue_summary, t.priority, t.status, t.reported_date
        FROM public.service_tickets t
        JOIN public.customers c USING (customer_id)
        WHERE t.status IN ('open', 'assigned', 'in_progress')
        ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
          t.reported_date, t.service_ticket_id
        LIMIT 5;
      `),
      pool.query(`
        SELECT actor_name, action, entity_type, entity_id, occurred_at
        FROM public.audit_logs
        ORDER BY occurred_at DESC, audit_log_id DESC
        LIMIT 6;
      `),
    ]);

    res.json({
      summary: {
        ...summaryResult.rows[0],
        // The legacy delinquency formula has not been confirmed. Returning an
        // explicit null prevents the UI from presenting an invented balance.
        delinquent_customers: null,
        delinquency_available: false,
      },
      paymentTrend: trendResult.rows,
      urgentTickets: ticketsResult.rows,
      recentActivity: activityResult.rows,
    });
  } catch (error) {
    console.error("Could not load dashboard:", error);
    res.status(500).json({ error: "Could not load dashboard." });
  }
});

export default dashboardRouter;
