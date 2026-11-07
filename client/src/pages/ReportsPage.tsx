/** Runs the selected operational report and renders its server-defined columns and rows. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useAuth } from "../auth/AuthContext";
import { apiFetch } from "../lib/api";
import { useOpenCustomerProfile } from "../hooks/useOpenCustomerProfile";
import { useScrollRestoration } from "../hooks/useScrollRestoration";

// Reports are read-only detailed views of existing operational records. They do
// not create or update tickets, payments, customers, applications, or pole boxes.
type ReportKey = "payments-by-date" | "payments-by-location" | "pending-service" | "technician-jobs" | "delinquent-customers" | "disconnected-customers" | "applications" | "pole-box-usage" | "nightly-disconnection-runs";
type ReportRow = Record<string, unknown>;
type Column = { key: string; label: string; format?: "date" | "datetime" | "currency" | "status" | "percent" };
type SortDirection = "asc" | "desc";
type ReportDefinition = { key: ReportKey; title: string; description: string; icon: string; dateFilters: boolean; adminOnly?: boolean; columns: Column[] };

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
    "last_payment_date",
  ],
};

const reports: ReportDefinition[] = [
  { key: "payments-by-date", title: "Payments by Date", description: "Payment count and amount for each day.", icon: "calendar_month", dateFilters: true, adminOnly: true, columns: [{ key: "payment_date", label: "Payment Date", format: "date" }, { key: "payment_count", label: "Transactions" }, { key: "gross_amount", label: "Collected", format: "currency" }, { key: "refund_amount", label: "Refunds", format: "currency" }, { key: "total_amount", label: "Net Total", format: "currency" }] },
  { key: "payments-by-location", title: "Payments by Location", description: "Collected amounts grouped by payment location.", icon: "location_on", dateFilters: true, adminOnly: true, columns: [{ key: "location", label: "Location" }, { key: "payment_count", label: "Transactions" }, { key: "gross_amount", label: "Collected", format: "currency" }, { key: "refund_amount", label: "Refunds", format: "currency" }, { key: "total_amount", label: "Net Total", format: "currency" }] },
  { key: "pending-service", title: "Pending Service", description: "Open, assigned, and in-progress service work.", icon: "construction", dateFilters: true, columns: [{ key: "service_ticket_id", label: "Ticket" }, { key: "customer_name", label: "Customer" }, { key: "customer_address", label: "Address" }, { key: "issue_summary", label: "Problem" }, { key: "priority", label: "Priority", format: "status" }, { key: "status", label: "Status", format: "status" }, { key: "technician", label: "Technician" }, { key: "reported_date", label: "Reported", format: "date" }] },
  // Open to Head Office as well as admins. It names members of staff, but the
  // people who dispatch the work are the people who need to see how it came
  // back, and they can already read every one of these jobs one at a time on
  // the service queue.
  //
  // "Jobs Closed" rather than "Jobs" because the date range is the day the job
  // ended, not the day it was reported - so the three period columns are all
  // about work finished, and they add up. "Open Now" is deliberately outside
  // the range and says so in its label.
  { key: "technician-jobs", title: "Technician Jobs", description: "Jobs each technician closed, completed, and left unresolved.", icon: "engineering", dateFilters: true, columns: [{ key: "technician", label: "Technician" }, { key: "jobs_closed", label: "Jobs Closed" }, { key: "completed_count", label: "Completed" }, { key: "unresolved_count", label: "Unresolved" }, { key: "cancelled_count", label: "Cancelled" }, { key: "completion_rate", label: "Completion Rate", format: "percent" }, { key: "open_now", label: "Open Now" }] },
  // This detailed report is the drill-down behind the dashboard delinquency count.
  { key: "delinquent-customers", title: "Delinquent Customers", description: "Active accounts past grace, with eligibility and active passes.", icon: "event_busy", dateFilters: false, columns: [{ key: "customer_id", label: "Customer ID" }, { key: "customer_name", label: "Customer" }, { key: "status", label: "Status", format: "status" }, { key: "outstanding_balance", label: "Outstanding", format: "currency" }, { key: "oldest_unpaid_due_date", label: "Oldest Due", format: "date" }, { key: "grace_end_date", label: "Grace End", format: "date" }, { key: "eligible_for_disconnection", label: "Eligible Now" }, { key: "is_on_hold", label: "On Hold" }, { key: "hold_expires_on", label: "Hold Until", format: "date" }, { key: "last_payment_date", label: "Last Payment", format: "date" }] },
  { key: "disconnected-customers", title: "Disconnected Customers", description: "Disconnected and pending-reconnection accounts.", icon: "link_off", dateFilters: false, columns: [{ key: "customer_id", label: "Customer ID" }, { key: "customer_name", label: "Customer" }, { key: "status", label: "Status", format: "status" }, { key: "monthly_fee", label: "Monthly Fee", format: "currency" }, { key: "deactivation_date", label: "Disconnected", format: "date" }, { key: "last_payment_date", label: "Last Payment", format: "date" }, { key: "lifetime_payments", label: "Lifetime Payments", format: "currency" }] },
  { key: "applications", title: "Applications", description: "Application outcomes, packages, and activation links.", icon: "description", dateFilters: true, columns: [{ key: "application_id", label: "Application" }, { key: "applicant_name", label: "Applicant" }, { key: "application_date", label: "Applied", format: "date" }, { key: "status", label: "Status", format: "status" }, { key: "package_name", label: "Package" }, { key: "monthly_fee", label: "Monthly Fee", format: "currency" }, { key: "customer_id", label: "Customer ID" }] },
  { key: "pole-box-usage", title: "Pole-Box Usage", description: "Capacity, occupied ports, and assignment conflicts.", icon: "dns", dateFilters: false, columns: [{ key: "box_number", label: "Pole Box" }, { key: "location_description", label: "Location" }, { key: "status", label: "Status", format: "status" }, { key: "occupied_ports", label: "Occupied" }, { key: "capacity", label: "Capacity" }, { key: "available_ports", label: "Available" }, { key: "duplicate_assignments", label: "Duplicates" }, { key: "over_capacity", label: "Over Capacity" }] },
  { key: "nightly-disconnection-runs", title: "Nightly Disconnection Runs", description: "Results of each automatic overdue-customer disconnection run.", icon: "schedule", dateFilters: false, adminOnly: true, columns: [{ key: "olt_automation_run_id", label: "Run" }, { key: "billing_date", label: "Billing Date", format: "date" }, { key: "status", label: "Status", format: "status" }, { key: "candidate_count", label: "Candidates" }, { key: "selected_count", label: "Selected" }, { key: "disconnected_count", label: "Disconnected" }, { key: "skipped_count", label: "Skipped" }, { key: "failed_count", label: "Failed" }, { key: "remaining_count", label: "Remaining" }, { key: "started_at", label: "Started", format: "datetime" }, { key: "completed_at", label: "Completed", format: "datetime" }, { key: "error_message", label: "Error" }] },
];

const technicianJobColumns: Column[] = [
  { key: "service_ticket_id", label: "Ticket" },
  { key: "job_type", label: "Job Type", format: "status" },
  { key: "customer_name", label: "Customer" },
  { key: "customer_address", label: "Address" },
  { key: "issue_summary", label: "Job" },
  { key: "outcome", label: "Period Outcome / Open Now", format: "status" },
  { key: "closed_at", label: "Closed", format: "datetime" },
  { key: "current_status", label: "Current Status", format: "status" },
  { key: "rescheduled_for", label: "Rescheduled For", format: "datetime" },
  { key: "outcome_notes", label: "Notes" },
];

function ReportsPage() {
  const navigate = useNavigate();
  const openCustomer = useOpenCustomerProfile();
  const { employee } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedReport = searchParams.get("report") as ReportKey | null;
  // Head Office keeps operational reports but cannot see administrator-only
  // reports or select them through a copied URL.
  const availableReports = useMemo(
    () => employee?.role === "admin" ? reports : reports.filter((item) => !item.adminOnly),
    [employee?.role]
  );
  const reportKey: ReportKey = availableReports.some((item) => item.key === requestedReport) ? requestedReport! : availableReports[0].key;
  const technicianId = reportKey === "technician-jobs" ? searchParams.get("employee_id") : null;
  const technicianName = searchParams.get("technician") || "Technician";
  const search = searchParams.get("search") ?? "";
  const from = searchParams.get("from") || jamaicaToday();
  const to = searchParams.get("to") || jamaicaToday();
  const page = Math.max(Number.parseInt(searchParams.get("page") ?? "1", 10) || 1, 1);
  // Empty sort means "use the report's own default order", which for the
  // delinquent list is the chase order: who gets cut off soonest.
  const sort = searchParams.get("sort") ?? "";
  const direction: SortDirection = searchParams.get("dir") === "asc" ? "asc" : "desc";
  const updateParams = useCallback((patch: Record<string, string | null>) => {
    setLoading(true);
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        for (const [key, value] of Object.entries(patch)) {
          if (!value) next.delete(key);
          else next.set(key, value);
        }
        return next;
      },
      { replace: true }
    );
  }, [setSearchParams]);
  const [rows, setRows] = useState<ReportRow[]>([]);
  const [totals, setTotals] = useState<Record<string, unknown> | null>(null);
  const [pagination, setPagination] = useState({ page: 1, limit: 25, total: 0, totalPages: 1 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const report = useMemo(() => availableReports.find((item) => item.key === reportKey) ?? availableReports[0], [availableReports, reportKey]);
  const columns = report.columns;
  useScrollRestoration(!loading);

  const loadReport = useCallback(async (signal: AbortSignal) => {
    try {
      setLoading(true); setError("");
      const query = new URLSearchParams({ search, page: String(page) });
      if (report.dateFilters) { query.set("from", from); query.set("to", to); }
      if (sort) { query.set("sort", sort); query.set("dir", direction); }
      const response = await apiFetch(`/api/reports/${reportKey}?${query}`, { signal });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || "Could not load report.");
      if (signal.aborted) return;
      setRows(data.rows); setTotals(data.totals || null); setPagination(data.pagination);
      if (data.pagination.page !== page) updateParams({ page: String(data.pagination.page) });
    } catch (loadError) { if (signal.aborted) return; setError(loadError instanceof Error ? loadError.message : "Could not load report."); }
    finally { if (!signal.aborted) setLoading(false); }
  }, [direction, from, page, report.dateFilters, reportKey, search, sort, to, updateParams]);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => loadReport(controller.signal), 180);
    return () => { window.clearTimeout(timeout); controller.abort(); };
  }, [loadReport]);

  const chooseReport = (key: ReportKey) => {
    setLoading(true);
    setSearchParams({ report: key }, { replace: true });
  };

  const sortableColumns = SORTABLE_COLUMNS[reportKey] ?? [];

  // First click on a column sorts it newest/largest first, which is what
  // someone reaching for a date or a money column almost always wants. Clicking
  // the same column again flips it; a third click returns to the report's
  // default order rather than trapping you in a sort you no longer want.
  const toggleSort = (key: string) => {
    if (!sortableColumns.includes(key)) return;
    if (sort !== key) { updateParams({ sort: key, dir: "desc", page: null }); return; }
    if (direction === "desc") { updateParams({ dir: "asc", page: null }); return; }
    updateParams({ sort: null, dir: null, page: null });
  };

  // Export the visible filtered page without adding a second data definition.
  const exportCsv = () => {
    const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
    const csv = [columns.map((column) => escape(column.label)).join(","), ...rows.map((row) => columns.map((column) => escape(row[column.key])).join(","))].join("\n");
    const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" })); link.download = `${reportKey}-${jamaicaToday()}.csv`; link.click(); URL.revokeObjectURL(link.href);
  };

  const openRow = (row: ReportRow) => {
    if (reportKey === "technician-jobs") {
      setSearchParams((current) => {
        const next = new URLSearchParams(current);
        next.set("employee_id", String(row.employee_id));
        next.set("technician", String(row.technician));
        return next;
      }, { replace: true });
    }
    if (reportKey === "pending-service") navigate(`/service-requests?search=${row.service_ticket_id}`);
    if (reportKey === "delinquent-customers" && row.customer_id) openCustomer(String(row.customer_id));
    if (reportKey === "disconnected-customers" && row.customer_id) openCustomer(String(row.customer_id));
    if (reportKey === "applications") navigate("/applications");
    if (reportKey === "pole-box-usage" && row.pole_box_id) navigate(`/pole-boxes?search=${encodeURIComponent(String(row.box_number))}`);
  };

  return <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-5 sm:px-6 sm:py-6 lg:px-8 lg:py-8">
    <div><h1 className="text-2xl font-semibold tracking-tight text-on-surface">Reports &amp; Analytics</h1><p className="mt-1 text-sm text-on-surface-variant">Detailed, filterable views of data already recorded by SPCL operations.</p></div>

    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{availableReports.map((item) => <button key={item.key} type="button" onClick={() => chooseReport(item.key)} className={`rounded-xl border p-4 text-left transition ${item.key === reportKey ? "border-primary bg-primary/5 shadow-sm" : "border-surface-container bg-surface-container-lowest hover:border-primary/30"}`}><div className="flex items-start gap-3"><span className={`material-symbols-outlined rounded-lg p-2 ${item.key === reportKey ? "bg-primary text-on-primary" : "bg-surface-container text-primary"}`}>{item.icon}</span><div><p className="font-medium text-on-surface">{item.title}</p><p className="mt-1 text-xs leading-5 text-on-surface-variant">{item.description}</p></div></div></button>)}</div>

    <div className="rounded-xl border border-warning/30 bg-warning-container p-4 text-sm text-warning"><span className="font-medium">Legacy balance note:</span> the most recent year is reconstructed from Access payments and anniversary charges. Older brought-forward amounts are clearly marked unverified on the customer account.</div>

    <section className="report-print-area overflow-hidden rounded-2xl bg-surface-container-lowest shadow-sm">
      <div className="flex flex-col gap-4 border-b border-surface-container p-5 xl:flex-row xl:items-end xl:justify-between"><div><h2 className="text-lg font-semibold text-on-surface">{report.title}</h2><p className="mt-1 text-sm text-on-surface-variant">{report.description}</p></div><div className="flex flex-wrap items-end gap-3"><label className="text-xs font-semibold uppercase tracking-wider text-on-surface-variant">Search<input value={search} onChange={(event) => updateParams({ search: event.target.value || null, page: null })} className="mt-1 block w-56 rounded-lg bg-surface-container-low px-3 py-2 text-sm font-normal normal-case tracking-normal" placeholder="Filter report..." /></label>{report.dateFilters && <><label className="text-xs font-semibold uppercase tracking-wider text-on-surface-variant">From<input type="date" value={from} onChange={(event) => updateParams({ from: event.target.value, page: null })} className="mt-1 block rounded-lg bg-surface-container-low px-3 py-2 text-sm font-normal" /></label><label className="text-xs font-semibold uppercase tracking-wider text-on-surface-variant">To<input type="date" value={to} onChange={(event) => updateParams({ to: event.target.value, page: null })} className="mt-1 block rounded-lg bg-surface-container-low px-3 py-2 text-sm font-normal" /></label></>}<button type="button" disabled={rows.length === 0} onClick={exportCsv} className="flex items-center gap-2 rounded-lg bg-surface-container px-3 py-2 text-xs font-medium disabled:opacity-40"><span className="material-symbols-outlined text-base">download</span>Export Page</button><button type="button" onClick={() => window.print()} className="flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-on-primary"><span className="material-symbols-outlined text-base">print</span>Print</button></div></div>
      {totals && <div className="flex flex-wrap gap-6 border-b border-surface-container bg-primary/5 px-5 py-3 text-sm">{"payment_count" in totals && <><span><strong>{Number(totals.payment_count || 0).toLocaleString()}</strong> transactions</span><span>Collected: <strong>{formatCurrency(totals.gross_amount)}</strong></span><span>Refunds: <strong>{formatCurrency(totals.refund_amount)}</strong></span><span>Net: <strong>{formatCurrency(totals.total_amount)}</strong></span></>}{"delinquent_count" in totals && <span><strong>{Number(totals.delinquent_count || 0).toLocaleString()}</strong> delinquent customers</span>}{"jobs_closed" in totals && <><span><strong>{Number(totals.jobs_closed || 0).toLocaleString()}</strong> jobs closed</span><span><strong>{Number(totals.completed_count || 0).toLocaleString()}</strong> completed</span><span><strong>{Number(totals.unresolved_count || 0).toLocaleString()}</strong> unresolved</span></>}</div>}
      {error && <p className="m-5 rounded-lg bg-error/10 p-4 text-sm text-error">{error}</p>}
      <div className="overflow-x-auto"><table className="w-full min-w-[44rem] text-left md:min-w-0"><thead className="bg-surface-container-low"><tr>{columns.map((column) => {
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
      })}</tr></thead><tbody className="divide-y divide-surface-container">{!loading && rows.map((row, index) => <tr key={`${reportKey}-${index}`} onClick={() => openRow(row)} className="transition hover:bg-surface-container-low/60">{columns.map((column) => <td key={column.key} className="max-w-sm px-5 py-4 text-sm text-on-surface-variant">{reportKey === "technician-jobs" && column.key === "technician" ? <button type="button" onClick={(event) => { event.stopPropagation(); openRow(row); }} aria-haspopup="dialog" className="inline-flex items-center gap-2 rounded-lg bg-primary/10 px-3 py-2 font-medium text-primary transition hover:bg-primary/20">{formatCell(row[column.key], column.format)}<span aria-hidden="true" className="material-symbols-outlined text-base">chevron_right</span></button> : formatCell(row[column.key], column.format)}</td>)}</tr>)}</tbody></table></div>
      {loading && <div className="px-5 py-14 text-center text-sm text-on-surface-variant">Generating report...</div>}{!loading && !error && rows.length === 0 && <div className="px-5 py-14 text-center text-sm text-on-surface-variant">No rows match these report filters.</div>}{!loading && rows.length > 0 && <div className="flex items-center justify-between border-t border-surface-container px-5 py-4 text-sm text-on-surface-variant"><span>{pagination.total.toLocaleString()} result{pagination.total === 1 ? "" : "s"}</span><div className="flex items-center gap-3"><button disabled={pagination.page <= 1} onClick={() => updateParams({ page: String(Math.max(page - 1, 1)) })} className="rounded-lg bg-surface-container px-3 py-2 text-xs font-medium disabled:opacity-40">Previous</button><span className="text-xs font-medium">Page {pagination.page} of {pagination.totalPages}</span><button disabled={pagination.page >= pagination.totalPages} onClick={() => updateParams({ page: String(Math.min(page + 1, pagination.totalPages)) })} className="rounded-lg bg-surface-container px-3 py-2 text-xs font-medium disabled:opacity-40">Next</button></div></div>}
    </section>
    {technicianId && <TechnicianJobsModal key={technicianId} technicianId={technicianId} name={technicianName} from={from} to={to} onClose={() => {
      setSearchParams((current) => {
        const next = new URLSearchParams(current);
        next.delete("employee_id"); next.delete("technician");
        return next;
      }, { replace: true });
    }} />}
  </div>;
}

function TechnicianJobsModal({ technicianId, name, from, to, onClose }: {
  technicianId: string; name: string; from: string; to: string; onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<ReportRow[]>([]);
  const [pagination, setPagination] = useState({ page: 1, total: 0, totalPages: 1 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    const dialog = dialogRef.current!;
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    dialog.showModal();
    document.body.style.overflow = "hidden";
    return () => {
      dialog.close();
      document.body.style.overflow = previousOverflow;
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(async () => {
      setLoading(true); setError("");
      try {
        const query = new URLSearchParams({ employee_id: technicianId, search, page: String(page), from, to });
        const response = await apiFetch(`/api/reports/technician-jobs?${query}`, { signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Could not load jobs.");
        if (controller.signal.aborted) return;
        setRows(data.rows); setPagination(data.pagination);
        if (data.pagination.page !== page) setPage(data.pagination.page);
      } catch (err) {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Could not load jobs.");
      } finally { if (!controller.signal.aborted) setLoading(false); }
    }, 180);
    return () => { window.clearTimeout(timeout); controller.abort(); };
  }, [technicianId, from, to, search, page]);
  const changePage = (next: number) => { setLoading(true); setPage(next); };
  const exportJobs = () => {
    const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
    const csv = [technicianJobColumns.map((column) => escape(column.label)).join(","), ...rows.map((row) => technicianJobColumns.map((column) => escape(row[column.key])).join(","))].join("\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    link.download = `technician-${technicianId}-jobs-${from}-${to}.csv`;
    link.click(); URL.revokeObjectURL(link.href);
  };
  return <dialog ref={dialogRef} aria-labelledby="technician-jobs-title" onCancel={(event) => { event.preventDefault(); onClose(); }}
    className="fixed inset-0 m-auto max-h-[90dvh] w-[calc(100%-2rem)] max-w-5xl overflow-hidden rounded-2xl border-0 bg-surface-container-lowest p-0 text-on-surface shadow-2xl backdrop:bg-black/50 backdrop:backdrop-blur-sm">
    <div className="flex max-h-[90dvh] flex-col">
      <header className="flex items-start justify-between gap-4 border-b border-surface-container p-5 sm:p-6">
        <div><p className="text-xs font-semibold uppercase tracking-wider text-primary">Technician jobs</p><h2 id="technician-jobs-title" className="mt-1 text-xl font-semibold">{name}</h2><p className="mt-2 text-sm text-on-surface-variant">{formatCell(from, "date")} – {formatCell(to, "date")} · Includes open jobs now</p></div>
        <button type="button" autoFocus onClick={onClose} aria-label="Close technician jobs" className="rounded-full bg-surface-container p-2 hover:bg-primary/10"><span aria-hidden="true" className="material-symbols-outlined block">close</span></button>
      </header>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-surface-container px-5 py-4 sm:px-6">
        <label className="flex items-center gap-2 rounded-xl bg-surface-container-low px-3 py-2"><span aria-hidden="true" className="material-symbols-outlined text-on-surface-variant">search</span><input aria-label="Search technician jobs" value={search} onChange={(event) => { setLoading(true); setSearch(event.target.value); setPage(1); }} placeholder="Search jobs, customers, status…" className="w-64 max-w-full bg-transparent text-sm outline-none" /></label>
        <button type="button" onClick={exportJobs} disabled={loading || !!error || !rows.length} className="rounded-lg bg-surface-container px-3 py-2 text-xs font-medium disabled:opacity-40">Export page</button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-5 sm:p-6" aria-busy={loading}>
        <p className="mb-4 text-xs leading-5 text-on-surface-variant">Closed jobs use the selected dates; open jobs show the current queue. Reopened jobs may appear more than once. Current status includes any later changes.</p>
        {loading ? <p role="status" className="py-12 text-center text-sm">Loading jobs…</p> : error ? <p role="alert" className="rounded-xl bg-error/10 p-4 text-sm text-error">{error}</p> : !rows.length ? <p className="py-12 text-center text-sm text-on-surface-variant">No jobs match these filters.</p> : <div className="space-y-3">{rows.map((row, index) => <article key={`${row.service_ticket_id}-${row.event_id ?? index}`} className="rounded-xl border border-surface-container p-4">
          <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-medium text-on-surface-variant">#{String(row.service_ticket_id)} · {humanize(String(row.job_type))}</p><h3 className="mt-1 font-semibold">{String(row.customer_name || "Customer")}</h3><p className="mt-1 text-sm text-on-surface-variant">{String(row.customer_address || "Address unavailable")}</p></div><JobStatus value={row.current_status} /></div>
          <p className="mt-3 text-sm">{String(row.issue_summary || "—")}</p>
          <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-on-surface-variant"><span>Outcome: <JobStatus value={row.outcome} /></span>{!!row.closed_at && <span>Closed {formatCell(row.closed_at, "datetime")}</span>}{!!row.rescheduled_for && <span>Return visit: {formatCell(row.rescheduled_for, "datetime")}</span>}</div>
          {!!row.outcome_notes && <p className="mt-3 whitespace-pre-wrap rounded-lg bg-surface-container-low p-3 text-sm text-on-surface-variant">{String(row.outcome_notes)}</p>}
          <button type="button" onClick={() => navigate(`/service-requests?search=${encodeURIComponent(String(row.service_ticket_id))}`)} className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-primary">Open service record<span aria-hidden="true" className="material-symbols-outlined text-sm">arrow_forward</span></button>
        </article>)}</div>}
      </div>
      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-surface-container px-5 py-4 text-xs text-on-surface-variant sm:px-6"><span>{loading ? "Loading…" : error ? "Jobs unavailable" : `${pagination.total.toLocaleString()} entries`}</span><div className="flex items-center gap-3"><button type="button" disabled={loading || !!error || pagination.page <= 1} onClick={() => changePage(page - 1)} className="rounded-lg bg-surface-container px-3 py-2 disabled:opacity-40">Previous</button><span>Page {pagination.page} of {pagination.totalPages}</span><button type="button" disabled={loading || !!error || pagination.page >= pagination.totalPages} onClick={() => changePage(page + 1)} className="rounded-lg bg-surface-container px-3 py-2 disabled:opacity-40">Next</button></div></footer>
    </div>
  </dialog>;
}

function JobStatus({ value }: { value: unknown }) {
  const status = String(value || "unknown");
  const color = status === "completed" ? "bg-emerald-100 text-emerald-800" : status === "unresolved" ? "bg-red-100 text-red-800" : status === "rescheduled" ? "bg-amber-100 text-amber-800" : status === "cancelled" ? "bg-surface-container text-on-surface-variant" : "bg-primary/10 text-primary";
  return <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${color}`}>{humanize(status)}</span>;
}

function formatCell(value: unknown, format?: Column["format"]) {
  if (value === null || value === undefined || value === "") return "—";
  if (format === "currency") return formatCurrency(value);
  if (format === "percent") return `${Number(value)}%`;
  if (format === "date") return new Date(`${String(value).slice(0,10)}T00:00:00`).toLocaleDateString("en-JM", { day: "numeric", month: "short", year: "numeric" });
  if (format === "datetime") return new Date(String(value)).toLocaleString("en-JM", { timeZone: "America/Jamaica", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
  if (format === "status") return <span className="inline-flex rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">{humanize(String(value))}</span>;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}
function formatCurrency(value: unknown) { return `J$${Number(value || 0).toLocaleString("en-JM", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
function humanize(value: string) { return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function jamaicaToday() { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Jamaica", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }

export default ReportsPage;
