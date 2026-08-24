/** Bulk-verifies imported mappings using one read-only Huawei query per PON port. */
import { isIP } from "node:net";
import { pool } from "../db.js";
import { normalizeExactCustomerName } from "../huawei/matchOntCustomers.js";
import { readOntPortFromOlt } from "../huawei/verifyOnt.js";
import type { ParsedOnt } from "../huawei/parseOntLog.js";

type MappingRow = {
  customer_ont_assignment_id: number;
  customer_id: number;
  customer_name: string;
  management_ip: string;
  frame_number: number;
  slot_number: number;
  pon_port_number: number;
  ont_id: number;
  ont_serial: string | null;
};

type SafeMatch = { mapping: MappingRow; live: ParsedOnt };

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() : undefined;
}

const managementIp = argument("--management-ip") ?? "";
const apply = process.argv.includes("--apply");
const enrollMissingSerials = process.argv.includes("--enroll-missing-serials");

if (!isIP(managementIp)) {
  console.error(
    "Usage: bulkVerifyHuaweiMappings --management-ip <IP> [--enroll-missing-serials] [--apply]"
  );
  process.exit(2);
}

function portKey(mapping: MappingRow) {
  return `${mapping.frame_number}/${mapping.slot_number}/${mapping.pon_port_number}`;
}

function locationKey(mapping: MappingRow) {
  return `${portKey(mapping)}/${mapping.ont_id}`;
}

async function applySafeMatch(match: SafeMatch) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query(
      `UPDATE public.customer_ont_assignments
       SET mapping_status = 'verified',
           ont_serial = $2,
           verified_at = CURRENT_TIMESTAMP,
           verified_by_employee_id = NULL,
           updated_by_employee_id = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE customer_ont_assignment_id = $1
         AND customer_id = $3
         AND ended_at IS NULL
         AND mapping_status = 'unverified'
         AND frame_number = $4
         AND slot_number = $5
         AND pon_port_number = $6
         AND ont_id = $7
         AND ont_serial IS NOT DISTINCT FROM $8
       RETURNING customer_ont_assignment_id;`,
      [
        match.mapping.customer_ont_assignment_id,
        match.live.ontSerial,
        match.mapping.customer_id,
        match.mapping.frame_number,
        match.mapping.slot_number,
        match.mapping.pon_port_number,
        match.mapping.ont_id,
        match.mapping.ont_serial,
      ]
    );
    if (updated.rows.length === 0) {
      await client.query("ROLLBACK");
      return false;
    }

    await client.query(
      `INSERT INTO public.audit_logs (
         employee_id, actor_name, action, entity_type, entity_id,
         field_name, old_value, new_value, reason, occurred_at
       ) VALUES (
         NULL, 'SPCL Bulk OLT Verifier', 'Bulk verified customer OLT information',
         'customer', $1, 'network_access', $2, $3,
         $4,
         CURRENT_TIMESTAMP
       );`,
      [
        String(match.mapping.customer_id),
        JSON.stringify({
          assignmentId: match.mapping.customer_ont_assignment_id,
          mappingStatus: "unverified",
          location: locationKey(match.mapping),
          ontSerial: match.mapping.ont_serial,
        }),
        JSON.stringify({
          assignmentId: match.mapping.customer_ont_assignment_id,
          mappingStatus: "verified",
          location: locationKey(match.mapping),
          ontSerial: match.live.ontSerial,
          liveControlFlag: match.live.controlFlag,
          liveRunState: match.live.runState,
        }),
        match.mapping.ont_serial
          ? "Exact live location, serial, and customer description match"
          : "Exact live location and customer description match; enrolled live ONT serial",
      ]
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(
      `Could not apply one safe mapping at ${locationKey(match.mapping)}:`,
      error instanceof Error ? error.message : "unknown database error"
    );
    return false;
  } finally {
    client.release();
  }
}

async function main() {
  const result = await pool.query<MappingRow>(
    `SELECT
       assignment.customer_ont_assignment_id,
       assignment.customer_id,
       customer.name AS customer_name,
       host(olt.management_ip) AS management_ip,
       assignment.frame_number,
       assignment.slot_number,
       assignment.pon_port_number,
       assignment.ont_id,
       assignment.ont_serial
     FROM public.customer_ont_assignments assignment
     JOIN public.customers customer ON customer.customer_id = assignment.customer_id
     JOIN public.olts olt ON olt.olt_id = assignment.olt_id
     WHERE assignment.ended_at IS NULL
       AND assignment.mapping_status = 'unverified'
       AND olt.management_ip = $1::INET
     ORDER BY assignment.frame_number, assignment.slot_number,
       assignment.pon_port_number, assignment.ont_id;`,
    [managementIp]
  );

  const groups = new Map<string, MappingRow[]>();
  for (const mapping of result.rows) {
    const samePort = groups.get(portKey(mapping)) ?? [];
    samePort.push(mapping);
    groups.set(portKey(mapping), samePort);
  }

  const safeMatches: SafeMatch[] = [];
  const counts = {
    mappingsLoaded: result.rows.length,
    portsRequested: groups.size,
    portsRead: 0,
    portErrors: 0,
    missingLiveOnt: 0,
    missingSavedSerial: 0,
    serialEnrollmentCandidates: 0,
    serialMismatch: 0,
    descriptionMismatch: 0,
    safeExactMatches: 0,
    applied: 0,
    applyConflicts: 0,
  };

  console.log(`Bulk verifier mode: ${apply ? "APPLY SAFE MATCHES" : "READ-ONLY DRY RUN"}`);
  console.log(`Enroll missing saved serials: ${enrollMissingSerials ? "yes" : "no"}`);
  console.log(`Loaded ${counts.mappingsLoaded} unverified mappings across ${counts.portsRequested} PON ports.`);

  for (const mappings of groups.values()) {
    const first = mappings[0];
    let liveByLocation: Map<string, ParsedOnt>;
    try {
      const livePort = await readOntPortFromOlt({
        managementIp,
        frameNumber: Number(first.frame_number),
        slotNumber: Number(first.slot_number),
        ponPortNumber: Number(first.pon_port_number),
      });
      counts.portsRead += 1;
      liveByLocation = new Map(
        livePort.onts.map((ont) => [
          `${ont.frameNumber}/${ont.slotNumber}/${ont.ponPortNumber}/${ont.ontId}`,
          ont,
        ])
      );
    } catch (error) {
      counts.portErrors += 1;
      console.error(
        `Read-only PON query failed for ${portKey(first)}:`,
        error instanceof Error ? error.message : "unknown OLT error"
      );
      continue;
    }

    for (const mapping of mappings) {
      const live = liveByLocation.get(locationKey(mapping));
      if (!live) {
        counts.missingLiveOnt += 1;
        continue;
      }
      if (!mapping.ont_serial?.trim()) {
        counts.missingSavedSerial += 1;
      } else if (mapping.ont_serial.trim().toUpperCase() !== live.ontSerial) {
        counts.serialMismatch += 1;
        continue;
      }
      if (
        !live.description ||
        normalizeExactCustomerName(live.description) !==
          normalizeExactCustomerName(mapping.customer_name)
      ) {
        counts.descriptionMismatch += 1;
        continue;
      }
      if (!mapping.ont_serial?.trim()) {
        if (!enrollMissingSerials) continue;
        counts.serialEnrollmentCandidates += 1;
      }
      safeMatches.push({ mapping, live });
      counts.safeExactMatches += 1;
    }
  }

  if (apply) {
    for (const match of safeMatches) {
      if (await applySafeMatch(match)) counts.applied += 1;
      else counts.applyConflicts += 1;
    }
  }

  console.log("Bulk verification summary:");
  for (const [label, value] of Object.entries(counts)) {
    console.log(`${label}: ${value}`);
  }
  if (!apply) {
    console.log("Dry run only: no mapping status was changed.");
  } else {
    console.log(
      enrollMissingSerials
        ? "Only exact live location + customer-description matches were verified; missing serials were enrolled from the live ONT."
        : "Only exact live location + serial + customer-description matches were verified."
    );
  }
}

main()
  .catch((error) => {
    console.error("Bulk OLT verification failed:", error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
