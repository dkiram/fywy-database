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
      "--olt-name <name> --management-ip <ip> --output-dir <private-directory> " +
      "[--two-year-expected-count <reviewed-count>]"
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

function twoYearReviewSql(matches: ExactOntMatch[], oltName: string) {
  const deactivatedMatches = matches.filter(
    (match) => match.ont.controlFlag === "deactivated"
  );
  const values = deactivatedMatches
    .map((match) => `  (${[
      match.customer.customerId,
      match.ont.frameNumber,
      match.ont.slotNumber,
      match.ont.ponPortNumber,
      match.ont.ontId,
      sqlText(match.ont.ontSerial),
    ].join(", ")})`)
    .join(",\n");
  const oltNameSql = sqlText(oltName);

  return `-- READ ONLY / PRIVATE: candidates for the father's two-year rule.
-- U2000 provides the current "deactivated" flag but no deactivation date.
-- Therefore this report uses customers.deactivation_date as a visible proxy;
-- it does not end, delete, or update any OLT mapping.
WITH u2000_deactivated (
  customer_id, frame_number, slot_number, pon_port_number, ont_id, ont_serial
) AS (
  VALUES
${values}
), evaluated AS (
  SELECT
    source.customer_id,
    customer.name AS customer_name,
    customer.status AS app_status,
    customer.deactivation_date,
    source.frame_number,
    source.slot_number,
    source.pon_port_number,
    source.ont_id,
    assignment.customer_ont_assignment_id,
    CASE
      WHEN assignment.customer_ont_assignment_id IS NULL
        THEN 'not_currently_imported'
      WHEN customer.status <> 'disconnected'
        THEN 'app_status_is_not_disconnected'
      WHEN customer.deactivation_date IS NULL
        THEN 'missing_deactivation_date'
      WHEN customer.deactivation_date < CURRENT_DATE - INTERVAL '2 years'
        THEN 'candidate_over_two_years'
      ELSE 'deactivated_within_two_years'
    END AS review_status
  FROM u2000_deactivated source
  JOIN public.customers customer ON customer.customer_id = source.customer_id
  LEFT JOIN public.olts olt
    ON olt.normalized_name = UPPER(TRIM(${oltNameSql}))
  LEFT JOIN public.customer_ont_assignments assignment
    ON assignment.customer_id = source.customer_id
   AND assignment.olt_id = olt.olt_id
   AND assignment.frame_number = source.frame_number
   AND assignment.slot_number = source.slot_number
   AND assignment.pon_port_number = source.pon_port_number
   AND assignment.ont_id = source.ont_id
   AND UPPER(TRIM(assignment.ont_serial)) = UPPER(TRIM(source.ont_serial))
   AND assignment.source = 'u2000_import'
   AND assignment.ended_at IS NULL
)
SELECT review_status, COUNT(*) AS customer_count
FROM evaluated
GROUP BY review_status
ORDER BY review_status;

WITH u2000_deactivated (
  customer_id, frame_number, slot_number, pon_port_number, ont_id, ont_serial
) AS (
  VALUES
${values}
)
SELECT
  customer.customer_id,
  customer.name AS customer_name,
  customer.status AS app_status,
  customer.deactivation_date,
  source.frame_number AS frame,
  source.slot_number AS card,
  source.pon_port_number AS pon_port,
  source.ont_id
FROM u2000_deactivated source
JOIN public.customers customer ON customer.customer_id = source.customer_id
JOIN public.olts olt ON olt.normalized_name = UPPER(TRIM(${oltNameSql}))
JOIN public.customer_ont_assignments assignment
  ON assignment.customer_id = source.customer_id
 AND assignment.olt_id = olt.olt_id
 AND assignment.frame_number = source.frame_number
 AND assignment.slot_number = source.slot_number
 AND assignment.pon_port_number = source.pon_port_number
 AND assignment.ont_id = source.ont_id
 AND UPPER(TRIM(assignment.ont_serial)) = UPPER(TRIM(source.ont_serial))
 AND assignment.source = 'u2000_import'
 AND assignment.ended_at IS NULL
WHERE customer.status = 'disconnected'
  AND customer.deactivation_date < CURRENT_DATE - INTERVAL '2 years'
ORDER BY customer.deactivation_date, customer.name;
`;
}

/**
 * Builds a guarded write script only after staff have reviewed the read-only
 * two-year report. The expected count makes the transaction fail closed if
 * customer status, dates, or current OLT mappings changed since that review.
 */
function twoYearApplySql(
  matches: ExactOntMatch[],
  oltName: string,
  expectedCount: number
) {
  const deactivatedMatches = matches.filter(
    (match) => match.ont.controlFlag === "deactivated"
  );
  const values = deactivatedMatches
    .map((match) => `  (${[
      match.customer.customerId,
      match.ont.frameNumber,
      match.ont.slotNumber,
      match.ont.ponPortNumber,
      match.ont.ontId,
      sqlText(match.ont.ontSerial),
    ].join(", ")})`)
    .join(",\n");
  const oltNameSql = sqlText(oltName);

  return `-- WRITE / PRIVATE: ends exactly the reviewed, over-two-year OLT mappings.
-- This preserves customers, billing, payments, and assignment history.
-- It does not contact U2000 and does not activate/deactivate/delete an ONT.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SELECT pg_advisory_xact_lock(hashtext('spcl-u2000-two-year-exclusion'));

CREATE TEMP TABLE spcl_u2000_deactivated_stage (
  customer_id INTEGER NOT NULL,
  frame_number SMALLINT NOT NULL,
  slot_number SMALLINT NOT NULL,
  pon_port_number SMALLINT NOT NULL,
  ont_id INTEGER NOT NULL,
  ont_serial TEXT NOT NULL,
  PRIMARY KEY (customer_id, frame_number, slot_number, pon_port_number, ont_id)
) ON COMMIT DROP;

INSERT INTO spcl_u2000_deactivated_stage (
  customer_id, frame_number, slot_number, pon_port_number, ont_id, ont_serial
) VALUES
${values};

CREATE TEMP TABLE spcl_two_year_olt_candidates ON COMMIT DROP AS
SELECT
  assignment.customer_ont_assignment_id,
  customer.customer_id,
  customer.name AS customer_name,
  customer.deactivation_date,
  source.frame_number,
  source.slot_number,
  source.pon_port_number,
  source.ont_id,
  source.ont_serial
FROM spcl_u2000_deactivated_stage source
JOIN public.customers customer ON customer.customer_id = source.customer_id
JOIN public.olts olt ON olt.normalized_name = UPPER(TRIM(${oltNameSql}))
JOIN public.customer_ont_assignments assignment
  ON assignment.customer_id = source.customer_id
 AND assignment.olt_id = olt.olt_id
 AND assignment.frame_number = source.frame_number
 AND assignment.slot_number = source.slot_number
 AND assignment.pon_port_number = source.pon_port_number
 AND assignment.ont_id = source.ont_id
 AND UPPER(TRIM(assignment.ont_serial)) = UPPER(TRIM(source.ont_serial))
 AND assignment.source = 'u2000_import'
 AND assignment.ended_at IS NULL
WHERE customer.status = 'disconnected'
  AND customer.deactivation_date < CURRENT_DATE - INTERVAL '2 years';

DO $$
DECLARE
  candidate_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO candidate_count FROM spcl_two_year_olt_candidates;
  IF candidate_count <> ${expectedCount} THEN
    RAISE EXCEPTION
      'Safety stop: expected ${expectedCount} reviewed mappings, found %. Rerun the dry-run report.',
      candidate_count;
  END IF;
END $$;

CREATE TEMP TABLE spcl_two_year_olt_ended (
  customer_ont_assignment_id BIGINT PRIMARY KEY,
  customer_id INTEGER NOT NULL,
  ended_at TIMESTAMPTZ NOT NULL
) ON COMMIT DROP;

WITH updated AS (
  UPDATE public.customer_ont_assignments assignment
  SET ended_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  FROM spcl_two_year_olt_candidates candidate
  WHERE assignment.customer_ont_assignment_id = candidate.customer_ont_assignment_id
    AND assignment.ended_at IS NULL
  RETURNING
    assignment.customer_ont_assignment_id,
    assignment.customer_id,
    assignment.ended_at
)
INSERT INTO spcl_two_year_olt_ended (
  customer_ont_assignment_id, customer_id, ended_at
)
SELECT customer_ont_assignment_id, customer_id, ended_at FROM updated;

DO $$
DECLARE
  ended_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO ended_count FROM spcl_two_year_olt_ended;
  IF ended_count <> ${expectedCount} THEN
    RAISE EXCEPTION
      'Safety stop: expected to end ${expectedCount} mappings, ended %. Transaction will roll back.',
      ended_count;
  END IF;
END $$;

INSERT INTO public.audit_logs (
  employee_id, actor_name, action, entity_type, entity_id, field_name,
  old_value, new_value, reason, source_key
)
SELECT
  NULL,
  'U2000 two-year exclusion',
  'Ended customer OLT information',
  'customer',
  candidate.customer_id::TEXT,
  'network_access',
  json_build_object(
    'customerOntAssignmentId', candidate.customer_ont_assignment_id,
    'oltName', ${oltNameSql},
    'frameNumber', candidate.frame_number,
    'slotNumber', candidate.slot_number,
    'ponPortNumber', candidate.pon_port_number,
    'ontId', candidate.ont_id,
    'source', 'u2000_import'
  )::TEXT,
  json_build_object('endedAt', ended.ended_at)::TEXT,
  'U2000 currently deactivated; app deactivation date is more than two years old',
  'u2000-two-year-exclusion:' || candidate.customer_ont_assignment_id
FROM spcl_two_year_olt_candidates candidate
JOIN spcl_two_year_olt_ended ended
  ON ended.customer_ont_assignment_id = candidate.customer_ont_assignment_id
ON CONFLICT (source_key) DO NOTHING;

SELECT
  candidate.customer_id,
  candidate.customer_name,
  candidate.deactivation_date,
  candidate.frame_number AS frame,
  candidate.slot_number AS card,
  candidate.pon_port_number AS pon_port,
  candidate.ont_id,
  ended.ended_at,
  'ended_this_run' AS result
FROM spcl_two_year_olt_candidates candidate
JOIN spcl_two_year_olt_ended ended
  ON ended.customer_ont_assignment_id = candidate.customer_ont_assignment_id
ORDER BY candidate.deactivation_date, candidate.customer_name;

COMMIT;
`;
}

async function main() {
  const files = optionValues("--file");
  const accessDb = optionValue("--access-db");
  const oltName = optionValue("--olt-name")?.trim();
  const managementIp = optionValue("--management-ip")?.trim();
  const outputDirectory = optionValue("--output-dir");
  const expectedTwoYearCountText = optionValue("--two-year-expected-count")?.trim();
  if (files.length === 0 || !accessDb || !oltName || !managementIp || !outputDirectory) {
    showUsage();
  }
  if (isIP(managementIp) === 0) throw new Error("Invalid --management-ip.");
  const expectedTwoYearCount = expectedTwoYearCountText == null
    ? null
    : Number(expectedTwoYearCountText);
  if (
    expectedTwoYearCount != null &&
    (!Number.isInteger(expectedTwoYearCount) || expectedTwoYearCount < 0)
  ) {
    throw new Error("--two-year-expected-count must be a non-negative integer.");
  }

  const onts = await readHuaweiOntLogs(files);
  const customers = await readAccessCustomers(accessDb);
  const matching = matchOntsToCustomers(onts, customers);
  const outputDir = path.resolve(outputDirectory);
  const dryRunPath = path.join(outputDir, "newport-safe-matches-tableplus-dry-run.sql");
  const applyPath = path.join(outputDir, "newport-safe-matches-tableplus-apply.sql");
  const twoYearReviewPath = path.join(
    outputDir,
    "newport-over-two-years-tableplus-dry-run.sql"
  );
  const twoYearApplyPath = expectedTwoYearCount == null
    ? null
    : path.join(outputDir, "newport-over-two-years-tableplus-apply.sql");

  await Promise.all([
    writeFile(dryRunPath, dryRunSql(matching.safeMatches, oltName, managementIp), {
      encoding: "utf8", mode: 0o600,
    }),
    writeFile(applyPath, applySql(matching.safeMatches, oltName, managementIp), {
      encoding: "utf8", mode: 0o600,
    }),
    writeFile(twoYearReviewPath, twoYearReviewSql(matching.safeMatches, oltName), {
      encoding: "utf8", mode: 0o600,
    }),
    ...(twoYearApplyPath == null
      ? []
      : [writeFile(
          twoYearApplyPath,
          twoYearApplySql(matching.safeMatches, oltName, expectedTwoYearCount!),
          { encoding: "utf8", mode: 0o600 }
        )]),
  ]);

  console.log(JSON.stringify({
    parsedOnts: onts.length,
    safeMatches: matching.safeMatches.length,
    needsReview: matching.review.length,
    dryRunPath,
    applyPath,
    twoYearReviewPath,
    twoYearApplyPath,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
