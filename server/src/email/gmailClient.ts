/** Minimal Gmail API sender shared by receipts and automated notifications. */
import { google } from "googleapis";

type GmailConfig = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  senderAddress: string;
  senderName: string;
};

type AutomatedEmail = {
  recipientEmail: string;
  subject: string;
  messageIdKey: string;
  plainText: string;
  html: string;
};

function requireGmailConfig(): GmailConfig {
  const config = {
    clientId: process.env.GMAIL_CLIENT_ID?.trim() ?? "",
    clientSecret: process.env.GMAIL_CLIENT_SECRET?.trim() ?? "",
    refreshToken: process.env.GMAIL_REFRESH_TOKEN?.trim() ?? "",
    senderAddress: process.env.GMAIL_SENDER_ADDRESS?.trim() ?? "receipts@fywycable.com",
    senderName: process.env.GMAIL_SENDER_NAME?.trim() ?? "SPCL/FYWY Cable - Do Not Reply",
  };

  if (!config.clientId || !config.clientSecret || !config.refreshToken) {
    throw new Error("Email delivery is not configured on this server.");
  }
  if (!isEmail(config.senderAddress)) {
    throw new Error("The configured email sender address is invalid.");
  }

  return config;
}

export function isEmail(value: string) {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export async function sendAutomatedEmail(email: AutomatedEmail) {
  if (!isEmail(email.recipientEmail)) {
    throw new Error("Enter a valid email address.");
  }
  if (/\r|\n/.test(email.subject)) {
    throw new Error("Email subject contains an invalid line break.");
  }

  const config = requireGmailConfig();
  const auth = new google.auth.OAuth2(config.clientId, config.clientSecret);
  auth.setCredentials({ refresh_token: config.refreshToken });
  const gmail = google.gmail({ version: "v1", auth });
  const raw = buildMimeMessage(config, email);
  const result = await gmail.users.messages.send(
    { userId: "me", requestBody: { raw } },
    { timeout: 20_000 },
  );

  if (!result.data.id) {
    throw new Error("Gmail accepted the request without returning a message ID.");
  }

  return { providerMessageId: result.data.id };
}

function buildMimeMessage(config: GmailConfig, email: AutomatedEmail) {
  const safeMessageId = email.messageIdKey.replace(/[^a-zA-Z0-9._-]/g, "-");
  const boundary = `spcl_${safeMessageId}_${Date.now()}`;
  const message = [
    `From: ${config.senderName.replace(/[\r\n]/g, " ")} <${config.senderAddress}>`,
    `To: ${email.recipientEmail}`,
    `Subject: ${email.subject}`,
    `Message-ID: <${safeMessageId}@fywycable.com>`,
    "MIME-Version: 1.0",
    "Auto-Submitted: auto-generated",
    "X-Auto-Response-Suppress: All",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    encodeBase64Body(email.plainText),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    encodeBase64Body(email.html),
    `--${boundary}--`,
  ].join("\r\n");

  return Buffer.from(message, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function encodeBase64Body(value: string) {
  const encoded = Buffer.from(value, "utf8").toString("base64");
  return (encoded.match(/.{1,76}/g) ?? []).join("\r\n");
}
