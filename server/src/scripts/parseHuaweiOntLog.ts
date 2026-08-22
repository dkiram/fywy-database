/** Converts a Huawei PuTTY ONT listing into a reviewable CSV or JSON file. */
import { isIP } from "node:net";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseHuaweiOntLog } from "../huawei/parseOntLog.js";

type Format = "csv" | "json";

function readOption(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function csvCell(value: unknown) {
  const text = value == null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function showUsage(): never {
  console.error(
    "Usage: npm run parse:ont-log -- --file <log.txt> --olt-name <name> " +
      "--management-ip <ip> [--format csv|json] [--output <file>]"
  );
  process.exit(1);
}

async function main() {
  const file = readOption("--file");
  const oltName = readOption("--olt-name")?.trim();
  const managementIp = readOption("--management-ip")?.trim();
  const format = (readOption("--format") ?? "csv") as Format;
  const output = readOption("--output");

  if (!file || !oltName || !managementIp) showUsage();
  if (isIP(managementIp) === 0) throw new Error("--management-ip must be a valid IP address.");
  if (!(["csv", "json"] as string[]).includes(format)) {
    throw new Error("--format must be csv or json.");
  }

  const logText = await readFile(path.resolve(file), "utf8");
  const result = parseHuaweiOntLog(logText);
  const rows = result.onts.map((ont) => ({
    oltName,
    managementIp,
    ...ont,
  }));

  let rendered: string;
  if (format === "json") {
    rendered = `${JSON.stringify({ rows, warnings: result.warnings }, null, 2)}\n`;
  } else {
    const headers = [
      "olt_name",
      "management_ip",
      "frame",
      "card_slot",
      "pon_port",
      "ont_id",
      "ont_serial",
      "customer_description",
      "control_flag",
      "run_state",
      "config_state",
      "match_state",
    ];
    const dataRows = rows.map((row) => [
      row.oltName,
      row.managementIp,
      row.frameNumber,
      row.slotNumber,
      row.ponPortNumber,
      row.ontId,
      row.ontSerial,
      row.description,
      row.controlFlag,
      row.runState,
      row.configState,
      row.matchState,
    ]);
    rendered = `${[headers, ...dataRows]
      .map((row) => row.map(csvCell).join(","))
      .join("\n")}\n`;
  }

  if (output) {
    const outputPath = path.resolve(output);
    await writeFile(outputPath, rendered, { encoding: "utf8", mode: 0o600 });
    console.log(`Wrote ${rows.length} ONT rows to ${outputPath}`);
  } else {
    process.stdout.write(rendered);
  }

  const online = rows.filter((row) => row.runState === "online").length;
  const deactivated = rows.filter((row) => row.controlFlag === "deactivated").length;
  console.error(
    `Parsed ${rows.length} ONTs: ${online} online, ${deactivated} deactivated, ` +
      `${result.warnings.length} warning(s).`
  );
  for (const warning of result.warnings) console.error(`Warning: ${warning}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
