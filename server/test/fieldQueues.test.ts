import assert from 'node:assert/strict';
import test from 'node:test';
import tickets from '../src/routes/serviceTickets.js';
import applications from '../src/routes/applications.js';
import { pool } from '../src/db.js';

test('office queues keep engineer returns separate', async t => {
  async function query(router: typeof tickets, path: string, view: string, onDate = '') {
    const queries: string[] = [];
    const mock = t.mock.method(pool, 'query', async (sql: string) => {
      queries.push(sql);
      return { rows: [{ total: 1 }] };
    });
    let status = 200;
    const response = { status(code: number) { status = code; return this; }, json() { return this; } };
    const route = router.stack.find(layer => layer.route?.path === path && layer.route.methods.get)!.route;
    try {
      await route.stack[1].handle({ query: { view, onDate } }, response);
      assert.equal(status, 200);
      return queries;
    } finally { mock.mock.restore(); }
  }
  await t.test('Open excludes returned work even with a date filter', async () => {
    for (const date of ['', '2026-11-07']) {
      const queries = await query(tickets, '/service-tickets', 'open', date);
      assert.match(queries[0], /t.status = 'open' AND t.field_return_kind IS NULL/);
      assert.match(queries[1], /t.status = 'open' AND t.field_return_kind IS NULL/);
    }
  });
  await t.test('Unresolved remains separate from explicit returns', async () => {
    const queries = await query(tickets, '/service-tickets', 'unresolved');
    assert.match(queries[0], /WHERE \(t.status = 'unresolved'\)/);
    assert.match(queries[2], /COUNT\(\*\) FILTER \(WHERE status = 'unresolved'\)::INTEGER AS unresolved/);
  });
  await t.test('Sent Back contains only explicit technician returns', async () => {
    for (const date of ['', '2026-11-07']) {
      const queries = await query(tickets, '/service-tickets', 'sent_back', date);
      assert.match(queries[0], /WHERE \(t.status = 'open' AND t.field_return_kind = 'technician_sent_back'\)/);
    }
  });
  await t.test('Engineers includes both outcomes and prioritizes completion before pagination', async () => {
    const queries = await query(tickets, '/service-tickets', 'engineers');
    assert.match(queries[0], /IN \('engineer_completed', 'engineer_sent_back'\)/);
    assert.match(queries[1], /ORDER BY\s+\(t.field_return_kind = 'engineer_completed'\) DESC NULLS LAST/);
  });
  await t.test('application Sent Back excludes engineer returns from rows and counts', async () => {
    const queries = await query(applications, '/applications', 'sent_back');
    for (const sql of queries.slice(0, 2)) {
      assert.match(sql, /= 'technician_sent_back'/);
      assert.doesNotMatch(sql, /IN \('unresolved', 'open'\)/);
    }
  });
  await t.test('application Unresolved contains unsuccessful visits only', async () => {
    const queries = await query(applications, '/applications', 'install_failed');
    assert.match(queries[0], /= 'unresolved'/);
    assert.doesNotMatch(queries[0], /= 'open'/);
  });
  await t.test('application Engineers includes both outcomes', async () => {
    const queries = await query(applications, '/applications', 'engineers');
    assert.match(queries[0], /IN \('engineer_completed', 'engineer_sent_back'\)/);
    assert.match(queries[1], /ORDER BY \(install.field_return_kind = 'engineer_completed'\) DESC NULLS LAST/);
  });
});
