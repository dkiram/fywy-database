/**
 * Re-checks only the staff-clarified legacy ONT locations listed below.
 *
 * Safety properties:
 * - Huawei access is read-only (`display ont info ... all`).
 * - The current SPCL assignment must belong to the clarified customer name.
 * - The saved serial must match the live serial (or be safely enrolled).
 * - A serial or location belonging to another current assignment always blocks.
 * - A description exception pins the exact live Huawei text; it is not fuzzy.
 * - Dry-run is the default. `--apply` only changes PostgreSQL after all checks.
 */
import { pool } from "../db.js";
import { normalizeExactCustomerName } from "../huawei/matchOntCustomers.js";
import type { ParsedOnt } from "../huawei/parseOntLog.js";
import { readOntPortFromOlt } from "../huawei/verifyOnt.js";

type ClarifiedTarget = {
  label: string;
  managementIp: string;
  frameNumber: number;
  slotNumber: number;
  ponPortNumber: number;
  ontId: number;
  allowedCustomerNames: string[];
};

type MappingRow = {
  customer_ont_assignment_id: number;
  customer_id: number;
  customer_name: string;
  olt_id: number;
  olt_name: string;
  management_ip: string;
  frame_number: number;
  slot_number: number;
  pon_port_number: number;
  ont_id: number;
  ont_serial: string | null;
  ont_description_override: string | null;
  mapping_status: "unverified" | "verified" | "mismatch";
};

type SafeCandidate = {
  target: ClarifiedTarget;
  mapping: MappingRow;
  live: ParsedOnt;
  overrideNeeded: boolean;
};

const TARGETS: ClarifiedTarget[] = [
  {
    label: "Shaven Dryden #3",
    managementIp: "192.168.1.3",
    frameNumber: 0,
    slotNumber: 11,
    ponPortNumber: 13,
    ontId: 100,
    allowedCustomerNames: ["Shaven Dryden #3", "Shaven Dryden"],
  },
  {
    label: "S & N Isaacs Dental Lab",
    managementIp: "192.168.1.211",
    frameNumber: 0,
    slotNumber: 2,
    ponPortNumber: 0,
    ontId: 13,
    allowedCustomerNames: [
      "S & N Isaacs Dental Lab",
      "S and N Isaacs Dental Lab",
      "S an N Isaacs Dental Lab",
    ],
  },
  {
    label: "Cassies Toiletries",
    managementIp: "192.168.1.211",
    frameNumber: 0,
    slotNumber: 2,
    ponPortNumber: 0,
    ontId: 21,
    allowedCustomerNames: [
      "Cassies Toiletries",
      "Cassies Toiletries AN More",
      "Cassies Toiletries And More",
      "Cassandre McKenzie",
    ],
  },
  {
    label: "Oshane Whyte",
    managementIp: "192.168.1.211",
    frameNumber: 0,
    slotNumber: 2,
    ponPortNumber: 6,
    ontId: 8,
    allowedCustomerNames: ["Oshane Whyte"],
  },
  {
    label: "Roy Bromfield",
    managementIp: "192.168.1.211",
    frameNumber: 0,
    slotNumber: 2,
    ponPortNumber: 7,
    ontId: 31,
    allowedCustomerNames: ["Roy Bromfield"],
  },
  {
    label: "Nadine Williams-Hepburn",
    managementIp: "192.168.1.211",
    frameNumber: 0,
    slotNumber: 2,
    ponPortNumber: 8,
    ontId: 31,
    allowedCustomerNames: ["Nadine Williams-Hepburn", "Nadine Williams Hepburn"],
  },
  {
    label: "Ashaney Haughton/Mirriam Thompson",
    managementIp: "192.168.1.211",
    frameNumber: 0,
    slotNumber: 2,
    ponPortNumber: 8,
    ontId: 38,
    allowedCustomerNames: [
      "Ashaney Haughton/Mirriam Thompson",
      "Ashaney Haughton / Mirriam Thompson",
      "Ashaney Haughton",
      "Mirriam Thompson",
    ],
  },
  {
    label: "Marcus/Michele Miller",
    managementIp: "192.168.1.211",
    frameNumber: 0,
    slotNumber: 2,
    ponPortNumber: 8,
    ontId: 43,
    allowedCustomerNames: [
      "Marcus/Michele Miller",
      "Marcus / Michele Miller",
      "Marcus Miller/Michele Miller",
      "Marcus Miller",
      "Michele Miller",
    ],
  },
  {
    label: "Rosalie Steele",
    managementIp: "192.168.1.211",
    frameNumber: 0,
    slotNumber: 2,
    ponPortNumber: 8,
    ontId: 74,
    allowedCustomerNames: ["Rosalie Steele"],
  },
  {
    label: "Chrishia Davidson Powell",
    managementIp: "192.168.1.211",
    frameNumber: 0,
    slotNumber: 2,
    ponPortNumber: 10,
    ontId: 53,
    allowedCustomerNames: [
      "Chrishia Davidson Powell",
      "Chrishia Davidson-Powell",
    ],
  },
  {
    label: "Forresters Windows and Door",
    managementIp: "192.168.1.211",
    frameNumber: 0,
    slotNumber: 2,
    ponPortNumber: 10,
    ontId: 75,
    allowedCustomerNames: [
      "Forresters Windows and Door",
      "Forresters Windows & Door",
      "Forresters Windows and Doors",
    ],
  },
];

const apply = process.argv.includes("--apply");

function portKey(target: ClarifiedTarget) {
  return `${target.managementIp}/${target.frameNumber}/${target.slotNumber}/${target.ponPortNumber}`;
}

function locationKey(target: ClarifiedTarget) {
  return `${target.managementIp}/${target.frameNumber}/${target.slotNumber}/${target.ponPortNumber}/${target.ontId}`;
}

function locationKeyForMapping(mapping: MappingRow) {
  return `${mapping.management_ip}/${mapping.frame_number}/${mapping.slot_number}/${mapping.pon_port_number}/${mapping.ont_id}`;
}

function customerMatchesTarget(target: ClarifiedTarget, customerName: string) {
  const actual = normalizeExactCustomerName(customerName);
  return target.allowedCustomerNames.some(
    (name) => normalizeExactCustomerName(name) === actual
  );
}

async function loadCurrentMappings() {
  const result = await pool.query<MappingRow>(
    `SELECT
       assignment.customer_ont_assignment_id,
       assignment.customer_id,
       customer.name AS customer_name,
       assignment.olt_id,
       olt.name AS olt_name,
       host(olt.management_ip) AS management_ip,
       assignment.frame_number,
       assignment.slot_number,
       assignment.pon_port_number,
       assignment.ont_id,
       assignment.ont_serial,
       assignment.ont_description_override,
       assignment.mapping_status
     FROM public.customer_ont_assignments assignment
     JOIN public.customers customer ON customer.customer_id = assignment.customer_id
     JOIN public.olts olt ON olt.olt_id = assignment.olt_id
     WHERE assignment.ended_at IS NULL;`
  );
  return result.rows;
}

async function applyCandidate(candidate: SafeCandidate) {
  const client = await pool.connect();
  const { target, mapping, live, overrideNeeded } = candidate;
  const reason =
    "Staff clarified this legacy mapping in OLT Mapping Staff Review - Clarified (1).docx; live location and serial were rechecked by the controlled batch verifier.";
  try {
    await client.query("BEGIN");
    const lockedResult = await client.query<MappingRow>(
      `SELECT
         assignment.customer_ont_assignment_id,
         assignment.customer_id,
         customer.name AS customer_name,
         assignment.olt_id,
         olt.name AS olt_name,
         host(olt.management_ip) AS management_ip,
         assignment.frame_number,
         assignment.slot_number,
         assignment.pon_port_number,
         assignment.ont_id,
         assignment.ont_serial,
         assignment.ont_description_override,
         assignment.mapping_status
       FROM public.customer_ont_assignments assignment
       JOIN public.customers customer ON customer.customer_id = assignment.customer_id
       JOIN public.olts olt ON olt.olt_id = assignment.olt_id
       WHERE assignment.customer_ont_assignment_id = $1
         AND assignment.ended_at IS NULL
       FOR UPDATE OF assignment;`,
      [mapping.customer_ont_assignment_id]
    );
    const locked = lockedResult.rows[0];
    if (
      !locked ||
      locked.customer_id !== mapping.customer_id ||
      locationKeyForMapping(locked) !== locationKey(target) ||
      !customerMatchesTarget(target, locked.customer_name) ||
      String(locked.ont_serial ?? "").trim().toUpperCase() !==
        String(mapping.ont_serial ?? "").trim().toUpperCase()
    ) {
      await client.query("ROLLBACK");
      return "changed_during_apply";
    }

    const conflict = await client.query(
      `SELECT customer_ont_assignment_id
       FROM public.customer_ont_assignments
       WHERE ended_at IS NULL
         AND customer_ont_assignment_id <> $1
         AND (
           (
             olt_id = $2
             AND frame_number = $3
             AND slot_number = $4
             AND pon_port_number = $5
             AND ont_id = $6
           )
           OR (
             ont_serial IS NOT NULL
             AND UPPER(TRIM(ont_serial)) = UPPER(TRIM($7))
           )
         )
       LIMIT 1
       FOR UPDATE;`,
      [
        mapping.customer_ont_assignment_id,
        mapping.olt_id,
        mapping.frame_number,
        mapping.slot_number,
        mapping.pon_port_number,
        mapping.ont_id,
        live.ontSerial,
      ]
    );
    if (conflict.rows.length > 0) {
      await client.query("ROLLBACK");
      return "duplicate_location_or_serial";
    }

    await client.query(
      `UPDATE public.customer_ont_assignments
       SET ont_serial = $2,
           ont_description_override = CASE WHEN $3 THEN $4 ELSE NULL END,
           description_override_reason = CASE WHEN $3 THEN $5 ELSE NULL END,
           description_overridden_at = CASE WHEN $3 THEN CURRENT_TIMESTAMP ELSE NULL END,
           description_overridden_by_employee_id = NULL,
           mapping_status = 'verified',
           verified_at = CURRENT_TIMESTAMP,
           verified_by_employee_id = NULL,
           updated_by_employee_id = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE customer_ont_assignment_id = $1;`,
      [
        mapping.customer_ont_assignment_id,
        live.ontSerial,
        overrideNeeded,
        live.description?.trim() ?? null,
        reason,
      ]
    );

    await client.query(
      `INSERT INTO public.audit_logs (
         employee_id, actor_name, action, entity_type, entity_id,
         field_name, old_value, new_value, reason, occurred_at
       ) VALUES (
         NULL, 'SPCL Clarified OLT Review', $1, 'customer', $2,
         'network_access', $3, $4, $5, CURRENT_TIMESTAMP
       );`,
      [
        overrideNeeded
          ? "Batch confirmed Huawei ONT description override"
          : "Batch verified clarified customer OLT information",
        String(mapping.customer_id),
        JSON.stringify({
          assignmentId: mapping.customer_ont_assignment_id,
          mappingStatus: mapping.mapping_status,
          location: locationKey(target),
          ontSerial: mapping.ont_serial,
          descriptionOverride: mapping.ont_description_override,
        }),
        JSON.stringify({
          assignmentId: mapping.customer_ont_assignment_id,
          mappingStatus: "verified",
          location: locationKey(target),
          ontSerial: live.ontSerial,
          liveDescription: live.description,
          descriptionOverride: overrideNeeded ? live.description : null,
          liveControlFlag: live.controlFlag,
          liveRunState: live.runState,
        }),
        reason,
      ]
    );
    await client.query("COMMIT");
    return "applied";
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(
      `${target.label}: apply failed:`,
      error instanceof Error ? error.message : "unknown database error"
    );
    return "apply_error";
  } finally {
    client.release();
  }
}

async function main() {
  console.log(
    `Clarified mapping mode: ${apply ? "APPLY SAFE OVERRIDES" : "READ-ONLY DRY RUN"}`
  );
  console.log("No Huawei activate/deactivate command exists in this script.");

  const mappings = await loadCurrentMappings();
  const mappingByLocation = new Map(
    mappings.map((mapping) => [locationKeyForMapping(mapping), mapping])
  );
  const mappingsBySerial = new Map<string, MappingRow[]>();
  for (const mapping of mappings) {
    const serial = mapping.ont_serial?.trim().toUpperCase();
    if (!serial) continue;
    const sameSerial = mappingsBySerial.get(serial) ?? [];
    sameSerial.push(mapping);
    mappingsBySerial.set(serial, sameSerial);
  }

  const targetsByPort = new Map<string, ClarifiedTarget[]>();
  for (const target of TARGETS) {
    const targets = targetsByPort.get(portKey(target)) ?? [];
    targets.push(target);
    targetsByPort.set(portKey(target), targets);
  }

  const liveByLocation = new Map<string, ParsedOnt>();
  const failedPorts = new Set<string>();
  for (const [key, targets] of targetsByPort) {
    const first = targets[0];
    try {
      const result = await readOntPortFromOlt({
        managementIp: first.managementIp,
        frameNumber: first.frameNumber,
        slotNumber: first.slotNumber,
        ponPortNumber: first.ponPortNumber,
      });
      for (const live of result.onts) {
        liveByLocation.set(
          `${first.managementIp}/${live.frameNumber}/${live.slotNumber}/${live.ponPortNumber}/${live.ontId}`,
          live
        );
      }
    } catch (error) {
      failedPorts.add(key);
      console.error(
        `${key}: read-only PON query failed:`,
        error instanceof Error ? error.message : "unknown OLT error"
      );
    }
  }

  const candidates: SafeCandidate[] = [];
  const report: Array<Record<string, string | number>> = [];
  for (const target of TARGETS) {
    const location = locationKey(target);
    const mapping = mappingByLocation.get(location);
    const live = liveByLocation.get(location);
    let outcome = "safe_description_override";

    if (failedPorts.has(portKey(target))) outcome = "olt_port_read_failed";
    else if (!mapping) outcome = "mapping_not_added_in_app";
    else if (!customerMatchesTarget(target, mapping.customer_name)) {
      outcome = "location_assigned_to_different_customer";
    } else if (!live) outcome = "live_ont_not_found";
    else if (
      mapping.ont_serial &&
      mapping.ont_serial.trim().toUpperCase() !== live.ontSerial
    ) {
      outcome = "saved_serial_mismatch";
    } else {
      const otherSerialMappings =
        mappingsBySerial
          .get(live.ontSerial)
          ?.filter(
            (row) =>
              row.customer_ont_assignment_id !==
              mapping.customer_ont_assignment_id
          ) ?? [];
      if (otherSerialMappings.length > 0) {
        outcome = "serial_assigned_to_another_customer";
      } else if (!live.description?.trim()) {
        outcome = "live_description_missing";
      } else {
        const descriptionMatches =
          normalizeExactCustomerName(live.description) ===
          normalizeExactCustomerName(mapping.customer_name);
        const pinnedOverrideMatches =
          !!mapping.ont_description_override &&
          normalizeExactCustomerName(live.description) ===
            normalizeExactCustomerName(mapping.ont_description_override);
        const alreadySafe =
          mapping.mapping_status === "verified" &&
          mapping.ont_serial?.trim().toUpperCase() === live.ontSerial &&
          (descriptionMatches || pinnedOverrideMatches);
        if (alreadySafe) outcome = "already_verified";
        else {
          const overrideNeeded = !descriptionMatches;
          candidates.push({ target, mapping, live, overrideNeeded });
          outcome = overrideNeeded
            ? "safe_description_override"
            : "safe_exact_verification";
        }
      }
    }

    report.push({
      target: target.label,
      location,
      customerId: mapping?.customer_id ?? "—",
      appCustomer: mapping?.customer_name ?? "—",
      liveDescription: live?.description ?? "—",
      outcome,
    });
  }

  console.table(report);
  if (!apply) {
    console.log(`Safe changes available: ${candidates.length}`);
    console.log("Dry run only: no mapping status or description override was changed.");
    return;
  }

  const applyCounts = new Map<string, number>();
  for (const candidate of candidates) {
    const result = await applyCandidate(candidate);
    applyCounts.set(result, (applyCounts.get(result) ?? 0) + 1);
    console.log(`${candidate.target.label}: ${result}`);
  }
  console.log("Apply summary:");
  for (const [result, count] of applyCounts) console.log(`${result}: ${count}`);
}

main()
  .catch((error) => {
    console.error("Clarified OLT review failed:", error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
