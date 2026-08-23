/** Runs one explicitly confirmed continuation of today's automatic OLT batch. */
import { pool } from "../db.js";
import { runAutomaticDelinquentDisconnect } from "../huawei/delinquentAutomation.js";

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() : undefined;
}

const count = Number.parseInt(argument("--count") ?? "", 10);
const confirmation = argument("--confirmation") ?? "";
const expectedConfirmation = `RUN ADDITIONAL ${count}`;

if (!Number.isInteger(count) || count < 1 || count > 500) {
  console.error("Usage: runAdditionalOltAutomationBatch --count <1-500> --confirmation <text>");
  process.exit(2);
}
if (confirmation !== expectedConfirmation) {
  console.error("The one-time batch confirmation did not match. Nothing was run.");
  process.exit(2);
}

runAutomaticDelinquentDisconnect({
  allowAdditionalRunToday: true,
  maxPerRunOverride: count,
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
