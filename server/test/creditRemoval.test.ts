import assert from "node:assert/strict";
import test from "node:test";
import accountsRouter from "../src/routes/accounts.js";
import applicationsRouter from "../src/routes/applications.js";
import { pool } from "../src/db.js";
const removal = accountsRouter.stack.find(l => l.route?.path === "/customers/:customerId/credit-removals")!.route;
const application = applicationsRouter.stack.find(l => l.route?.path === "/applications" && l.route.methods.post)!.route;
test("credit removal and application email safeguards", async t => {
  async function run(route: any, body: any, role = "admin", credit = 100, failAudit = false) {
    const calls: { sql: string; values: any[] }[] = [];
    let released = false;
    const mock = t.mock.method(pool, "connect", async () => ({
      query: async (sql: string, values: any[] = []) => {
        calls.push({ sql, values });
        if (failAudit && sql.includes("audit_logs")) throw Error("Audit failed");
        return { rows: [{ customer_id: 42, credit_balance: credit, account_ledger_entry_id: 1 }] };
      }, release: () => { released = true; },
    }));
    let status = 200;
    const req = { params: { customerId: "42" }, body, session: { employee: role === "anonymous" ? undefined : { employeeId: 1, role, firstName: "Test", lastName: "User" } } };
    const res = { status(code: number) { status = code; return this; }, json() { return this; } };
    try { for (const layer of route.stack) { let next = false; await layer.handle(req, res, () => { next = true; }); if (!next) break; } }
    finally { mock.mock.restore(); }
    return { status, calls, released };
  }
  for (const role of ["admin", "head_office"]) {
    for (const amount of [25.50, 100]) {
      const r = await run(removal, { amount, reason: "Correct credit" }, role);
      assert.equal(r.status, 201);
      assert.ok(r.calls.some(c => c.sql.includes("FOR UPDATE")));
      const entry = r.calls.find(c => c.sql.includes("INSERT INTO public.account_ledger_entries"))!;
      assert.match(entry.sql, /'adjustment'/);
      assert.equal(entry.values[1], amount);
      assert.ok(r.calls.some(c => c.sql.includes("audit_logs")));
      assert.equal(r.calls.at(-1)?.sql, "COMMIT");
      assert.ok(r.released);
    }
  }
  for (const role of ["branch", "technician", "anonymous"]) {
    const r = await run(removal, { amount: 10, reason: "Correction" }, role);
    assert.equal(r.status, role === "anonymous" ? 401 : 403);
    assert.equal(r.calls.length, 0);
  }
  for (const body of [{ amount: 0 }, { amount: -5 }, { amount: 1.001 }, { amount: "no" }, { amount: 10, reason: " " }]) {
    const r = await run(removal, { reason: "Correction", ...body });
    assert.equal(r.status, 400);
    assert.equal(r.calls.length, 0);
  }
  for (const credit of [0, 5]) {
    const r = await run(removal, { amount: 10, reason: "Correction" }, "admin", credit);
    assert.equal(r.status, 409);
    assert.ok(!r.calls.some(c => c.sql.includes("INSERT")));
    assert.equal(r.calls.at(-1)?.sql, "ROLLBACK");
  }
  const log = t.mock.method(console, "error", () => {});
  const failed = await run(removal, { amount: 10, reason: "Correction" }, "admin", 100, true);
  log.mock.restore();
  assert.equal(failed.status, 500);
  assert.equal(failed.calls.at(-1)?.sql, "ROLLBACK");
  assert.ok(failed.released);
  for (const email of [undefined, "", "   ", "invalid", "a@", "a b@example.com"]) {
    const r = await run(application, { name: "Applicant", address: "Address", telephone: "123", email });
    assert.equal(r.status, 400);
    assert.equal(r.calls.length, 0);
  }
});
