/** Presents a recorded payment as an on-screen and print-friendly receipt. */
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
};

function PaymentReceiptModal({ payment, onClose }: { payment: PaymentReceipt; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-label={`Receipt ${payment.receipt_number}`}>
      <div className="w-full max-w-xl overflow-hidden rounded-2xl bg-white shadow-2xl">
        {/* Print CSS hides the surrounding app and leaves only this receipt section visible. */}
        <div className="payment-receipt-print bg-white p-7 text-on-surface sm:p-9">
          <div className="flex items-start justify-between gap-6 border-b-2 border-primary pb-5">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.2em] text-primary">SPCL</p>
              <h2 className="mt-1 text-2xl font-bold">Payment Receipt</h2>
              <p className="mt-1 text-sm text-on-surface-variant">Official customer payment record</p>
            </div>
            <div className="text-right">
              <p className="font-mono text-sm font-bold text-primary">{payment.receipt_number}</p>
              <p className="mt-1 text-xs text-on-surface-variant">{formatDate(payment.payment_date)}</p>
            </div>
          </div>

          <div className="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-2">
            <ReceiptField label="Received from" value={payment.customer_name || "Unnamed customer"} />
            <ReceiptField label="Customer ID" value={String(payment.customer_id)} />
            <ReceiptField label="Payment type" value={payment.payment_type} />
            <ReceiptField label="Month paid for" value={formatMonth(payment.month_paid)} />
            <ReceiptField label="Cashier" value={payment.cashier_name || "—"} />
            <ReceiptField label="Location" value={payment.location || "—"} />
          </div>

          <div className="mt-7 rounded-xl bg-primary/10 px-5 py-5 text-center">
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-primary">Amount received</p>
            <p className="mt-2 text-4xl font-bold text-primary">{formatCurrency(payment.amount_paid)}</p>
          </div>

          {payment.note && (
            <div className="mt-6 border-t border-surface-container pt-4">
              <ReceiptField label="Note" value={payment.note} />
            </div>
          )}

          <p className="mt-7 border-t border-surface-container pt-4 text-center text-xs text-on-surface-variant">
            Recorded {formatDateTime(payment.recorded_at)} · Payment #{payment.payment_id}
          </p>
        </div>

        <div className="no-print flex justify-end gap-3 border-t border-surface-container bg-surface-container-low px-6 py-4">
          <button type="button" onClick={onClose} className="rounded-lg bg-surface-container px-5 py-2.5 text-sm font-bold text-on-surface-variant">Close</button>
          <button type="button" onClick={() => window.print()} className="flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-bold text-on-primary">
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
      <p className="text-[11px] font-bold uppercase tracking-wider text-on-surface-variant">{label}</p>
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
