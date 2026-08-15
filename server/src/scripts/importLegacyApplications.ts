import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PoolClient } from "pg";
import { pool } from "../db.js";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(scriptDirectory, "../../..");
const databaseDirectory = path.join(projectDirectory, "database");

const currentCsvPath = path.resolve(
  process.argv[2] ?? path.join(projectDirectory, "appl.csv")
);
const copiedCsvPath = path.resolve(
  process.argv[3] ?? path.join(projectDirectory, "copyofappl.csv")
);

const currentColumns = [
  "application_id",
  "name",
  "alias",
  "address",
  "occupation",
  "telephone",
  "email",
  "id_type",
  "id_number",
  "package_id",
  "monthly_fee",
  "application_date",
  "card_number",
  "activation_date",
  "adult_channel",
  "additional_box",
  "pole_box_number",
  "port_number",
] as const;

const copiedColumns = currentColumns.slice(0, 16);

const expectedCurrentHeaders = [
  "Application ID",
  "Name",
  "Alias",
  "Address",
  "Occupation",
  "Tel #",
  "Email",
  "ID Type",
  "ID No",
  "Package",
  "Monthly Fee",
  "Application Date",
  "Card #",
  "Activation Date",
  "Adult Channel",
  "Additional Box",
  "Pole Box No",
  "Port No",
];

const expectedCopiedHeaders = expectedCurrentHeaders.slice(0, 16);

function parseCsv(csvText: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let insideQuotes = false;

  for (let index = 0; index < csvText.length; index += 1) {
    const character = csvText[index];

    if (insideQuotes) {
      if (character === '"') {
        if (csvText[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          insideQuotes = false;
        }
      } else if (character !== "\r") {
        field += character;
      }
      continue;
    }

    if (character === '"') {
      insideQuotes = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (character !== "\r") {
      field += character;
    }
  }

  if (insideQuotes) {
    throw new Error("CSV ended inside a quoted field.");
  }

  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter(
    (parsedRow) =>
      parsedRow.length > 1 || parsedRow.some((value) => value.trim() !== "")
  );
}

async function readCsv(
  csvPath: string,
  expectedHeaders: string[]
): Promise<string[][]> {
  const csvText = await readFile(csvPath, "utf8");
  const rows = parseCsv(csvText.replace(/^\uFEFF/, ""));
  const headers = rows.shift();

  if (!headers || headers.join("|") !== expectedHeaders.join("|")) {
    throw new Error(
      `Unexpected CSV columns in ${path.basename(csvPath)}.`
    );
  }

  for (const row of rows) {
    if (row.length !== expectedHeaders.length) {
      throw new Error(
        `Invalid column count in ${path.basename(csvPath)}.`
      );
    }
  }

  return rows;
}

async function runSqlFile(client: PoolClient, relativePath: string) {
  const sql = await readFile(
    path.join(databaseDirectory, relativePath),
    "utf8"
  );
  await client.query(sql);
}

async function insertRows(
  client: PoolClient,
  tableName: string,
  columns: readonly string[],
  rows: string[][]
) {
  if (rows.length === 0) {
    throw new Error(`${tableName} has no rows to import.`);
  }

  const values: string[] = [];
  const valueGroups = rows.map((row) => {
    const placeholders = row.map((value) => {
      values.push(value);
      return `$${values.length}`;
    });
    return `(${placeholders.join(", ")})`;
  });

  await client.query(
    `
    INSERT INTO ${tableName} (${columns.join(", ")})
    VALUES ${valueGroups.join(", ")};
    `,
    values
  );
}

async function importApplications() {
  const currentRows = await readCsv(
    currentCsvPath,
    expectedCurrentHeaders
  );
  const copiedRows = await readCsv(
    copiedCsvPath,
    expectedCopiedHeaders
  );
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const dependencyResult = await client.query<{
      customers: string | null;
      packages: string | null;
      employees: string | null;
    }>(`
      SELECT
        TO_REGCLASS('public.customers')::TEXT AS customers,
        TO_REGCLASS('public.packages')::TEXT AS packages,
        TO_REGCLASS('public.employees')::TEXT AS employees;
    `);

    const dependencies = dependencyResult.rows[0];
    if (
      !dependencies?.customers ||
      !dependencies.packages ||
      !dependencies.employees
    ) {
      throw new Error(
        "Customers, packages, and employees must be migrated first."
      );
    }

    await runSqlFile(
      client,
      "migrations/018_create_staging_applications.sql"
    );
    await runSqlFile(
      client,
      "migrations/019_create_applications.sql"
    );

    await client.query(`
      TRUNCATE TABLE
        staging.applications_current,
        staging.applications_copy
      RESTART IDENTITY;
    `);

    await insertRows(
      client,
      "staging.applications_current",
      currentColumns,
      currentRows
    );
    await insertRows(
      client,
      "staging.applications_copy",
      copiedColumns,
      copiedRows
    );

    await runSqlFile(
      client,
      "migrations/020_reconcile_legacy_applications.sql"
    );

    const verificationResult = await client.query<{
      legacy_source: string;
      status: string;
      match_method: string;
      application_count: number;
    }>(`
      SELECT
        legacy_source,
        status,
        match_method,
        COUNT(*)::INTEGER AS application_count
      FROM public.applications
      WHERE legacy_source IS NOT NULL
      GROUP BY legacy_source, status, match_method
      ORDER BY legacy_source, status, match_method;
    `);

    const importedCount = verificationResult.rows.reduce(
      (total, row) => total + row.application_count,
      0
    );
    const expectedCount = currentRows.length + copiedRows.length;

    if (importedCount !== expectedCount) {
      throw new Error(
        `Expected ${expectedCount} legacy applications, found ${importedCount}.`
      );
    }

    await client.query("COMMIT");

    console.log(`Imported ${currentRows.length} current applications.`);
    console.log(`Imported ${copiedRows.length} historical applications.`);
    for (const row of verificationResult.rows) {
      console.log(
        `${row.legacy_source}: ${row.status} / ${row.match_method} = ${row.application_count}`
      );
    }
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

importApplications()
  .catch((error) => {
    console.error("Application import failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
