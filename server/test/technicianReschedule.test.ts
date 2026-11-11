import assert from 'node:assert/strict';
import test from 'node:test';
import router from '../src/routes/technicianApp.js';
import { pool } from '../src/db.js';

const route = router.stack.find(l => l.route?.path === '/tech/jobs/:ticketId' && l.route.methods.patch)!.route;
test('field rescheduling', async t => {
  const appointment = new Date(Date.now() + 86400000).toISOString().slice(0, 16);
  async function run(body: unknown, status = 'assigned', owner = 7) {
    const calls: { sql: string; values: unknown[] }[] = [];
    const connection = t.mock.method(pool, 'connect', async () => ({
      query: async (sql: string, values: unknown[] = []) => {
        calls.push({ sql, values });
        if (sql.includes('SELECT * FROM public.service_tickets')) return { rows: [{ service_ticket_id: 42, assigned_employee_id: owner, status }] };
        if (sql.includes('SELECT role')) return { rows: [{ role: 'technician' }] };
        return { rows: [] };
      }, release() {},
    }));
    let code = 200;
    const req = { params: { ticketId: '42' }, body, session: { technician: { employeeId: 7, firstName: 'Test', lastName: 'Worker' } } };
    const res = { status(n: number) { code = n; return this; }, json() { return this; } };
    try { await route.stack[1].handle(req, res); } finally { connection.mock.restore(); }
    return { code, calls };
  }
  for (const status of ['assigned', 'in_progress']) {
    await t.test(`reschedule ${status} work returns it to office with appointment and history`, async () => {
      const result = await run({ rescheduledFor: appointment, note: 'Customer requested tomorrow' }, status);
      assert.equal(result.code, 200);
      const update = result.calls.find(c => c.sql.includes('UPDATE public.service_tickets'))!;
      assert.equal(update.values[0], 'open');
      assert.match(update.sql, /assigned_employee_id = CASE WHEN \$6::TIMESTAMPTZ IS NOT NULL\s+THEN NULL/);
      assert.ok(update.values[5] instanceof Date);
      assert.match(update.sql, /WHEN \$6::TIMESTAMPTZ IS NOT NULL THEN \$6::TIMESTAMPTZ/);
      const history = result.calls.find(c => c.sql.includes('INSERT INTO public.service_ticket_history'))!;
      assert.equal(history.values[3], 'open');
      assert.match(String(history.values[4]), /Rescheduled for/);
      assert.equal(history.values[5], 7);
      assert.equal(result.calls.at(-1)?.sql, 'COMMIT');
    });
  }
  await t.test('stale phone cannot reclaim a returned job', async () => {
    const result = await run({ rescheduledFor: appointment }, 'open', 0);
    assert.equal(result.code, 403);
    assert.equal(result.calls.at(-1)?.sql, 'ROLLBACK');
    assert.ok(!result.calls.some(c => c.sql.includes('UPDATE public.service_tickets')));
  });
  await t.test('invalid appointments and mixed actions do not write', async () => {
    for (const body of [{ rescheduledFor: 'invalid' }, { rescheduledFor: appointment, status: 'completed' }]) {
      const result = await run(body);
      assert.equal(result.code, 400);
      assert.equal(result.calls.length, 0);
    }
  });
  await t.test('completion keeps its existing attribution', async () => {
    const result = await run({ status: 'completed', note: 'Installed and tested' });
    assert.equal(result.code, 200);
    const update = result.calls.find(c => c.sql.includes('UPDATE public.service_tickets'))!;
    assert.equal(update.values[0], 'completed');
    assert.equal(update.values[5], null);
    assert.match(update.sql, /THEN NULL ELSE assigned_employee_id END/);
  });
});
