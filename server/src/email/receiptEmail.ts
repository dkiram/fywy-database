/** Sends one official payment receipt through the configured Google mailbox. */
import { google } from "googleapis";

export type EmailedReceipt = {
  receipt_number: string;
  payment_id: number;
  payment_type: string;
  amount_paid: string;
  month_paid: string | null;
  payment_date: string;
  recorded_at: string;
  location: string | null;
  cashier_name: string | null;
  customer_id: number | null;
  application_id: number | null;
  customer_name: string | null;
};

type GmailConfig = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  senderAddress: string;
  senderName: string;
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
    throw new Error("Receipt email is not configured on this server.");
  }

  if (!isEmail(config.senderAddress)) {
    throw new Error("The configured receipt sender address is invalid.");
  }

  return config;
}

export function isEmail(value: string) {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export async function sendReceiptEmail(
  recipientEmail: string,
  receipt: EmailedReceipt,
) {
  if (!isEmail(recipientEmail)) {
    throw new Error("Enter a valid receipt email address.");
  }

  const config = requireGmailConfig();
  const auth = new google.auth.OAuth2(config.clientId, config.clientSecret);
  auth.setCredentials({ refresh_token: config.refreshToken });

  const gmail = google.gmail({ version: "v1", auth });
  const raw = buildMimeMessage(config, recipientEmail, receipt);
  const result = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw },
  });

  if (!result.data.id) {
    throw new Error("Gmail accepted the request without returning a message ID.");
  }

  return { providerMessageId: result.data.id };
}

function buildMimeMessage(
  config: Pick<GmailConfig, "senderAddress" | "senderName">,
  recipientEmail: string,
  receipt: EmailedReceipt,
) {
  const boundary = `spcl_receipt_${receipt.payment_id}_${Date.now()}`;
  const subject = `SPCL payment receipt ${receipt.receipt_number}`;
  const plainText = buildPlainText(receipt);
  const html = buildHtml(receipt);

  const message = [
    `From: ${config.senderName} <${config.senderAddress}>`,
    `To: ${recipientEmail}`,
    `Subject: ${subject}`,
    `Message-ID: <receipt-${receipt.payment_id}@fywycable.com>`,
    "MIME-Version: 1.0",
    "Auto-Submitted: auto-generated",
    "X-Auto-Response-Suppress: All",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(plainText, "utf8").toString("base64"),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(html, "utf8").toString("base64"),
    `--${boundary}--`,
  ].join("\r\n");

  return Buffer.from(message, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function buildPlainText(receipt: EmailedReceipt) {
  const reference = receipt.customer_id !== null
    ? `Customer #${receipt.customer_id}`
    : `Application #${receipt.application_id ?? "-"}`;

  return [
    "SPCL/FYWY Cable",
    "PAYMENT RECEIPT",
    "",
    `Receipt: ${receipt.receipt_number}`,
    `Date: ${formatDate(receipt.payment_date)}`,
    `Received from: ${receipt.customer_name || "Unnamed customer"}`,
    reference,
    `Payment type: ${receipt.payment_type}`,
    `Month paid for: ${formatMonth(receipt.month_paid)}`,
    `Amount received: ${formatCurrency(receipt.amount_paid)}`,
    `Cashier: ${firstName(receipt.cashier_name)}`,
    `Location: ${receipt.location || "-"}`,
    `Recorded: ${formatDateTime(receipt.recorded_at)}`,
    "",
    "Please keep this email as proof of payment.",
    "This is an automated message. Please do not reply.",
    "WhatsApp: 1-876-899-8867 or 1-876-880-0093",
    "Telephone: 1-876-941-0043 or 1-876-965-7334",
  ].join("\n");
}

function buildHtml(receipt: EmailedReceipt) {
  const referenceLabel = receipt.customer_id !== null ? "Customer ID" : "Application";
  const referenceValue = receipt.customer_id !== null
    ? String(receipt.customer_id)
    : `#${receipt.application_id ?? "-"}`;

  return `<!doctype html>
<html lang="en">
  <body style="margin:0;background:#f4f5f3;font-family:Arial,sans-serif;color:#1d211f">
    <div style="max-width:620px;margin:0 auto;padding:24px 12px">
      <div style="background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #dde2de">
        <div style="padding:26px 28px;border-bottom:3px solid #176b50">
          <div style="font-size:12px;letter-spacing:2px;color:#176b50;font-weight:700">SPCL/FYWY CABLE</div>
          <h1 style="margin:8px 0 2px;font-size:25px">Payment Receipt</h1>
          <div style="color:#66706a;font-size:14px">Official customer payment record</div>
        </div>
        <div style="padding:24px 28px">
          ${field("Receipt", receipt.receipt_number)}
          ${field("Date", formatDate(receipt.payment_date))}
          ${field("Received from", receipt.customer_name || "Unnamed customer")}
          ${field(referenceLabel, referenceValue)}
          ${field("Payment type", receipt.payment_type)}
          ${field("Month paid for", formatMonth(receipt.month_paid))}
          ${field("Cashier", firstName(receipt.cashier_name))}
          ${field("Location", receipt.location || "-")}
          <div style="margin-top:22px;padding:20px;border-radius:10px;background:#e7f3ed;text-align:center">
            <div style="font-size:11px;letter-spacing:1.5px;color:#176b50;font-weight:700">AMOUNT RECEIVED</div>
            <div style="margin-top:7px;font-size:34px;color:#176b50;font-weight:700">${escapeHtml(formatCurrency(receipt.amount_paid))}</div>
          </div>
          <div style="margin-top:22px;padding-top:16px;border-top:1px solid #dde2de;text-align:center;color:#66706a;font-size:12px">
            Recorded ${escapeHtml(formatDateTime(receipt.recorded_at))} · Payment #${receipt.payment_id}<br>
            Please keep this email as proof of payment.
          </div>
        </div>
      </div>
      <div style="padding:18px 12px;text-align:center;color:#66706a;font-size:12px;line-height:1.6">
        <strong>This is an automated message. Please do not reply.</strong><br>
        WhatsApp: 1-876-899-8867 or 1-876-880-0093<br>
        Telephone: 1-876-941-0043 or 1-876-965-7334
      </div>
    </div>
  </body>
</html>`;
}

function field(label: string, value: string) {
  return `<div style="display:inline-block;width:48%;min-width:230px;vertical-align:top;margin-bottom:17px">
    <div style="font-size:11px;letter-spacing:1px;color:#66706a;font-weight:700">${escapeHtml(label.toUpperCase())}</div>
    <div style="margin-top:5px;font-size:14px;font-weight:600">${escapeHtml(value)}</div>
  </div>`;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function firstName(value: string | null) {
  return (value ?? "").trim().split(/\s+/)[0] || "-";
}

function formatCurrency(value: string) {
  return `J$${Number(value).toLocaleString("en-JM", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatDate(value: string) {
  const date = new Date(`${value.slice(0, 10)}T12:00:00.000Z`);
  return date.toLocaleDateString("en-JM", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "America/Jamaica",
  });
}

function formatMonth(value: string | null) {
  if (!value) return "Not applicable";
  const date = new Date(`${value.slice(0, 10)}T12:00:00.000Z`);
  return date.toLocaleDateString("en-JM", {
    month: "long",
    year: "numeric",
    timeZone: "America/Jamaica",
  });
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString("en-JM", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Jamaica",
  });
}
