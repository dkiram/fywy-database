/** Builds the five-day outstanding-balance/disconnection warning email. */
import { readFile } from "node:fs/promises";
import { sendAutomatedEmail } from "./gmailClient.js";

export type DisconnectionReminder = {
  customerId: number;
  customerName: string | null;
  recipientEmail: string;
  outstandingBalance: string;
  dueDate: string | Date;
  graceEndDate: string | Date;
};

export async function sendDisconnectionReminderEmail(reminder: DisconnectionReminder) {
  const dueDate = formatDate(reminder.dueDate);
  const customerFirstName = firstName(reminder.customerName);
  const greeting = customerFirstName ? `Hi ${customerFirstName}` : "Hi there";
  const logo = await readFile(new URL("./assets/fywy-email-logo.png", import.meta.url));

  return sendAutomatedEmail({
    recipientEmail: reminder.recipientEmail,
    subject: "Payment reminder for your FYWY account",
    messageIdKey: `disconnection-5-day-${reminder.customerId}-${toIsoDate(reminder.graceEndDate)}`,
    plainText: [
      "FYWY WiFi & Cable",
      "",
      `${greeting},`,
      "",
      `Payment for your FYWY bill on account #${reminder.customerId} was due on ${dueDate} and is now 5 days overdue.`,
      "",
      "We understand this might have simply been overlooked. Please arrange payment as soon as possible. If payment is not received, your service may be disconnected after 48 hours.",
      "",
      "WHERE TO PAY",
      "You’re welcome to make your payment in person at any of our offices, or pay securely online through our website:",
      "Pay your bill online: https://fywycable.com/paymentpage",
      "",
      "Not sure how much you owe? Call or WhatsApp our office using the details below, or contact us through our website:",
      "Contact us about your balance: https://fywycable.com/contact",
      "",
      "If payment has already been made, please disregard this reminder.",
      "",
      "Questions about your bill? WhatsApp us at 1-876-899-8867 or call 1-876-941-0043.",
      "",
      "Thank you,",
      "FYWY WiFi & Cable",
      "",
      "This is an automated message. Please do not reply.",
    ].join("\n"),
    html: `<!doctype html>
<html lang="en">
  <body style="margin:0;background:#f4f2ed;font-family:Arial,Helvetica,sans-serif;color:#10202b">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f4f2ed">
      <tr><td align="center" style="padding:28px 12px">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:620px;background:#ffffff;border:1px solid #dde4e1;border-radius:16px;overflow:hidden">
          <tr><td align="center" style="padding:24px 28px 18px;border-top:7px solid #3f615d">
            <img src="cid:fywy-logo" width="150" alt="FYWY WiFi & Cable" style="display:block;width:150px;height:auto;border:0">
          </td></tr>
          <tr><td style="padding:8px 34px 32px;font-size:16px;line-height:1.6">
            <h1 style="margin:0 0 18px;color:#10202b;font-size:25px;line-height:1.25">Payment Reminder</h1>
            <p style="margin:0 0 16px">${escapeHtml(greeting)},</p>
            <p style="margin:0 0 16px">Payment for your FYWY bill on account <strong>#${reminder.customerId}</strong> was due on <strong>${escapeHtml(dueDate)}</strong> and is now <strong>5 days overdue</strong>.</p>
            <div style="margin:22px 0;padding:17px 18px;background:#fff7ed;border-left:4px solid #c65d1e;color:#7c2d12;font-size:14px;line-height:1.55">We understand this might have simply been overlooked. Please arrange payment as soon as possible. If payment is not received, your service may be disconnected after <strong>48 hours</strong>.</div>
            <h2 style="margin:0 0 8px;color:#10202b;font-size:17px;line-height:1.3">Where to pay</h2>
            <p style="margin:0 0 18px">You’re welcome to make your payment in person at any of our offices, or pay securely online through our website:</p>
            <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" style="margin:0 auto 24px">
              <tr><td bgcolor="#3f615d" style="border-radius:8px">
                <a href="https://fywycable.com/paymentpage" style="display:inline-block;padding:13px 26px;color:#ffffff;text-decoration:none;font-size:15px;font-weight:700">Pay Bill Online</a>
              </td></tr>
            </table>
            <p style="margin:0 0 16px">Not sure how much you owe? Call or WhatsApp our office using the details below, or contact us through our website:</p>
            <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" style="margin:0 auto 24px">
              <tr><td style="border:2px solid #3f615d;border-radius:8px">
                <a href="https://fywycable.com/contact" style="display:inline-block;padding:11px 20px;color:#3f615d;text-decoration:none;font-size:14px;font-weight:700">Contact Us About Your Balance</a>
              </td></tr>
            </table>
            <p style="margin:0 0 22px;color:#5d6967;font-size:14px">If payment has already been made, please disregard this reminder.</p>
            <div style="padding-top:20px;border-top:1px solid #e1e6e4;font-size:14px;line-height:1.7">
              Questions about your bill? WhatsApp us at <a href="https://wa.me/18768998867" style="color:#3f615d;font-weight:700">1-876-899-8867</a> or call <a href="tel:+18769410043" style="color:#3f615d;font-weight:700">1-876-941-0043</a>.
              <p style="margin:16px 0 0">Thank you,<br><strong>FYWY WiFi &amp; Cable</strong></p>
            </div>
          </td></tr>
        </table>
        <div style="padding:16px 12px 0;color:#6b7572;font-size:11px;line-height:1.5">
          This is an automated message. Please do not reply.<br>
          <a href="https://fywycable.com/" style="color:#3f615d">fywycable.com</a>
        </div>
      </td></tr>
    </table>
  </body>
</html>`,
    inlineImages: [{
      contentId: "fywy-logo",
      filename: "fywy-logo.png",
      mimeType: "image/png",
      content: logo,
    }],
  }, "reminders");
}

function firstName(value: string | null) {
  const raw = value?.trim().split(/\s+/)[0] ?? "";
  if (!raw) return null;
  if (!/^[A-ZÀ-ÖØ-Þ'’-]+$/u.test(raw)) return raw;
  return raw.toLocaleLowerCase("en-JM").replace(/(^|['’-])\p{L}/gu, (letter) => letter.toLocaleUpperCase("en-JM"));
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
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
