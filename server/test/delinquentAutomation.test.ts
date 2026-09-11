import assert from 'node:assert/strict';
import test from 'node:test';
import { pool } from '../src/db.js';
import { runAutomaticDelinquentDisconnect } from '../src/huawei/delinquentAutomation.js';

// Exercise the actual scheduler with a fake DB. No customer/device is selected,
// so these regression tests never open a network connection or disconnect anyone.
for (const policy of [undefined, true, false]) {
  test(`scheduler uses imported-balance policy ${String(policy)} consistently`, async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-09T05:10:00Z') });
    const oldEnabled = process.env.HUAWEI_OLT_AUTOMATION_ENABLED;
    const oldHolidays = process.env.HUAWEI_OLT_AUTOMATION_ADDITIONAL_HOLIDAYS;
    process.env.HUAWEI_OLT_AUTOMATION_ENABLED = 'true';
    process.env.HUAWEI_OLT_AUTOMATION_ADDITIONAL_HOLIDAYS = '';
    t.after(() => {
      if (oldEnabled === undefined) delete process.env.HUAWEI_OLT_AUTOMATION_ENABLED;
      else process.env.HUAWEI_OLT_AUTOMATION_ENABLED = oldEnabled;
      if (oldHolidays === undefined) delete process.env.HUAWEI_OLT_AUTOMATION_ADDITIONAL_HOLIDAYS;
      else process.env.HUAWEI_OLT_AUTOMATION_ADDITIONAL_HOLIDAYS = oldHolidays;
    });
    let selected = false;
    const query = async (sql: string, values?: unknown[]) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
      if (sql.includes('COUNT(*) OVER()')) {
        selected = true;
        assert.equal(values?.[3], policy ?? true);
        assert.match(sql, /billing\.eligible_for_disconnection/);
        assert.match(sql, /customer\.hidden_from_app = FALSE/);
        assert.match(sql, /earlier_item\.customer_id = customer\.customer_id/);
      }
      if (sql.includes('INSERT INTO public.olt_automation_runs')) {
        return { rows: [{ olt_automation_run_id: 1 }] };
      }
      return { rows: [] };
    };
    t.mock.method(pool, 'connect', async () => ({ query, release() {} }));
    t.mock.method(pool, 'query', query);
    const result = await runAutomaticDelinquentDisconnect(
      policy === undefined ? {} : { includeUnverifiedLedgerEntries: policy },
    );
    assert.equal(selected, true);
    assert.equal(result.ran, true);
    if (result.ran) assert.equal(result.disconnected, 0);
  });
}
