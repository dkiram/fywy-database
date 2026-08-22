/**
 * Builds and optionally applies conservative customer-to-ONT links.
 *
 * Dry-run is the default. The importer trusts only exact customer-name matches
 * and refuses duplicate names, multiple ONTs per customer, existing mappings,
 * reused OLT locations, and reused ONT serial numbers.
 */
import { isIP } from "node:net";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { PoolClient } from "pg";
import { pool } from "../db.js";
import {
  matchOntsToCustomers,
  type CustomerNameRow,
  type ExactOntMatch,
} from "../huawei/matchOntCustomers.js";
import type { ParsedOnt } from "../huawei/parseOntLog.js";
import { readHuaweiOntLogs } from "../huawei/readOntLogs.js";

type ExistingAssignment = {
  assignmentId: number;
  customerId: number;
  oltName: string;
  managementIp: string;
  frameNumber: number;
  slotNumber: number;
  ponPortNumber: number;
  ontId: number;
  ontSerial: string | null;
};

type DatabaseConflict = {
  reason:
    | "customer_already_has_different_mapping"
    | "olt_location_already_assigned"
    | "ont_serial_already_assigned";
  customerId: number;
  customerName: string;
  ont: ParsedOnt;
  existingAssignmentId: number;
};

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
    "Usage: npm run import:ont-matches -- " +
      "--file <port-log.txt> [--file <another-log.txt>] " +
      "--olt-name <name> --management-ip <ip> " +
      "[--report <report.json>] [--apply]"
  );
  process.exit(1);
}

function oltLocationKey(oltName: string, ont: ParsedOnt) {
  return [
    oltName.trim().toLocaleUpperCase("en-US"),
    ont.frameNumber,
    ont.slotNumber,
    ont.ponPortNumber,
    ont.ontId,
  ].join("/");
}

function assignmentLocationKey(assignment: ExistingAssignment) {
  return [
    assignment.oltName.trim().toLocaleUpperCase("en-US"),
    assignment.frameNumber,
    assignment.slotNumber,
    assignment.ponPortNumber,
    assignment.ontId,
  ].join("/");
}

function importedOntKey(ont: ParsedOnt) {
  return [ont.frameNumber, ont.slotNumber, ont.ponPortNumber, ont.ontId].join("/");
}

async function loadCustomers(client: PoolClient): Promise<CustomerNameRow[]> {
  const result = await client.query<{ customer_id: number; name: string }>(`
    SELECT customer_id, name
    FROM public.customers
    WHERE NULLIF(TRIM(COALESCE(name, '')), '') IS NOT NULL
    ORDER BY customer_id;
  `);
  return result.rows.map((row) => ({
    customerId: Number(row.customer_id),
    name: row.name,
  }));
}

async function loadExistingAssignments(client: PoolClient): Promise<ExistingAssignment[]> {
  const result = await client.query<{
    customer_ont_assignment_id: number;
    customer_id: number;
    olt_name: string;
    management_ip: string;
    frame_number: number;
    slot_number: number;
    pon_port_number: number;
    ont_id: number;
    ont_serial: string | null;
  }>(`
    SELECT
      assignment.customer_ont_assignment_id,
      assignment.customer_id,
      olt.name AS olt_name,
      host(olt.management_ip) AS management_ip,
      assignment.frame_number,
      assignment.slot_number,
      assignment.pon_port_number,
      assignment.ont_id,
      assignment.ont_serial
    FROM public.customer_ont_assignments assignment
    JOIN public.olts olt ON olt.olt_id = assignment.olt_id
    WHERE assignment.ended_at IS NULL;
  `);

  return result.rows.map((row) => ({
    assignmentId: Number(row.customer_ont_assignment_id),
    customerId: Number(row.customer_id),
    oltName: row.olt_name,
    managementIp: row.management_ip,
    frameNumber: Number(row.frame_number),
    slotNumber: Number(row.slot_number),
    ponPortNumber: Number(row.pon_port_number),
    ontId: Number(row.ont_id),
    ontSerial: row.ont_serial?.trim().toLocaleUpperCase("en-US") ?? null,
  }));
}

function removeDatabaseConflicts(
  matches: ExactOntMatch[],
  existingAssignments: ExistingAssignment[],
  oltName: string
) {
  const byCustomer = new Map(
    existingAssignments.map((assignment) => [assignment.customerId, assignment])
  );
  const byLocation = new Map(
    existingAssignments.map((assignment) => [assignmentLocationKey(assignment), assignment])
  );
  const bySerial = new Map(
    existingAssignments
      .filter((assignment) => assignment.ontSerial)
      .map((assignment) => [assignment.ontSerial!, assignment])
  );

  const insertable: ExactOntMatch[] = [];
  const alreadyPresent: ExactOntMatch[] = [];
  const conflicts: DatabaseConflict[] = [];

  for (const match of matches) {
    const targetLocation = oltLocationKey(oltName, match.ont);
    const customerAssignment = byCustomer.get(match.customer.customerId);
    if (customerAssignment) {
      const sameLocation = assignmentLocationKey(customerAssignment) === targetLocation;
      const sameSerial =
        customerAssignment.ontSerial === null ||
        customerAssignment.ontSerial === match.ont.ontSerial;
      if (sameLocation && sameSerial) {
        alreadyPresent.push(match);
      } else {
        conflicts.push({
          reason: "customer_already_has_different_mapping",
          customerId: match.customer.customerId,
          customerName: match.customer.name,
          ont: match.ont,
          existingAssignmentId: customerAssignment.assignmentId,
        });
      }
      continue;
    }

    const locationAssignment = byLocation.get(targetLocation);
    if (locationAssignment) {
      conflicts.push({
        reason: "olt_location_already_assigned",
        customerId: match.customer.customerId,
        customerName: match.customer.name,
        ont: match.ont,
        existingAssignmentId: locationAssignment.assignmentId,
      });
      continue;
    }

    const serialAssignment = bySerial.get(match.ont.ontSerial);
    if (serialAssignment) {
      conflicts.push({
        reason: "ont_serial_already_assigned",
        customerId: match.customer.customerId,
        customerName: match.customer.name,
        ont: match.ont,
        existingAssignmentId: serialAssignment.assignmentId,
      });
      continue;
    }

    insertable.push(match);
  }

  return { insertable, alreadyPresent, conflicts };
}

async function validateOrCreateOlt(
  client: PoolClient,
  oltName: string,
  managementIp: string,
  apply: boolean
) {
  const result = await client.query<{
    olt_id: number;
    name: string;
    management_ip: string;
  }>(`
    SELECT olt_id, name, host(management_ip) AS management_ip
    FROM public.olts
    WHERE normalized_name = UPPER(TRIM($1)) OR management_ip = $2::INET
    FOR UPDATE;
  `, [oltName, managementIp]);

  if (result.rows.length > 1) {
    throw new Error(
      `${oltName} and ${managementIp} point to two different OLT records. Resolve that before importing.`
    );
  }
  if (result.rows.length === 1) {
    const olt = result.rows[0];
    if (
      olt.name.trim().toLocaleUpperCase("en-US") !==
        oltName.trim().toLocaleUpperCase("en-US") ||
      olt.management_ip !== managementIp
    ) {
      throw new Error(
        `OLT inventory conflict: found ${olt.name} at ${olt.management_ip}, expected ${oltName} at ${managementIp}.`
      );
    }
    return Number(olt.olt_id);
  }

  if (!apply) return null;
  const inserted = await client.query<{ olt_id: number }>(`
    INSERT INTO public.olts (name, management_ip)
    VALUES ($1, $2::INET)
    RETURNING olt_id;
  `, [oltName, managementIp]);
  return Number(inserted.rows[0].olt_id);
}

async function applyMatches(
  client: PoolClient,
  oltId: number,
  oltName: string,
  matches: ExactOntMatch[]
) {
  for (const match of matches) {
    const inserted = await client.query<{ customer_ont_assignment_id: number }>(`
      INSERT INTO public.customer_ont_assignments (
        customer_id,
        olt_id,
        frame_number,
        slot_number,
        pon_port_number,
        ont_id,
        ont_serial,
        source,
        mapping_status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'u2000_import', 'unverified')
      RETURNING customer_ont_assignment_id;
    `, [
      match.customer.customerId,
      oltId,
      match.ont.frameNumber,
      match.ont.slotNumber,
      match.ont.ponPortNumber,
      match.ont.ontId,
      match.ont.ontSerial,
    ]);

    // Imported mappings appear in the normal customer audit trail, without
    // pretending that a staff member manually created them.
    await client.query(`
      INSERT INTO public.audit_logs (
        employee_id,
        actor_name,
        action,
        entity_type,
        entity_id,
        field_name,
        new_value,
        reason,
        source_key
      ) VALUES (
        NULL,
        'U2000 safe-match import',
        'Added customer OLT information',
        'customer',
        $1,
        'network_access',
        $2,
        'Exact U2000 description-to-customer-name match; pending live OLT verification',
        $3
      )
      ON CONFLICT (source_key) DO NOTHING;
    `, [
      String(match.customer.customerId),
      JSON.stringify({
        customerOntAssignmentId: Number(inserted.rows[0].customer_ont_assignment_id),
        oltName,
        frameNumber: match.ont.frameNumber,
        slotNumber: match.ont.slotNumber,
        ponPortNumber: match.ont.ponPortNumber,
        ontId: match.ont.ontId,
        source: "u2000_import",
        mappingStatus: "unverified",
      }),
      `u2000-safe-match:${oltName.toLocaleUpperCase("en-US")}:${importedOntKey(match.ont)}`,
    ]);
  }
}

async function main() {
  const files = optionValues("--file");
  const oltName = optionValue("--olt-name")?.trim();
  const managementIp = optionValue("--management-ip")?.trim();
  const reportPath = optionValue("--report");
  const apply = process.argv.includes("--apply");

  if (files.length === 0 || !oltName || !managementIp) showUsage();
  if (isIP(managementIp) === 0) {
    throw new Error("--management-ip must be a valid IP address.");
  }

  // Parse every private input file before opening a database transaction.
  const onts = await readHuaweiOntLogs(files);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    // Prevent two copies of this importer from assigning the same records at
    // once. The lock lasts only for this transaction.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('spcl-u2000-safe-match-import'));");

    const dependencyResult = await client.query<{
      customers: string | null;
      olts: string | null;
      assignments: string | null;
    }>(`
      SELECT
        to_regclass('public.customers')::TEXT AS customers,
        to_regclass('public.olts')::TEXT AS olts,
        to_regclass('public.customer_ont_assignments')::TEXT AS assignments;
    `);
    const dependencies = dependencyResult.rows[0];
    if (!dependencies?.customers || !dependencies.olts || !dependencies.assignments) {
      throw new Error("Run database migrations 047 and 048 before importing OLT matches.");
    }

    const oltId = await validateOrCreateOlt(client, oltName, managementIp, apply);
    const customers = await loadCustomers(client);
    const nameMatching = matchOntsToCustomers(onts, customers);
    const existingAssignments = await loadExistingAssignments(client);
    const databaseMatching = removeDatabaseConflicts(
      nameMatching.safeMatches,
      existingAssignments,
      oltName
    );

    const summary = {
      mode: apply ? "apply" : "dry-run",
      oltName,
      managementIp,
      inputFiles: files.map((file) => path.basename(file)),
      parsedOnts: onts.length,
      exactOneToOneMatches: nameMatching.safeMatches.length,
      needsNameReview: nameMatching.review.length,
      databaseConflicts: databaseMatching.conflicts.length,
      alreadyPresent: databaseMatching.alreadyPresent.length,
      readyToInsert: databaseMatching.insertable.length,
      inserted: apply ? databaseMatching.insertable.length : 0,
    };

    const report = {
      summary,
      nameReview: nameMatching.review.map((item) => ({
        reason: item.reason,
        customerDescription: item.ont.description,
        candidateCustomerIds: item.candidateCustomerIds,
        frameNumber: item.ont.frameNumber,
        slotNumber: item.ont.slotNumber,
        ponPortNumber: item.ont.ponPortNumber,
        ontId: item.ont.ontId,
      })),
      databaseConflicts: databaseMatching.conflicts.map((item) => ({
        reason: item.reason,
        customerId: item.customerId,
        customerName: item.customerName,
        existingAssignmentId: item.existingAssignmentId,
        frameNumber: item.ont.frameNumber,
        slotNumber: item.ont.slotNumber,
        ponPortNumber: item.ont.ponPortNumber,
        ontId: item.ont.ontId,
      })),
    };

    if (reportPath) {
      const absoluteReportPath = path.resolve(reportPath);
      await writeFile(absoluteReportPath, `${JSON.stringify(report, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      console.log(`Private review report: ${absoluteReportPath}`);
    }

    if (apply) {
      if (oltId === null) throw new Error("Could not create the OLT inventory record.");
      await applyMatches(client, oltId, oltName, databaseMatching.insertable);
      await client.query("COMMIT");
    } else {
      // Dry-run performs every database check but leaves no changes behind.
      await client.query("ROLLBACK");
    }

    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error("Huawei ONT safe-match import failed:", error);
  process.exitCode = 1;
});
