/** Builds the five-day outstanding-balance/disconnection warning email. */
import { sendAutomatedEmail } from "./gmailClient.js";

export type DisconnectionReminder = {
  customerId: number;
  customerName: string | null;
  recipientEmail: string;
  outstandingBalance: string;
  scheduledDisconnectionDate: string | Date;
};

export function sendDisconnectionReminderEmail(reminder: DisconnectionReminder) {
  const disconnectionDate = formatDate(reminder.scheduledDisconnectionDate);
  const balance = formatCurrency(reminder.outstandingBalance);
  const customerName = reminder.customerName?.trim() || "Customer";

  return sendAutomatedEmail({
    recipientEmail: reminder.recipientEmail,
    subject: `Payment reminder: service disconnection scheduled for ${disconnectionDate}`,
    messageIdKey: `disconnection-5-day-${reminder.customerId}-${toIsoDate(reminder.scheduledDisconnectionDate)}`,
    plainText: [
      "SPCL/FYWY Cable",
      "PAYMENT REMINDER",
      "",
      `Dear ${customerName},`,
      "",
      `Our records show an outstanding balance of ${balance} on customer account #${reminder.customerId}.`,
      `Unless the outstanding balance is paid, service is scheduled for disconnection on ${disconnectionDate}, which is five days from this notice.`,
      "",
      "Please make payment before the scheduled disconnection date to avoid an interruption in service.",
      "If you have already paid, please disregard this reminder or contact SPCL so we can verify the payment.",
      "",
      "This is an automated message. Please do not reply.",
      "WhatsApp: 1-876-899-8867 or 1-876-880-0093",
      "Telephone: 1-876-941-0043 or 1-876-965-7334",
    ].join("\n"),
    html: `<!doctype html>
<html lang="en">
  <body style="margin:0;background:#f4f5f3;font-family:Arial,sans-serif;color:#1d211f">
    <div style="max-width:620px;margin:0 auto;padding:24px 12px">
      <div style="background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #dde2de">
        <div style="padding:26px 28px;border-bottom:3px solid #b45309">
          <div style="font-size:12px;letter-spacing:2px;color:#176b50;font-weight:700">SPCL/FYWY CABLE</div>
          <h1 style="margin:8px 0 2px;font-size:25px">Payment Reminder</h1>
          <div style="color:#66706a;font-size:14px">Action required to avoid service interruption</div>
        </div>
        <div style="padding:26px 28px;font-size:15px;line-height:1.6">
          <p style="margin-top:0">Dear ${escapeHtml(customerName)},</p>
          <p>Our records show an outstanding balance on customer account <strong>#${reminder.customerId}</strong>.</p>
          <div style="margin:22px 0;padding:20px;border-radius:10px;background:#fff7ed;border:1px solid #fed7aa;text-align:center">
            <div style="font-size:11px;letter-spacing:1.5px;color:#9a3412;font-weight:700">OUTSTANDING BALANCE</div>
            <div style="margin-top:6px;font-size:32px;color:#9a3412;font-weight:700">${escapeHtml(balance)}</div>
            <div style="margin-top:14px;font-size:12px;color:#7c2d12;font-weight:700">SCHEDULED DISCONNECTION</div>
            <div style="margin-top:3px;font-size:19px;color:#7c2d12;font-weight:700">${escapeHtml(disconnectionDate)}</div>
          </div>
          <p>Unless the outstanding balance is paid, service is scheduled for disconnection on that date, which is <strong>five days from this notice</strong>.</p>
          <p>Please make payment before the scheduled date to avoid an interruption in service.</p>
          <p style="color:#66706a;font-size:13px">If you have already paid, please disregard this reminder or contact SPCL so we can verify the payment.</p>
        </div>
      </div>
      <div style="padding:18px 12px;text-align:center;color:#66706a;font-size:12px;line-height:1.6">
        <strong>This is an automated message. Please do not reply.</strong><br>
        WhatsApp: 1-876-899-8867 or 1-876-880-0093<br>
        Telephone: 1-876-941-0043 or 1-876-965-7334
      </div>
    </div>
  </body>
</html>`,
  });
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatCurrency(value: string) {
  return `J$${Number(value).toLocaleString("en-JM", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function toIsoDate(value: string | Date) {
  if (value instanceof Date) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  return value.slice(0, 10);
}

function formatDate(value: string | Date) {
  const iso = toIsoDate(value);
  const date = new Date(`${iso}T12:00:00.000Z`);
  return date.toLocaleDateString("en-JM", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "America/Jamaica",
  });
}
