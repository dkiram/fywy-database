import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseHuaweiOntLog, type ParsedOnt } from "./parseOntLog.js";

function importedOntKey(ont: ParsedOnt) {
  return [ont.frameNumber, ont.slotNumber, ont.ponPortNumber, ont.ontId].join("/");
}

/** Read and validate one or more private PuTTY captures as one OLT snapshot. */
export async function readHuaweiOntLogs(files: string[]) {
  const ontsByLocation = new Map<string, ParsedOnt>();
  const warnings: string[] = [];

  for (const file of files) {
    const absolutePath = path.resolve(file);
    const parsed = parseHuaweiOntLog(await readFile(absolutePath, "utf8"));
    warnings.push(...parsed.warnings.map((warning) => `${path.basename(file)}: ${warning}`));

    for (const ont of parsed.onts) {
      const key = importedOntKey(ont);
      const existing = ontsByLocation.get(key);
      if (existing && JSON.stringify(existing) !== JSON.stringify(ont)) {
        throw new Error(`The input files contain conflicting ONT data for ${key}.`);
      }
      ontsByLocation.set(key, ont);
    }
  }

  if (warnings.length > 0) {
    throw new Error(
      `Huawei log validation found ${warnings.length} warning(s):\n${warnings.join("\n")}`
    );
  }

  // A serial appearing at two live locations means at least one record is not
  // safe to import. Stop the entire run instead of guessing which one is new.
  const locationsBySerial = new Map<string, string>();
  for (const [location, ont] of ontsByLocation) {
    const existingLocation = locationsBySerial.get(ont.ontSerial);
    if (existingLocation && existingLocation !== location) {
      throw new Error(
        `ONT serial ${ont.ontSerial} appears at both ${existingLocation} and ${location}.`
      );
    }
    locationsBySerial.set(ont.ontSerial, location);
  }

  return [...ontsByLocation.values()].sort(
    (left, right) =>
      left.frameNumber - right.frameNumber ||
      left.slotNumber - right.slotNumber ||
      left.ponPortNumber - right.ponPortNumber ||
      left.ontId - right.ontId
  );
}
