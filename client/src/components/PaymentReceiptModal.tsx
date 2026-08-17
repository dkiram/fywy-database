/** Presents a recorded payment as an on-screen and print-friendly receipt. */
import { useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { apiFetch } from "../lib/api";

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
  customer_id: number;
  customer_name: string | null;
  customer_address: string | null;
  customer_telephone: string | null;
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
  const canVoid = employee?.role === "admin" || employee?.role === "head_office";
  const canDelete = employee?.role === "admin";

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

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/50 p-2 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label={`Receipt ${displayPayment.receipt_number}`}>
      <div className="my-2 flex max-h-[calc(100dvh-1rem)] w-full max-w-xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl sm:my-0 sm:max-h-[calc(100dvh-2rem)]">
        {/* Keep long receipts and destructive confirmations inside a dedicated
            scroll region while the main action bar remains reachable. */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {/* Print CSS hides the surrounding app and leaves only this receipt section visible. */}
        <div className="payment-receipt-print bg-white p-5 text-on-surface sm:p-9">
          <div className="flex items-start justify-between gap-6 border-b-2 border-primary pb-5">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary">SPCL</p>
              <h2 className="mt-1 text-2xl font-semibold">Payment Receipt</h2>
              <p className="mt-1 text-sm text-on-surface-variant">Official customer payment record</p>
            </div>
            <div className="text-right">
              <p className="font-mono text-sm font-medium text-primary">{displayPayment.receipt_number}</p>
              <p className="mt-1 text-xs text-on-surface-variant">{formatDate(displayPayment.payment_date)}</p>
            </div>
          </div>

          {displayPayment.is_voided && (
            // The original receipt remains printable but can never be mistaken
            // for a valid collection after its reversal.
            <div className="mt-5 rounded-xl border-2 border-error bg-error/10 p-4 text-center text-error">
              <p className="text-2xl font-semibold uppercase tracking-[0.25em]">Voided</p>
              <p className="mt-2 text-sm font-semibold">{displayPayment.void_reason}</p>
              <p className="mt-1 text-xs">{displayPayment.voided_at ? formatDateTime(displayPayment.voided_at) : ""}{displayPayment.voided_by_name ? ` · ${displayPayment.voided_by_name}` : ""}</p>
            </div>
          )}

          <div className="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-2">
            <ReceiptField label="Received from" value={displayPayment.customer_name || "Unnamed customer"} />
            <ReceiptField label="Customer ID" value={String(displayPayment.customer_id)} />
            <ReceiptField label="Payment type" value={displayPayment.payment_type} />
            <ReceiptField label="Month paid for" value={formatMonth(displayPayment.month_paid)} />
            <ReceiptField label="Cashier" value={displayPayment.cashier_name || "—"} />
            <ReceiptField label="Location" value={displayPayment.location || "—"} />
          </div>

          <div className="mt-7 rounded-xl bg-primary/10 px-5 py-5 text-center">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">Amount received</p>
            <p className="mt-2 text-4xl font-medium text-primary">{formatCurrency(displayPayment.amount_paid)}</p>
          </div>

          {displayPayment.note && (
            <div className="mt-6 border-t border-surface-container pt-4">
              <ReceiptField label="Note" value={displayPayment.note} />
            </div>
          )}

          <p className="mt-7 border-t border-surface-container pt-4 text-center text-xs text-on-surface-variant">
            Recorded {formatDateTime(displayPayment.recorded_at)} · Payment #{displayPayment.payment_id}
          </p>
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
          <button type="button" onClick={onClose} className="rounded-lg bg-surface-container px-4 py-2.5 text-sm font-medium text-on-surface-variant sm:px-5">Close</button>
          <button type="button" onClick={() => window.print()} className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-on-primary sm:px-5">
            <span className="material-symbols-outlined text-lg">print</span>
            Print Receipt
          </button>
        </div>
      </div>
    </div>
  );
}

function ReceiptField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant">{label}</p>
      <p className="mt-1.5 break-words text-sm font-semibold text-on-surface">{value}</p>
    </div>
  );
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
