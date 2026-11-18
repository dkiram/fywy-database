import assert from 'node:assert/strict';
import test from 'node:test';
import router from '../src/routes/payments.js';
import { pool } from '../src/db.js';

const route = router.stack.find(l => l.route?.path === '/payments/daily-summary')!.route;
test('daily payment location filter', async t => {
  async function run(query: Record<string, string>, role = 'admin') {
    const calls: { sql: string; values: unknown[] }[] = [];
    const mock = t.mock.method(pool, 'query', async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      if (sql.includes('FROM public.locations')) return { rows: [{ location_id: 2, name: 'Newport' }, { location_id: 3, name: 'Mandeville' }] };
      if (sql.includes('AS selected_date')) return { rows: [{ selected_date: '2026-11-18' }] };
      if (sql.includes('AS average_amount')) return { rows: [{ payment_count: 26, total_amount: '1000', average_amount: '100', refund_amount: '-100' }] };
      return { rows: [] };
    });
    let code = 200;
    let payload: any;
    const req = { query, session: { employee: { role, locationId: 2, locationName: 'Newport' } } };
    const res = { status(n: number) { code = n; return this; }, json(value: unknown) { payload = value; return this; } };
    try {
      let authorized = false;
      route.stack[0].handle(req, res, () => { route.stack[1].handle(req, res, () => { authorized = true; }); });
      if (authorized) await route.stack[2].handle(req, res);
    } finally { mock.mock.restore(); }
    return { code, payload, calls };
  }
  await t.test('office filter scopes totals, refunds, breakdowns and ledger before pagination', async () => {
    const result = await run({ date: '2026-11-18', locationId: '2', page: '2' });
    assert.equal(result.code, 200);
    assert.equal(result.payload.scope, 'Newport');
    assert.equal(result.payload.locations.length, 2);
    const payments = result.calls.filter(c => c.sql.includes('FROM public.payments pay'));
    assert.equal(payments.length, 4);
    for (const call of payments) {
      assert.deepEqual(call.values.slice(0, 3), ['2026-11-18', 2, 'Newport']);
      assert.match(call.sql, /pay.location_id = \$2/);
      assert.match(call.sql, /pay.location_id IS NULL/);
      assert.match(call.sql, /LOWER\(TRIM\(\$3\)\)/);
      assert.match(call.sql, /pay.voided_at IS NULL/);
    }
    assert.deepEqual(payments.at(-1)!.values.slice(3), [25, 25]);
  });
  await t.test('all locations retains the original scope', async () => {
    const result = await run({ date: '2026-11-18' });
    assert.equal(result.payload.scope, 'All locations');
    assert.equal(result.calls.find(c => c.sql.includes('FROM public.payments pay'))!.values[1], null);
  });
  await t.test('invalid and unknown offices fail rather than showing all payments', async () => {
    for (const locationId of ['abc', '-1', '0', '99999', '9']) assert.equal((await run({ locationId })).code, 400);
  });
  await t.test('filter does not broaden access for non-admin staff', async () => {
    const result = await run({ locationId: '3' }, 'branch');
    assert.equal(result.code, 403);
    assert.equal(result.calls.length, 0);
  });
});
