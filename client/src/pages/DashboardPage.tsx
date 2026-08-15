/** Summarizes current operations and links each dashboard signal to its working queue. */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useAuth } from "../auth/AuthContext";
import { apiFetch } from "../lib/api";

// The management dashboard answers "what needs attention now?". Detailed rows
// live in their operational pages and reports, reached by clicking each card.
type DashboardData = {
  summary: {
    payments_today: number; payment_total_today: string; pending_applications: number;
    pending_service_tickets: number; active_customers: number; disconnected_customers: number;
    pending_reconnections: number; pole_boxes: number; pole_box_alerts: number;
    delinquent_customers: number | null; delinquency_available: boolean;
  };
  paymentTrend: Array<{ payment_date: string; payment_count: number; total_amount: string }>;
  urgentTickets: Array<{ service_ticket_id: number; customer_id: number; customer_name: string | null; issue_summary: string; priority: string; status: string; reported_date: string }>;
  recentActivity: Array<{ actor_name: string; action: string; entity_type: string; entity_id: string; occurred_at: string }>;
};

function DashboardPage() {
  const navigate = useNavigate();
  const { employee } = useAuth();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    apiFetch("/api/dashboard").then(async (response) => {
      const body = await response.json(); if (!response.ok) throw new Error(body.error || "Could not load dashboard."); setData(body);
    }).catch((loadError) => setError(loadError instanceof Error ? loadError.message : "Could not load dashboard.")).finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="p-8 text-sm text-on-surface-variant">Loading management dashboard...</div>;
  if (error || !data) return <div className="m-8 rounded-lg bg-error/10 p-4 text-sm text-error">{error || "Dashboard unavailable."}</div>;

  const maxTrend = Math.max(...data.paymentTrend.map((item) => Number(item.total_amount)), 1);
  const today = jamaicaToday();

  return <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 py-6 lg:px-8 lg:py-8">
    <div><h1 className="text-2xl font-bold tracking-tight text-on-surface">Management Dashboard</h1><p className="mt-1 text-sm text-on-surface-variant">Welcome back, {employee?.firstName}. Here is SPCL&apos;s operational snapshot for {formatDate(today)}.</p></div>

    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <DashboardCard label="Payments Today" value={data.summary.payments_today} detail={formatCurrency(data.summary.payment_total_today)} icon="payments" tone="primary" onClick={() => navigate(`/reports?report=payments-by-location&from=${today}&to=${today}`)} />
      <DashboardCard label="Pending Applications" value={data.summary.pending_applications} detail="Awaiting a decision" icon="description" tone="warning" onClick={() => navigate("/applications")} />
      <DashboardCard label="Pending Service" value={data.summary.pending_service_tickets} detail="Open, assigned, or in progress" icon="construction" tone="warning" onClick={() => navigate("/service-requests")} />
      <DashboardCard label="Disconnected" value={data.summary.disconnected_customers} detail={`${data.summary.pending_reconnections} pending reconnection`} icon="link_off" tone="negative" onClick={() => navigate("/account-operations")} />
      <DashboardCard label="Active Customers" value={data.summary.active_customers} detail="Current active accounts" icon="group" tone="positive" onClick={() => navigate("/account-operations?view=active")} />
      <DashboardCard label="Pole Boxes" value={data.summary.pole_boxes} detail={`${data.summary.pole_box_alerts} need attention`} icon="dns" tone={data.summary.pole_box_alerts > 0 ? "negative" : "primary"} onClick={() => navigate("/pole-boxes")} />
      <DashboardCard label="Pending Reconnection" value={data.summary.pending_reconnections} detail="Waiting for management approval" icon="sync" tone="warning" onClick={() => navigate("/account-operations?view=pending_reconnection")} />
      <button type="button" onClick={() => navigate("/reports")} className="rounded-xl border border-amber-200 bg-amber-50 p-5 text-left shadow-sm"><div className="flex items-start justify-between"><div><p className="text-xs font-bold uppercase tracking-wider text-amber-800">Delinquent Customers</p><p className="mt-2 text-xl font-bold text-amber-950">Billing rule needed</p><p className="mt-2 text-xs leading-5 text-amber-800">No count is shown until SPCL confirms the balance formula.</p></div><span className="material-symbols-outlined text-amber-700">rule</span></div></button>
    </div>

    <div className="grid gap-6 xl:grid-cols-12">
      <section className="rounded-2xl bg-surface-container-lowest p-6 shadow-sm xl:col-span-7"><div className="flex items-center justify-between"><div><h2 className="text-lg font-bold">Payments — Last 7 Days</h2><p className="mt-1 text-sm text-on-surface-variant">Daily collected amounts</p></div><button type="button" onClick={() => navigate("/reports?report=payments-by-date")} className="text-sm font-bold text-primary">Open report</button></div><div className="mt-8 flex h-56 items-end gap-3">{data.paymentTrend.map((item) => { const height = Math.max((Number(item.total_amount) / maxTrend) * 100, Number(item.total_amount) > 0 ? 4 : 1); return <div key={item.payment_date} className="flex h-full flex-1 flex-col justify-end text-center"><p className="mb-2 hidden text-[10px] font-bold text-on-surface-variant sm:block">{formatCompactCurrency(item.total_amount)}</p><div title={`${formatDate(item.payment_date)}: ${formatCurrency(item.total_amount)}`} className="mx-auto w-full max-w-14 rounded-t-lg bg-primary/80 transition hover:bg-primary" style={{ height: `${height}%` }} /><p className="mt-2 text-[10px] font-bold uppercase text-on-surface-variant">{weekday(item.payment_date)}</p></div>; })}</div></section>

      <section className="overflow-hidden rounded-2xl bg-surface-container-lowest shadow-sm xl:col-span-5"><div className="flex items-center justify-between border-b border-surface-container px-6 py-5"><div><h2 className="text-lg font-bold">Priority Service Work</h2><p className="mt-1 text-sm text-on-surface-variant">Oldest urgent work first</p></div><button type="button" onClick={() => navigate("/service-requests")} className="text-sm font-bold text-primary">View all</button></div>{data.urgentTickets.length === 0 ? <Empty text="No pending service tickets." /> : data.urgentTickets.map((ticket) => <button key={ticket.service_ticket_id} type="button" onClick={() => navigate(`/service-requests?search=${ticket.service_ticket_id}`)} className="flex w-full items-start gap-3 border-b border-surface-container px-6 py-4 text-left last:border-0 hover:bg-surface-container-low"><span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${ticket.priority === "urgent" ? "bg-error" : ticket.priority === "high" ? "bg-amber-500" : "bg-primary"}`} /><div className="min-w-0 flex-1"><p className="truncate font-semibold">#{ticket.service_ticket_id} · {ticket.customer_name || `Customer ${ticket.customer_id}`}</p><p className="mt-1 line-clamp-1 text-sm text-on-surface-variant">{ticket.issue_summary}</p></div><span className="text-xs font-bold text-primary">{humanize(ticket.status)}</span></button>)}</section>
    </div>

    <section className="overflow-hidden rounded-2xl bg-surface-container-lowest shadow-sm"><div className="flex items-center justify-between border-b border-surface-container px-6 py-5"><div><h2 className="text-lg font-bold">Recent Activity</h2><p className="mt-1 text-sm text-on-surface-variant">Latest audited employee actions</p></div><button type="button" onClick={() => navigate("/activity-history")} className="text-sm font-bold text-primary">Activity History</button></div><div className="divide-y divide-surface-container">{data.recentActivity.map((item, index) => <div key={`${item.entity_type}-${item.entity_id}-${index}`} className="flex flex-wrap items-center justify-between gap-3 px-6 py-4"><div><p className="font-semibold text-on-surface">{item.action}</p><p className="mt-1 text-xs text-on-surface-variant">{item.actor_name} · {humanize(item.entity_type)} #{item.entity_id}</p></div><time className="text-xs text-on-surface-variant">{formatDateTime(item.occurred_at)}</time></div>)}</div></section>
  </div>;
}

function DashboardCard({ label, value, detail, icon, tone, onClick }: { label: string; value: number; detail: string; icon: string; tone: "primary" | "positive" | "warning" | "negative"; onClick: () => void }) { const tones = { primary: "bg-primary/10 text-primary", positive: "bg-tertiary/10 text-tertiary", warning: "bg-amber-100 text-amber-800", negative: "bg-error/10 text-error" }; return <button type="button" onClick={onClick} className="rounded-xl bg-surface-container-lowest p-5 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"><div className="flex items-start justify-between"><div><p className="text-xs font-bold uppercase tracking-wider text-on-surface-variant">{label}</p><p className="mt-2 text-3xl font-bold text-on-surface">{Number(value).toLocaleString()}</p><p className="mt-2 text-xs text-on-surface-variant">{detail}</p></div><span className={`material-symbols-outlined rounded-lg p-3 ${tones[tone]}`}>{icon}</span></div></button>; }
function Empty({ text }: { text: string }) { return <div className="px-6 py-12 text-center text-sm text-on-surface-variant">{text}</div>; }
function formatCurrency(value: unknown) { return `J$${Number(value || 0).toLocaleString("en-JM", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
function formatCompactCurrency(value: unknown) { return new Intl.NumberFormat("en", { notation: "compact", style: "currency", currency: "JMD", maximumFractionDigits: 1 }).format(Number(value || 0)); }
function formatDate(value: string) { return new Date(`${value.slice(0,10)}T00:00:00`).toLocaleDateString("en-JM", { day: "numeric", month: "short", year: "numeric" }); }
function formatDateTime(value: string) { return new Date(value).toLocaleString("en-JM", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }); }
function weekday(value: string) { return new Date(`${value.slice(0,10)}T00:00:00`).toLocaleDateString("en-JM", { weekday: "short" }); }
function humanize(value: string) { return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function jamaicaToday() { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Jamaica", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }

export default DashboardPage;
