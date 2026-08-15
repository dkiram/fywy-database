/** Shows the daily ledger, totals, breakdowns, and receipt access for recorded payments. */
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import PaymentReceiptModal, { type PaymentReceipt } from "../components/PaymentReceiptModal";
import { apiFetch } from "../lib/api";

type DailySummary = {
  payment_count: number;
  total_amount: string;
  average_amount: string;
};

type PaymentBreakdown = {
  payment_type?: string;
  location?: string;
  payment_count: number;
  total_amount: string;
};

type RecentPayment = {
  payment_id: number;
  receipt_number: string | null;
  payment_type: string;
  amount_paid: string;
  payment_date: string;
  recorded_at: string | null;
  cashier_name: string | null;
  location: string | null;
  legacy_customer_id: string | null;
  customer_id: number | null;
  customer_name: string | null;
  source: "imported" | "new_system";
};

type PaymentPagination = {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
};

type DailyPaymentsResponse = {
  date: string;
  scope: string;
  summary: DailySummary;
  byType: PaymentBreakdown[];
  byLocation: PaymentBreakdown[];
  recentPayments: RecentPayment[];
  pagination: PaymentPagination;
};

const emptyPagination: PaymentPagination = {
  page: 1,
  limit: 25,
  total: 0,
  totalPages: 1,
};

function jamaicaToday() {
  // Business dates use Jamaica time even when the employee's device uses another zone.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Jamaica",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function PaymentsPage() {
  const navigate = useNavigate();
  const [date, setDate] = useState(jamaicaToday());
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState(emptyPagination);
  const [data, setData] = useState<DailyPaymentsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState<PaymentReceipt | null>(null);

  const loadDailyPayments = useCallback(async () => {
    try {
      // Totals, breakdowns, and the ledger share one date/scope snapshot from the API.
      setLoading(true);
      setError("");
      const response = await apiFetch(
        `/api/payments/daily-summary?date=${date}&page=${page}`
      );
      const responseData = await response.json();
      if (!response.ok) throw new Error(responseData.error || "Could not load daily payments.");
      setData(responseData);
      setPagination(responseData.pagination);
      if (responseData.pagination.page !== page) {
        setPage(responseData.pagination.page);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load daily payments.");
    } finally {
      setLoading(false);
    }
  }, [date, page]);

  useEffect(() => {
    loadDailyPayments();
  }, [loadDailyPayments]);

  const openReceipt = async (paymentId: number) => {
    try {
      // Imported rows have no receipt number, so only new-system payments call this route.
      setError("");
      const response = await apiFetch(`/api/payments/${paymentId}/receipt`);
      const responseData = await response.json();
      if (!response.ok) throw new Error(responseData.error || "Could not load receipt.");
      setReceipt(responseData.payment);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load receipt.");
    }
  };

  const summary = data?.summary ?? { payment_count: 0, total_amount: "0", average_amount: "0" };

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 py-6 lg:px-8 lg:py-8">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-on-surface">Daily Payments</h1>
          <p className="mt-1 text-sm text-on-surface-variant">Daily totals and ledger entries from imported records and the new system.</p>
        </div>
        <button type="button" onClick={() => navigate("/customers")} className="flex w-fit items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-bold text-on-primary shadow-sm transition hover:bg-primary-container">
          <span className="material-symbols-outlined text-lg">person_search</span>
          Find Customer to Record Payment
        </button>
      </div>

      <div className="flex flex-col gap-3 rounded-xl bg-surface-container-lowest p-4 shadow-sm sm:flex-row sm:items-end sm:justify-between">
        <div>
          <label className="text-xs font-bold uppercase tracking-wider text-on-surface-variant">Business date</label>
          <input
            type="date"
            value={date}
            onChange={(event) => {
              setDate(event.target.value);
              setPage(1);
            }}
            className="mt-1.5 block rounded-lg border border-outline-variant bg-white px-3 py-2 text-sm outline-none focus:border-primary"
          />
        </div>
        <div className="text-sm text-on-surface-variant">
          Scope: <span className="font-bold text-on-surface">{data?.scope || "Loading..."}</span>
        </div>
      </div>

      {error && <div className="rounded-lg bg-error/10 p-4 text-sm font-medium text-error">{error}</div>}

      {/* Summary totals include both imported and newly recorded payments for the date. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <SummaryCard label="Total Collected" value={formatCurrency(summary.total_amount)} icon="payments" primary />
        <SummaryCard label="Payments Recorded" value={summary.payment_count.toLocaleString()} icon="receipt_long" />
        <SummaryCard label="Average Payment" value={formatCurrency(summary.average_amount)} icon="calculate" />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <BreakdownCard title="By payment type" icon="category" rows={data?.byType ?? []} labelKey="payment_type" empty="No payments were recorded for this date." />
        <BreakdownCard title="By location" icon="location_on" rows={data?.byLocation ?? []} labelKey="location" empty="No location totals are available for this date." />
      </div>

      {/* The paginated ledger labels each row's source and only offers real receipts. */}
      <section className="overflow-hidden rounded-2xl bg-surface-container-lowest shadow-sm">
        <div className="flex items-center justify-between border-b border-surface-container px-6 py-5">
          <div>
            <h2 className="text-lg font-bold text-on-surface">Payment ledger</h2>
            <p className="mt-1 text-sm text-on-surface-variant">All available transactions for {formatDate(date)}.</p>
          </div>
          <button type="button" onClick={loadDailyPayments} className="flex h-10 w-10 items-center justify-center rounded-lg bg-surface-container text-on-surface-variant transition hover:bg-surface-container-high" aria-label="Refresh daily payments">
            <span className="material-symbols-outlined">refresh</span>
          </button>
        </div>

        {loading ? (
          <div className="px-6 py-14 text-center text-sm text-on-surface-variant">Loading daily payments...</div>
        ) : data && data.recentPayments.length > 0 ? (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead className="bg-surface-container-low">
                  <tr>
                    <TableHeading>Time</TableHeading>
                    <TableHeading>Customer</TableHeading>
                    <TableHeading>Type</TableHeading>
                    <TableHeading>Source</TableHeading>
                    <TableHeading>Cashier / Location</TableHeading>
                    <TableHeading>Amount</TableHeading>
                    <th className="px-6 py-4 text-right text-xs font-bold uppercase tracking-wider text-on-surface-variant">Receipt</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-container">
                  {data.recentPayments.map((payment) => (
                    <tr key={payment.payment_id} className="transition hover:bg-surface-container-low/60">
                      <td className="whitespace-nowrap px-6 py-4 text-sm text-on-surface-variant">{formatTime(payment.recorded_at)}</td>
                      <td className="px-6 py-4">
                        <p className="font-semibold text-on-surface">{payment.customer_name || "Unmatched legacy customer"}</p>
                        <p className="mt-1 text-xs text-on-surface-variant">{customerReference(payment)}</p>
                      </td>
                      <td className="px-6 py-4"><span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-bold text-primary">{payment.payment_type}</span></td>
                      <td className="px-6 py-4"><SourceBadge source={payment.source} /></td>
                      <td className="px-6 py-4 text-sm text-on-surface-variant"><p>{payment.cashier_name || "—"}</p><p className="mt-1 text-xs">{payment.location || "Unassigned location"}</p></td>
                      <td className="whitespace-nowrap px-6 py-4 font-bold text-on-surface">{formatCurrency(payment.amount_paid)}</td>
                      <td className="px-6 py-4 text-right">
                        {payment.receipt_number ? (
                          <button type="button" onClick={() => openReceipt(payment.payment_id)} className="rounded-lg px-3 py-2 text-sm font-bold text-primary transition hover:bg-primary/10">View</button>
                        ) : (
                          <span className="text-sm text-outline">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-col gap-3 border-t border-surface-container px-6 py-4 text-sm text-on-surface-variant sm:flex-row sm:items-center sm:justify-between">
              <p>
                Showing {(pagination.page - 1) * pagination.limit + 1}–
                {Math.min(pagination.page * pagination.limit, pagination.total)} of{" "}
                {pagination.total.toLocaleString()}
              </p>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setPage((current) => Math.max(current - 1, 1))}
                  disabled={pagination.page <= 1}
                  className="rounded-lg bg-surface-container px-3 py-2 text-xs font-bold text-on-surface transition hover:bg-surface-container-high disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Previous
                </button>
                <span className="min-w-24 text-center text-xs font-semibold">
                  Page {pagination.page} of {pagination.totalPages}
                </span>
                <button
                  type="button"
                  onClick={() => setPage((current) => Math.min(current + 1, pagination.totalPages))}
                  disabled={pagination.page >= pagination.totalPages}
                  className="rounded-lg bg-surface-container px-3 py-2 text-xs font-bold text-on-surface transition hover:bg-surface-container-high disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="px-6 py-14 text-center"><span className="material-symbols-outlined text-4xl text-outline">payments</span><p className="mt-2 text-sm font-medium text-on-surface">No payments for this date</p><p className="mt-1 text-sm text-on-surface-variant">Choose another business date to view its ledger.</p></div>
        )}
      </section>

      {receipt && <PaymentReceiptModal payment={receipt} onClose={() => setReceipt(null)} />}
    </div>
  );
}

function SummaryCard({ label, value, icon, primary = false }: { label: string; value: string; icon: string; primary?: boolean }) {
  return <div className={`rounded-xl p-5 shadow-sm ${primary ? "bg-primary text-on-primary" : "bg-surface-container-lowest text-on-surface"}`}><div className="flex items-start justify-between gap-4"><div><p className={`text-xs font-bold uppercase tracking-wider ${primary ? "text-white/70" : "text-on-surface-variant"}`}>{label}</p><p className="mt-3 text-3xl font-bold">{value}</p></div><span className={`material-symbols-outlined flex h-11 w-11 items-center justify-center rounded-lg ${primary ? "bg-white/15" : "bg-primary/10 text-primary"}`}>{icon}</span></div></div>;
}

function BreakdownCard({ title, icon, rows, labelKey, empty }: { title: string; icon: string; rows: PaymentBreakdown[]; labelKey: "payment_type" | "location"; empty: string }) {
  return <section className="rounded-2xl bg-surface-container-lowest p-6 shadow-sm"><div className="mb-5 flex items-center gap-3 border-b border-surface-container pb-4"><span className="material-symbols-outlined text-primary">{icon}</span><h2 className="font-bold text-on-surface">{title}</h2></div>{rows.length > 0 ? <div className="space-y-4">{rows.map((row) => <div key={row[labelKey] || "Unknown"} className="flex items-center justify-between gap-4"><div><p className="text-sm font-semibold text-on-surface">{row[labelKey] || "Unknown"}</p><p className="mt-1 text-xs text-on-surface-variant">{row.payment_count} payment{row.payment_count === 1 ? "" : "s"}</p></div><p className="font-bold text-on-surface">{formatCurrency(row.total_amount)}</p></div>)}</div> : <p className="text-sm text-on-surface-variant">{empty}</p>}</section>;
}

function TableHeading({ children }: { children: React.ReactNode }) {
  return <th className="px-6 py-4 text-xs font-bold uppercase tracking-wider text-on-surface-variant">{children}</th>;
}

function SourceBadge({ source }: { source: RecentPayment["source"] }) {
  const imported = source === "imported";
  return (
    <span className={`whitespace-nowrap rounded-full px-3 py-1 text-xs font-bold ${imported ? "bg-surface-container text-on-surface-variant" : "bg-tertiary/10 text-tertiary"}`}>
      {imported ? "Imported" : "New System"}
    </span>
  );
}

function customerReference(payment: RecentPayment) {
  if (payment.customer_id !== null) return `Customer #${payment.customer_id}`;
  if (payment.legacy_customer_id) return `Legacy ID ${payment.legacy_customer_id}`;
  return "No customer ID";
}

function formatCurrency(value: string) {
  return `J$${Number(value).toLocaleString("en-JM", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(value: string) {
  const dateValue = value.slice(0, 10);
  return new Date(`${dateValue}T00:00:00`).toLocaleDateString("en-JM", { day: "numeric", month: "long", year: "numeric" });
}

function formatTime(value: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleTimeString("en-JM", { hour: "numeric", minute: "2-digit", timeZone: "America/Jamaica" });
}

export default PaymentsPage;
