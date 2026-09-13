import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient } from "pg";
import { addCableBox, removeCableBox, CableBoxError } from "../src/cableBoxes.js";

const employee = { employeeId: 1, firstName: "Test", lastName: "Staff" };
function fixture(overrides = {}) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const row = { package_id: 7, monthly_fee: "4500.00", additional_cable_boxes: 0, status: "active", service_type: "cable_internet", ...overrides };
  const client = { async query(sql: string, values: unknown[] = []) {
    calls.push({ sql, values });
    return { rows: sql.includes("SELECT") ? [row] : [] };
  } } as unknown as PoolClient;
  return { client, calls };
}

test("adds J$1,000 to the actual rate, retains the package, and writes no payments or ledger charges", async () => {
  const { client, calls } = fixture();
  assert.deepEqual(await addCableBox(client, 10, 0, employee), { additionalCableBoxes: 1, monthlyFee: "5500.00" });
  assert.match(calls[0].sql, /FOR UPDATE OF c/);
  assert.deepEqual(calls[1].values, [1, "5500.00", 10]);
  assert.deepEqual(calls[2].values.slice(0, 3), [10, 7, "5500.00"]);
  assert.match(calls[2].sql, /customer_rate_history/);
  assert.match(calls[3].sql, /audit_logs/);
  assert.equal(calls.length, 4);
  for (const call of calls) assert.doesNotMatch(call.sql, /payments|account_ledger_entries/);
});

test("cable-only and multiple extra boxes increase the existing customer rate", async () => {
  const { client } = fixture({ monthly_fee: "4000.00", additional_cable_boxes: 1, service_type: "cable" });
  assert.deepEqual(await addCableBox(client, 10, 1, employee), { additionalCableBoxes: 2, monthlyFee: "5000.00" });
});

for (const overrides of [{ service_type: "internet" }, { status: "terminated" }, { monthly_fee: null }, { additional_cable_boxes: 1 }]) {
  test(`rejects unsupported or stale account without writing: ${JSON.stringify(overrides)}`, async () => {
    const { client, calls } = fixture(overrides);
    await assert.rejects(addCableBox(client, 10, 0, employee), CableBoxError);
    assert.equal(calls.length, 1);
  });
}
for (const count of [-1, 1.5, "0", null]) {
  test(`rejects invalid count ${JSON.stringify(count)}`, async () => {
    const { client, calls } = fixture();
    await assert.rejects(addCableBox(client, 10, count, employee), CableBoxError);
    assert.equal(calls.length, 0);
  });
}

for (const service_type of ["cable", "cable_internet"]) {
  test(`removes an extra box and J$1,000 for ${service_type} without changing payments`, async () => {
    const { client, calls } = fixture({ service_type, additional_cable_boxes: 1, monthly_fee: "5500.00" });
    assert.deepEqual(await removeCableBox(client, 10, 1, employee), { additionalCableBoxes: 0, monthlyFee: "4500.00" });
    assert.deepEqual(calls[1].values, [0, "4500.00", 10]);
    assert.deepEqual(calls[2].values.slice(0, 3), [10, 7, "4500.00"]);
    assert.equal(calls[3].values[6], "Removed customer cable box");
    assert.equal(calls.length, 4);
    for (const call of calls) assert.doesNotMatch(call.sql, /payments|account_ledger_entries/);
  });
}

test("removing from several boxes subtracts exactly one", async () => {
  const { client } = fixture({ additional_cable_boxes: 3, monthly_fee: "7500.00" });
  assert.deepEqual(await removeCableBox(client, 10, 3, employee), { additionalCableBoxes: 2, monthlyFee: "6500.00" });
});

for (const overrides of [
  { additional_cable_boxes: 0 },
  { additional_cable_boxes: 2 },
  { service_type: "internet" },
  { status: "terminated" },
  { monthly_fee: "500.00" },
]) {
  test(`refuses invalid removal without writes: ${JSON.stringify(overrides)}`, async () => {
    const { client, calls } = fixture({ additional_cable_boxes: 1, ...overrides });
    const expectedCount = overrides.additional_cable_boxes === 0 ? 0 : 1;
    await assert.rejects(removeCableBox(client, 10, expectedCount, employee), CableBoxError);
    assert.equal(calls.length, 1);
  });
}
