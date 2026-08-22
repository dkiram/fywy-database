/** Parses read-only Huawei MA5680T `display ont info ... all` PuTTY logs. */

export type ParsedOnt = {
  frameNumber: number;
  slotNumber: number;
  ponPortNumber: number;
  ontId: number;
  ontSerial: string;
  controlFlag: "active" | "deactivated";
  runState: "online" | "offline";
  configState: string;
  matchState: string;
  description: string | null;
};

export type OntLogResult = {
  onts: ParsedOnt[];
  warnings: string[];
  reportedTotal: number | null;
  reportedOnline: number | null;
};

type StatusRecord = Omit<ParsedOnt, "description">;

const pagerMarker = /---- More \( Press 'Q' to break \) ----\s*/g;
const ansiEscape = /\u001B\[[0-?]*[ -/]*[@-~]/g;

function locationKey(
  frameNumber: number,
  slotNumber: number,
  ponPortNumber: number,
  ontId: number
) {
  return `${frameNumber}/${slotNumber}/${ponPortNumber}/${ontId}`;
}

/**
 * PuTTY records Huawei's pager prompt on the same line as the next row. Remove
 * only terminal decoration; the customer description and serial remain intact.
 */
function cleanTerminalLine(line: string) {
  return line.replace(ansiEscape, "").replace(pagerMarker, "").replace(/\0/g, "");
}

export function parseHuaweiOntLog(logText: string): OntLogResult {
  const statuses = new Map<string, StatusRecord>();
  const descriptions = new Map<string, string>();
  const reportedPorts = new Map<string, { total: number; online: number }>();
  const warnings: string[] = [];

  for (const [lineIndex, rawLine] of logText.split(/\r?\n/).entries()) {
    const line = cleanTerminalLine(rawLine);

    // Example: 0/11/0  45  4857544384095AA2  deactivated offline initial initial no
    const statusMatch = line.match(
      /^\s*(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)\s+(\d+)\s+([0-9A-F]{16})\s+(active|deactivated)\s+(online|offline)\s+(\S+)\s+(\S+)\s+\S+/i
    );
    if (statusMatch) {
      const record: StatusRecord = {
        frameNumber: Number(statusMatch[1]),
        slotNumber: Number(statusMatch[2]),
        ponPortNumber: Number(statusMatch[3]),
        ontId: Number(statusMatch[4]),
        ontSerial: statusMatch[5].toUpperCase(),
        controlFlag: statusMatch[6].toLowerCase() as StatusRecord["controlFlag"],
        runState: statusMatch[7].toLowerCase() as StatusRecord["runState"],
        configState: statusMatch[8].toLowerCase(),
        matchState: statusMatch[9].toLowerCase(),
      };
      const key = locationKey(
        record.frameNumber,
        record.slotNumber,
        record.ponPortNumber,
        record.ontId
      );
      const existing = statuses.get(key);
      if (existing && JSON.stringify(existing) !== JSON.stringify(record)) {
        throw new Error(`Conflicting ONT status rows for ${key} near line ${lineIndex + 1}.`);
      }
      statuses.set(key, record);
      continue;
    }

    // The command prints descriptions in a second table using the same tuple.
    const descriptionMatch = line.match(
      /^\s*(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)\s+(\d+)\s+(.+?)\s*$/
    );
    if (descriptionMatch) {
      const key = locationKey(
        Number(descriptionMatch[1]),
        Number(descriptionMatch[2]),
        Number(descriptionMatch[3]),
        Number(descriptionMatch[4])
      );
      const description = descriptionMatch[5].trim();
      const existing = descriptions.get(key);
      if (existing && existing !== description) {
        throw new Error(`Conflicting ONT descriptions for ${key} near line ${lineIndex + 1}.`);
      }
      descriptions.set(key, description);
      continue;
    }

    const footerMatch = line.match(
      /In port\s+(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)\s*,\s*the total of ONTs are:\s*(\d+)\s*,\s*online:\s*(\d+)/i
    );
    if (footerMatch) {
      const portKey = `${Number(footerMatch[1])}/${Number(footerMatch[2])}/${Number(footerMatch[3])}`;
      reportedPorts.set(portKey, {
        total: Number(footerMatch[4]),
        online: Number(footerMatch[5]),
      });
    }
  }

  if (statuses.size === 0) {
    throw new Error("No Huawei ONT status rows were found in this PuTTY log.");
  }

  const onts = [...statuses.entries()]
    .map(([key, status]) => ({
      ...status,
      description: descriptions.get(key) ?? null,
    }))
    .sort(
      (left, right) =>
        left.frameNumber - right.frameNumber ||
        left.slotNumber - right.slotNumber ||
        left.ponPortNumber - right.ponPortNumber ||
        left.ontId - right.ontId
    );

  const missingDescriptions = onts.filter((ont) => !ont.description).length;
  if (missingDescriptions > 0) {
    warnings.push(`${missingDescriptions} ONT row(s) have no customer description.`);
  }
  const orphanDescriptions = [...descriptions.keys()].filter((key) => !statuses.has(key));
  if (orphanDescriptions.length > 0) {
    warnings.push(`${orphanDescriptions.length} description row(s) have no matching ONT status.`);
  }
  // Compare each Huawei footer with only that physical PON port. This supports
  // putting ports 0-15 into one PuTTY log without treating the last footer as
  // the total for the entire file.
  for (const [portKey, reported] of reportedPorts) {
    const [frame, slot, port] = portKey.split("/").map(Number);
    const portOnts = onts.filter(
      (ont) =>
        ont.frameNumber === frame &&
        ont.slotNumber === slot &&
        ont.ponPortNumber === port
    );
    const parsedOnline = portOnts.filter((ont) => ont.runState === "online").length;
    if (reported.total !== portOnts.length) {
      warnings.push(
        `${portKey}: Huawei reported ${reported.total} ONTs, but the parser found ${portOnts.length}.`
      );
    }
    if (reported.online !== parsedOnline) {
      warnings.push(
        `${portKey}: Huawei reported ${reported.online} online ONTs, but the parser found ${parsedOnline}.`
      );
    }
  }

  const reportedTotal = reportedPorts.size
    ? [...reportedPorts.values()].reduce((sum, port) => sum + port.total, 0)
    : null;
  const reportedOnline = reportedPorts.size
    ? [...reportedPorts.values()].reduce((sum, port) => sum + port.online, 0)
    : null;

  return { onts, warnings, reportedTotal, reportedOnline };
}
