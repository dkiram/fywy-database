import assert from "node:assert/strict";
import test from "node:test";
import { buildHtml, buildPlainText, type EmailedReceipt } from "../src/email/receiptEmail.js";
import { buildDisconnectionReminderEmail } from "../src/email/disconnectionReminderEmail.js";
import { loadReceipt } from "../src/routes/payments.js";

const receipt: EmailedReceipt = {
  payment_id: 1, receipt_number: "SPCL-1", payment_type: "Monthly", amount_paid: "2500.00",
  month_paid: "2026-10-01", payment_date: "2026-10-27", recorded_at: "2026-10-27T12:00:00Z",
  location: "Office", cashier_name: "Test Staff", customer_id: 42, application_id: null,
  customer_name: "Test Customer", current_balance: "1250.50",
};
test("receipt HTML and text show current debt, zero, and credit with distinct labels", () => {
  for (const [balance, label, amount] of [
    ["1250.50", "Current balance due", "J$1,250.50"],
    ["0.00", "Current balance due", "J$0.00"],
    ["-300.25", "Current account credit", "J$300.25"],
  ]) {
    for (const render of [buildHtml, buildPlainText]) {
      const result = render({ ...receipt, current_balance: balance });
      assert.ok(result.includes(`${label}: ${amount}`));
      assert.ok(result.includes("J$2,500.00"));
    }
  }
});
test("application receipts without an account do not invent a zero balance", () => {
  for (const render of [buildHtml, buildPlainText]) {
    const output = render({ ...receipt, customer_id: null, application_id: 7, current_balance: null });
    assert.doesNotMatch(output, /Current balance due|Current account credit/);
    assert.match(output, /Application/i);
  }
});
test("reminder balance is present in both email formats without altering the warning", () => {
  const result = buildDisconnectionReminderEmail({ customerId: 42, customerName: "Jane", recipientEmail: "jane@example.com", outstandingBalance: "3456.78", dueDate: "2026-10-22", graceEndDate: "2026-10-29" });
  for (const output of [result.html, result.plainText]) {
    assert.match(output, /Outstanding balance: J\$3,456\.78/);
    assert.match(output, /48 hours/);
    assert.doesNotMatch(output, /Not sure how much you owe/);
  }
});
test("receipt loader supplies the same customer-scoped billing balance to print and email", async () => {
  const client = { query: async (sql: string, values: unknown[]) => {
    assert.match(sql, /billing.balance AS current_balance/);
    assert.match(sql, /LEFT JOIN LATERAL public.spcl_customer_billing_status\(c.customer_id\)/);
    assert.deepEqual(values, [1]);
    return { rows: [receipt] };
  } };
  assert.deepEqual(await loadReceipt(client as any, 1), receipt);
});
