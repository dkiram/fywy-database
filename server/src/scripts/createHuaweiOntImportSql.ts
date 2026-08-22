/** Creates private dry-run/apply SQL files for an already-open TablePlus connection. */
import { spawn } from "node:child_process";
import { isIP } from "node:net";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import {
  matchOntsToCustomers,
  normalizeExactCustomerName,
  type CustomerNameRow,
  type ExactOntMatch,
} from "../huawei/matchOntCustomers.js";
import { readHuaweiOntLogs } from "../huawei/readOntLogs.js";

function optionValues(name: string) {
  const values: string[] = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === name && process.argv[index + 1]) {
      values.push(process.argv[index + 1]);
    }
  }
  return values;
}

function optionValue(name: string) {
  return optionValues(name)[0];
}

function showUsage(): never {
  console.error(
    "Usage: npm run create:ont-import-sql -- " +
      "--file <log.txt> [--file <log.txt>] --access-db <legacy.accdb> " +
      "--olt-name <name> --management-ip <ip> --output-dir <private-directory>"
  );
  process.exit(1);
}

function sqlText(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

async function readAccessCustomers(databasePath: string): Promise<CustomerNameRow[]> {
  const child = spawn("mdb-json", [path.resolve(databasePath), "Customer TBL"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const rows: CustomerNameRow[] = [];
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  for await (const line of createInterface({ input: child.stdout })) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as Record<string, unknown>;
    const customerId = Number(row.CustomerID);
    const name = row.Name == null ? "" : String(row.Name).trim();
    if (Number.isInteger(customerId) && name) rows.push({ customerId, name });
  }

  const exitCode = await new Promise<number | null>((resolve) => child.on("close", resolve));
  if (exitCode !== 0) throw new Error(`mdb-json failed: ${stderr.trim()}`);
  return rows;
}

function stageValues(matches: ExactOntMatch[]) {
  return matches
    .map((match) => `  (${[
      match.customer.customerId,
      sqlText(normalizeExactCustomerName(match.customer.name)),
      match.ont.frameNumber,
      match.ont.slotNumber,
      match.ont.ponPortNumber,
      match.ont.ontId,
      sqlText(match.ont.ontSerial),
    ].join(", ")})`)
    .join(",\n");
}

function commonSql(
  matches: ExactOntMatch[],
  oltName: string,
  managementIp: string,
  insertOlt: boolean
) {
  const oltNameSql = sqlText(oltName);
  const managementIpSql = sqlText(managementIp);
  const expectedCount = matches.length;

  return `-- PRIVATE: contains customer IDs and Huawei ONT serial numbers.
-- Generated from validated PuTTY logs. Do not commit or email this file.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SELECT pg_advisory_xact_lock(hashtext('spcl-u2000-safe-match-import'));

DO $$
BEGIN
  IF to_regclass('public.customers') IS NULL
     OR to_regclass('public.olts') IS NULL
     OR to_regclass('public.customer_ont_assignments') IS NULL THEN
    RAISE EXCEPTION 'Run database migrations 047 and 048 first.';
  END IF;
END $$;

CREATE TEMP TABLE spcl_newport_safe_stage (
  customer_id INTEGER PRIMARY KEY,
  expected_normalized_name TEXT NOT NULL,
  frame_number SMALLINT NOT NULL,
  slot_number SMALLINT NOT NULL,
  pon_port_number SMALLINT NOT NULL,
  ont_id INTEGER NOT NULL,
  ont_serial TEXT NOT NULL,
  UNIQUE (frame_number, slot_number, pon_port_number, ont_id),
  UNIQUE (ont_serial)
) ON COMMIT DROP;

INSERT INTO spcl_newport_safe_stage (
  customer_id, expected_normalized_name, frame_number, slot_number,
  pon_port_number, ont_id, ont_serial
) VALUES
${stageValues(matches)};

DO $$
DECLARE
  staged_count INTEGER;
  matching_olts INTEGER;
  conflicting_olts INTEGER;
BEGIN
  SELECT COUNT(*) INTO staged_count FROM spcl_newport_safe_stage;
  IF staged_count <> ${expectedCount} THEN
    RAISE EXCEPTION 'Expected ${expectedCount} staged matches, found %.', staged_count;
  END IF;

  SELECT COUNT(*) INTO matching_olts
  FROM public.olts
  WHERE normalized_name = UPPER(TRIM(${oltNameSql}))
     OR management_ip = ${managementIpSql}::INET;

  SELECT COUNT(*) INTO conflicting_olts
  FROM public.olts
  WHERE (normalized_name = UPPER(TRIM(${oltNameSql}))
         OR management_ip = ${managementIpSql}::INET)
    AND NOT (
      normalized_name = UPPER(TRIM(${oltNameSql}))
      AND management_ip = ${managementIpSql}::INET
    );

  IF matching_olts > 1 OR conflicting_olts > 0 THEN
    RAISE EXCEPTION 'OLT inventory conflict for ${oltName.replace(/'/g, "''")} / ${managementIp.replace(/'/g, "''")}.';
  END IF;
END $$;

${insertOlt ? `INSERT INTO public.olts (name, management_ip)
SELECT ${oltNameSql}, ${managementIpSql}::INET
WHERE NOT EXISTS (
  SELECT 1 FROM public.olts
  WHERE normalized_name = UPPER(TRIM(${oltNameSql}))
     OR management_ip = ${managementIpSql}::INET
);
` : ""}
CREATE TEMP TABLE spcl_newport_safe_evaluation ON COMMIT DROP AS
SELECT
  stage.*,
  CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM public.customers customer
      WHERE customer.customer_id = stage.customer_id
        AND LOWER(REGEXP_REPLACE(TRIM(customer.name), '[[:space:]]+', ' ', 'g')) =
            stage.expected_normalized_name
    ) THEN 'customer_missing_or_name_changed'
    WHEN (
      SELECT COUNT(*) FROM public.customers customer
      WHERE LOWER(REGEXP_REPLACE(TRIM(customer.name), '[[:space:]]+', ' ', 'g')) =
            stage.expected_normalized_name
    ) <> 1 THEN 'duplicate_live_customer_name'
    WHEN EXISTS (
      SELECT 1
      FROM public.customer_ont_assignments assignment
      WHERE assignment.customer_id = stage.customer_id
        AND assignment.ended_at IS NULL
        AND NOT (
          COALESCE(
            assignment.olt_id = (
              SELECT olt_id FROM public.olts
              WHERE normalized_name = UPPER(TRIM(${oltNameSql}))
                AND management_ip = ${managementIpSql}::INET
            ),
            FALSE
          )
          AND assignment.frame_number = stage.frame_number
          AND assignment.slot_number = stage.slot_number
          AND assignment.pon_port_number = stage.pon_port_number
          AND assignment.ont_id = stage.ont_id
          AND (assignment.ont_serial IS NULL
               OR UPPER(TRIM(assignment.ont_serial)) = UPPER(TRIM(stage.ont_serial)))
        )
    ) THEN 'customer_existing_mapping_conflict'
    WHEN EXISTS (
      SELECT 1
      FROM public.customer_ont_assignments assignment
      JOIN public.olts olt ON olt.olt_id = assignment.olt_id
      WHERE assignment.ended_at IS NULL
        AND olt.normalized_name = UPPER(TRIM(${oltNameSql}))
        AND assignment.frame_number = stage.frame_number
        AND assignment.slot_number = stage.slot_number
        AND assignment.pon_port_number = stage.pon_port_number
        AND assignment.ont_id = stage.ont_id
        AND assignment.customer_id <> stage.customer_id
    ) THEN 'olt_location_already_assigned'
    WHEN EXISTS (
      SELECT 1
      FROM public.customer_ont_assignments assignment
      WHERE assignment.ended_at IS NULL
        AND assignment.ont_serial IS NOT NULL
        AND UPPER(TRIM(assignment.ont_serial)) = UPPER(TRIM(stage.ont_serial))
        AND assignment.customer_id <> stage.customer_id
    ) THEN 'ont_serial_already_assigned'
    WHEN EXISTS (
      SELECT 1
      FROM public.customer_ont_assignments assignment
      JOIN public.olts olt ON olt.olt_id = assignment.olt_id
      WHERE assignment.customer_id = stage.customer_id
        AND assignment.ended_at IS NULL
        AND olt.normalized_name = UPPER(TRIM(${oltNameSql}))
        AND assignment.frame_number = stage.frame_number
        AND assignment.slot_number = stage.slot_number
        AND assignment.pon_port_number = stage.pon_port_number
        AND assignment.ont_id = stage.ont_id
        AND (assignment.ont_serial IS NULL
             OR UPPER(TRIM(assignment.ont_serial)) = UPPER(TRIM(stage.ont_serial)))
    ) THEN 'already_present'
    ELSE 'ready'
  END AS import_status
FROM spcl_newport_safe_stage stage;
`;
}

function dryRunSql(matches: ExactOntMatch[], oltName: string, managementIp: string) {
  return `${commonSql(matches, oltName, managementIp, false)}
SELECT import_status, COUNT(*) AS customer_count
FROM spcl_newport_safe_evaluation
GROUP BY import_status
ORDER BY import_status;

-- Deliberately leave the live database unchanged.
ROLLBACK;
`;
}

function applySql(matches: ExactOntMatch[], oltName: string, managementIp: string) {
  const oltNameSql = sqlText(oltName);
  const managementIpSql = sqlText(managementIp);
  return `${commonSql(matches, oltName, managementIp, true)}
CREATE TEMP TABLE spcl_newport_inserted (
  customer_ont_assignment_id BIGINT PRIMARY KEY,
  customer_id INTEGER NOT NULL
) ON COMMIT DROP;

WITH inserted AS (
  INSERT INTO public.customer_ont_assignments (
    customer_id, olt_id, frame_number, slot_number, pon_port_number,
    ont_id, ont_serial, source, mapping_status
  )
  SELECT
    evaluation.customer_id,
    olt.olt_id,
    evaluation.frame_number,
    evaluation.slot_number,
    evaluation.pon_port_number,
    evaluation.ont_id,
    evaluation.ont_serial,
    'u2000_import',
    'unverified'
  FROM spcl_newport_safe_evaluation evaluation
  CROSS JOIN public.olts olt
  WHERE evaluation.import_status = 'ready'
    AND olt.normalized_name = UPPER(TRIM(${oltNameSql}))
    AND olt.management_ip = ${managementIpSql}::INET
  ORDER BY evaluation.customer_id
  RETURNING customer_ont_assignment_id, customer_id
)
INSERT INTO spcl_newport_inserted (customer_ont_assignment_id, customer_id)
SELECT customer_ont_assignment_id, customer_id FROM inserted;

INSERT INTO public.audit_logs (
  employee_id, actor_name, action, entity_type, entity_id, field_name,
  new_value, reason, source_key
)
SELECT
  NULL,
  'U2000 safe-match import',
  'Added customer OLT information',
  'customer',
  inserted.customer_id::TEXT,
  'network_access',
  json_build_object(
    'customerOntAssignmentId', assignment.customer_ont_assignment_id,
    'oltName', ${oltNameSql},
    'frameNumber', assignment.frame_number,
    'slotNumber', assignment.slot_number,
    'ponPortNumber', assignment.pon_port_number,
    'ontId', assignment.ont_id,
    'source', 'u2000_import',
    'mappingStatus', 'unverified'
  )::TEXT,
  'Exact U2000 description-to-customer-name match; pending live OLT verification',
  'u2000-safe-match:' || UPPER(${oltNameSql}) || ':' ||
    assignment.frame_number || '/' || assignment.slot_number || '/' ||
    assignment.pon_port_number || '/' || assignment.ont_id
FROM spcl_newport_inserted inserted
JOIN public.customer_ont_assignments assignment
  ON assignment.customer_ont_assignment_id = inserted.customer_ont_assignment_id
ON CONFLICT (source_key) DO NOTHING;

SELECT import_status, COUNT(*) AS customer_count
FROM spcl_newport_safe_evaluation
GROUP BY import_status
UNION ALL
SELECT 'inserted_this_run', COUNT(*) FROM spcl_newport_inserted
ORDER BY import_status;

COMMIT;
`;
}

async function main() {
  const files = optionValues("--file");
  const accessDb = optionValue("--access-db");
  const oltName = optionValue("--olt-name")?.trim();
  const managementIp = optionValue("--management-ip")?.trim();
  const outputDirectory = optionValue("--output-dir");
  if (files.length === 0 || !accessDb || !oltName || !managementIp || !outputDirectory) {
    showUsage();
  }
  if (isIP(managementIp) === 0) throw new Error("Invalid --management-ip.");

  const onts = await readHuaweiOntLogs(files);
  const customers = await readAccessCustomers(accessDb);
  const matching = matchOntsToCustomers(onts, customers);
  const outputDir = path.resolve(outputDirectory);
  const dryRunPath = path.join(outputDir, "newport-safe-matches-tableplus-dry-run.sql");
  const applyPath = path.join(outputDir, "newport-safe-matches-tableplus-apply.sql");

  await Promise.all([
    writeFile(dryRunPath, dryRunSql(matching.safeMatches, oltName, managementIp), {
      encoding: "utf8", mode: 0o600,
    }),
    writeFile(applyPath, applySql(matching.safeMatches, oltName, managementIp), {
      encoding: "utf8", mode: 0o600,
    }),
  ]);

  console.log(JSON.stringify({
    parsedOnts: onts.length,
    safeMatches: matching.safeMatches.length,
    needsReview: matching.review.length,
    dryRunPath,
    applyPath,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
