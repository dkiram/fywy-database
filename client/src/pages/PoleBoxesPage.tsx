/** Tracks pole-box capacity, assignments, service tickets, and manager-only edits. */
import { useCallback, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useAuth } from "../auth/AuthContext";
import { apiFetch } from "../lib/api";
import { useOpenCustomerProfile } from "../hooks/useOpenCustomerProfile";
import { useScrollRestoration } from "../hooks/useScrollRestoration";

// Pole-box inventory wraps normalized metadata around the original customer
// pole/port fields, so legacy assignments remain visible and auditable.
type PoleBox = {
  pole_box_id: number; box_number: string; location_description: string | null;
  capacity: number | null; status: "active" | "maintenance" | "retired";
  notes: string | null; connected_customers: number; active_connections: number;
  occupied_ports: number; duplicate_assignments: number; available_ports: number | null;
  over_capacity: boolean;
};

type BoxCustomer = { customer_id: number; name: string | null; address: string | null; telephone: string | null; status: string; port_number: string | null };
type BoxTicket = { service_ticket_id: number; customer_id: number; issue_summary: string; status: string; priority: string; reported_date: string };
type BoxView = "all" | "attention" | "available" | "full" | "maintenance" | "retired";

const blankForm = { boxNumber: "", locationDescription: "", capacity: "", status: "active", notes: "", reason: "" };

function PoleBoxesPage() {
  const navigate = useNavigate();
  const openCustomer = useOpenCustomerProfile();
  const [searchParams, setSearchParams] = useSearchParams();
  const { employee } = useAuth();
  const canManage = employee?.role === "admin" || employee?.role === "head_office";
  const [boxes, setBoxes] = useState<PoleBox[]>([]);
  const [summary, setSummary] = useState({ total_boxes: 0, active_connections: 0, boxes_with_duplicates: 0, over_capacity: 0, maintenance: 0 });
  const [pagination, setPagination] = useState({ page: 1, limit: 12, total: 0, totalPages: 1 });
  const view = (searchParams.get("view") as BoxView) || "all";
  const search = searchParams.get("search") ?? "";
  const page = Math.max(Number.parseInt(searchParams.get("page") ?? "1", 10) || 1, 1);
  const updateListParams = useCallback((
    patch: Partial<Record<"view" | "search" | "page", string | null>>
  ) => {
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
  const setView = (value: BoxView) => updateListParams({ view: value, page: null });
  const setSearch = (value: string) => updateListParams({ search: value || null, page: null });
  const setPage = useCallback((value: React.SetStateAction<number>) => {
    const next = typeof value === "function" ? value(page) : value;
    updateListParams({ page: next > 1 ? String(next) : null });
  }, [page, updateListParams]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<PoleBox | null>(null);
  const [boxCustomers, setBoxCustomers] = useState<BoxCustomer[]>([]);
  const [boxTickets, setBoxTickets] = useState<BoxTicket[]>([]);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [editing, setEditing] = useState<"new" | "edit" | null>(null);
  const [form, setForm] = useState(blankForm);
  const [saving, setSaving] = useState(false);
  const [modalError, setModalError] = useState("");
  useScrollRestoration(!loading);

  const loadBoxes = useCallback(async () => {
    try {
      setLoading(true); setError("");
      const response = await apiFetch(`/api/pole-boxes?view=${view}&search=${encodeURIComponent(search)}&page=${page}`);
      const data = await response.json(); if (!response.ok) throw new Error(data.error || "Could not load pole boxes.");
      setBoxes(data.poleBoxes); setSummary(data.summary); setPagination(data.pagination);
      if (data.pagination.page !== page) setPage(data.pagination.page);
    } catch (loadError) { setError(loadError instanceof Error ? loadError.message : "Could not load pole boxes."); }
    finally { setLoading(false); }
  }, [page, search, setPage, view]);

  useEffect(() => { const timeout = window.setTimeout(loadBoxes, 180); return () => window.clearTimeout(timeout); }, [loadBoxes]);

  const openDetails = async (box: PoleBox) => {
    setSelected(box); setDetailsLoading(true); setBoxCustomers([]); setBoxTickets([]);
    try {
      const response = await apiFetch(`/api/pole-boxes/${box.pole_box_id}`); const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load pole-box details.");
      setSelected(data.poleBox); setBoxCustomers(data.customers); setBoxTickets(data.tickets);
    } catch (loadError) { setError(loadError instanceof Error ? loadError.message : "Could not load pole-box details."); }
    finally { setDetailsLoading(false); }
  };

  const openNew = () => { setSelected(null); setForm(blankForm); setModalError(""); setEditing("new"); };
  const openEdit = (box: PoleBox) => { setForm({ boxNumber: box.box_number, locationDescription: box.location_description || "", capacity: box.capacity ? String(box.capacity) : "", status: box.status, notes: box.notes || "", reason: "" }); setModalError(""); setEditing("edit"); };

  const saveBox = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      setSaving(true); setModalError("");
      const isNew = editing === "new";
      const response = await apiFetch(isNew ? "/api/pole-boxes" : `/api/pole-boxes/${selected?.pole_box_id}`, { method: isNew ? "POST" : "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || "Could not save pole box.");
      setEditing(null); setNotice(`Pole box ${data.poleBox.box_number} was ${isNew ? "created" : "updated"}.`); await loadBoxes();
      if (!isNew) await openDetails({ ...selected!, ...data.poleBox });
    } catch (saveError) { setModalError(saveError instanceof Error ? saveError.message : "Could not save pole box."); }
    finally { setSaving(false); }
  };

  return <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 py-6 lg:px-8 lg:py-8">
    <div className="flex flex-wrap items-end justify-between gap-4"><div><h1 className="text-2xl font-semibold tracking-tight text-on-surface">Pole Boxes</h1><p className="mt-1 text-sm text-on-surface-variant">Review port usage, connected customers, and infrastructure conflicts.</p></div>{canManage && <button type="button" onClick={openNew} className="flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-on-primary"><span className="material-symbols-outlined text-lg">add</span>Add Pole Box</button>}</div>
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4"><Summary label="Pole Boxes" value={summary.total_boxes} icon="dns" tone="primary" /><Summary label="Active Connections" value={summary.active_connections} icon="cable" tone="positive" /><Summary label="Duplicate Assignments" value={summary.boxes_with_duplicates} icon="warning" tone="warning" /><Summary label="Over Capacity" value={summary.over_capacity} icon="error" tone="negative" /></div>
    {notice && <p className="rounded-lg bg-tertiary/10 p-4 text-sm font-semibold text-tertiary">{notice}</p>}{error && <p className="rounded-lg bg-error/10 p-4 text-sm text-error">{error}</p>}

    <section className="overflow-hidden rounded-2xl bg-surface-container-lowest shadow-sm">
      <div className="flex flex-col gap-3 border-b border-surface-container px-5 py-4 lg:flex-row lg:items-center lg:justify-between"><div className="flex flex-wrap gap-2">{([['all','All'],['attention','Needs Attention'],['available','Available'],['full','Full'],['maintenance','Maintenance']] as Array<[BoxView,string]>).map(([value,label]) => <button key={value} type="button" onClick={() => setView(value)} className={view === value ? activeChip : idleChip}>{label}</button>)}</div><div className="relative w-full lg:w-80"><span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-outline">search</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search box or location..." className="w-full rounded-lg bg-surface-container-low py-2.5 pl-10 pr-4 text-sm" /></div></div>
      <div className="grid gap-4 p-5 sm:grid-cols-2 xl:grid-cols-3">{!loading && boxes.map((box) => <button key={box.pole_box_id} type="button" onClick={() => openDetails(box)} className="rounded-xl border border-surface-container p-5 text-left transition hover:border-primary/30 hover:bg-surface-container-low/40"><div className="flex items-start justify-between gap-4"><div><p className="text-lg font-medium text-on-surface">{box.box_number}</p><p className="mt-1 line-clamp-1 text-xs text-on-surface-variant">{box.location_description || "Location not recorded"}</p></div><BoxStatus status={box.status} /></div><div className="mt-5 grid grid-cols-3 gap-3 text-center"><Metric label="Ports Used" value={box.occupied_ports} /><Metric label="Capacity" value={box.capacity ?? "?"} /><Metric label="Available" value={box.available_ports ?? "?"} /></div>{(box.duplicate_assignments > 0 || box.over_capacity) && <div className="mt-4 flex items-center gap-2 rounded-lg bg-error/10 px-3 py-2 text-xs font-medium text-error"><span className="material-symbols-outlined text-base">warning</span>{box.duplicate_assignments > 0 ? `${box.duplicate_assignments} duplicate assignment${box.duplicate_assignments === 1 ? "" : "s"}` : "Usage exceeds capacity"}</div>}</button>)}</div>
      {loading && <Empty text="Loading pole boxes..." />}{!loading && !error && boxes.length === 0 && <Empty text="No pole boxes found." />}{!loading && boxes.length > 0 && <Pagination pagination={pagination} setPage={setPage} />}
    </section>

    {selected && !editing && <div className="fixed inset-0 z-[65] bg-black/35" onClick={() => setSelected(null)} role="presentation"><aside className="absolute inset-y-0 right-0 w-full max-w-2xl overflow-y-auto bg-surface-container-lowest p-6 shadow-2xl" onClick={(event) => event.stopPropagation()}><div className="flex items-start justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-wider text-primary">Pole Box</p><h2 className="mt-1 text-2xl font-semibold text-on-surface">{selected.box_number}</h2><p className="mt-1 text-sm text-on-surface-variant">{selected.location_description || "Location not recorded"}</p></div><button type="button" onClick={() => setSelected(null)} className="rounded-full p-2 hover:bg-surface-container"><span className="material-symbols-outlined">close</span></button></div><div className="mt-5 grid grid-cols-3 gap-3"><MetricCard label="Occupied" value={selected.occupied_ports} /><MetricCard label="Capacity" value={selected.capacity ?? "Unknown"} /><MetricCard label="Available" value={selected.available_ports ?? "Unknown"} /></div>{canManage && <button type="button" onClick={() => openEdit(selected)} className="mt-5 w-full rounded-lg bg-primary/10 py-2.5 text-sm font-medium text-primary">Edit Pole Box Metadata</button>}{detailsLoading ? <Empty text="Loading assignments..." /> : <><SectionTitle>Connected Customers</SectionTitle><div className="overflow-hidden rounded-xl border border-surface-container">{boxCustomers.length === 0 ? <Empty text="No customer assignments." /> : boxCustomers.map((customer) => <button key={customer.customer_id} type="button" onClick={() => openCustomer(customer.customer_id)} className="flex w-full items-center justify-between border-b border-surface-container px-4 py-3 text-left last:border-0 hover:bg-surface-container-low"><div><p className="font-semibold text-on-surface">{customer.name || "Unnamed customer"}</p><p className="text-xs text-on-surface-variant">Customer #{customer.customer_id} · {humanize(customer.status)}</p></div><span className="font-mono text-sm font-medium text-primary">Port {customer.port_number || "—"}</span></button>)}</div><SectionTitle>Recent Service Tickets</SectionTitle><div className="overflow-hidden rounded-xl border border-surface-container">{boxTickets.length === 0 ? <Empty text="No service tickets for this box." /> : boxTickets.map((ticket) => <button key={ticket.service_ticket_id} type="button" onClick={() => navigate(`/service-requests?search=${ticket.service_ticket_id}`)} className="flex w-full items-center justify-between border-b border-surface-container px-4 py-3 text-left last:border-0 hover:bg-surface-container-low"><div><p className="font-semibold text-on-surface">#{ticket.service_ticket_id} · {ticket.issue_summary}</p><p className="text-xs text-on-surface-variant">{formatDate(ticket.reported_date)}</p></div><span className="text-xs font-medium text-primary">{humanize(ticket.status)}</span></button>)}</div></>}</aside></div>}

    {editing && <Modal title={editing === "new" ? "Add pole box" : `Edit ${form.boxNumber}`} onClose={() => !saving && setEditing(null)}><form onSubmit={saveBox} className="space-y-4"><Field label="Box number" required><input required disabled={editing === "edit"} value={form.boxNumber} onChange={(event) => setForm({ ...form, boxNumber: event.target.value })} className={inputClass} /></Field><div className="grid gap-4 sm:grid-cols-2"><Field label="Capacity"><input type="number" min="1" max="512" value={form.capacity} onChange={(event) => setForm({ ...form, capacity: event.target.value })} className={inputClass} placeholder="Unknown" /></Field>{editing === "edit" && <Field label="Status" required><select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })} className={inputClass}><option value="active">Active</option><option value="maintenance">Maintenance</option><option value="retired">Retired</option></select></Field>}</div><Field label="Location description"><input value={form.locationDescription} onChange={(event) => setForm({ ...form, locationDescription: event.target.value })} className={inputClass} placeholder="Street, district, or landmark..." /></Field><Field label="Notes"><textarea rows={3} value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} className={inputClass} /></Field>{editing === "edit" && <Field label="Reason for change" required><textarea required minLength={3} maxLength={500} rows={3} value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} className={inputClass} /></Field>}{modalError && <p className="rounded-lg bg-error/10 p-3 text-sm text-error">{modalError}</p>}<div className="flex justify-end gap-3 border-t border-surface-container pt-5"><button type="button" onClick={() => setEditing(null)} className="rounded-lg bg-surface-container px-5 py-2.5 text-sm font-medium">Cancel</button><button type="submit" disabled={saving} className="rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-on-primary disabled:opacity-50">{saving ? "Saving..." : "Save Pole Box"}</button></div></form></Modal>}
  </div>;
}

const inputClass = "mt-1.5 w-full rounded-lg border border-outline-variant bg-white px-3 py-2.5 text-sm focus:border-primary disabled:bg-surface-container";
const activeChip = "rounded-full bg-primary px-4 py-2 text-xs font-medium text-on-primary";
const idleChip = "rounded-full bg-surface-container px-4 py-2 text-xs font-medium text-on-surface-variant disabled:opacity-40";
function Summary({ label, value, icon, tone }: { label: string; value: number; icon: string; tone: "primary" | "positive" | "warning" | "negative" }) { const tones = { primary: "bg-primary/10 text-primary", positive: "bg-tertiary/10 text-tertiary", warning: "bg-warning-container text-warning", negative: "bg-error/10 text-error" }; return <div className="rounded-xl bg-surface-container-lowest p-5 shadow-sm"><div className="flex items-center justify-between"><div><p className="text-xs font-semibold uppercase tracking-wider text-on-surface-variant">{label}</p><p className="mt-2 text-3xl font-medium">{Number(value).toLocaleString()}</p></div><span className={`material-symbols-outlined rounded-lg p-3 ${tones[tone]}`}>{icon}</span></div></div>; }
function Metric({ label, value }: { label: string; value: number | string }) { return <div><p className="text-lg font-medium text-on-surface">{value}</p><p className="text-[10px] font-semibold uppercase tracking-wider text-on-surface-variant">{label}</p></div>; }
function MetricCard({ label, value }: { label: string; value: number | string }) { return <div className="rounded-xl bg-surface-container-low p-4 text-center"><p className="text-xl font-medium">{value}</p><p className="mt-1 text-xs text-on-surface-variant">{label}</p></div>; }
function BoxStatus({ status }: { status: PoleBox["status"] }) { const style = status === "active" ? "bg-tertiary/10 text-tertiary" : status === "maintenance" ? "bg-warning-container text-warning" : "bg-surface-container-high text-on-surface-variant"; return <span className={`rounded-full px-3 py-1 text-xs font-medium ${style}`}>{humanize(status)}</span>; }
function SectionTitle({ children }: { children: React.ReactNode }) { return <h3 className="mb-3 mt-7 text-sm font-semibold uppercase tracking-wider text-on-surface-variant">{children}</h3>; }
function Field({ label, required = false, children }: { label: string; required?: boolean; children: React.ReactNode }) { return <label className="block text-sm font-semibold">{label}{required && <span className="text-error"> *</span>}{children}</label>; }
function Empty({ text }: { text: string }) { return <div className="px-5 py-10 text-center text-sm text-on-surface-variant">{text}</div>; }
function Pagination({ pagination, setPage }: { pagination: { page: number; totalPages: number; total: number; limit: number }; setPage: React.Dispatch<React.SetStateAction<number>> }) { return <div className="flex items-center justify-between border-t border-surface-container px-6 py-4 text-sm text-on-surface-variant"><span>{pagination.total} pole boxes</span><div className="flex items-center gap-3"><button disabled={pagination.page <= 1} onClick={() => setPage((value) => value - 1)} className={idleChip}>Previous</button><span className="text-xs font-medium">{pagination.page} / {pagination.totalPages}</span><button disabled={pagination.page >= pagination.totalPages} onClick={() => setPage((value) => value + 1)} className={idleChip}>Next</button></div></div>; }
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) { return <div className="fixed inset-0 z-[75] flex items-center justify-center bg-black/45 p-4" role="dialog" aria-modal="true"><div className="max-h-[92vh] w-full max-w-xl overflow-y-auto rounded-2xl bg-surface-container-lowest shadow-2xl"><div className="flex items-center justify-between border-b border-surface-container px-6 py-4"><h2 className="text-xl font-semibold">{title}</h2><button type="button" onClick={onClose}><span className="material-symbols-outlined">close</span></button></div><div className="p-6">{children}</div></div></div>; }
function humanize(value: string) { return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function formatDate(value: string) { return new Date(`${value.slice(0,10)}T00:00:00`).toLocaleDateString("en-JM", { day: "numeric", month: "short", year: "numeric" }); }

export default PoleBoxesPage;
