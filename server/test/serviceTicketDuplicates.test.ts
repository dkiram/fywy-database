import assert from 'node:assert/strict';
import test from 'node:test';
import router from '../src/routes/serviceTickets.js';
import { pool } from '../src/db.js';

const route = router.stack.find(l => l.route?.path === '/service-tickets' && l.route.methods.post)!.route;

test('service ticket duplicate protection', async t => {
  async function run(existingStatus: string | null) {
    const calls: { sql: string; values: unknown[] }[] = [];
    let released = false;
    const connection = t.mock.method(pool, 'connect', async () => ({
      query: async (sql: string, values: unknown[] = []) => {
        calls.push({ sql, values });
        if (sql.includes('FROM public.customers')) return { rows: [{ customer_id: 9, name: 'Customer' }] };
        if (sql.includes('FROM public.service_tickets')) {
          assert.match(sql, /customer_id = \$1 AND status <> 'completed'/);
          assert.equal(values[0], 9);
          return { rows: existingStatus && existingStatus !== 'completed' ? [{ service_ticket_id: 42, status: existingStatus, issue_summary: 'Existing problem' }] : [] };
        }
        if (sql.includes('INSERT INTO public.service_tickets')) return { rows: [{ service_ticket_id: 43, status: 'open' }] };
        return { rows: [] };
      }, release() { released = true; },
    }));
    let code = 200;
    let payload: any;
    const req = { body: { customerId: '9', issueSummary: 'Internet down', priority: 'normal', reportedDate: '2026-11-13' }, session: { employee: { employeeId: 1, firstName: 'Office', lastName: 'Staff' } } };
    const res = { status(n: number) { code = n; return this; }, json(value: unknown) { payload = value; return this; } };
    try { await route.stack[1].handle(req, res); } finally { connection.mock.restore(); }
    return { code, payload, calls, released };
  }
  for (const status of ['open', 'assigned', 'in_progress', 'unresolved', 'cancelled']) {
    await t.test(`blocks ${status} and returns existing ticket without writing`, async () => {
      const result = await run(status);
      assert.equal(result.code, 409);
      assert.equal(result.payload.existingTicket.service_ticket_id, 42);
      assert.match(result.payload.error, /Update the existing ticket/);
      assert.ok(!result.calls.some(c => c.sql.includes('INSERT INTO')));
      assert.equal(result.calls.at(-1)?.sql, 'ROLLBACK');
      assert.ok(result.released);
    });
  }
  for (const status of [null, 'completed']) {
    await t.test(`permits creation with ${status ?? 'no'} prior ticket`, async () => {
      const result = await run(status);
      assert.equal(result.code, 201);
      assert.equal(result.payload.ticket.service_ticket_id, 43);
      assert.equal(result.calls.at(-1)?.sql, 'COMMIT');
      // The customer lock must precede the duplicate check, so concurrent
      // requests serialize even when there is no ticket row to lock yet.
      const lock = result.calls.findIndex(c => c.sql.includes('FROM public.customers') && c.sql.includes('FOR UPDATE'));
      const check = result.calls.findIndex(c => c.sql.includes('FROM public.service_tickets'));
      assert.ok(lock > 0 && lock < check);
    });
  }
});
