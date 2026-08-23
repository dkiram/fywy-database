/**
 * Reports exactly why receipt email is failing, in Google's own words.
 *
 * The API deliberately hides Gmail's error from cashiers - "Gmail could not
 * send the receipt" is all a counter needs to know. That sanitising happens
 * before anything is written down, though, so the real reason never reaches
 * the logs or the database either, and there is no way to tell a wrong From
 * address from a disabled API from a dead token. This script asks Google the
 * same questions the mailer does and prints the answers unedited.
 *
 * Read-only unless a recipient is passed: with no argument it checks
 * configuration, the refresh token and the granted scopes and sends nothing.
 *
 *   npm run check:gmail
 *   npm run check:gmail -- you@example.com
 */
import "dotenv/config";
import dotenv from "dotenv";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { google } from "googleapis";
import { sendReceiptEmail, type EmailedReceipt } from "../email/receiptEmail.js";

const args = process.argv.slice(2);
/* --real sends through sendReceiptEmail, the exact function the API calls, so
   the multipart receipt itself is under test rather than a hand-written plain
   text stand-in. A trivial message proving the credentials work says nothing
   about whether the real payload is accepted. */
const useRealReceipt = args.includes("--real");
const explicitEnvFiles = args
  .filter((arg) => arg.startsWith("--env="))
  .map((arg) => arg.slice("--env=".length));
const recipient = args.find((arg) => !arg.startsWith("--"))?.trim() ?? "";

/**
 * Finds the Gmail values wherever they actually live.
 *
 * `dotenv/config` reads ./.env and nothing else, but authorizeGmail.ts writes
 * its output to .env.gmail by default - so the values normally sit in a file
 * the server never loads either, having been copied straight to the NAS's
 * .env.production. Checking only .env therefore reports MISSING on the very
 * machine that holds the credentials. Every plausible file is read, .env still
 * wins, and each value is labelled with the file it came from so a mismatch
 * between this machine and the NAS is visible rather than assumed.
 */
const GMAIL_KEYS = [
  "GMAIL_CLIENT_ID",
  "GMAIL_CLIENT_SECRET",
  "GMAIL_REFRESH_TOKEN",
  "GMAIL_SENDER_ADDRESS",
  "GMAIL_SENDER_NAME",
] as const;

const valueSource = new Map<string, string>();
for (const key of GMAIL_KEYS) {
  if (process.env[key]) valueSource.set(key, "environment or .env");
}

const candidateFiles = explicitEnvFiles.length > 0
  ? explicitEnvFiles
  : [".env.gmail", "../.env.production", ".env.production"];
const filesRead: string[] = [];

for (const candidate of candidateFiles) {
  const resolved = path.resolve(candidate);
  if (!existsSync(resolved)) continue;
  filesRead.push(resolved);
  const parsed = dotenv.parse(readFileSync(resolved, "utf8"));
  for (const key of GMAIL_KEYS) {
    // First file to supply a key wins, and anything already in the real
    // environment always wins, matching how the server itself resolves them.
    if (parsed[key] && !process.env[key]) {
      process.env[key] = parsed[key];
      valueSource.set(key, path.basename(resolved));
    }
  }
}

const clientId = process.env.GMAIL_CLIENT_ID?.trim() ?? "";
const clientSecret = process.env.GMAIL_CLIENT_SECRET?.trim() ?? "";
const refreshToken = process.env.GMAIL_REFRESH_TOKEN?.trim() ?? "";
const senderAddress = process.env.GMAIL_SENDER_ADDRESS?.trim() ?? "receipts@fywycable.com";
const senderName = process.env.GMAIL_SENDER_NAME?.trim() ?? "SPCL/FYWY Cable - Do Not Reply";

/* Enough of a secret to confirm the right value is loaded, never enough to
   reconstruct it if this output gets pasted into a chat. */
function mask(value: string) {
  if (!value) return "MISSING";
  if (value.length <= 12) return `set (${value.length} chars)`;
  return `${value.slice(0, 6)}...${value.slice(-4)} (${value.length} chars)`;
}

function heading(text: string) {
  console.log(`\n=== ${text} ===`);
}

heading("1. Configuration on this machine");
console.log(`Files read: ${filesRead.length > 0 ? filesRead.join(", ") : "(only ./.env)"}`);
console.log("");
function origin(key: string) {
  const source = valueSource.get(key);
  return source ? `  <- ${source}` : "";
}
console.log(`GMAIL_CLIENT_ID       ${mask(clientId)}${origin("GMAIL_CLIENT_ID")}`);
console.log(`GMAIL_CLIENT_SECRET   ${mask(clientSecret)}${origin("GMAIL_CLIENT_SECRET")}`);
console.log(`GMAIL_REFRESH_TOKEN   ${mask(refreshToken)}${origin("GMAIL_REFRESH_TOKEN")}`);
console.log(`GMAIL_SENDER_ADDRESS  ${senderAddress}${origin("GMAIL_SENDER_ADDRESS")}`);
console.log(`GMAIL_SENDER_NAME     ${senderName}${origin("GMAIL_SENDER_NAME")}`);

if (!clientId || !clientSecret || !refreshToken) {
  console.log(
    "\nSTOP: nothing to test - no Gmail credentials found in any of the files above." +
      "\nPoint this at the file that has them:" +
      "\n  npm run check:gmail -- --env=.env.gmail" +
      "\nThe server itself only ever reads .env (or .env.production on the NAS), so if the" +
      "\nvalues live somewhere else, receipt email is unconfigured there too.",
  );
  process.exit(1);
}

const auth = new google.auth.OAuth2(clientId, clientSecret);
auth.setCredentials({ refresh_token: refreshToken });

heading("2. Exchanging the refresh token for an access token");
let accessToken = "";
try {
  const response = await auth.getAccessToken();
  accessToken = typeof response === "string" ? response : response?.token ?? "";
  if (!accessToken) throw new Error("Google returned no access token.");
  console.log("OK - the refresh token is still valid.");
} catch (error) {
  console.log("FAILED. Google said:\n");
  console.log(describe(error));
  console.log(
    "\nWhat this usually means:" +
      "\n  invalid_grant      - the refresh token was revoked, or the OAuth consent screen is" +
      "\n                       still in Testing, where refresh tokens die after 7 days." +
      "\n                       Publish the app, or re-run: npm run authorize:gmail" +
      "\n  invalid_client     - CLIENT_ID/CLIENT_SECRET do not match the token's OAuth client.",
  );
  process.exit(1);
}

heading("3. Scopes Google actually granted this token");
try {
  const response = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`,
  );
  const info = (await response.json()) as { scope?: string; email?: string; error?: string };
  if (info.scope) {
    for (const scope of info.scope.split(" ")) console.log(`  ${scope}`);
    if (!info.scope.includes("https://www.googleapis.com/auth/gmail.send")) {
      console.log(
        "\nPROBLEM: gmail.send is NOT in that list, so Gmail will reject every send." +
          "\nRe-run: npm run authorize:gmail",
      );
    }
  } else {
    console.log(`  (Google returned: ${JSON.stringify(info)})`);
  }
  if (info.email) console.log(`\nToken belongs to: ${info.email}`);
} catch (error) {
  console.log(`Could not read token info: ${describe(error)}`);
}

heading("4. Which mailbox this token can send as");
try {
  const gmail = google.gmail({ version: "v1", auth });
  const profile = await gmail.users.getProfile({ userId: "me" });
  const mailbox = profile.data.emailAddress ?? "(not returned)";
  console.log(`Authorized mailbox: ${mailbox}`);
  if (mailbox !== "(not returned)" && mailbox.toLowerCase() !== senderAddress.toLowerCase()) {
    console.log(
      `\nLIKELY THE BUG: GMAIL_SENDER_ADDRESS is ${senderAddress}, but this token belongs to` +
        `\n${mailbox}. Gmail rejects a From header that is neither the authorized mailbox nor a` +
        '\nverified "Send mail as" alias on it. Either set GMAIL_SENDER_ADDRESS=' +
        `${mailbox},` +
        `\nor add ${senderAddress} to that mailbox under Gmail Settings > Accounts >` +
        '\n"Send mail as" and complete its verification email.',
    );
  }
} catch (error) {
  /* gmail.send alone does not authorize getProfile, so a permission error here
     is expected and says nothing about whether sending works. */
  console.log(`Could not read the profile (normal with a send-only token): ${describe(error)}`);
}

if (!recipient) {
  heading("Done - nothing was sent");
  console.log(
    "Re-run with an address to attempt a real send and see Gmail's exact refusal:" +
      "\n  npm run check:gmail -- you@example.com",
  );
  process.exit(0);
}

if (useRealReceipt) {
  heading(`5. Sending through the REAL receipt mailer to ${recipient}`);
  console.log("Using sendReceiptEmail() - the same multipart message the API builds.\n");
  const sample: EmailedReceipt = {
    receipt_number: "SPCL-20260823-000000000",
    payment_id: 0,
    payment_type: "Monthly Fee",
    amount_paid: "4500.00",
    month_paid: "2026-08-01",
    payment_date: "2026-08-23",
    recorded_at: new Date().toISOString(),
    location: "Newport",
    cashier_name: "Diagnostic Test",
    customer_id: 0,
    application_id: null,
    customer_name: "Receipt Email Diagnostic",
  };

  try {
    const sent = await sendReceiptEmail(recipient, sample);
    console.log(`SENT. Gmail message ID: ${sent.providerMessageId}`);
    console.log(
      "\nThe real receipt message is accepted from this machine. Since the NAS has" +
        "\nidentical credentials and can reach Google, compare the deployed code: the" +
        "\ncontainer may be running an older build of receiptEmail.ts than this file.",
    );
    process.exit(0);
  } catch (error) {
    console.log("FAILED - and this is the same failure the NAS is hitting.\n");
    console.log(describe(error));
    console.log(
      "\nThe credentials are proven good, so this is the MESSAGE being rejected," +
        "\nnot the account or the network. Common causes:" +
        "\n  Invalid value at 'message.raw' / invalid argument" +
        "\n      The MIME is malformed. Note that buildMimeMessage emits base64 as one" +
        "\n      unwrapped line; RFC 5322 caps a line at 998 characters and the HTML part" +
        "\n      is several thousand, which some senders reject outright." +
        "\n  Invalid From header" +
        "\n      Only reachable if GMAIL_SENDER_ADDRESS differs from the tested one.",
    );
    process.exit(1);
  }
}

heading(`5. Sending a plain test message to ${recipient}`);
console.log("This proves the credentials only. Add --real to test the actual receipt.\n");
try {
  const gmail = google.gmail({ version: "v1", auth });
  const message = [
    `From: ${senderName} <${senderAddress}>`,
    `To: ${recipient}`,
    "Subject: SPCL receipt email test",
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    "If you are reading this, receipt email works. Nothing was charged or recorded.",
  ].join("\r\n");

  const raw = Buffer.from(message, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

  const result = await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
  console.log(`SENT. Gmail message ID: ${result.data.id}`);
  console.log("Receipt email is working. If the app still fails, the NAS has different");
  console.log("GMAIL_* values than this machine - compare its .env.production.");
} catch (error) {
  console.log("FAILED. Google said:\n");
  console.log(describe(error));
  console.log(
    "\nWhat the common ones mean:" +
      "\n  Invalid From header / Precondition check failed" +
      `\n      GMAIL_SENDER_ADDRESS (${senderAddress}) is not the authorized mailbox and not a` +
      '\n      verified "Send mail as" alias on it. This is the most common cause.' +
      "\n  Gmail API has not been used in project ... or it is disabled" +
      "\n      Enable the Gmail API for that Google Cloud project, then wait a minute." +
      "\n  Request had insufficient authentication scopes" +
      "\n      The token lacks gmail.send. Re-run: npm run authorize:gmail",
  );
  process.exit(1);
}

/* googleapis buries the useful sentence in the HTTP response body; error.message
   alone is often just "Bad Request". Print both, plus the status. */
function describe(error: unknown): string {
  const lines: string[] = [];
  const candidate = error as {
    message?: string;
    code?: unknown;
    status?: unknown;
    response?: { status?: number; data?: unknown };
  };

  if (candidate?.message) lines.push(`message: ${candidate.message}`);
  const status = candidate?.response?.status ?? candidate?.status ?? candidate?.code;
  if (status !== undefined) lines.push(`status:  ${String(status)}`);

  const data = candidate?.response?.data;
  if (data !== undefined) {
    lines.push(`body:    ${typeof data === "string" ? data : JSON.stringify(data, null, 2)}`);
  }

  return lines.length > 0 ? lines.join("\n") : String(error);
}
