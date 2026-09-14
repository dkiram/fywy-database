import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolClient } from 'pg';
import { ensureMonthlyChargeForPayment, paymentBalanceDeduction } from '../src/routes/paymentMonthCharge.js';

// Drive the guard with a fake client: the first query is the month lookup and
// returns whatever the test says the ledger looks like; any INSERT is
// captured so the test can see exactly what would have been raised.
type LookupRow = {
  month_start: string;
  due_date: string | null;
  is_past: boolean;
  has_charge: boolean;
  service_on: boolean | null;
  status_then: string | null;
  customer_rate_history_id: number | null;
  monthly_fee: string | null;
};

function fakeClient(row: LookupRow, insertRows = 1) {
  const inserts: { sql: string; values: unknown[] }[] = [];
  const client = {
    async query(sql: string, values?: unknown[]) {
      if (/INSERT INTO public\.account_ledger_entries/.test(sql)) {
        inserts.push({ sql, values: values ?? [] });
        return { rows: insertRows ? [{ account_ledger_entry_id: 99 }] : [], rowCount: insertRows };
      }
      return { rows: [row], rowCount: 1 };
    },
  } as unknown as PoolClient;
  return { client, inserts };
}

const baseRow: LookupRow = {
  month_start: '2026-07-01',
  due_date: '2026-07-18',
  is_past: true,
  has_charge: false,
  service_on: true,
  status_then: 'active',
  customer_rate_history_id: 7,
  monthly_fee: '4500.00',
};

const input = { customerId: 6105, monthPaid: '2026-07', employeeId: 2 };

test('a past month that was never billed is charged at the rate in force', async () => {
  const { client, inserts } = fakeClient(baseRow);
  const outcome = await ensureMonthlyChargeForPayment(client, input);
  assert.deepEqual(outcome, { kind: 'charged', dueDate: '2026-07-18', amount: '4500.00' });
  assert.equal(inserts.length, 1);
  const [charge] = inserts;
  assert.match(charge.sql, /'monthly_charge'/);
  // The generator's own key, so the nightly run can never double this month.
  assert.match(charge.sql, /'monthly-charge:' \|\| \(\$1::INTEGER\)::TEXT \|\| ':' \|\| \(\$3::DATE\)::TEXT/);
  assert.deepEqual(charge.values, [6105, '4500.00', '2026-07-18', 7, 2]);
});

test('a month that already has a charge is left alone', async () => {
  const { client, inserts } = fakeClient({ ...baseRow, has_charge: true });
  const outcome = await ensureMonthlyChargeForPayment(client, input);
  assert.deepEqual(outcome, { kind: 'ok', reason: 'already_charged' });
  assert.equal(inserts.length, 0);
});

test('this month or later is left to the generator', async () => {
  const { client, inserts } = fakeClient({ ...baseRow, month_start: '2026-09-01', due_date: '2026-09-18', is_past: false });
  const outcome = await ensureMonthlyChargeForPayment(client, { ...input, monthPaid: '2026-09' });
  assert.deepEqual(outcome, { kind: 'ok', reason: 'not_past' });
  assert.equal(inserts.length, 0);
});

test('a month the customer was disconnected is refused, whether past or current', async () => {
  for (const isPast of [true, false]) {
    const { client, inserts } = fakeClient({ ...baseRow, is_past: isPast, service_on: false, status_then: 'disconnected' });
    const outcome = await ensureMonthlyChargeForPayment(client, input);
    assert.equal(outcome.kind, 'refused');
    if (outcome.kind === 'refused') {
      assert.match(outcome.message, /disconnected in July 2026/);
      assert.match(outcome.message, /does not bill months a customer was cut off/);
      assert.match(outcome.message, /Reconnection Fee/);
    }
    assert.equal(inserts.length, 0);
  }
});

test('pending_reconnection and offline months read as cut off too', async () => {
  for (const status of ['pending_reconnection', 'offline', 'terminated', null]) {
    const { client } = fakeClient({ ...baseRow, service_on: false, status_then: status });
    const outcome = await ensureMonthlyChargeForPayment(client, input);
    assert.equal(outcome.kind, 'refused', `status ${String(status)}`);
  }
});

test('a suspended month is accepted without a package charge', async () => {
  // Suspension bills its own J$500 holding charges; the Monthly Fee payment
  // lands on those, so nothing is raised and nothing is refused.
  const { client, inserts } = fakeClient({ ...baseRow, service_on: false, status_then: 'suspended' });
  const outcome = await ensureMonthlyChargeForPayment(client, input);
  assert.deepEqual(outcome, { kind: 'ok', reason: 'suspended' });
  assert.equal(inserts.length, 0);
});

test('no activation date means nothing to align with', async () => {
  const { client, inserts } = fakeClient({ ...baseRow, due_date: null, service_on: null });
  const outcome = await ensureMonthlyChargeForPayment(client, input);
  assert.deepEqual(outcome, { kind: 'ok', reason: 'no_activation_date' });
  assert.equal(inserts.length, 0);
});

test('no usable rate means no charge is invented', async () => {
  for (const row of [
    { ...baseRow, customer_rate_history_id: null, monthly_fee: null },
    { ...baseRow, monthly_fee: '0.00' },
  ]) {
    const { client, inserts } = fakeClient(row);
    const outcome = await ensureMonthlyChargeForPayment(client, input);
    assert.deepEqual(outcome, { kind: 'ok', reason: 'no_rate' });
    assert.equal(inserts.length, 0);
  }
});

test('a charge the service-timeline trigger drops fails the payment instead of passing silently', async () => {
  const { client } = fakeClient(baseRow, 0);
  await assert.rejects(
    () => ensureMonthlyChargeForPayment(client, input),
    /Could not raise the July 2026 charge for customer 6105/,
  );
});

test('explicit override accepts cut-off months without raising a charge', async () => {
  for (const isPast of [true, false]) {
    const { client, inserts } = fakeClient({ ...baseRow, is_past: isPast, service_on: false, status_then: 'disconnected' });
    const outcome = await ensureMonthlyChargeForPayment(client, { ...input, overrideDisconnectedMonth: true });
    assert.equal(outcome.kind, 'overridden');
    assert.equal(inserts.length, 0);
  }
});

test('past monthly payments only deduct outstanding debt, never creating credit', () => {
  assert.equal(paymentBalanceDeduction('2500', '4000.00', true), '2500.00');
  assert.equal(paymentBalanceDeduction('2500', '1000.25', true), '1000.25');
  assert.equal(paymentBalanceDeduction('2500', '0.00', true), '0.00');
  assert.equal(paymentBalanceDeduction('2500', '-500.00', true), '0.00');
  assert.equal(paymentBalanceDeduction('0.01', '0.02', true), '0.01');
  assert.equal(paymentBalanceDeduction('999999999998.99', '999999999998.98', true), '999999999998.98');
});

test('advance payments retain their full deduction, clearing debt before creating credit', () => {
  for (const balance of ['4000.00', '1000.00', '0.00', '-500.00']) {
    assert.equal(paymentBalanceDeduction('2500', balance, false), '2500.00');
  }
});
