import assert from "node:assert/strict";
import test from "node:test";
import applicationsRouter from "../src/routes/applications.js";
import { pool } from "../src/db.js";

const route = applicationsRouter.stack.find((layer) =>
  layer.route?.path === "/applications/:applicationId" && layer.route.methods.patch
)!.route;

test("application corrections", async (t) => {
  async function run(body: unknown, options: { authenticated?: boolean; found?: boolean; failAudit?: boolean } = {}) {
    const calls: { sql: string; values: unknown[] }[] = [];
    let released = false;
    const connection = t.mock.method(pool, "connect", async () => ({
      query: async (sql: string, values: unknown[] = []) => {
        calls.push({ sql, values });
        if (options.failAudit && sql.includes("audit_logs")) throw new Error("Audit unavailable");
        return { rows: sql.startsWith("SELECT") && options.found !== false
          ? [{ application_id: 42, name: "Jnae", telephone: "123", status: "serviced", customer_id: 7 }]
          : [] };
      },
      release: () => { released = true; },
    }));
    let status = 200;
    let payload: any;
    const request = {
      params: { applicationId: "42" }, body,
      session: { employee: options.authenticated === false ? undefined : {
        employeeId: 1, firstName: "Test", lastName: "Staff", role: "branch",
      } },
    };
    const response = { status(code: number) { status = code; return this; }, json(value: unknown) { payload = value; return this; } };
    let authorized = false;
    route.stack[0].handle(request, response, () => { authorized = true; });
    if (authorized) await route.stack[1].handle(request, response);
    connection.mock.restore();
    return { status, payload, calls, released };
  }

  const body = { changes: { name: " Jane ", telephone: "456" }, original: { name: "Jnae", telephone: "123" } };
  await t.test("saves trimmed corrections and audits without altering the linked account or payment", async () => {
    const result = await run(body);
    assert.equal(result.status, 200);
    assert.equal(result.payload.application.name, "Jane");
    assert.equal(result.payload.application.telephone, "456");
    assert.equal(result.payload.application.customer_id, 7);
    assert.equal(result.calls.filter((call) => call.sql.includes("audit_logs")).length, 2);
    assert.deepEqual(result.calls.find((call) => call.sql.includes("audit_logs"))!.values.slice(3), ["name", "Jnae", "Jane"]);
    assert.equal(result.calls.at(-1)!.sql, "COMMIT");
    assert.ok(result.released);
    result.calls.forEach(({ sql }) => assert.doesNotMatch(sql, /UPDATE public.customers|payments/));
  });
  await t.test("refuses unauthenticated edits", async () => {
    const result = await run(body, { authenticated: false });
    assert.equal(result.status, 401);
    assert.equal(result.calls.length, 0);
  });
  await t.test("rejects empty names and fields outside applicant details", async () => {
    for (const changes of [{ name: " " }, { status: "pending" }, { name: 123 }]) {
      const result = await run({ ...body, changes });
      assert.equal(result.status, 400);
      assert.equal(result.calls.length, 0);
    }
  });
  await t.test("does not overwrite another employee's correction", async () => {
    const result = await run({ ...body, original: { name: "Different", telephone: "123" } });
    assert.equal(result.status, 409);
    assert.equal(result.calls.at(-1)!.sql, "ROLLBACK");
    assert.ok(!result.calls.some(({ sql }) => sql.startsWith("UPDATE")));
  });
  await t.test("reports missing applications", async () => {
    const result = await run(body, { found: false });
    assert.equal(result.status, 404);
    assert.equal(result.calls.at(-1)!.sql, "ROLLBACK");
  });
  await t.test("rolls back if audit writing fails", async () => {
    const log = t.mock.method(console, "error", () => {});
    const result = await run(body, { failAudit: true });
    log.mock.restore();
    assert.equal(result.status, 500);
    assert.equal(result.calls.at(-1)!.sql, "ROLLBACK");
    assert.ok(result.released);
  });
});
