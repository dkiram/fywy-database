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
  inlineImages?: Array<{
    contentId: string;
    filename: string;
    mimeType: "image/png" | "image/jpeg";
    content: Buffer;
  }>;
};

export type GmailSender = "receipts" | "reminders";

function requireGmailConfig(sender: GmailSender): GmailConfig {
  const reminderSender = sender === "reminders";
  const config = reminderSender
    ? {
        clientId: process.env.REMINDER_GMAIL_CLIENT_ID?.trim()
          || process.env.GMAIL_CLIENT_ID?.trim()
          || "",
        clientSecret: process.env.REMINDER_GMAIL_CLIENT_SECRET?.trim()
          || process.env.GMAIL_CLIENT_SECRET?.trim()
          || "",
        refreshToken: process.env.REMINDER_GMAIL_REFRESH_TOKEN?.trim() ?? "",
        senderAddress: process.env.REMINDER_GMAIL_SENDER_ADDRESS?.trim()
          ?? "notifications@fywycable.com",
        senderName: process.env.REMINDER_GMAIL_SENDER_NAME?.trim()
          ?? "SPCL/FYWY Cable - Do Not Reply",
      }
    : {
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

export async function sendAutomatedEmail(
  email: AutomatedEmail,
  sender: GmailSender = "receipts",
) {
  if (!isEmail(email.recipientEmail)) {
    throw new Error("Enter a valid email address.");
  }
  if (/\r|\n/.test(email.subject)) {
    throw new Error("Email subject contains an invalid line break.");
  }

  const config = requireGmailConfig(sender);
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
  const alternativeBoundary = `spcl_alt_${safeMessageId}_${Date.now()}`;
  const relatedBoundary = `spcl_related_${safeMessageId}_${Date.now()}`;
  const headers = [
    `From: ${config.senderName.replace(/[\r\n]/g, " ")} <${config.senderAddress}>`,
    `To: ${email.recipientEmail}`,
    `Subject: ${email.subject}`,
    `Message-ID: <${safeMessageId}@fywycable.com>`,
    "MIME-Version: 1.0",
    "Auto-Submitted: auto-generated",
    "X-Auto-Response-Suppress: All",
  ];
  const alternative = [
    `--${alternativeBoundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    encodeBase64Body(email.plainText),
    `--${alternativeBoundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    encodeBase64Body(email.html),
    `--${alternativeBoundary}--`,
  ];

  let body: string[];
  if (email.inlineImages?.length) {
    const images = email.inlineImages.flatMap((image) => {
      const contentId = image.contentId.replace(/[^a-zA-Z0-9._-]/g, "-");
      const filename = image.filename.replace(/[\r\n"\\]/g, "-");
      return [
        `--${relatedBoundary}`,
        `Content-Type: ${image.mimeType}; name="${filename}"`,
        "Content-Transfer-Encoding: base64",
        `Content-ID: <${contentId}>`,
        `Content-Disposition: inline; filename="${filename}"`,
        "",
        encodeBase64Buffer(image.content),
      ];
    });
    body = [
      `Content-Type: multipart/related; boundary="${relatedBoundary}"`,
      "",
      `--${relatedBoundary}`,
      `Content-Type: multipart/alternative; boundary="${alternativeBoundary}"`,
      "",
      ...alternative,
      ...images,
      `--${relatedBoundary}--`,
    ];
  } else {
    body = [
      `Content-Type: multipart/alternative; boundary="${alternativeBoundary}"`,
      "",
      ...alternative,
    ];
  }

  const message = [
    ...headers,
    ...body,
  ].join("\r\n");

  return Buffer.from(message, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function encodeBase64Buffer(value: Buffer) {
  const encoded = value.toString("base64");
  return (encoded.match(/.{1,76}/g) ?? []).join("\r\n");
}

function encodeBase64Body(value: string) {
  return encodeBase64Buffer(Buffer.from(value, "utf8"));
}
