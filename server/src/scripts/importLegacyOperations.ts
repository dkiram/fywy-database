import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { pool } from "../db.js";

// Read one Access table as newline-delimited JSON using mdbtools. The original
// .accdb remains read-only; all normalization happens inside PostgreSQL.
async function readAccessTable(tableName: string) {
  const databasePath = path.resolve(process.cwd(), "..", "SPCL 2018 acco.accdb");
  const child = spawn("mdb-json", [databasePath, tableName], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const rows: Record<string, unknown>[] = [];
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  const lines = createInterface({ input: child.stdout });
  for await (const line of lines) {
    if (line.trim()) rows.push(JSON.parse(line));
  }

  const exitCode = await new Promise<number | null>((resolve) => child.on("close", resolve));
  if (exitCode !== 0) throw new Error(`mdb-json failed for ${tableName}: ${stderr.trim()}`);
  return rows;
}

function cleanText(value: unknown) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function dateOnly(value: unknown) {
  const text = cleanText(value);
  if (!text) return "";
  const parsed = new Date(text);
  if (Number.isNaN(parsed.valueOf())) return "";
  return parsed.toISOString().slice(0, 10);
}

async function main() {
  const [poleRows, serviceRows] = await Promise.all([
    readAccessTable("PoleBoxTBL"),
    readAccessTable("Service TBL"),
  ]);

  // Duplicate and blank legacy labels receive a stable ID suffix so the new
  // inventory can keep a unique normalized box number without losing evidence.
  const labelCounts = new Map<string, number>();
  for (const row of poleRows) {
    const label = cleanText(row["Box No"]).toUpperCase();
    if (label) labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
  }

  const client = await pool.connect();
  let importedPoleBoxes = 0;
  let remappedCustomers = 0;
  let importedTickets = 0;

  try {
    await client.query("BEGIN");

    // The MVP 4 migration created temporary inventory rows from the numeric
    // values stored on customers. Those values are Access BoxIDs, not the
    // human-facing box labels. Move every temporary row to a collision-proof
    // staging label first, then the loop below can safely replace it with the
    // real Access label (for example, BoxID 51 may itself be labelled "51").
    await client.query(`
      UPDATE public.pole_boxes SET
        legacy_box_id = box_number::INTEGER,
        box_number = 'Legacy import staging ' || box_number,
        updated_at = CURRENT_TIMESTAMP
      WHERE legacy_box_id IS NULL
        AND notes = 'Imported from existing customer pole-box assignments'
        AND box_number ~ '^[0-9]+$';
    `);

    for (const row of poleRows) {
      const legacyBoxId = Number(row.BoxID);
      if (!Number.isInteger(legacyBoxId) || legacyBoxId < 1) continue;
      const legacyLabel = cleanText(row["Box No"]);
      const normalizedLabel = legacyLabel.toUpperCase();
      const displayLabel = !legacyLabel
        ? `Legacy Pole Box ${legacyBoxId}`
        : (labelCounts.get(normalizedLabel) ?? 0) > 1
          ? `${legacyLabel} [Legacy ID ${legacyBoxId}]`
          : legacyLabel;
      const rawCapacity = Number(row["No of Ports"]);
      const capacity = Number.isInteger(rawCapacity) && rawCapacity >= 1 && rawCapacity <= 64
        ? rawCapacity
        : null;
      const importNote = capacity === null && Number.isFinite(rawCapacity)
        ? `Imported from Access; invalid legacy capacity preserved as ${rawCapacity}`
        : "Imported from Access PoleBoxTBL";

      const existingResult = await client.query(
        `
        SELECT pole_box_id
        FROM public.pole_boxes
        WHERE legacy_box_id = $1
           OR (
             legacy_box_id IS NULL
             AND normalized_box_number = UPPER(TRIM($2))
             AND notes = 'Imported from existing customer pole-box assignments'
           )
        ORDER BY CASE WHEN legacy_box_id = $1 THEN 0 ELSE 1 END
        LIMIT 1
        FOR UPDATE;
        `,
        [legacyBoxId, String(legacyBoxId)]
      );

      let poleBoxId: number;
      if (existingResult.rows.length > 0) {
        poleBoxId = Number(existingResult.rows[0].pole_box_id);
        await client.query(
          `
          UPDATE public.pole_boxes SET
            box_number = $1,
            capacity = $2,
            legacy_box_id = $3,
            legacy_box_number = NULLIF($4, ''),
            legacy_capacity_raw = $5,
            notes = $6,
            updated_at = CURRENT_TIMESTAMP
          WHERE pole_box_id = $7;
          `,
          [displayLabel, capacity, legacyBoxId, legacyLabel, Number.isFinite(rawCapacity) ? rawCapacity : null, importNote, poleBoxId]
        );
      } else {
        const inserted = await client.query(
          `
          INSERT INTO public.pole_boxes (
            box_number, capacity, status, notes,
            legacy_box_id, legacy_box_number, legacy_capacity_raw
          ) VALUES ($1, $2, 'active', $3, $4, NULLIF($5, ''), $6)
          RETURNING pole_box_id;
          `,
          [displayLabel, capacity, importNote, legacyBoxId, legacyLabel, Number.isFinite(rawCapacity) ? rawCapacity : null]
        );
        poleBoxId = Number(inserted.rows[0].pole_box_id);
      }
      void poleBoxId;
      importedPoleBoxes += 1;

      const remapped = await client.query(
        `
        UPDATE public.customers SET
          legacy_pole_box_id = $1,
          pole_box_number = $2
        WHERE legacy_pole_box_id = $1
           OR (
             legacy_pole_box_id IS NULL
             AND TRIM(COALESCE(pole_box_number, '')) = $1::TEXT
           );
        `,
        [legacyBoxId, displayLabel]
      );
      remappedCustomers += remapped.rowCount ?? 0;
    }

    for (const row of serviceRows) {
      const legacyServiceId = cleanText(row.ServiceID);
      const customerId = Number(row.CustomerID);
      if (!legacyServiceId || !Number.isInteger(customerId)) continue;
      const customerResult = await client.query(
        `SELECT customer_id, pole_box_number, port_number FROM public.customers WHERE customer_id = $1;`,
        [customerId]
      );
      // Missing customer IDs are retained as unlinked legacy tickets. This is
      // safer than creating fake customer profiles and keeps all Access rows.
      const linkedCustomer = customerResult.rows[0] ?? null;

      const customerLog = cleanText(row["Customer Log"]);
      const serviceLog = cleanText(row["Service Log"]);
      const reportedDate = dateOnly(row["Date Reported"]);
      const serviceDate = dateOnly(row["Service Date"]);
      const status = serviceDate && serviceLog ? "completed" : "open";
      const sourceKey = `access-service:${legacyServiceId}`;
      const ticketResult = await client.query(
        `
        INSERT INTO public.service_tickets (
          customer_id, issue_summary, description, priority, status,
          reported_date, pole_box_number, port_number, service_date,
          resolution_notes, completed_at, legacy_service_id,
          legacy_source, source_key, legacy_customer_id
        ) VALUES (
          $1, $2, NULLIF($3, ''), 'normal', $4,
          COALESCE(NULLIF($5, '')::DATE, (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE),
          NULLIF($6, ''), NULLIF($7, ''), NULLIF($8, '')::DATE,
          NULLIF($9, ''), CASE WHEN $4 = 'completed' THEN CURRENT_TIMESTAMP ELSE NULL END,
          $10, 'Service TBL', $11, $12
        )
        ON CONFLICT (source_key) DO UPDATE SET
          customer_id = EXCLUDED.customer_id,
          issue_summary = EXCLUDED.issue_summary,
          description = EXCLUDED.description,
          status = EXCLUDED.status,
          reported_date = EXCLUDED.reported_date,
          pole_box_number = EXCLUDED.pole_box_number,
          port_number = EXCLUDED.port_number,
          service_date = EXCLUDED.service_date,
          resolution_notes = EXCLUDED.resolution_notes,
          legacy_customer_id = EXCLUDED.legacy_customer_id,
          updated_at = CURRENT_TIMESTAMP
        RETURNING service_ticket_id;
        `,
        [
          linkedCustomer ? customerId : null,
          (customerLog || "Legacy service request").slice(0, 160),
          customerLog,
          status,
          reportedDate,
          linkedCustomer?.pole_box_number || "",
          linkedCustomer?.port_number || "",
          serviceDate,
          serviceLog,
          legacyServiceId,
          sourceKey,
          customerId,
        ]
      );
      const ticketId = ticketResult.rows[0].service_ticket_id;
      await client.query(
        `
        INSERT INTO public.service_ticket_history (
          service_ticket_id, event_type, from_status, to_status,
          note, changed_by_employee_id, source_key
        ) VALUES ($1, 'created', NULL, $2, $3, NULL, $4)
        -- Match the migration's partial unique index, which allows ordinary
        -- application history rows to keep a NULL source key.
        ON CONFLICT (source_key) WHERE source_key IS NOT NULL DO NOTHING;
        `,
        [ticketId, status, serviceLog || customerLog || "Imported legacy service request", `${sourceKey}:history`]
      );
      importedTickets += 1;
    }

    await client.query("COMMIT");
    console.log(JSON.stringify({ importedPoleBoxes, remappedCustomers, importedTickets }));
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error("Legacy operations import failed:", error);
  process.exitCode = 1;
});
