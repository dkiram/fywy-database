/** Runs the selected operational report and renders its server-defined columns and rows. */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useAuth } from "../auth/AuthContext";
import { apiFetch } from "../lib/api";

// Reports are read-only detailed views of existing operational records. They do
// not create or update tickets, payments, customers, applications, or pole boxes.
type ReportKey = "payments-by-date" | "payments-by-location" | "pending-service" | "delinquent-customers" | "disconnected-customers" | "applications" | "pole-box-usage";
type ReportRow = Record<string, unknown>;
type Column = { key: string; label: string; format?: "date" | "currency" | "status" };
type SortDirection = "asc" | "desc";

// Which column headers are clickable, per report. Sorting happens in SQL, not
// here - a report can run to hundreds of pages and reordering the twenty-five
// rows on screen would be a lie. This list only decides what looks clickable;
// REPORT_SORTS on the server decides what actually sorts, and ignores anything
// it does not recognise. Keep the two in step when adding a column.
const SORTABLE_COLUMNS: Partial<Record<ReportKey, string[]>> = {
  "delinquent-customers": [
    "customer_id",
    "customer_name",
    "outstanding_balance",
    "oldest_unpaid_due_date",
    "grace_end_date",
    "scheduled_disconnection_date",
    "last_payment_date",
  ],
};

const reports: Array<{ key: ReportKey; title: string; description: string; icon: string; dateFilters: boolean; columns: Column[] }> = [
  { key: "payments-by-date", title: "Payments by Date", description: "Payment count and amount for each day.", icon: "calendar_month", dateFilters: true, columns: [{ key: "payment_date", label: "Payment Date", format: "date" }, { key: "payment_count", label: "Payments" }, { key: "total_amount", label: "Total", format: "currency" }] },
  { key: "payments-by-location", title: "Payments by Location", description: "Collected amounts grouped by payment location.", icon: "location_on", dateFilters: true, columns: [{ key: "location", label: "Location" }, { key: "payment_count", label: "Payments" }, { key: "total_amount", label: "Total", format: "currency" }] },
  { key: "pending-service", title: "Pending Service", description: "Open, assigned, and in-progress service work.", icon: "construction", dateFilters: true, columns: [{ key: "service_ticket_id", label: "Ticket" }, { key: "customer_name", label: "Customer" }, { key: "issue_summary", label: "Problem" }, { key: "priority", label: "Priority", format: "status" }, { key: "status", label: "Status", format: "status" }, { key: "technician", label: "Technician" }, { key: "reported_date", label: "Reported", format: "date" }] },
  // This detailed report is the drill-down behind the dashboard delinquency count.
  { key: "delinquent-customers", title: "Delinquent Customers", description: "Active accounts past grace, with disconnection dates and active passes.", icon: "event_busy", dateFilters: false, columns: [{ key: "customer_id", label: "Customer ID" }, { key: "customer_name", label: "Customer" }, { key: "status", label: "Status", format: "status" }, { key: "outstanding_balance", label: "Outstanding", format: "currency" }, { key: "oldest_unpaid_due_date", label: "Oldest Due", format: "date" }, { key: "grace_end_date", label: "Grace End", format: "date" }, { key: "scheduled_disconnection_date", label: "Disconnect On", format: "date" }, { key: "eligible_for_disconnection", label: "Eligible Now" }, { key: "is_on_hold", label: "On Hold" }, { key: "hold_expires_on", label: "Hold Until", format: "date" }, { key: "last_payment_date", label: "Last Payment", format: "date" }] },
  { key: "disconnected-customers", title: "Disconnected Customers", description: "Disconnected and pending-reconnection accounts.", icon: "link_off", dateFilters: false, columns: [{ key: "customer_id", label: "Customer ID" }, { key: "customer_name", label: "Customer" }, { key: "status", label: "Status", format: "status" }, { key: "monthly_fee", label: "Monthly Fee", format: "currency" }, { key: "deactivation_date", label: "Disconnected", format: "date" }, { key: "last_payment_date", label: "Last Payment", format: "date" }, { key: "lifetime_payments", label: "Lifetime Payments", format: "currency" }] },
  { key: "applications", title: "Applications", description: "Application outcomes, packages, and activation links.", icon: "description", dateFilters: true, columns: [{ key: "application_id", label: "Application" }, { key: "applicant_name", label: "Applicant" }, { key: "application_date", label: "Applied", format: "date" }, { key: "status", label: "Status", format: "status" }, { key: "package_name", label: "Package" }, { key: "monthly_fee", label: "Monthly Fee", format: "currency" }, { key: "customer_id", label: "Customer ID" }] },
  { key: "pole-box-usage", title: "Pole-Box Usage", description: "Capacity, occupied ports, and assignment conflicts.", icon: "dns", dateFilters: false, columns: [{ key: "box_number", label: "Pole Box" }, { key: "location_description", label: "Location" }, { key: "status", label: "Status", format: "status" }, { key: "occupied_ports", label: "Occupied" }, { key: "capacity", label: "Capacity" }, { key: "available_ports", label: "Available" }, { key: "duplicate_assignments", label: "Duplicates" }, { key: "over_capacity", label: "Over Capacity" }] },
];

function ReportsPage() {
  const navigate = useNavigate();
  const { employee } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedReport = searchParams.get("report") as ReportKey | null;
  // Head Office keeps operational reports but cannot see the company-wide
  // Payments by Date report or select it through a copied URL.
  const availableReports = useMemo(
    () =>
      employee?.role === "admin"
        ? reports
        : reports.filter(
            (item) =>
              item.key !== "payments-by-date" &&
              item.key !== "payments-by-location"
          ),
    [employee?.role]
  );
  const [reportKey, setReportKey] = useState<ReportKey>(availableReports.some((item) => item.key === requestedReport) ? requestedReport! : availableReports[0].key);
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState(searchParams.get("from") || jamaicaToday());
  const [to, setTo] = useState(searchParams.get("to") || jamaicaToday());
  const [page, setPage] = useState(1);
  // Empty sort means "use the report's own default order", which for the
  // delinquent list is the chase order: who gets cut off soonest.
  const [sort, setSort] = useState("");
  const [direction, setDirection] = useState<SortDirection>("desc");
  const [rows, setRows] = useState<ReportRow[]>([]);
  const [totals, setTotals] = useState<Record<string, unknown> | null>(null);
  const [pagination, setPagination] = useState({ page: 1, limit: 25, total: 0, totalPages: 1 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const report = useMemo(() => availableReports.find((item) => item.key === reportKey) ?? availableReports[0], [availableReports, reportKey]);

  const loadReport = useCallback(async () => {
    try {
      setLoading(true); setError("");
      const query = new URLSearchParams({ search, page: String(page) });
      if (report.dateFilters) { query.set("from", from); query.set("to", to); }
      if (sort) { query.set("sort", sort); query.set("dir", direction); }
      const response = await apiFetch(`/api/reports/${reportKey}?${query}`);
      const data = await response.json(); if (!response.ok) throw new Error(data.error || "Could not load report.");
      setRows(data.rows); setTotals(data.totals || null); setPagination(data.pagination);
      if (data.pagination.page !== page) setPage(data.pagination.page);
    } catch (loadError) { setError(loadError instanceof Error ? loadError.message : "Could not load report."); }
    finally { setLoading(false); }
  }, [direction, from, page, report.dateFilters, reportKey, search, sort, to]);

  useEffect(() => { const timeout = window.setTimeout(loadReport, 180); return () => window.clearTimeout(timeout); }, [loadReport]);

  const chooseReport = (key: ReportKey) => { setReportKey(key); setPage(1); setSearch(""); setSort(""); setDirection("desc"); setSearchParams({ report: key }); };

  const sortableColumns = SORTABLE_COLUMNS[reportKey] ?? [];

  // First click on a column sorts it newest/largest first, which is what
  // someone reaching for a date or a money column almost always wants. Clicking
  // the same column again flips it; a third click returns to the report's
  // default order rather than trapping you in a sort you no longer want.
  const toggleSort = (key: string) => {
    if (!sortableColumns.includes(key)) return;
    setPage(1);
    if (sort !== key) { setSort(key); setDirection("desc"); return; }
    if (direction === "desc") { setDirection("asc"); return; }
    setSort(""); setDirection("desc");
  };

  // Export the visible filtered page without adding a second data definition.
  const exportCsv = () => {
    const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
    const csv = [report.columns.map((column) => escape(column.label)).join(","), ...rows.map((row) => report.columns.map((column) => escape(row[column.key])).join(","))].join("\n");
    const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" })); link.download = `${reportKey}-${jamaicaToday()}.csv`; link.click(); URL.revokeObjectURL(link.href);
  };

  const openRow = (row: ReportRow) => {
    if (reportKey === "pending-service") navigate(`/service-requests?search=${row.service_ticket_id}`);
    if (reportKey === "delinquent-customers" && row.customer_id) navigate(`/customers/${row.customer_id}`);
    if (reportKey === "disconnected-customers" && row.customer_id) navigate(`/customers/${row.customer_id}`);
    if (reportKey === "applications") navigate("/applications");
    if (reportKey === "pole-box-usage" && row.pole_box_id) navigate(`/pole-boxes?search=${encodeURIComponent(String(row.box_number))}`);
  };

  return <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 py-6 lg:px-8 lg:py-8">
    <div><h1 className="text-2xl font-semibold tracking-tight text-on-surface">Reports &amp; Analytics</h1><p className="mt-1 text-sm text-on-surface-variant">Detailed, filterable views of data already recorded by SPCL operations.</p></div>

    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{availableReports.map((item) => <button key={item.key} type="button" onClick={() => chooseReport(item.key)} className={`rounded-xl border p-4 text-left transition ${item.key === reportKey ? "border-primary bg-primary/5 shadow-sm" : "border-surface-container bg-surface-container-lowest hover:border-primary/30"}`}><div className="flex items-start gap-3"><span className={`material-symbols-outlined rounded-lg p-2 ${item.key === reportKey ? "bg-primary text-on-primary" : "bg-surface-container text-primary"}`}>{item.icon}</span><div><p className="font-medium text-on-surface">{item.title}</p><p className="mt-1 text-xs leading-5 text-on-surface-variant">{item.description}</p></div></div></button>)}</div>

    <div className="rounded-xl border border-warning/30 bg-warning-container p-4 text-sm text-warning"><span className="font-medium">Legacy balance note:</span> the most recent year is reconstructed from Access payments and anniversary charges. Older brought-forward amounts are clearly marked unverified on the customer account.</div>

    <section className="report-print-area overflow-hidden rounded-2xl bg-surface-container-lowest shadow-sm">
      <div className="flex flex-col gap-4 border-b border-surface-container p-5 xl:flex-row xl:items-end xl:justify-between"><div><h2 className="text-lg font-semibold text-on-surface">{report.title}</h2><p className="mt-1 text-sm text-on-surface-variant">{report.description}</p></div><div className="flex flex-wrap items-end gap-3"><label className="text-xs font-semibold uppercase tracking-wider text-on-surface-variant">Search<input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} className="mt-1 block w-56 rounded-lg bg-surface-container-low px-3 py-2 text-sm font-normal normal-case tracking-normal" placeholder="Filter report..." /></label>{report.dateFilters && <><label className="text-xs font-semibold uppercase tracking-wider text-on-surface-variant">From<input type="date" value={from} onChange={(event) => { setFrom(event.target.value); setPage(1); }} className="mt-1 block rounded-lg bg-surface-container-low px-3 py-2 text-sm font-normal" /></label><label className="text-xs font-semibold uppercase tracking-wider text-on-surface-variant">To<input type="date" value={to} onChange={(event) => { setTo(event.target.value); setPage(1); }} className="mt-1 block rounded-lg bg-surface-container-low px-3 py-2 text-sm font-normal" /></label></>}<button type="button" disabled={rows.length === 0} onClick={exportCsv} className="flex items-center gap-2 rounded-lg bg-surface-container px-3 py-2 text-xs font-medium disabled:opacity-40"><span className="material-symbols-outlined text-base">download</span>Export Page</button><button type="button" onClick={() => window.print()} className="flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-on-primary"><span className="material-symbols-outlined text-base">print</span>Print</button></div></div>
      {totals && <div className="flex flex-wrap gap-6 border-b border-surface-container bg-primary/5 px-5 py-3 text-sm">{"payment_count" in totals && <><span><strong>{Number(totals.payment_count || 0).toLocaleString()}</strong> payments</span><span><strong>{formatCurrency(totals.total_amount)}</strong> collected</span></>}{"delinquent_count" in totals && <span><strong>{Number(totals.delinquent_count || 0).toLocaleString()}</strong> delinquent customers</span>}</div>}
      {error && <p className="m-5 rounded-lg bg-error/10 p-4 text-sm text-error">{error}</p>}
      <div className="overflow-x-auto"><table className="w-full text-left"><thead className="bg-surface-container-low"><tr>{report.columns.map((column) => {
        const canSort = sortableColumns.includes(column.key);
        const active = sort === column.key;
        return <th key={column.key} aria-sort={active ? (direction === "asc" ? "ascending" : "descending") : undefined} className="whitespace-nowrap px-5 py-4 text-xs font-semibold uppercase tracking-wider text-on-surface-variant">
          {canSort
            ? <button type="button" onClick={() => toggleSort(column.key)} title={active ? "Click to reverse, again to clear" : "Sort by this column"} className={`-mx-1 inline-flex items-center gap-1 rounded px-1 py-0.5 uppercase tracking-wider transition hover:text-on-surface ${active ? "text-primary" : ""}`}>
                {column.label}
                <span className="material-symbols-outlined text-sm leading-none">{active ? (direction === "asc" ? "arrow_upward" : "arrow_downward") : "unfold_more"}</span>
              </button>
            : column.label}
        </th>;
      })}</tr></thead><tbody className="divide-y divide-surface-container">{!loading && rows.map((row, index) => <tr key={`${reportKey}-${index}`} onClick={() => openRow(row)} className="transition hover:bg-surface-container-low/60">{report.columns.map((column) => <td key={column.key} className="max-w-sm px-5 py-4 text-sm text-on-surface-variant">{formatCell(row[column.key], column.format)}</td>)}</tr>)}</tbody></table></div>
      {loading && <div className="px-5 py-14 text-center text-sm text-on-surface-variant">Generating report...</div>}{!loading && !error && rows.length === 0 && <div className="px-5 py-14 text-center text-sm text-on-surface-variant">No rows match these report filters.</div>}{!loading && rows.length > 0 && <div className="flex items-center justify-between border-t border-surface-container px-5 py-4 text-sm text-on-surface-variant"><span>{pagination.total.toLocaleString()} result{pagination.total === 1 ? "" : "s"}</span><div className="flex items-center gap-3"><button disabled={pagination.page <= 1} onClick={() => setPage((value) => value - 1)} className="rounded-lg bg-surface-container px-3 py-2 text-xs font-medium disabled:opacity-40">Previous</button><span className="text-xs font-medium">Page {pagination.page} of {pagination.totalPages}</span><button disabled={pagination.page >= pagination.totalPages} onClick={() => setPage((value) => value + 1)} className="rounded-lg bg-surface-container px-3 py-2 text-xs font-medium disabled:opacity-40">Next</button></div></div>}
    </section>
  </div>;
}

function formatCell(value: unknown, format?: Column["format"]) {
  if (value === null || value === undefined || value === "") return "—";
  if (format === "currency") return formatCurrency(value);
  if (format === "date") return new Date(`${String(value).slice(0,10)}T00:00:00`).toLocaleDateString("en-JM", { day: "numeric", month: "short", year: "numeric" });
  if (format === "status") return <span className="inline-flex rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">{humanize(String(value))}</span>;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}
function formatCurrency(value: unknown) { return `J$${Number(value || 0).toLocaleString("en-JM", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
function humanize(value: string) { return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function jamaicaToday() { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Jamaica", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }

export default ReportsPage;
