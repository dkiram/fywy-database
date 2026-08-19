/** Collects a new customer payment and returns its server-issued receipt to the parent. */
import { useEffect, useState } from "react";
import type { Employee } from "../auth/AuthContext";
import { apiFetch } from "../lib/api";
import type { PaymentReceipt } from "./PaymentReceiptModal";

type PaymentCustomer = {
  customer_id: number;
  name: string | null;
  monthly_fee: string | null;
  installation_fee: string | null;
  reconnection_fee: string | null;
};

// The three original types take their amount from the customer's package, so
// they carry no price here. The flat service charges added Aug 2026 do, and
// the cashier can still edit the amount before taking the money.
//
// recordablePaymentTypes in server/src/routes/payments.ts must list the same
// names, or the server rejects the payment.
const paymentTypeOptions = [
  { label: "Monthly Fee", price: null },
  { label: "Reconnection Fee", price: null },
  { label: "Installation Fee", price: null },
  { label: "Password Change", price: "1000.00" },
  { label: "Modem Relocation", price: "1500.00" },
  { label: "Modem Reset", price: "1500.00" },
  { label: "Broken Ends", price: "1500.00" },
  { label: "Cable Remote", price: "1500.00" },
] as const;

type PaymentTypeLabel = (typeof paymentTypeOptions)[number]["label"];

const paymentTypes: readonly PaymentTypeLabel[] = paymentTypeOptions.map(
  (option) => option.label,
);

function jamaicaCurrentMonth() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Jamaica",
    year: "numeric",
    month: "2-digit",
  }).format(new Date());
}

function RecordPaymentDrawer({ customer, employee, onClose, onRecorded }: { customer: PaymentCustomer; employee: Employee; onClose: () => void; onRecorded: (receipt: PaymentReceipt) => void }) {
  const [paymentType, setPaymentType] = useState<PaymentTypeLabel>("Monthly Fee");
  const [amount, setAmount] = useState(customer.monthly_fee ?? "");
  const [monthPaid, setMonthPaid] = useState(jamaicaCurrentMonth());
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    // Lock background scrolling while the full-height drawer is open.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  const updatePaymentType = (value: PaymentTypeLabel) => {
    // Prefill the configured fee but leave the amount editable for the cashier.
    setPaymentType(value);
    if (value === "Monthly Fee") return setAmount(customer.monthly_fee ?? "");
    if (value === "Reconnection Fee") return setAmount(customer.reconnection_fee ?? "");
    if (value === "Installation Fee") return setAmount(customer.installation_fee ?? "");
    // Flat service charges carry their own price.
    setAmount(paymentTypeOptions.find((option) => option.label === value)?.price ?? "");
  };

  const submitPayment = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      // The server stamps cashier, branch, date, receipt number, and audit information.
      setSaving(true);
      setError("");
      const response = await apiFetch(`/api/customers/${customer.customer_id}/payments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paymentType, amount, monthPaid: paymentType === "Monthly Fee" ? monthPaid : "", note }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not record payment.");
      onRecorded(data.payment);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not record payment.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="application-drawer-backdrop fixed inset-0 z-50 flex justify-end bg-black/45" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}>
      <aside className="application-drawer flex h-dvh w-full flex-col bg-white shadow-2xl sm:max-w-lg" role="dialog" aria-modal="true" aria-labelledby="record-payment-title">
        <header className="flex items-start justify-between gap-4 border-b border-surface-container px-6 py-6 sm:px-8">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">Customer #{customer.customer_id}</p>
            <h2 id="record-payment-title" className="mt-2 text-2xl font-semibold">Record Payment</h2>
            <p className="mt-1 text-sm text-on-surface-variant">{customer.name || "Unnamed customer"}</p>
          </div>
          <button type="button" disabled={saving} onClick={onClose} aria-label="Close payment form" className="flex h-10 w-10 items-center justify-center rounded-lg bg-surface-container text-on-surface-variant disabled:opacity-40">
            <span className="material-symbols-outlined">close</span>
          </button>
        </header>

        <form onSubmit={submitPayment} className="flex min-h-0 flex-1 flex-col">
          <div className="flex-1 space-y-6 overflow-y-auto px-6 py-7 sm:px-8">
            <div className="grid grid-cols-1 gap-3 rounded-xl bg-surface-container-low p-4 sm:grid-cols-2">
              <ReadOnlyField label="Cashier" value={`${employee.firstName} ${employee.lastName}`} />
              <ReadOnlyField label="Location" value={employee.locationName || "Unassigned location"} />
            </div>

            <Field label="Payment type" required>
              <select value={paymentType} onChange={(event) => updatePaymentType(event.target.value as PaymentTypeLabel)} className={inputClass}>
                {paymentTypes.map((type) => <option key={type} value={type}>{type}</option>)}
              </select>
            </Field>

            <Field label="Amount received (J$)" required>
              <input required type="number" min="0.01" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} className={inputClass} placeholder="0.00" />
            </Field>

            {paymentType === "Monthly Fee" && (
              <Field label="Month being paid for" required>
                <input required type="month" value={monthPaid} onChange={(event) => setMonthPaid(event.target.value)} className={inputClass} />
              </Field>
            )}

            {/* The place to record that the money came in on a different day
                from the receipt, which is why the payment date itself stays
                fixed and uneditable. */}
            <Field label="Internal note (not printed on the receipt)">
              <textarea rows={4} maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} className={inputClass} placeholder="Payment details or correct date..." />
            </Field>

            <div className="rounded-xl border border-primary/15 bg-primary/5 p-4 text-sm text-on-surface-variant">
              <div className="flex gap-3">
                <span className="material-symbols-outlined text-primary">verified_user</span>
                <p>The cashier, location, date, and time are recorded automatically. Accidental payments can only be voided by Admin or Head Office with a reason.</p>
              </div>
            </div>

            {error && <p className="rounded-lg bg-error/10 p-3 text-sm font-medium text-error">{error}</p>}
          </div>

          <footer className="flex justify-end gap-3 border-t border-surface-container bg-white px-6 py-4 sm:px-8">
            <button type="button" disabled={saving} onClick={onClose} className="rounded-lg bg-surface-container px-5 py-2.5 text-sm font-medium text-on-surface-variant disabled:opacity-40">Cancel</button>
            <button type="submit" disabled={saving} className="flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-on-primary disabled:opacity-50">
              <span className="material-symbols-outlined text-lg">payments</span>
              {saving ? "Recording..." : "Record & Create Receipt"}
            </button>
          </footer>
        </form>
      </aside>
    </div>
  );
}

const inputClass = "mt-1.5 w-full rounded-lg border border-outline-variant bg-white px-3 py-2.5 text-sm transition focus:border-primary";

function Field({ label, required = false, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return <label className="block text-sm font-semibold text-on-surface">{label}{required && <span className="ml-1 text-error">*</span>}{children}</label>;
}

function ReadOnlyField({ label, value }: { label: string; value: string }) {
  return <div><p className="text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant">{label}</p><p className="mt-1 text-sm font-semibold text-on-surface">{value}</p></div>;
}

export default RecordPaymentDrawer;
