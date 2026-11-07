import assert from 'node:assert/strict';
import test from 'node:test';
import reports from '../src/routes/reports.js';
import { pool } from '../src/db.js';

const route = reports.stack.find(layer => layer.route?.path === '/reports/payments-by-location/cashiers')!.route;
test('location cashier report', async t => {
  async function run(query: Record<string, string>, role: string | null = 'admin') {
    const calls: { sql: string; values: unknown[] }[] = [];
    const mock = t.mock.method(pool, 'query', async (sql: string, values: unknown[]) => {
      calls.push({ sql, values });
      return { rows: [{ cashier_key: 'employee:1', cashier: 'Cashier', payment_count: 2, recorded_amount: '14000.00', voided_payments: '7000.00', refund_amount: '-1000.00', net_amount: '6000.00', void_count: 0, voided_by_cashier: '0.00' }] };
    });
    let status = 200; let body: any;
    const response = { status(code: number) { status = code; return this; }, json(value: unknown) { body = value; return this; } };
    try {
      for (const layer of route.stack) {
        let next = false;
        await layer.handle({ query, session: { employee: role ? { role } : undefined } }, response, () => { next = true; });
        if (!next) break;
      }
    } finally { mock.mock.restore(); }
    return { status, body, calls };
  }
  const query = { location: 'Newport', from: '2026-11-01', to: '2026-11-07' };
  await t.test('requires the same admin access as its parent report', async () => {
    for (const role of [null, 'branch', 'head_office']) {
      const result = await run(query, role);
      assert.equal(result.status, role ? 403 : 401); assert.equal(result.calls.length, 0);
    }
  });
  await t.test('rejects impossible dates, reverse ranges, and missing location', async () => {
    for (const change of [{ from: '2026-02-30' }, { from: '2026-11-08' }, { location: '' }, { to: '' }]) {
      const result = await run({ ...query, ...change });
      assert.equal(result.status, 400); assert.equal(result.calls.length, 0);
    }
  });
  await t.test('preserves selected dates and binds location as data', async () => {
    const location = "Newport ' OR 1=1 --";
    const result = await run({ ...query, location });
    assert.equal(result.status, 200);
    assert.deepEqual(result.calls[0].values, [location, query.from, query.to]);
    assert.ok(!result.calls[0].sql.includes(location));
    assert.equal(result.body.rows[0].net_amount, '6000.00');
  });
  await t.test('separates the original cashier from the voiding actor and keeps zero-activity staff', async () => {
    const { calls } = await run(query);
    const sql = calls[0].sql;
    assert.match(sql, /e.employee_id = p.recorded_by_employee_id/);
    assert.match(sql, /e.employee_id = p.voided_by_employee_id/);
    assert.match(sql, /p.payment_date BETWEEN \$2::DATE AND \$3::DATE/);
    assert.match(sql, /p.voided_at AT TIME ZONE 'America\/Jamaica'/);
    assert.match(sql, /FROM public.employees e JOIN public.locations/);
    assert.match(sql, /GROUP BY cashier_key/);
  });
});
