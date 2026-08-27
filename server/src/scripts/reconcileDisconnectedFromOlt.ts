/**
 * Reconcile account status DOWN to physical reality: where the live OLT shows a
 * customer's ONT `deactivated` but the account is still `active`, mark the
 * account `disconnected`.
 *
 * Read-only against the OLT — one `display ont info` per PON port, no Huawei
 * write ever. Only money left untouched: existing charges stay, migration 054's
 * trigger stops new ones once the disconnected status-history row exists.
 *
 * A candidate is transitioned only when the live ONT at the saved location is
 * `deactivated` AND its serial matches the saved serial AND (unless
 * --skip-name-match) its description matches the customer name — so a stale or
 * wrong mapping cannot disconnect the wrong person.
 *
 * Preview (no OLT write, no DB write):
 *   npm run reconcile:olt-disconnected -- --performed-by <username>
 *
 * Apply after reviewing the count:
 *   npm run reconcile:olt-disconnected -- --performed-by <username> --apply \
 *     --expected-count <count> \
 *     --confirmation "RECONCILE <count> OLT DISCONNECTED ACCOUNTS"
 */
import { isIP } from "node:net";
import type { PoolClient } from "pg";
import { pool } from "../db.js";
import { normalizeExactCustomerName } from "../huawei/matchOntCustomers.js";
import { readOntPortFromOlt, OltVerificationError } from "../huawei/verifyOnt.js";
import type { ParsedOnt } from "../huawei/parseOntLog.js";

const ELIGIBLE_PERFORMER_ROLES = ["admin", "head_office"];
const STATUS_REASON = "Live OLT shows the ONT deactivated; reconciling account status";

type MappingRow = {
  customer_ont_assignment_id: number;
  customer_id: number;
  customer_name: string;
  management_ip: string;
  olt_name: string;
  frame_number: number;
  slot_number: number;
  pon_port_number: number;
  ont_id: number;
  ont_serial: string | null;
  outstanding_balance: string;
  is_delinquent: boolean;
};

type Performer = {
  employee_id: string;
  first_name: string;
  last_name: string;
  role: string;
};

type Candidate = { mapping: MappingRow; live: ParsedOnt };

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() : undefined;
}

function positiveInteger(value: string | undefined) {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function portKey(m: { frame_number: number; slot_number: number; pon_port_number: number }) {
  return `${m.frame_number}/${m.slot_number}/${m.pon_port_number}`;
}
function locationKey(m: MappingRow) {
  return `${portKey(m)}/${m.ont_id}`;
}

function usage() {
  return [
    "Preview:",
    "  npm run reconcile:olt-disconnected -- --performed-by <username>",
    "",
    "Options:",
    "  --management-ip <IP>   only this OLT (default: every active OLT)",
    "  --include-non-delinquent   also reconcile active accounts that are not delinquent",
    "  --skip-name-match      match on location + serial only (less safe)",
    "",
    "Apply:",
    "  npm run reconcile:olt-disconnected -- --performed-by <username> --apply \\",
    "    --expected-count <count> \\",
    '    --confirmation "RECONCILE <count> OLT DISCONNECTED ACCOUNTS"',
  ].join("\n");
}

async function findPerformer(client: PoolClient, username: string): Promise<Performer> {
  const result = await client.query<Performer>(
    `SELECT employee_id, first_name, last_name, role
     FROM public.employees
     WHERE LOWER(username) = LOWER($1) AND is_active = TRUE
     LIMIT 1;`,
    [username]
  );
  const performer = result.rows[0];
  if (!performer) {
    const choices = await client.query<{ username: string; role: string }>(
      `SELECT username, role FROM public.employees
       WHERE is_active = TRUE AND username IS NOT NULL AND role = ANY($1)
       ORDER BY username;`,
      [ELIGIBLE_PERFORMER_ROLES]
    );
    throw new Error(
      `No active employee has username "${username}". Use one of:\n` +
        choices.rows.map((r) => `  ${r.username} (${r.role})`).join("\n")
    );
  }
  if (!ELIGIBLE_PERFORMER_ROLES.includes(performer.role)) {
    throw new Error(`${username} has role "${performer.role}", which cannot disconnect accounts.`);
  }
  return performer;
}

async function loadMappings(includeNonDelinquent: boolean, managementIp: string | null) {
  const result = await pool.query<MappingRow>(
    `SELECT
       a.customer_ont_assignment_id,
       a.customer_id,
       c.name AS customer_name,
       host(o.management_ip) AS management_ip,
       o.name AS olt_name,
       a.frame_number, a.slot_number, a.pon_port_number, a.ont_id,
       a.ont_serial,
       billing.outstanding_balance,
       billing.is_delinquent
     FROM public.customer_ont_assignments a
     JOIN public.customers c ON c.customer_id = a.customer_id
     JOIN public.olts o ON o.olt_id = a.olt_id
     JOIN public.customer_billing_status billing ON billing.customer_id = a.customer_id
     WHERE a.ended_at IS NULL
       AND c.status = 'active'
       AND c.hidden_from_app = FALSE
       AND o.is_active = TRUE
       AND ($1::BOOLEAN OR billing.is_delinquent)
       AND ($2::INET IS NULL OR o.management_ip = $2::INET)
     ORDER BY o.management_ip, a.frame_number, a.slot_number, a.pon_port_number, a.ont_id;`,
    [includeNonDelinquent, managementIp]
  );
  return result.rows;
}

async function transition(performer: Performer, candidate: Candidate) {
  const { mapping, live } = candidate;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query(
      `SELECT status FROM public.customers WHERE customer_id = $1 FOR UPDATE;`,
      [mapping.customer_id]
    );
    if (locked.rows[0]?.status !== "active") {
      await client.query("ROLLBACK");
      return false;
    }

    const today = (
      await client.query(
        `SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE AS d;`
      )
    ).rows[0].d;
    const sourceKey = `olt-reconcile-disconnect:${mapping.customer_id}:${today}`;

    await client.query(
      `INSERT INTO public.account_status_history (
         customer_id, from_status, to_status, reason,
         effective_date, changed_by_employee_id, source_key
       ) VALUES ($1, 'active', 'disconnected', $2,
         (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE, $3, $4)
       ON CONFLICT (source_key) DO NOTHING;`,
      [mapping.customer_id, STATUS_REASON, performer.employee_id, sourceKey]
    );

    await client.query(
      `UPDATE public.customers
       SET status = 'disconnected',
           deactivation_date = (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE
       WHERE customer_id = $1 AND status = 'active';`,
      [mapping.customer_id]
    );

    await client.query(
      `INSERT INTO public.audit_logs (
         employee_id, actor_name, action, entity_type, entity_id,
         field_name, old_value, new_value, reason, occurred_at, source_key
       ) VALUES ($1, $2, 'Marked disconnected (OLT reconciliation)', 'customer', $3,
         'status', 'active', $4, $5, CURRENT_TIMESTAMP, $6)
       ON CONFLICT (source_key) DO NOTHING;`,
      [
        performer.employee_id,
        `${performer.first_name} ${performer.last_name}`,
        String(mapping.customer_id),
        JSON.stringify({
          status: "disconnected",
          location: locationKey(mapping),
          liveControlFlag: live.controlFlag,
          liveRunState: live.runState,
          liveSerial: live.ontSerial,
        }),
        STATUS_REASON,
        sourceKey,
      ]
    );

    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(
      `Could not reconcile customer ${mapping.customer_id}:`,
      error instanceof Error ? error.message : "unknown database error"
    );
    return false;
  } finally {
    client.release();
  }
}

async function main() {
  const username = argument("--performed-by") ?? "";
  const apply = process.argv.includes("--apply");
  const includeNonDelinquent = process.argv.includes("--include-non-delinquent");
  const skipNameMatch = process.argv.includes("--skip-name-match");
  const expectedCount = positiveInteger(argument("--expected-count"));
  const confirmation = argument("--confirmation") ?? "";
  const managementIp = argument("--management-ip") ?? null;

  if (!username) throw new Error(`--performed-by is required.\n\n${usage()}`);
  if (managementIp && !isIP(managementIp)) throw new Error("--management-ip must be an IP address.");
  if (apply && expectedCount === null) {
    throw new Error(`--expected-count is required in apply mode.\n\n${usage()}`);
  }

  const setupClient = await pool.connect();
  let performer: Performer;
  try {
    performer = await findPerformer(setupClient, username);
  } finally {
    setupClient.release();
  }

  const mappings = await loadMappings(includeNonDelinquent, managementIp);
  const groups = new Map<string, MappingRow[]>();
  for (const m of mappings) {
    const key = `${m.management_ip}|${portKey(m)}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(m);
    else groups.set(key, [m]);
  }

  const counts = {
    mappings: mappings.length,
    ports: groups.size,
    portsRead: 0,
    portErrors: 0,
    ontNotFound: 0,
    serialMismatch: 0,
    nameMismatch: 0,
    activeOnOlt: 0,
    deactivatedOnOlt: 0,
    reconciled: 0,
    conflicts: 0,
  };
  const candidates: Candidate[] = [];

  console.log(`Mode: ${apply ? "APPLY" : "DRY RUN (no OLT write, no DB write)"}`);
  console.log(
    `Loaded ${counts.mappings} ONT assignment(s)` +
      `${includeNonDelinquent ? "" : " for delinquent accounts"} across ${counts.ports} PON port(s).`
  );

  for (const portMappings of groups.values()) {
    const first = portMappings[0];
    let liveByLocation: Map<string, ParsedOnt>;
    try {
      const parsed = await readOntPortFromOlt({
        managementIp: first.management_ip,
        frameNumber: Number(first.frame_number),
        slotNumber: Number(first.slot_number),
        ponPortNumber: Number(first.pon_port_number),
      });
      counts.portsRead += 1;
      liveByLocation = new Map(
        parsed.onts.map((o) => [
          `${o.frameNumber}/${o.slotNumber}/${o.ponPortNumber}/${o.ontId}`,
          o,
        ])
      );
    } catch (error) {
      counts.portErrors += 1;
      console.error(
        `PON read failed for ${first.management_ip} ${portKey(first)}:`,
        error instanceof OltVerificationError ? error.message : String(error)
      );
      continue;
    }

    for (const mapping of portMappings) {
      const live = liveByLocation.get(locationKey(mapping));
      if (!live) {
        counts.ontNotFound += 1;
        continue;
      }
      if (
        mapping.ont_serial?.trim() &&
        mapping.ont_serial.trim().toUpperCase() !== live.ontSerial
      ) {
        counts.serialMismatch += 1;
        continue;
      }
      if (
        !skipNameMatch &&
        (!live.description ||
          normalizeExactCustomerName(live.description) !==
            normalizeExactCustomerName(mapping.customer_name))
      ) {
        counts.nameMismatch += 1;
        continue;
      }
      if (live.controlFlag !== "deactivated") {
        counts.activeOnOlt += 1;
        continue;
      }
      counts.deactivatedOnOlt += 1;
      candidates.push({ mapping, live });
    }
  }

  if (candidates.length > 0) {
    console.table(
      candidates.map((c) => ({
        customer: c.mapping.customer_id,
        name: c.mapping.customer_name,
        olt: c.mapping.olt_name,
        location: locationKey(c.mapping),
        run_state: c.live.runState,
        balance: c.mapping.outstanding_balance,
        delinquent: c.mapping.is_delinquent,
      }))
    );
  }

  const expectedConfirmation = `RECONCILE ${candidates.length} OLT DISCONNECTED ACCOUNTS`;

  if (!apply) {
    console.log("\nSummary:");
    for (const [k, v] of Object.entries(counts)) console.log(`  ${k}: ${v}`);
    console.log(
      `\nDRY RUN: nothing changed. ${candidates.length} account(s) would be marked disconnected.`
    );
    if (candidates.length > 0) {
      console.log(
        `To apply: --apply --expected-count ${candidates.length} ` +
          `--confirmation "${expectedConfirmation}"` +
          (managementIp ? ` --management-ip ${managementIp}` : "") +
          (includeNonDelinquent ? " --include-non-delinquent" : "") +
          (skipNameMatch ? " --skip-name-match" : "")
      );
    }
    return;
  }

  if (candidates.length !== expectedCount) {
    throw new Error(
      `Expected ${expectedCount} accounts, but the live OLT read found ${candidates.length}. ` +
        "Nothing was changed; run the preview again."
    );
  }
  if (confirmation !== expectedConfirmation) {
    throw new Error(`Confirmation did not match "${expectedConfirmation}". Nothing was changed.`);
  }
  if (candidates.length === 0) {
    throw new Error("No accounts to reconcile.");
  }

  for (const candidate of candidates) {
    if (await transition(performer, candidate)) counts.reconciled += 1;
    else counts.conflicts += 1;
  }

  console.log("\nSummary:");
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k}: ${v}`);
  console.log(
    `\nMarked ${counts.reconciled} account(s) disconnected to match the OLT. No Huawei command ` +
      "was sent and no balances were changed."
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "Unknown OLT reconciliation error.");
    process.exitCode = 1;
  })
  .finally(() => pool.end());
