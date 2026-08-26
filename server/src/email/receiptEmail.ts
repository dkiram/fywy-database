/** Sends one official payment receipt through the configured Google mailbox. */
import { isEmail, sendAutomatedEmail } from "./gmailClient.js";

export { isEmail } from "./gmailClient.js";

/**
 * One receipt as it comes back from the database.
 *
 * The date fields are typed `string | Date` because that is the truth: node-pg
 * parses DATE and TIMESTAMPTZ columns into JavaScript Date objects, and only
 * hand-built objects (tests, fixtures) ever carry strings. Declaring them as
 * plain strings is what let `value.slice is not a function` reach production -
 * every row from loadReceipt violated the type, and TypeScript could not see
 * it because a pg query result is `any`.
 */
export type EmailedReceipt = {
  receipt_number: string;
  payment_id: number;
  payment_type: string;
  amount_paid: string;
  month_paid: string | Date | null;
  payment_date: string | Date;
  recorded_at: string | Date;
  location: string | null;
  cashier_name: string | null;
  customer_id: number | null;
  application_id: number | null;
  customer_name: string | null;
};

export async function sendReceiptEmail(
  recipientEmail: string,
  receipt: EmailedReceipt,
) {
  if (!isEmail(recipientEmail)) {
    throw new Error("Enter a valid receipt email address.");
  }

  return sendAutomatedEmail({
    recipientEmail,
    subject: `SPCL payment receipt ${receipt.receipt_number}`,
    messageIdKey: `receipt-${receipt.payment_id}`,
    plainText: buildPlainText(receipt),
    html: buildHtml(receipt),
  });
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

/**
 * Reduces a date column to plain YYYY-MM-DD, whatever shape it arrives in.
 *
 * A Date is read through its LOCAL components rather than toISOString(),
 * because node-pg builds a DATE at local midnight. Converting to UTC would
 * roll a receipt back to the previous day on any server running east of
 * Greenwich - the kind of fault that only shows up once the business or the
 * container timezone changes.
 */
function toIsoDate(value: string | Date | null | undefined) {
  if (value === null || value === undefined || value === "") return null;

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  const text = String(value);
  return text.length >= 10 ? text.slice(0, 10) : text;
}

function formatDate(value: string | Date) {
  const isoDate = toIsoDate(value);
  if (!isoDate) return "-";
  // Midday UTC, so no timezone conversion can move it to an adjacent day.
  const date = new Date(`${isoDate}T12:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleDateString("en-JM", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "America/Jamaica",
  });
}

function formatMonth(value: string | Date | null) {
  const isoDate = toIsoDate(value);
  if (!isoDate) return "Not applicable";
  const date = new Date(`${isoDate}T12:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return "Not applicable";
  return date.toLocaleDateString("en-JM", {
    month: "long",
    year: "numeric",
    timeZone: "America/Jamaica",
  });
}

function formatDateTime(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("en-JM", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Jamaica",
  });
}
