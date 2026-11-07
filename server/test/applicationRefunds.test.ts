import assert from 'node:assert/strict';
import test from 'node:test';
import router from '../src/routes/applicationRefunds.js';
import { pool } from '../src/db.js';

test('application refund requests and approvals', async t => {
  async function run(kind: 'request' | 'review', body: unknown, options: {
    role?: string; authenticated?: boolean; appStatus?: string; duplicate?: boolean;
    refundStatus?: string; voided?: boolean; validDate?: boolean; amount?: string;
    locationId?: number | null; failAudit?: boolean;
  } = {}) {
    const calls: { sql: string; values: any[] }[] = [];
    const refund = { application_refund_id: 9, application_id: 42, payment_id: 7, amount: '7000.00', returned_on: '2026-11-05', location_id: 3, location_name: 'Newport', requested_by_employee_id: 11, cashier_name: 'Branch Cashier', status: options.refundStatus ?? 'pending' };
    let released = false;
    const mock = t.mock.method(pool, 'connect', async () => ({
      query: async (sql: string, values: any[] = []) => {
        calls.push({ sql, values });
        if (options.failAudit && sql.includes('INSERT INTO public.audit_logs')) throw Error('Audit unavailable');
        if (sql.startsWith('SELECT * FROM public.applications')) return { rows: [{ application_id: 42, status: options.appStatus ?? 'pending', customer_id: null }] };
        if (sql.startsWith('SELECT 1 FROM public.application_refunds')) return { rows: options.duplicate ? [{}] : [] };
        if (sql.includes('FROM public.payments')) return { rows: [{ payment_id: 7, amount_paid: options.amount ?? '7000.00', customer_id: null, voided_at: options.voided ? '2026-11-04' : null, valid_date: options.validDate ?? true }] };
        if (sql.startsWith('SELECT name FROM public.locations')) return { rows: [{ name: 'Newport' }] };
        if (sql.includes('INSERT INTO public.application_refunds') || sql.startsWith('SELECT * FROM public.application_refunds')) return { rows: [refund] };
        return { rows: [] };
      }, release() { released = true; },
    }));
    let status = 200; let payload: any;
    const response = { status(code: number) { status = code; return this; }, json(data: unknown) { payload = data; return this; } };
    const request = { params: { applicationId: '42', refundId: '9' }, body, session: { employee: options.authenticated === false ? undefined : {
      employeeId: kind === 'request' ? 11 : 99, firstName: 'Office', lastName: 'Person', role: options.role ?? (kind === 'request' ? 'branch' : 'head_office'), locationId: options.locationId === undefined ? 3 : options.locationId,
    } } };
    const path = kind === 'request' ? '/applications/:applicationId/refunds' : '/applications/:applicationId/refunds/:refundId/review';
    const route = router.stack.find(layer => layer.route?.path === path && layer.route.methods.post)!.route;
    try {
      for (const layer of route.stack) {
        let next = false;
        await layer.handle(request, response, () => { next = true; });
        if (!next) break;
      }
    } finally { mock.mock.restore(); }
    return { status, payload, calls, released };
  }
  const request = { returnedOn: '2026-11-05', moneyReturned: true };
  await t.test('request fixes full amount, returning office and cashier without changing totals', async () => {
    const result = await run('request', request);
    assert.equal(result.status, 201);
    const insert = result.calls.find(c => c.sql.includes('INSERT INTO public.application_refunds'))!;
    assert.deepEqual(insert.values, [42, 7, '7000.00', '2026-11-05', 3, 'Newport', 11, 'Office Person']);
    assert.ok(!result.calls.some(c => c.sql.includes('INSERT INTO public.payments') || c.sql.includes('UPDATE public.applications')));
    assert.equal(result.calls.at(-1)?.sql, 'COMMIT');
    assert.ok(result.released);
  });
  await t.test('approval posts one negative return-day transaction, preserves receipt and closes jobs', async () => {
    const result = await run('review', { decision: 'approved' });
    assert.equal(result.status, 200);
    const payment = result.calls.find(c => c.sql.includes('INSERT INTO public.payments'))!;
    assert.match(payment.sql, /'Refund',-\$3::NUMERIC/);
    assert.deepEqual(payment.values, [42, 9, '7000.00', '2026-11-05', 3, 'Newport', 11, 'Branch Cashier']);
    assert.ok(!result.calls.some(c => /UPDATE public.payments|DELETE FROM public.payments/.test(c.sql)));
    assert.match(result.calls.find(c => c.sql.includes('UPDATE public.applications'))!.sql, /closure_reason = 'Refund'/);
    assert.ok(result.calls.some(c => c.sql.includes('Application refunded') && c.sql.includes('service_ticket_history')));
    assert.equal(result.calls.at(-1)?.sql, 'COMMIT');
  });
  await t.test('branch cannot approve and unauthenticated callers cannot request', async () => {
    for (const result of [await run('review', { decision: 'approved' }, { role: 'branch' }), await run('request', request, { authenticated: false })]) {
      assert.ok([401, 403].includes(result.status)); assert.equal(result.calls.length, 0);
    }
  });
  await t.test('invalid dates, unconfirmed cash and missing office are rejected', async () => {
    for (const body of [{ ...request, returnedOn: '2026-02-30' }, { ...request, moneyReturned: false }]) assert.equal((await run('request', body)).status, 400);
    assert.equal((await run('request', request, { locationId: null })).status, 409);
    assert.equal((await run('request', request, { validDate: false })).status, 409);
  });
  await t.test('duplicate requests and repeated approvals do not post money twice', async () => {
    assert.equal((await run('request', request, { duplicate: true })).status, 409);
    const result = await run('review', { decision: 'approved' }, { refundStatus: 'approved' });
    assert.equal(result.status, 409);
    assert.ok(!result.calls.some(c => c.sql.includes('INSERT INTO public.payments')));
  });
  await t.test('closed applications and changed payments cannot be refunded', async () => {
    assert.equal((await run('request', request, { appStatus: 'serviced' })).status, 409);
    for (const options of [{ voided: true }, { amount: '6000.00' }, { appStatus: 'cancelled' }]) {
      assert.equal((await run('review', { decision: 'approved' }, options)).status, 409);
    }
  });
  await t.test('rejection records review without closing application or changing totals', async () => {
    assert.equal((await run('review', { decision: 'rejected' })).status, 400);
    const result = await run('review', { decision: 'rejected', note: 'Amount needs checking' });
    assert.equal(result.status, 200);
    assert.ok(!result.calls.some(c => c.sql.includes('INSERT INTO public.payments') || c.sql.includes('UPDATE public.applications')));
  });
  await t.test('audit failure rolls back financial and application changes', async () => {
    const log = t.mock.method(console, 'error', () => {});
    const result = await run('review', { decision: 'approved' }, { failAudit: true });
    log.mock.restore();
    assert.equal(result.status, 500); assert.equal(result.calls.at(-1)?.sql, 'ROLLBACK'); assert.ok(result.released);
  });
});

test('paid applications cannot bypass approval by using Not Serviced', async t => {
  const { default: applications } = await import('../src/routes/applications.js');
  const route = applications.stack.find(layer => layer.route?.path === '/applications/:applicationId/close' && layer.route.methods.patch)!.route;
  const calls: string[] = [];
  t.mock.method(pool, 'connect', async () => ({
    query: async (sql: string) => {
      calls.push(sql);
      if (sql.includes('FROM public.applications')) return { rows: [{ status: 'pending', legacy_source: null }] };
      if (sql.includes('FROM public.payments')) return { rows: [{}] };
      return { rows: [] };
    }, release() {},
  }));
  let status = 200; let payload: any;
  const res = { status(code: number) { status = code; return this; }, json(data: unknown) { payload = data; return this; } };
  await route.stack[2].handle({ params: { applicationId: '42' }, body: { status: 'cancelled' }, session: { employee: { employeeId: 99 } } }, res);
  assert.equal(status, 409);
  assert.match(payload.error, /Request a refund/);
  assert.ok(!calls.some(sql => sql.includes('UPDATE public.payments') || sql.includes('UPDATE public.applications')));
  assert.equal(calls.at(-1), 'ROLLBACK');
});
