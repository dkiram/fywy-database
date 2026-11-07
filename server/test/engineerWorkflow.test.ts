import assert from 'node:assert/strict';
import test from 'node:test';
import router from '../src/routes/technicianApp.js';
import { pool } from '../src/db.js';

const route = router.stack.find(layer => layer.route?.path === '/tech/jobs/:ticketId' && layer.route.methods.patch)!.route;

test('field completion and office handoff', async t => {
  async function run(role: string, body: unknown, assignedId = 7, failHistory = false) {
    const calls: { sql: string; values: any[] }[] = [];
    const mock = t.mock.method(pool, 'connect', async () => ({
      query: async (sql: string, values: any[] = []) => {
        calls.push({ sql, values });
        if (failHistory && sql.includes('INSERT INTO public.service_ticket_history')) throw Error('history unavailable');
        if (sql.includes('SELECT * FROM public.service_tickets')) return { rows: [{ service_ticket_id: 42, assigned_employee_id: assignedId, status: 'in_progress' }] };
        if (sql.includes('SELECT role FROM')) return { rows: [{ role }] };
        return { rows: [{}] };
      }, release() {},
    }));
    let status = 200;
    let payload: any;
    const response = { status(code: number) { status = code; return this; }, json(value: unknown) { payload = value; return this; } };
    await route.stack[1].handle({ params: { ticketId: '42' }, body, session: { technician: { employeeId: 7, firstName: 'Andrew', lastName: 'Morgan' } } }, response);
    mock.mock.restore();
    return { calls, status, payload };
  }
  await t.test('engineer Done reopens and unassigns instead of closing the job', async () => {
    const result = await run('engineer', { status: 'completed', note: 'Network restored' });
    assert.equal(result.status, 200);
    assert.equal(result.payload.engineerCompleted, true);
    const update = result.calls.find(c => c.sql.includes('UPDATE public.service_tickets'))!;
    assert.match(update.sql, /status = 'open'/);
    assert.match(update.sql, /assigned_employee_id = NULL/);
    assert.match(update.sql, /completed_at = NULL/);
    assert.equal(update.values[3], 'engineer_completed');
    assert.equal(result.calls.at(-1)?.sql, 'COMMIT');
  });
  await t.test('technician Done still completes the ticket', async () => {
    const result = await run('technician', { status: 'completed', note: 'Installation finished' });
    assert.equal(result.status, 200);
    const update = result.calls.find(c => c.sql.includes('UPDATE public.service_tickets'))!;
    assert.equal(update.values[0], 'completed');
    assert.equal(update.values[1], true);
    assert.doesNotMatch(update.sql, /field_return_kind/);
  });
  for (const role of ['engineer', 'technician']) {
    await t.test(`${role} send-back records its own badge`, async () => {
      const result = await run(role, { handBack: true, note: 'Needs another visit' });
      assert.equal(result.status, 200);
      assert.equal(result.calls.find(c => c.sql.includes('UPDATE public.service_tickets'))!.values[3], `${role}_sent_back`);
    });
  }
  await t.test('Start retains assignment and moves to in progress', async () => {
    const result = await run('engineer', { status: 'in_progress' });
    assert.equal(result.status, 200);
    const update = result.calls.find(c => c.sql.includes('UPDATE public.service_tickets'))!;
    assert.equal(update.values[0], 'in_progress');
    assert.doesNotMatch(update.sql, /assigned_employee_id = NULL/);
  });
  await t.test('engineer completion requires notes', async () => {
    const result = await run('engineer', { status: 'completed', note: '' });
    assert.equal(result.status, 400);
    assert.equal(result.calls.at(-1)?.sql, 'ROLLBACK');
  });
  await t.test('stale phone cannot complete a reassigned job', async () => {
    const result = await run('engineer', { status: 'completed', note: 'Done here' }, 8);
    assert.equal(result.status, 403);
    assert.ok(!result.calls.some(c => c.sql.includes('UPDATE public.service_tickets')));
  });
  await t.test('failed history rolls back the handoff', async () => {
    const log = t.mock.method(console, 'error', () => {});
    const result = await run('engineer', { status: 'completed', note: 'Done here' }, 7, true);
    log.mock.restore();
    assert.equal(result.status, 500);
    assert.equal(result.calls.at(-1)?.sql, 'ROLLBACK');
  });
});
