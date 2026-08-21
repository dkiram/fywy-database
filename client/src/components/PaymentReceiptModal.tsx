/**
 * Presents a recorded payment as an on-screen receipt and prints it either as
 * an 80mm thermal slip for the customer or on A4. The print layouts live in
 * index.css under `html.printing-receipt.printing-thermal` and
 * `html.printing-receipt.printing-a4`; this file owns the classes and the
 * @page rules that switch them on.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useAuth } from "../auth/AuthContext";
import { apiFetch } from "../lib/api";

type PrintFormat = "thermal" | "a4";

const PRINT_FORMAT_STORAGE_KEY = "spcl.receiptPrintFormat";

const A4_PAGE_RULE = "@page { size: A4 portrait; margin: 16mm; }";

/* Printed at the foot of every receipt so a customer holding the slip has a
   way to reach the company without looking one up. `display` is what goes on
   the paper; `href` is what a click does on screen. */
const CONTACT_NUMBERS = {
  whatsapp: [
    { display: "1-876-899-8867", href: "https://wa.me/18768998867" },
    { display: "1-876-880-0093", href: "https://wa.me/18768800093" },
  ],
  telephone: [
    { display: "1-876-941-0043", href: "tel:+18769410043" },
    { display: "1-876-965-7334", href: "tel:+18769657334" },
  ],
} as const;

/* Width of the roll. Change to 58 if an office ever runs narrow stock; the
   72mm printable column in .receipt-slip-layout has to come down with it. */
const SLIP_WIDTH_MM = 80;

/* CSS px per mm at the 96dpi reference resolution the CSS `mm` unit is
   defined against. */
const PX_PER_MM = 96 / 25.4;

/* A couple of millimetres of slack so a sub-pixel rounding error can't push
   the last line onto a second page — which on a continuous roll means a
   second slip's worth of wasted paper and a stray cut. */
const SLIP_HEIGHT_SLACK_MM = 2;

/**
 * Builds the @page rule for the slip.
 *
 * The page box needs an explicit height. `size: 80mm auto` looks like the
 * obvious way to say "80mm wide, as long as it needs to be", but it is not
 * valid CSS — `size` takes one or two lengths, or the bare keyword `auto`,
 * never a length paired with `auto`. Browsers drop the invalid declaration
 * and fall back to the printer's default sheet, so the slip lands on A4.
 *
 * So we measure instead: switch the slip layout on, read the height the
 * receipt actually occupies at 72mm, and write it into the rule. The class is
 * added and removed inside one synchronous block, so no frame is ever painted
 * with it half-applied.
 */
function buildSlipPageRule(receipt: HTMLElement): string {
  receipt.classList.add("receipt-slip-layout");
  const heightPx = receipt.getBoundingClientRect().height;
  receipt.classList.remove("receipt-slip-layout");

  const heightMm = Math.ceil(heightPx / PX_PER_MM) + SLIP_HEIGHT_SLACK_MM;
  return `@page { size: ${SLIP_WIDTH_MM}mm ${heightMm}mm; margin: 0; }`;
}

/* Branches hand the slip to the customer at the counter; head office and
   admin don't serve customers directly and file a full sheet instead. This is
   only the starting position — the toggle below overrides it and the choice
   sticks per machine. */
function defaultFormatForRole(role: string | undefined): PrintFormat {
  return role === "branch" ? "thermal" : "a4";
}

function readStoredFormat(): PrintFormat | null {
  try {
    const stored = window.localStorage.getItem(PRINT_FORMAT_STORAGE_KEY);
    return stored === "thermal" || stored === "a4" ? stored : null;
  } catch {
    // Storage can be unavailable (locked-down profile, private mode). The
    // role default is a fine answer; printing must not depend on this.
    return null;
  }
}

export type PaymentReceipt = {
  payment_id: number;
  receipt_number: string;
  payment_type: string;
  amount_paid: string;
  month_paid: string | null;
  payment_date: string;
  recorded_at: string;
  location: string | null;
  cashier_name: string | null;
  note: string | null;
  // Null while an installation fee is still sitting against an application:
  // the money is collected but the applicant is not a customer yet. Activation
  // fills this in on the same row.
  customer_id: number | null;
  application_id: number | null;
  customer_name: string | null;
  customer_address: string | null;
  customer_telephone: string | null;
  customer_email: string | null;
  receipt_delivery_method: "physical" | "email";
  receipt_email_delivery_id: number | null;
  receipt_email: string | null;
  receipt_email_status: "pending" | "sending" | "sent" | "failed" | null;
  receipt_email_attempt_count: number | null;
  receipt_email_error: string | null;
  receipt_email_sent_at: string | null;
  is_voided: boolean;
  voided_at: string | null;
  void_reason: string | null;
  voided_by_name: string | null;
};

function PaymentReceiptModal({ payment, onClose, onVoided, onDeleted }: { payment: PaymentReceipt; onClose: () => void; onVoided?: (payment: PaymentReceipt) => void; onDeleted?: () => void }) {
  const { employee } = useAuth();
  const [displayPayment, setDisplayPayment] = useState(payment);
  const [showVoidForm, setShowVoidForm] = useState(false);
  const [voidReason, setVoidReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [showDeleteForm, setShowDeleteForm] = useState(false);
  const [deleteReason, setDeleteReason] = useState("");
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [showEmailForm, setShowEmailForm] = useState(false);
  const [emailRecipient, setEmailRecipient] = useState(
    payment.receipt_email || payment.customer_email || "",
  );
  const [emailError, setEmailError] = useState("");
  // Voiding and permanent deletion are both Admin-only. Head Office lost the
  // void button in Aug 2026; the server enforces the same rule, so hiding it
  // here is presentation, not the control.
  const canVoid = employee?.role === "admin";
  const canDelete = employee?.role === "admin";
  const emailFailed = displayPayment.receipt_delivery_method === "email"
    && displayPayment.receipt_email_status === "failed";
  const canPrint = displayPayment.receipt_delivery_method === "physical" || emailFailed;

  const [printFormat, setPrintFormat] = useState<PrintFormat>(
    () => readStoredFormat() ?? defaultFormatForRole(employee?.role),
  );

  const choosePrintFormat = (format: PrintFormat) => {
    setPrintFormat(format);
    try {
      window.localStorage.setItem(PRINT_FORMAT_STORAGE_KEY, format);
    } catch {
      // Non-fatal: the toggle still works for this session.
    }
  };

  // Driven off beforeprint rather than the button's click handler so that
  // Ctrl+P with the receipt open produces the same output as the button, and
  // so the @page size is never left applied to the rest of the app.
  useEffect(() => {
    let pageStyle: HTMLStyleElement | null = null;

    const enterPrintMode = () => {
      if (!canPrint) return;
      const receipt = document.querySelector<HTMLElement>(".payment-receipt-print");
      const thermal = printFormat === "thermal" && receipt !== null;

      // Measure before anything else: buildSlipPageRule needs the receipt in
      // its on-screen box, not the unwrapped print one.
      const rule = thermal ? buildSlipPageRule(receipt) : A4_PAGE_RULE;

      document.documentElement.classList.add(
        "printing-receipt",
        thermal ? "printing-thermal" : "printing-a4",
      );
      if (thermal) receipt.classList.add("receipt-slip-layout");

      if (pageStyle) return;
      pageStyle = document.createElement("style");
      pageStyle.textContent = rule;
      document.head.appendChild(pageStyle);
    };

    const exitPrintMode = () => {
      document.documentElement.classList.remove(
        "printing-receipt",
        "printing-thermal",
        "printing-a4",
      );
      document
        .querySelector(".payment-receipt-print")
        ?.classList.remove("receipt-slip-layout");
      pageStyle?.remove();
      pageStyle = null;
    };

    window.addEventListener("beforeprint", enterPrintMode);
    window.addEventListener("afterprint", exitPrintMode);
    return () => {
      window.removeEventListener("beforeprint", enterPrintMode);
      window.removeEventListener("afterprint", exitPrintMode);
      exitPrintMode();
    };
    // Re-bound when the format changes so beforeprint always reads the
    // current choice rather than the one captured at mount.
  }, [canPrint, printFormat]);

  const emailReceipt = async () => {
    try {
      setSaving(true);
      setEmailError("");
      const response = await apiFetch(`/api/payments/${displayPayment.payment_id}/email-receipt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: emailRecipient }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not email receipt.");
      setDisplayPayment(data.payment);
      setEmailRecipient(data.payment.receipt_email || emailRecipient);
      setShowEmailForm(data.payment.receipt_email_status === "failed");
    } catch (sendError) {
      setEmailError(sendError instanceof Error ? sendError.message : "Could not email receipt.");
    } finally {
      setSaving(false);
    }
  };

  // Voiding preserves the receipt and posts a separate balance reversal.
  const voidPayment = async () => {
    try {
      setSaving(true);
      setError("");
      const response = await apiFetch(`/api/payments/${displayPayment.payment_id}/void`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: voidReason }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not void payment.");
      setDisplayPayment(data.payment);
      setShowVoidForm(false);
      onVoided?.(data.payment);
    } catch (voidError) {
      setError(voidError instanceof Error ? voidError.message : "Could not void payment.");
    } finally {
      setSaving(false);
    }
  };

  // Permanent deletion is available only after the safer void path. Requiring
  // the exact receipt number prevents an accidental destructive confirmation.
  const deletePayment = async () => {
    try {
      setSaving(true);
      setError("");
      const response = await apiFetch(`/api/payments/${displayPayment.payment_id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: deleteReason, confirmation: deleteConfirmation }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not permanently delete payment.");
      onDeleted?.();
      onClose();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Could not permanently delete payment.");
    } finally {
      setSaving(false);
    }
  };

  // Portalled to <body> so the printed slip can be isolated with a single
  // `body > *:not(.receipt-modal-root)` rule, and so the fixed overlay is not
  // trapped by a transformed ancestor.
  return createPortal(
    <div className="receipt-modal-root fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/50 p-2 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label={`Receipt ${displayPayment.receipt_number}`}>
      <div className="receipt-modal-card my-2 flex max-h-[calc(100dvh-1rem)] w-full max-w-xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl sm:my-0 sm:max-h-[calc(100dvh-2rem)]">
        {/* Keep long receipts and destructive confirmations inside a dedicated
            scroll region while the main action bar remains reachable. */}
        <div className="receipt-modal-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <ReceiptDeliveryStatus
          payment={displayPayment}
          emailRecipient={emailRecipient}
          setEmailRecipient={setEmailRecipient}
          showEmailForm={showEmailForm}
          setShowEmailForm={setShowEmailForm}
          emailError={emailError}
          saving={saving}
          onSend={emailReceipt}
        />
        {/* Print CSS drops the rest of the app and reflows this section into a
            single 72mm column. The hook classes below are print-only; they
            carry no screen styling. */}
        <div className="payment-receipt-print bg-white p-5 text-on-surface sm:p-9">
          <div className="receipt-header flex items-start justify-between gap-6 border-b-2 border-primary pb-5">
            <div>
              <p className="receipt-brand text-xs font-semibold uppercase tracking-[0.2em] text-primary">SPCL/FYWY</p>
              <h2 className="receipt-title mt-1 text-2xl font-semibold">Payment Receipt</h2>
              <p className="receipt-subtitle mt-1 text-sm text-on-surface-variant">Official customer payment record</p>
            </div>
            <div className="receipt-meta text-right">
              <p className="receipt-number font-mono text-sm font-medium text-primary">{displayPayment.receipt_number}</p>
              <p className="mt-1 text-xs text-on-surface-variant">{formatDate(displayPayment.payment_date)}</p>
            </div>
          </div>

          {displayPayment.is_voided && (
            // The original receipt remains printable but can never be mistaken
            // for a valid collection after its reversal. On a monochrome head
            // the box, the struck figure and the wording carry that on their
            // own — none of it depends on the red.
            <div className="receipt-void mt-5 rounded-xl border-2 border-error bg-error/10 p-4 text-center text-error">
              <p className="receipt-void-word text-2xl font-semibold uppercase tracking-[0.25em]">Voided</p>
              <p className="receipt-void-note print-only hidden">This payment was reversed. Not a valid receipt.</p>
              <p className="mt-2 text-sm font-semibold">{displayPayment.void_reason}</p>
              <p className="receipt-void-meta mt-1 text-xs">{displayPayment.voided_at ? formatDateTime(displayPayment.voided_at) : ""}{displayPayment.voided_by_name ? ` · ${displayPayment.voided_by_name}` : ""}</p>
            </div>
          )}

          <div className="receipt-fields mt-6 grid grid-cols-1 gap-5 sm:grid-cols-2">
            <ReceiptField label="Received from" value={displayPayment.customer_name || "Unnamed customer"} />
            {/* An applicant has no customer number to print yet, so the slip
                carries the application number they can quote instead. */}
            {displayPayment.customer_id !== null ? (
              <ReceiptField label="Customer ID" value={String(displayPayment.customer_id)} />
            ) : (
              <ReceiptField label="Application" value={displayPayment.application_id !== null ? `#${displayPayment.application_id}` : "—"} />
            )}
            <ReceiptField label="Payment type" value={displayPayment.payment_type} />
            <ReceiptField label="Month paid for" value={formatMonth(displayPayment.month_paid)} />
            <ReceiptField label="Cashier" value={firstName(displayPayment.cashier_name)} />
            <ReceiptField label="Location" value={displayPayment.location || "—"} />
          </div>

          <div className={`receipt-amount${displayPayment.is_voided ? " receipt-amount--voided" : ""} mt-7 rounded-xl bg-primary/10 px-5 py-5 text-center`}>
            <p className="receipt-amount-label text-xs font-semibold uppercase tracking-[0.18em] text-primary">Amount received</p>
            <p className="receipt-amount-value mt-2 text-4xl font-medium text-primary">{formatCurrency(displayPayment.amount_paid)}</p>
          </div>

          {/* Staff-only. `no-print` drops it from both the A4 file copy and the
              80mm slip, and index.css removes it from the slip layout as well
              so the measured page height does not reserve paper for it. The
              customer's receipt must not carry an internal remark like "paid
              Monday, receipt handed in today". */}
          {displayPayment.note && (
            <div className="receipt-note no-print mt-6 rounded-lg border border-dashed border-outline-variant bg-surface-container-low p-4">
              <ReceiptField label="Internal note — not printed" value={displayPayment.note} />
            </div>
          )}

          <div className="receipt-footer mt-7 border-t border-surface-container pt-4 text-center text-xs text-on-surface-variant">
            <p>Recorded {formatDateTime(displayPayment.recorded_at)} · Payment #{displayPayment.payment_id}</p>
            <p className="print-only hidden">Please keep this slip as proof of payment.</p>
          </div>

          {/* Kept out of .receipt-footer so the dashed rule above the contact
              block reads as its own section on the slip rather than a second
              line of recording metadata. */}
          <div className="receipt-contact mt-5 border-t border-surface-container pt-4 text-center text-xs text-on-surface-variant">
            <ContactLine label="WhatsApp" numbers={CONTACT_NUMBERS.whatsapp} />
            <ContactLine label="Telephone" numbers={CONTACT_NUMBERS.telephone} />
            <p className="receipt-thanks print-only mt-3 hidden">Thank you</p>
          </div>
        </div>

        {showVoidForm && (
          <div className="no-print border-t border-error/20 bg-error/5 px-4 py-5 sm:px-6">
            <h3 className="font-semibold text-error">Void this accidental payment?</h3>
            <p className="mt-1 text-sm text-on-surface-variant">It will be removed from collection totals and reversed from the customer balance. The receipt remains in history.</p>
            <label className="mt-4 block text-sm font-semibold">Required reason<textarea autoFocus rows={3} maxLength={500} value={voidReason} onChange={(event) => setVoidReason(event.target.value)} placeholder="Explain why this payment is being voided..." className="mt-1.5 w-full resize-none rounded-lg border border-outline-variant bg-white px-3 py-2.5 text-sm focus:border-error" /></label>
            {error && <p className="mt-3 rounded-lg bg-error/10 p-3 text-sm text-error">{error}</p>}
            <div className="mt-4 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end"><button type="button" disabled={saving} onClick={() => { setShowVoidForm(false); setVoidReason(""); setError(""); }} className="rounded-lg bg-surface-container px-4 py-2.5 text-sm font-medium">Cancel</button><button type="button" disabled={saving || voidReason.trim().length < 3} onClick={voidPayment} className="rounded-lg bg-error px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50">{saving ? "Voiding..." : "Confirm Void"}</button></div>
          </div>
        )}

        {showDeleteForm && (
          <div className="no-print border-t border-error bg-error/5 px-4 py-5 sm:px-6">
            <h3 className="font-semibold text-error">Permanently delete this voided payment?</h3>
            <p className="mt-1 text-sm text-on-surface-variant">The payment, receipt, and paired ledger entries will be removed permanently. Only a compact admin deletion marker remains.</p>
            <label className="mt-4 block text-sm font-semibold">Required reason<textarea autoFocus rows={3} maxLength={500} value={deleteReason} onChange={(event) => setDeleteReason(event.target.value)} placeholder="Explain why permanent deletion is necessary..." className="mt-1.5 w-full resize-none rounded-lg border border-outline-variant bg-white px-3 py-2.5 text-sm focus:border-error" /></label>
            <label className="mt-4 block text-sm font-semibold">Type <span className="break-all font-mono text-error">{displayPayment.receipt_number}</span> to confirm<input value={deleteConfirmation} onChange={(event) => setDeleteConfirmation(event.target.value)} className="mt-1.5 w-full rounded-lg border border-outline-variant bg-white px-3 py-2.5 font-mono text-sm focus:border-error" /></label>
            {error && <p className="mt-3 rounded-lg bg-error/10 p-3 text-sm text-error">{error}</p>}
            <div className="mt-4 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end"><button type="button" disabled={saving} onClick={() => { setShowDeleteForm(false); setDeleteReason(""); setDeleteConfirmation(""); setError(""); }} className="rounded-lg bg-surface-container px-4 py-2.5 text-sm font-medium">Cancel</button><button type="button" disabled={saving || deleteReason.trim().length < 3 || deleteConfirmation !== displayPayment.receipt_number} onClick={deletePayment} className="rounded-lg bg-error px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50">{saving ? "Deleting..." : "Delete Permanently"}</button></div>
          </div>
        )}
        </div>

        <div className="no-print flex shrink-0 flex-wrap justify-end gap-3 border-t border-surface-container bg-surface-container-low px-4 py-3 sm:px-6 sm:py-4">
          {canVoid && !displayPayment.is_voided && !showVoidForm && (
            <button type="button" onClick={() => setShowVoidForm(true)} className="mr-auto rounded-lg bg-error/10 px-5 py-2.5 text-sm font-medium text-error">Void Payment</button>
          )}
          {canDelete && displayPayment.is_voided && !showDeleteForm && (
            <button type="button" onClick={() => { setShowDeleteForm(true); setError(""); }} className="mr-auto rounded-lg bg-error px-5 py-2.5 text-sm font-medium text-white">Delete Permanently</button>
          )}
          {/* Counters print the 80mm slip, head office prints a full sheet.
              Defaults by role, then remembers whatever this machine last used. */}
          {canPrint && (
            <div className="flex items-center gap-0.5 rounded-lg bg-surface-container p-0.5" role="group" aria-label="Print format">
              <PrintFormatOption label="Slip" description="Print as an 80mm thermal slip" active={printFormat === "thermal"} onSelect={() => choosePrintFormat("thermal")} />
              <PrintFormatOption label="A4" description="Print on A4 paper" active={printFormat === "a4"} onSelect={() => choosePrintFormat("a4")} />
            </div>
          )}
          <button type="button" onClick={onClose} className="rounded-lg bg-surface-container px-4 py-2.5 text-sm font-medium text-on-surface-variant sm:px-5">Close</button>
          {canPrint && (
            <button type="button" onClick={() => window.print()} className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-on-primary sm:px-5">
              <span className="material-symbols-outlined text-lg">print</span>
              {emailFailed ? "Print After Email Failure" : printFormat === "thermal" ? "Print Slip" : "Print A4"}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ReceiptDeliveryStatus({ payment, emailRecipient, setEmailRecipient, showEmailForm, setShowEmailForm, emailError, saving, onSend }: {
  payment: PaymentReceipt;
  emailRecipient: string;
  setEmailRecipient: (value: string) => void;
  showEmailForm: boolean;
  setShowEmailForm: (value: boolean) => void;
  emailError: string;
  saving: boolean;
  onSend: () => void;
}) {
  const status = payment.receipt_email_status;
  const sent = payment.receipt_delivery_method === "email" && status === "sent";
  const failed = payment.receipt_delivery_method === "email" && status === "failed";
  const inProgress = payment.receipt_delivery_method === "email" && (status === "pending" || status === "sending");

  return (
    <div className="no-print border-b border-surface-container px-4 py-4 sm:px-6">
      {sent && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl bg-primary/10 p-4 text-sm text-primary">
          <span className="material-symbols-outlined">mark_email_read</span>
          <div className="min-w-0 flex-1">
            <p className="font-semibold">Receipt emailed successfully</p>
            <p className="mt-0.5 break-all text-xs">{maskEmail(payment.receipt_email)}</p>
          </div>
          {!payment.is_voided && <button type="button" onClick={() => setShowEmailForm(!showEmailForm)} className="rounded-lg bg-white px-3 py-2 text-xs font-semibold text-primary">Send Again</button>}
        </div>
      )}

      {inProgress && (
        <div className="flex items-center gap-3 rounded-xl bg-primary/10 p-4 text-sm text-primary">
          <span className="material-symbols-outlined animate-pulse">outgoing_mail</span>
          <p className="font-semibold">Sending receipt email…</p>
        </div>
      )}

      {failed && (
        <div className="rounded-xl border border-error/25 bg-error/5 p-4 text-sm">
          <div className="flex gap-3 text-error">
            <span className="material-symbols-outlined">mark_email_unread</span>
            <div>
              <p className="font-semibold">Email failed — the payment is still recorded</p>
              <p className="mt-1 text-xs">{payment.receipt_email_error || "Check the address and retry. Print only if the customer is still present and email cannot be sent."}</p>
            </div>
          </div>
        </div>
      )}

      {payment.receipt_delivery_method === "physical" && !payment.is_voided && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl bg-surface-container-low p-4 text-sm text-on-surface-variant">
          <span className="material-symbols-outlined">receipt_long</span>
          <p className="min-w-0 flex-1 font-semibold">Physical receipt selected</p>
          <button type="button" onClick={() => setShowEmailForm(!showEmailForm)} className="rounded-lg bg-white px-3 py-2 text-xs font-semibold text-primary">Email Instead</button>
        </div>
      )}

      {(showEmailForm || failed) && !payment.is_voided && (
        <div className="mt-3 rounded-xl bg-surface-container-low p-4">
          <label className="block text-sm font-semibold text-on-surface">Receipt email address
            <input
              type="email"
              maxLength={254}
              value={emailRecipient}
              onChange={(event) => setEmailRecipient(event.target.value)}
              className="mt-1.5 w-full rounded-lg border border-outline-variant bg-white px-3 py-2.5 text-sm focus:border-primary"
              placeholder="customer@example.com"
            />
          </label>
          <p className="mt-2 text-xs text-on-surface-variant">Changing this address applies only to this send and does not update the customer profile.</p>
          {emailError && <p className="mt-3 rounded-lg bg-error/10 p-3 text-sm text-error">{emailError}</p>}
          <div className="mt-3 flex justify-end gap-3">
            {!failed && <button type="button" disabled={saving} onClick={() => setShowEmailForm(false)} className="rounded-lg bg-white px-4 py-2 text-sm font-medium">Cancel</button>}
            <button type="button" disabled={saving || !emailRecipient.trim()} onClick={onSend} className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-on-primary disabled:opacity-50">{saving ? "Sending…" : failed ? "Retry Email" : "Send Email"}</button>
          </div>
        </div>
      )}
    </div>
  );
}

function maskEmail(value: string | null) {
  if (!value) return "Email address unavailable";
  const [local, domain] = value.split("@");
  if (!domain) return value;
  return `${local.slice(0, 1)}${"*".repeat(Math.min(Math.max(local.length - 1, 2), 6))}@${domain}`;
}

function PrintFormatOption({ label, description, active, onSelect }: { label: string; description: string; active: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      title={description}
      className={`rounded-md px-3 py-2 text-sm font-medium ${active ? "bg-surface-container-lowest text-on-surface shadow-sm" : "text-on-surface-variant"}`}
    >
      {label}
      <span className="sr-only"> — {description}</span>
    </button>
  );
}

/* Anchors rather than plain text: on screen a counter can tap through to
   WhatsApp or dial, and print simply drops the affordance and leaves the
   number readable. */
function ContactLine({ label, numbers }: { label: string; numbers: readonly { display: string; href: string }[] }) {
  return (
    <p className="receipt-contact-line">
      <span className="receipt-contact-label font-semibold">{label}</span>{" "}
      {numbers.map((number, index) => (
        <span key={number.href}>
          {index > 0 && <span className="receipt-contact-separator"> or </span>}
          <a href={number.href} className="receipt-contact-number whitespace-nowrap hover:underline">{number.display}</a>
        </span>
      ))}
    </p>
  );
}

function ReceiptField({ label, value }: { label: string; value: string }) {
  return (
    <div className="receipt-field">
      <p className="receipt-field-label text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant">{label}</p>
      <p className="receipt-field-value mt-1.5 break-words text-sm font-semibold text-on-surface">{value}</p>
    </div>
  );
}

/* The slip only needs to say who served the customer, and a counter is known
   by a first name. The full name stays on the payment record itself, which is
   what an audit looks at. */
function firstName(value: string | null) {
  const first = (value ?? "").trim().split(/\s+/)[0];
  return first || "—";
}

function formatCurrency(value: string) {
  return `J$${Number(value).toLocaleString("en-JM", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(value: string) {
  const date = new Date(`${value.slice(0, 10)}T00:00:00`);
  return date.toLocaleDateString("en-JM", { day: "numeric", month: "long", year: "numeric" });
}

function formatMonth(value: string | null) {
  if (!value) return "Not applicable";
  const date = new Date(`${value.slice(0, 10)}T00:00:00`);
  return date.toLocaleDateString("en-JM", { month: "long", year: "numeric" });
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString("en-JM", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Jamaica",
  });
}

export default PaymentReceiptModal;
