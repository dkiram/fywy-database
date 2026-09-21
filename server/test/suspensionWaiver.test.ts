import assert from "node:assert/strict";
import test from "node:test";
import accountsRouter from "../src/routes/accounts.js";
import { pool } from "../src/db.js";

// Exercise both HTTP handlers with a database fixture, without touching a live
// account or OLT. The fixture supplies the database's credit-adjusted quote.
for (const review of [false, true]) {
  for (const scenario of [
    { name: "zero ledger balance with an unpaid return fee", status: "suspended", outstanding: "0.00", quote: "1500.00", amount: "1500.00", allowed: true },
    { name: "holding charges plus return fee", status: "suspended", outstanding: "500.00", quote: "2000.00", amount: "2000.00", allowed: true },
    { name: "advance credit covers part of the return fee", status: "suspended", outstanding: "0.00", quote: "1000.00", amount: "1000.00", allowed: true },
    { name: "a payment since the request reduced the amount due", status: "suspended", outstanding: "0.00", quote: "1000.00", amount: "1500.00", allowed: false },
    { name: "credits already cover the entire return fee", status: "suspended", outstanding: "0.00", quote: "0.00", amount: "1500.00", allowed: false },
    { name: "ordinary accounts retain the outstanding balance cap", status: "active", outstanding: "500.00", quote: null, amount: "1500.00", allowed: false },
    { name: "ordinary balance discount still works", status: "active", outstanding: "500.00", quote: null, amount: "500.00", allowed: true },
  ]) {
    test(`${review ? "approve" : "request"}: ${scenario.name}`, async (t) => {
      const queries: { sql: string; values?: unknown[] }[] = [];
      const request = { waiver_request_id: 1, customer_id: 8465, amount: scenario.amount, reason: "Approved suspension adjustment", status: "pending" };
      const client = {
        async query(sql: string, values?: unknown[]) {
          queries.push({ sql, values });
          if (sql.includes("spcl_customer_billing_status")) {
            return { rows: [{ status: scenario.status, outstanding_balance: scenario.outstanding, total_due_to_reconnect: scenario.quote }] };
          }
          if (sql.includes("FROM public.customers")) return { rows: [{ customer_id: 8465, status: scenario.status }] };
          if (sql.includes("FROM public.waiver_requests")) return { rows: review ? [request] : [] };
          if (sql.includes("INSERT INTO public.waiver_requests")) return { rows: [request] };
          if (sql.includes("SELECT outstanding_balance")) return { rows: [{ outstanding_balance: scenario.outstanding }] };
          if (sql.includes("INSERT INTO public.account_ledger_entries")) return { rows: [{ account_ledger_entry_id: 99, amount: `-${scenario.amount}` }] };
          return { rows: [] };
        },
        release() {},
      };
      t.mock.method(pool, "connect", async () => client);
      const path = review ? "/waiver-requests/:requestId/review" : "/customers/:customerId/waiver-requests";
      const route = accountsRouter.stack.find((layer) => layer.route?.path === path && layer.route.methods.post)!.route;
      let code = 200;
      let body: any;
      const res = {
        status(value: number) { code = value; return this; },
        json(value: unknown) { body = value; return this; },
      };
      await route.stack.at(-1)!.handle({
        params: { customerId: "8465", requestId: "1" },
        body: { amount: scenario.amount, reason: request.reason, decision: "approve", reviewNote: "Verified payments" },
        session: { employee: { employeeId: 2, firstName: "Test", lastName: "Admin", role: "admin" } },
      }, res, () => {});
      const currentDue = Number(scenario.status === "suspended" ? scenario.quote : scenario.outstanding);
      assert.equal(code, scenario.allowed ? (review ? 200 : 201) : (review || currentDue === 0 ? 409 : 400), JSON.stringify(body));
      assert.equal(queries.some(({ sql }) => sql === "COMMIT"), scenario.allowed);
      const ledgerWrites = queries.filter(({ sql }) => sql.includes("INSERT INTO public.account_ledger_entries"));
      assert.equal(ledgerWrites.length, review && scenario.allowed ? 1 : 0);
      if (ledgerWrites.length) assert.equal(ledgerWrites[0].values?.[1], scenario.amount);
      assert.equal(queries.some(({ sql }) => sql.includes("UPDATE public.customers")), false);
    });
  }
}
