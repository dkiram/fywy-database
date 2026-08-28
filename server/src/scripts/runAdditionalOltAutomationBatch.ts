/** Runs one explicitly confirmed continuation of today's automatic OLT batch. */
import { pool } from "../db.js";
import { runAutomaticDelinquentDisconnect } from "../huawei/delinquentAutomation.js";

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() : undefined;
}

const count = Number.parseInt(argument("--count") ?? "", 10);
const maxScheduledDate = argument("--max-scheduled-date") ?? "";
const confirmation = argument("--confirmation") ?? "";
const expectedConfirmation = `RUN ADDITIONAL ${count} THROUGH ${maxScheduledDate}`;

if (!Number.isInteger(count) || count < 1 || count > 500) {
  console.error(
    "Usage: runAdditionalOltAutomationBatch --count <1-500> --max-scheduled-date <YYYY-MM-DD> --confirmation <text>"
  );
  process.exit(2);
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(maxScheduledDate) || Number.isNaN(Date.parse(maxScheduledDate))) {
  console.error("--max-scheduled-date must be a real calendar date in YYYY-MM-DD form. Nothing was run.");
  process.exit(2);
}
if (confirmation !== expectedConfirmation) {
  console.error(
    `The one-time batch confirmation did not match. Expected: "${expectedConfirmation}". Nothing was run.`
  );
  process.exit(2);
}

runAutomaticDelinquentDisconnect({
  allowAdditionalRunToday: true,
  maxPerRunOverride: count,
  maxScheduledDate,
})
  .then((result) => {
    console.log("One-time additional OLT batch result:", JSON.stringify(result));
    if (!result.ran) process.exitCode = 1;
  })
  .catch((error) => {
    console.error(
      "One-time additional OLT batch failed:",
      error instanceof Error ? error.message : "unknown error"
    );
    process.exitCode = 1;
  })
  .finally(() => pool.end());
