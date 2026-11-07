/** Application refunds are full cash returns, approved separately from collection. */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { pool } from '../db.js';
const router = Router();
function auth(req: Request, res: Response, next: NextFunction) {
  if (!req.session.employee) return res.status(401).json({ error: 'Not authenticated.' });
  next();
}
function manager(req: Request, res: Response, next: NextFunction) {
  if (!['admin', 'head_office'].includes(req.session.employee!.role)) return res.status(403).json({ error: 'Only Head Office and Admin can review refunds.' });
  next();
}
function id(value: unknown) {
  return typeof value === 'string' && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
}
router.get('/applications/:applicationId/refunds', auth, async (req, res) => {
  const applicationId = id(req.params.applicationId);
  if (!applicationId) return res.status(400).json({ error: 'Invalid application.' });
  try {
    const result = await pool.query(`SELECT r.*, CONCAT_WS(' ', e.first_name, e.last_name) AS reviewer_name
      FROM public.application_refunds r LEFT JOIN public.employees e ON e.employee_id = r.reviewed_by_employee_id
      WHERE r.application_id = $1 ORDER BY r.application_refund_id DESC`, [applicationId]);
    res.json({ refunds: result.rows });
  } catch (error) { console.error('Could not load refunds:', error); res.status(500).json({ error: 'Could not load refunds.' }); }
});
router.post('/applications/:applicationId/refunds', auth, async (req, res) => {
  const applicationId = id(req.params.applicationId);
  const returnedOn = typeof req.body?.returnedOn === 'string' ? req.body?.returnedOn : '';
  if (!applicationId || !/^\d{4}-\d{2}-\d{2}$/.test(returnedOn) || Number.isNaN(Date.parse(returnedOn)) || new Date(returnedOn).toISOString().slice(0,10) !== returnedOn) return res.status(400).json({ error: 'Choose a valid return date.' });
  if (req.body?.moneyReturned !== true) return res.status(400).json({ error: 'Confirm that the money was handed back to the applicant.' });
  const employee = req.session.employee!;
  if (!employee.locationId) return res.status(409).json({ error: 'Your staff account needs the office that returned the money.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const app = (await client.query('SELECT * FROM public.applications WHERE application_id = $1 FOR UPDATE', [applicationId])).rows[0];
    if (!app || !['pending', 'match_review', 'legacy_unresolved'].includes(app.status) || app.customer_id) {
      await client.query('ROLLBACK'); return res.status(409).json({ error: 'Refund requests require an active, unactivated application.' });
    }
    const existing = await client.query("SELECT 1 FROM public.application_refunds WHERE application_id = $1 AND status IN ('pending', 'approved')", [applicationId]);
    if (existing.rows.length) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'This application already has a pending or approved refund.' }); }
    const payment = (await client.query(`SELECT *, ($2::DATE >= payment_date AND $2::DATE <= (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE) AS valid_date
      FROM public.payments WHERE application_id = $1 AND voided_at IS NULL AND application_refund_id IS NULL FOR UPDATE`, [applicationId, returnedOn])).rows[0];
    if (!payment || Number(payment.amount_paid) <= 0 || payment.customer_id || !payment.valid_date) {
      await client.query('ROLLBACK'); return res.status(409).json({ error: 'A refund needs an unvoided application payment and a return date between collection day and today.' });
    }
    const location = (await client.query('SELECT name FROM public.locations WHERE location_id = $1 AND is_active = TRUE', [employee.locationId])).rows[0];
    if (!location) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'The returning office is unavailable.' }); }
    const refund = (await client.query(`INSERT INTO public.application_refunds
      (application_id, payment_id, amount, returned_on, location_id, location_name, requested_by_employee_id, cashier_name)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [applicationId, payment.payment_id, payment.amount_paid, returnedOn, employee.locationId, location.name, employee.employeeId, `${employee.firstName} ${employee.lastName}`])).rows[0];
    await client.query(`INSERT INTO public.audit_logs (employee_id, actor_name, action, entity_type, entity_id, field_name, new_value, reason)
      VALUES ($1,$2,'Requested application refund','application',$3,'refund',$4,$5)`,
      [employee.employeeId, refund.cashier_name, String(applicationId), String(refund.application_refund_id), `Money returned ${returnedOn}; ${location.name}; amount ${payment.amount_paid}`]);
    await client.query('COMMIT'); res.status(201).json({ refund });
  } catch (error) { await client.query('ROLLBACK'); console.error('Could not request refund:', error); res.status(500).json({ error: 'Could not request refund.' }); }
  finally { client.release(); }
});
router.post('/applications/:applicationId/refunds/:refundId/review', auth, manager, async (req, res) => {
  const applicationId = id(req.params.applicationId), refundId = id(req.params.refundId);
  const decision = req.body?.decision;
  const note = typeof req.body?.note === 'string' ? req.body?.note.trim() : '';
  if (!applicationId || !refundId || !['approved', 'rejected'].includes(decision) || note.length > 500 || (decision === 'rejected' && note.length < 3)) return res.status(400).json({ error: 'Choose approve or reject; a rejection needs a short explanation.' });
  const employee = req.session.employee!;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const app = (await client.query('SELECT * FROM public.applications WHERE application_id = $1 FOR UPDATE', [applicationId])).rows[0];
    const refund = (await client.query('SELECT * FROM public.application_refunds WHERE application_refund_id = $1 AND application_id = $2 FOR UPDATE', [refundId, applicationId])).rows[0];
    if (!app || !refund || refund.status !== 'pending') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'This refund is no longer awaiting approval.' }); }
    if (decision === 'approved') {
      const payment = (await client.query('SELECT * FROM public.payments WHERE payment_id = $1 FOR UPDATE', [refund.payment_id])).rows[0];
      if (!['pending', 'match_review', 'legacy_unresolved'].includes(app.status) || app.customer_id || !payment || payment.voided_at || payment.customer_id || Number(payment.amount_paid) !== Number(refund.amount)) {
        await client.query('ROLLBACK'); return res.status(409).json({ error: 'The application or payment changed; review it before approving.' });
      }
      // Cash attribution belongs to the returning office/cashier, never the approver.
      await client.query(`INSERT INTO public.payments (application_id, application_refund_id, payment_type, amount_paid, payment_date,
        location_id, location, recorded_by_employee_id, cashier_name, recorded_at, note)
        VALUES ($1,$2,'Refund',-$3::NUMERIC,$4,$5,$6,$7,$8,CURRENT_TIMESTAMP,'Approved application refund')`,
        [applicationId, refundId, refund.amount, refund.returned_on, refund.location_id, refund.location_name, refund.requested_by_employee_id, refund.cashier_name]);
      await client.query(`UPDATE public.applications SET status = 'cancelled', closure_reason = 'Refund', closed_by_employee_id = $2,
        closed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE application_id = $1`, [applicationId, employee.employeeId]);
      // Cancel outstanding installation dispatches so the phone cannot continue a refunded job.
      await client.query(`WITH closed AS (
        SELECT service_ticket_id, status FROM public.service_tickets WHERE application_id = $1 AND status IN ('open','assigned','in_progress','unresolved') FOR UPDATE
      ), updated AS (
        UPDATE public.service_tickets t SET status = 'cancelled', assigned_employee_id = NULL, rescheduled_for = NULL,
          updated_at = CURRENT_TIMESTAMP, updated_by_employee_id = $2 FROM closed c WHERE t.service_ticket_id = c.service_ticket_id RETURNING t.service_ticket_id
      ) INSERT INTO public.service_ticket_history (service_ticket_id,event_type,from_status,to_status,note,changed_by_employee_id)
        SELECT c.service_ticket_id,'status_changed',c.status,'cancelled','Application refunded',$2 FROM closed c JOIN updated u USING(service_ticket_id)`, [applicationId, employee.employeeId]);
    }
    await client.query(`UPDATE public.application_refunds SET status = $2, reviewed_by_employee_id = $3, reviewed_at = CURRENT_TIMESTAMP, review_note = NULLIF($4,'')
      WHERE application_refund_id = $1`, [refundId, decision, employee.employeeId, note]);
    await client.query(`INSERT INTO public.audit_logs (employee_id,actor_name,action,entity_type,entity_id,field_name,old_value,new_value,reason)
      VALUES ($1,$2,$3,'application',$4,'refund','pending',$5,$6)`,
      [employee.employeeId, `${employee.firstName} ${employee.lastName}`, decision === 'approved' ? 'Approved application refund and closed application' : 'Rejected application refund', String(applicationId), decision, note || 'Refund']);
    await client.query('COMMIT'); res.json({ status: decision });
  } catch (error) { await client.query('ROLLBACK'); console.error('Could not review refund:', error); res.status(500).json({ error: 'Could not review refund.' }); }
  finally { client.release(); }
});
export default router;
