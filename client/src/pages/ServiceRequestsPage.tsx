/** Runs the service-ticket queue from customer report through technician completion. */
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { apiFetch } from "../lib/api";
import { useOpenCustomerProfile } from "../hooks/useOpenCustomerProfile";
import { useScrollRestoration } from "../hooks/useScrollRestoration";

// Service tickets are editable work records: customer service reports an issue,
// an employee is assigned, and the technician records the completed work.
type TicketStatus = "open" | "assigned" | "in_progress" | "completed" | "unresolved" | "cancelled";
type TicketPriority = "low" | "normal" | "high" | "urgent";
/** The Status dropdown's choices: every real status, plus Rescheduled. */
type EditStatus = TicketStatus | "rescheduled";
type TicketView = "rescheduled" | "open" | "assigned" | "in_progress" | "completed" | "unresolved" | "cancelled" | "all";

type ServiceTicket = {
  service_ticket_id: number; customer_id: number | null; legacy_customer_id: number | null;
  customer_name: string | null;
  telephone: string | null; address: string | null; issue_summary: string;
  description: string | null; priority: TicketPriority; status: TicketStatus;
  reported_date: string; assigned_employee_id: number | null;
  assigned_employee_name: string | null; assigned_employee_role: string | null;
  // Optional because the queue query does not return them - they arrive only
  // once a ticket is opened and the detail response is merged in. Treating
  // them as always-present is what produced the false "legacy import" label.
  created_by_name?: string | null; completed_by_name?: string | null;
  pole_box_number: string | null;
  port_number: string | null; service_date: string | null; resolution_notes: string | null;
  // When the technician agreed to come back (migration 080). A time, not a
  // status: the ticket stays 'assigned' and stays on their phone.
  rescheduled_for: string | null;
};

type CustomerOption = {
  customer_id: number; name: string | null; address: string | null;
  telephone: string | null; status: string; pole_box_number?: string | null;
  port_number?: string | null;
};

type Assignee = {
  employee_id: number; first_name: string; last_name: string; role: string;
  // Migration 076: a technician holds at most job_limit jobs, and once they
  // reach it nothing new is added until the queue is empty again. The list
  // carries each technician's load so the dropdown can say so up front
  // instead of the server refusing after the fact.
  open_jobs: number; job_limit: number; can_take_work: boolean;
};
type TicketHistory = { service_ticket_history_id: string; event_type: string; from_status: string | null; to_status: string | null; note: string; changed_at: string; changed_by_first_name: string | null; changed_by_last_name: string | null };

const emptyForm = () => ({
  customerId: "", issueSummary: "", description: "", priority: "normal" as TicketPriority,
  reportedDate: jamaicaToday(), assignedEmployeeId: "", poleBoxNumber: "", portNumber: "",
});

function ServiceRequestsPage() {
  const openCustomer = useOpenCustomerProfile();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tickets, setTickets] = useState<ServiceTicket[]>([]);
  const [summary, setSummary] = useState({ rescheduled: 0, open: 0, assigned: 0, in_progress: 0, completed: 0, unresolved: 0 });
  const [pagination, setPagination] = useState({ page: 1, limit: 10, total: 0, totalPages: 1 });
  const view = (searchParams.get("view") as TicketView) || "open";
  const search = searchParams.get("search") ?? "";
  // One day, read through whichever view is selected: the chip picks the
  // status, the date asks when a ticket moved into it. In the URL alongside
  // the view and the search, so a filtered queue survives opening a ticket and
  // coming back, and can be pasted to somebody else.
  const onDate = searchParams.get("onDate") ?? "";
  const page = Math.max(Number.parseInt(searchParams.get("page") ?? "1", 10) || 1, 1);
  const updateListParams = useCallback((
    patch: Partial<Record<"view" | "search" | "page" | "onDate", string | null>>
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
  const setView = (value: TicketView) => updateListParams({ view: value, page: null });
  const setSearch = (value: string) => updateListParams({ search: value || null, page: null });
  /**
   * The date no longer overrides the view.
   *
   * It used to: the date meant "closed on", so asking Needs Attention - which
   * is open/assigned/in_progress/unresolved - what closed on Tuesday could
   * only ever answer with the unresolved ones, and that read as a broken
   * filter rather than as two filters disagreeing. Picking a date therefore
   * widened the default view to All to get out of the way.
   *
   * Now the date means "moved into whatever this chip names", so every chip
   * has an answer of its own and there is nothing to get out of the way of.
   * Needs Attention plus a date is the tickets that landed in the attention
   * pile that day, which is a question worth being able to ask.
   */
  const setOnDate = (value: string) =>
    updateListParams({ onDate: value || null, page: null });
  const setPage = useCallback((value: React.SetStateAction<number>) => {
    const next = typeof value === "function" ? value(page) : value;
    updateListParams({ page: next > 1 ? String(next) : null });
  }, [page, updateListParams]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [assignees, setAssignees] = useState<Assignee[]>([]);
  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [customerSearch, setCustomerSearch] = useState("");
  const [customerResults, setCustomerResults] = useState<CustomerOption[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerOption | null>(null);
  const [editing, setEditing] = useState<ServiceTicket | null>(null);
  const [ticketHistory, setTicketHistory] = useState<TicketHistory[]>([]);
  // `status` here can be "rescheduled", which is not a ticket status. It is
  // what the office picks in the dropdown; on save it becomes status=assigned
  // plus the time (migration 080). Behaves as a status everywhere on screen,
  // stays a time on an assigned ticket underneath, which is what keeps the job
  // on the technician's list and inside their cap.
  const [editForm, setEditForm] = useState({ status: "open" as EditStatus, priority: "normal" as TicketPriority, assignedEmployeeId: "", serviceDate: "", resolutionNotes: "", poleBoxNumber: "", portNumber: "", updateNote: "", rescheduledFor: "" });
  const [saving, setSaving] = useState(false);
  const [modalError, setModalError] = useState("");
  useScrollRestoration(!loading);

  // Queue data is filtered and paginated on the server.
  const loadTickets = useCallback(async () => {
    try {
      setLoading(true); setError("");
      const response = await apiFetch(`/api/service-tickets?view=${view}&search=${encodeURIComponent(search)}&page=${page}&onDate=${onDate}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load service tickets.");
      setTickets(data.tickets); setSummary(data.summary); setPagination(data.pagination);
      if (data.pagination.page !== page) setPage(data.pagination.page);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load service tickets.");
    } finally { setLoading(false); }
  }, [onDate, page, search, setPage, view]);

  useEffect(() => { const timeout = window.setTimeout(loadTickets, 180); return () => window.clearTimeout(timeout); }, [loadTickets]);

  // Populate the Technician selector from active employee accounts.
  useEffect(() => {
    apiFetch("/api/service-ticket-assignees").then(async (response) => {
      const data = await response.json(); if (response.ok) setAssignees(data.employees);
    }).catch(() => setAssignees([]));
  }, []);

  const selectCustomer = (customer: CustomerOption) => {
    setSelectedCustomer(customer); setCustomerSearch(customer.name || `Customer #${customer.customer_id}`); setCustomerResults([]);
    setForm((current) => ({ ...current, customerId: String(customer.customer_id), poleBoxNumber: customer.pole_box_number || "", portNumber: customer.port_number || "" }));
  };

  // A customer-profile Support History link can preselect its customer here.
  useEffect(() => {
    const customerId = searchParams.get("customerId"); if (!customerId) return;
    apiFetch(`/api/customers/${customerId}`).then(async (response) => {
      const customer = await response.json(); if (!response.ok) return;
      selectCustomer(customer); setShowNew(true); setSearchParams({}, { replace: true });
    }).catch(() => undefined);
  }, [searchParams, setSearchParams]);

  // Customer lookup is part of ticket creation, so staff never need to copy a
  // customer ID from another page before reporting a problem.
  useEffect(() => {
    if (!showNew || selectedCustomer || customerSearch.trim().length < 2) { setCustomerResults([]); return; }
    const timeout = window.setTimeout(async () => {
      try {
        const response = await apiFetch(`/api/customers?search=${encodeURIComponent(customerSearch.trim())}`);
        const data = await response.json(); setCustomerResults(response.ok ? data.slice(0, 8) : []);
      } catch { setCustomerResults([]); }
    }, 200);
    return () => window.clearTimeout(timeout);
  }, [customerSearch, selectedCustomer, showNew]);

  const openNew = () => { setForm(emptyForm()); setSelectedCustomer(null); setCustomerSearch(""); setCustomerResults([]); setModalError(""); setShowNew(true); };

  const createTicket = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      setSaving(true); setModalError("");
      const response = await apiFetch("/api/service-tickets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || "Could not create service ticket.");
      setShowNew(false); setNotice(`Service ticket #${data.ticket.service_ticket_id} was created.`); setView(data.ticket.assigned_employee_id ? "assigned" : "open"); await loadTickets();
    } catch (saveError) { setModalError(saveError instanceof Error ? saveError.message : "Could not create service ticket."); }
    finally { setSaving(false); }
  };

  const openEdit = (ticket: ServiceTicket) => {
    setEditing(ticket); setModalError(""); setTicketHistory([]);
    const booked = ticket.status === "assigned" && !!ticket.rescheduled_for;
    setEditForm({ status: booked ? "rescheduled" : ticket.status, priority: ticket.priority, assignedEmployeeId: ticket.assigned_employee_id ? String(ticket.assigned_employee_id) : "", serviceDate: ticket.service_date?.slice(0, 10) || "", resolutionNotes: ticket.resolution_notes || "", poleBoxNumber: ticket.pole_box_number || "", portNumber: ticket.port_number || "", updateNote: "", rescheduledFor: booked ? toDateTimeLocal(ticket.rescheduled_for!) : "" });
    // Load the immutable history only when a ticket is opened, keeping the main
    // queue request small while still giving the editor full context.
    //
    // The detail response also carries who reported the ticket and who
    // completed it, which the queue query deliberately leaves out. Until Aug
    // 2026 this call took only `data.history` and threw the rest away, so the
    // modal read created_by_name off the queue row - where it never existed.
    // Every ticket therefore fell through to the "legacy import" wording, and
    // "Completed by" never appeared on any ticket at all. Merging the detail
    // over the queue row fixes both; the queue row stays as the base so the
    // modal never blanks out if this request fails.
    const requestedId = ticket.service_ticket_id;
    apiFetch(`/api/service-tickets/${requestedId}`).then(async (response) => {
      const data = await response.json();
      if (!response.ok) return;
      setTicketHistory(data.history);
      // Guarded so a slow response cannot overwrite a different ticket the
      // user has since opened.
      setEditing((current) =>
        current && current.service_ticket_id === requestedId
          ? { ...current, ...data.ticket }
          : current
      );
    }).catch(() => setTicketHistory([]));
  };

  const updateTicket = async (event: React.FormEvent) => {
    event.preventDefault(); if (!editing) return;
    try {
      setSaving(true); setModalError("");
      // Rescheduled is assigned-with-a-time on the wire. Any other status
      // sends no time, and the server clears whatever was there.
      const { rescheduledFor, ...rest } = editForm;
      const body = editForm.status === "rescheduled"
        ? { ...rest, status: "assigned", rescheduledFor }
        : rest;
      const response = await apiFetch(`/api/service-tickets/${editing.service_ticket_id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || "Could not update service ticket.");
      setEditing(null); setNotice(`Service ticket #${data.ticket.service_ticket_id} was updated.`); await loadTickets();
    } catch (saveError) { setModalError(saveError instanceof Error ? saveError.message : "Could not update service ticket."); }
    finally { setSaving(false); }
  };

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-5 sm:px-6 sm:py-6 lg:px-8 lg:py-8">
      <div className="flex flex-wrap items-end justify-between gap-4"><div><h1 className="text-2xl font-semibold tracking-tight text-on-surface">Service Tickets</h1><p className="mt-1 text-sm text-on-surface-variant">Report customer issues, assign technicians, and record completed work.</p></div><button type="button" onClick={openNew} className="flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-on-primary shadow-sm"><span className="material-symbols-outlined text-lg">add</span>New Ticket</button></div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-6">{/* Took the Needs Attention slot. That card was the four active
          statuses rolled together, and with a card per status beside it, it
          had stopped saying anything the others did not. */}
      <Summary label="Rescheduled" value={summary.rescheduled} icon="event" tone="scheduled" /><Summary label="Open" value={summary.open} icon="inbox" tone="primary" /><Summary label="Assigned" value={summary.assigned} icon="engineering" tone="primary" /><Summary label="In Progress" value={summary.in_progress} icon="construction" tone="warning" /><Summary label="Completed" value={summary.completed} icon="task_alt" tone="positive" />{/* Counted separately from Completed because these are the jobs that
          still owe somebody a visit — the technician got there and could not
          do the work. They stay inside Needs Attention for the same reason. */}
      <Summary label="Unresolved" value={summary.unresolved} icon="door_front" tone="stalled" /></div>
      {notice && <div className="rounded-lg bg-tertiary/10 p-4 text-sm font-medium text-tertiary">{notice}</div>}
      {error && <div className="rounded-lg bg-error/10 p-4 text-sm text-error">{error}</div>}

      <section className="overflow-hidden rounded-2xl bg-surface-container-lowest shadow-sm">
        <div className="flex flex-col gap-3 border-b border-surface-container px-5 py-4"><div className="flex flex-wrap gap-2">{([['rescheduled', 'Rescheduled'], ['open', 'Open'], ['assigned', 'Assigned'], ['in_progress', 'In Progress'], ['completed', 'Completed'], ['unresolved', 'Unresolved'], ['all', 'All']] as Array<[TicketView, string]>).map(([value, label]) => <button key={value} type="button" onClick={() => setView(value)} className={view === value ? activeChip : idleChip}>{label}</button>)}</div><div className="flex flex-wrap items-center justify-between gap-3"><OnDateFilter view={view} value={onDate} onChange={setOnDate} /><SearchInput value={search} onChange={setSearch} placeholder="Search ticket, customer, phone, issue..." /></div></div>
        <div className="overflow-x-auto"><table className="w-full min-w-[44rem] text-left md:min-w-0"><thead className="bg-surface-container-low"><tr><Heading>Ticket</Heading><Heading>Customer</Heading><Heading>Problem</Heading><Heading>Priority</Heading><Heading>Status</Heading><Heading>Technician</Heading><Heading>Reported</Heading><th className="px-5 py-4" /></tr></thead><tbody className="divide-y divide-surface-container">{!loading && tickets.map((ticket) => <tr key={ticket.service_ticket_id} className="cursor-pointer transition hover:bg-surface-container-low/60" onClick={() => openEdit(ticket)}><td className="px-5 py-4 font-mono text-sm font-medium text-primary">#{ticket.service_ticket_id}</td><td className="px-5 py-4"><p className="font-semibold text-on-surface">{ticket.customer_name || (ticket.legacy_customer_id ? "Legacy Customer" : "Customer unavailable")}</p>{/* The address is on the row because a technician reading this queue
       is deciding where to drive, and making them open each profile to
       find that out is the slowest possible way to answer it. */}
    <p className="mt-0.5 max-w-[22rem] text-xs leading-5 text-on-surface-variant">{ticket.address || "No address on file"}</p>{ticket.customer_id ? <button type="button" onClick={(event) => { event.stopPropagation(); openCustomer(ticket.customer_id!); }} className="mt-1 whitespace-nowrap text-left text-xs font-medium text-primary">Customer #{ticket.customer_id}</button> : <p className="mt-1 whitespace-nowrap text-xs text-on-surface-variant">{ticket.legacy_customer_id ? `Legacy Customer #${ticket.legacy_customer_id}` : "No linked customer profile"}</p>}</td><td className="max-w-xs px-5 py-4 text-sm text-on-surface"><p className="line-clamp-2">{ticket.issue_summary}</p><p className="mt-1 text-xs text-on-surface-variant">Pole {ticket.pole_box_number || "—"} · Port {ticket.port_number || "—"}</p></td><td className="px-5 py-4"><PriorityBadge priority={ticket.priority} /></td><td className="px-5 py-4">{ticket.status === "assigned" && ticket.rescheduled_for ? <><span className="inline-flex whitespace-nowrap rounded-full bg-scheduled px-3 py-1 text-xs font-medium text-on-scheduled">Rescheduled</span><p className="mt-1 whitespace-nowrap text-[11px] text-on-surface-variant">{formatAppointment(ticket.rescheduled_for)}</p></> : <StatusBadge status={ticket.status} />}</td><td className="px-5 py-4 text-sm text-on-surface-variant">{ticket.assigned_employee_name || "Unassigned"}</td><td className="whitespace-nowrap px-5 py-4 text-sm text-on-surface-variant">{formatDate(ticket.reported_date)}</td><td className="px-5 py-4 text-right"><span className="material-symbols-outlined text-outline">chevron_right</span></td></tr>)}</tbody></table></div>
        {loading && <EmptyState text="Loading service tickets..." />}{!loading && !error && tickets.length === 0 && <EmptyState text="No service tickets found." />}{!loading && tickets.length > 0 && <Pagination pagination={pagination} setPage={setPage} />}
      </section>

      {showNew && <Modal title="Create service ticket" onClose={() => !saving && setShowNew(false)}><form onSubmit={createTicket} className="space-y-5"><Field label="Customer" required><div className="relative"><input required value={customerSearch} onChange={(event) => { setCustomerSearch(event.target.value); setSelectedCustomer(null); setForm((current) => ({ ...current, customerId: "" })); }} className={inputClass} placeholder="Search name, customer ID, or phone..." />{customerResults.length > 0 && <div className="absolute z-10 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-outline-variant bg-white shadow-xl">{customerResults.map((customer) => <button key={customer.customer_id} type="button" onClick={() => selectCustomer(customer)} className="block w-full border-b border-surface-container px-4 py-3 text-left last:border-0 hover:bg-surface-container-low"><span className="font-semibold">{customer.name || "Unnamed customer"}</span><span className="ml-2 text-xs text-on-surface-variant">#{customer.customer_id} · {customer.telephone || "No phone"}</span><p className="mt-1 truncate text-xs text-on-surface-variant">{customer.address || "No address"}</p></button>)}</div>}</div>{selectedCustomer && <p className="mt-2 text-xs font-semibold text-tertiary">Selected customer #{selectedCustomer.customer_id} · {humanize(selectedCustomer.status)}</p>}</Field><div className="grid gap-4 sm:grid-cols-2"><Field label="Problem summary" required><input required minLength={3} maxLength={160} value={form.issueSummary} onChange={(event) => setForm({ ...form, issueSummary: event.target.value })} className={inputClass} placeholder="e.g. Internet connection is down" /></Field><Field label="Priority" required><select value={form.priority} onChange={(event) => setForm({ ...form, priority: event.target.value as TicketPriority })} className={inputClass}><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option></select></Field><Field label="Date reported" required><input required type="date" value={form.reportedDate} onChange={(event) => setForm({ ...form, reportedDate: event.target.value })} className={inputClass} /></Field><Field label="Technician"><select value={form.assignedEmployeeId} onChange={(event) => setForm({ ...form, assignedEmployeeId: event.target.value })} className={inputClass}><option value="">Leave unassigned</option>{assignees.map((employee) => <AssigneeOption key={employee.employee_id} employee={employee} urgent={form.priority === "urgent"} />)}</select>{assignees.length === 0 ? <p className="mt-1.5 text-xs text-on-surface-variant">No technicians on file yet. The ticket can be created unassigned.</p> : form.priority !== "urgent" && assignees.every((employee) => !employee.can_take_work) && <p className="mt-1.5 text-xs text-on-surface-variant">Every technician is working through a full queue. Create it unassigned and it waits in Open, or set it to Urgent to send it through anyway.</p>}</Field><Field label="Pole box"><input value={form.poleBoxNumber} onChange={(event) => setForm({ ...form, poleBoxNumber: event.target.value })} className={inputClass} /></Field><Field label="Port"><input value={form.portNumber} onChange={(event) => setForm({ ...form, portNumber: event.target.value })} className={inputClass} /></Field></div><Field label="Problem details"><textarea rows={4} maxLength={2000} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} className={inputClass} placeholder="Describe what the customer reported..." /></Field>{modalError && <ErrorMessage text={modalError} />}<ModalActions saving={saving} label="Create Ticket" onCancel={() => setShowNew(false)} /></form></Modal>}

      {editing && <Modal title={`Update service ticket #${editing.service_ticket_id}`} onClose={() => !saving && setEditing(null)}><form onSubmit={updateTicket} className="space-y-5"><div className="rounded-xl bg-surface-container-low p-4"><p className="font-medium text-on-surface">{editing.customer_name || (editing.legacy_customer_id ? "Legacy Customer" : "Customer unavailable")} · {editing.customer_id ? `Customer #${editing.customer_id}` : editing.legacy_customer_id ? `Legacy Customer #${editing.legacy_customer_id}` : "No linked customer profile"}</p><p className="mt-1 flex items-start gap-1.5 text-sm text-on-surface-variant"><span className="material-symbols-outlined text-base leading-5">location_on</span>{editing.address || "No address on file"}{editing.telephone ? <span className="ml-2 whitespace-nowrap">· {editing.telephone}</span> : null}</p><p className="mt-1 text-sm text-on-surface-variant">{editing.issue_summary}</p><p className="mt-2 text-xs text-on-surface-variant">{reporterLabel(editing)} on {formatDate(editing.reported_date)}{editing.completed_by_name ? ` · Completed by ${editing.completed_by_name}` : ""}</p></div><div className="grid gap-4 sm:grid-cols-2"><Field label="Status" required><select value={editForm.status} onChange={(event) => setEditForm({ ...editForm, status: event.target.value as EditStatus })} className={inputClass}><option value="open">Open</option><option value="assigned">Assigned</option><option value="rescheduled">Rescheduled — customer asked for another time</option><option value="in_progress">In Progress</option><option value="completed">Completed</option><option value="unresolved">Unresolved — nobody home / no answer</option><option value="cancelled">Cancelled</option></select></Field>{editForm.status === "rescheduled" && <Field label="Come back on" required><input required type="datetime-local" min={minAppointment()} value={editForm.rescheduledFor} onChange={(event) => setEditForm({ ...editForm, rescheduledFor: event.target.value })} className={inputClass} /></Field>}<Field label="Priority" required><select value={editForm.priority} onChange={(event) => setEditForm({ ...editForm, priority: event.target.value as TicketPriority })} className={inputClass}><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option></select></Field><Field label="Technician"><select value={editForm.assignedEmployeeId} onChange={(event) => setEditForm({ ...editForm, assignedEmployeeId: event.target.value })} className={inputClass}><option value="">Unassigned</option>{/* A ticket assigned before technicians became a distinct role still names
    someone who is not in the technician list. Without this option the select
    would fall back to "Unassigned" and quietly drop the assignee on save. */}
{editing.assigned_employee_id && !assignees.some((employee) => employee.employee_id === editing.assigned_employee_id) && <option value={editing.assigned_employee_id}>{editing.assigned_employee_name} (not a technician)</option>}{assignees.map((employee) => <AssigneeOption key={employee.employee_id} employee={employee} urgent={editForm.priority === "urgent"} />)}</select></Field><Field label="Service date" required={editForm.status === "completed"}><input required={editForm.status === "completed"} type="date" value={editForm.serviceDate} onChange={(event) => setEditForm({ ...editForm, serviceDate: event.target.value })} className={inputClass} /></Field><Field label="Pole box"><input value={editForm.poleBoxNumber} onChange={(event) => setEditForm({ ...editForm, poleBoxNumber: event.target.value })} className={inputClass} /></Field><Field label="Port"><input value={editForm.portNumber} onChange={(event) => setEditForm({ ...editForm, portNumber: event.target.value })} className={inputClass} /></Field></div><Field label={editForm.status === "unresolved" ? "Why it could not be done" : "Technician work / resolution"} required={editForm.status === "completed" || editForm.status === "unresolved"}><textarea required={editForm.status === "completed" || editForm.status === "unresolved"} rows={4} maxLength={4000} value={editForm.resolutionNotes} onChange={(event) => setEditForm({ ...editForm, resolutionNotes: event.target.value })} className={inputClass} placeholder={editForm.status === "unresolved" ? "Nobody home, no answer on the phone, gate locked..." : "What was inspected, repaired, or replaced?"} /></Field><Field label="Update note"><textarea rows={3} maxLength={1000} value={editForm.updateNote} onChange={(event) => setEditForm({ ...editForm, updateNote: event.target.value })} className={inputClass} placeholder="Optional note for the ticket history..." /></Field>{ticketHistory.length > 0 && <div className="rounded-xl border border-surface-container p-4"><p className="text-xs font-semibold uppercase tracking-wider text-on-surface-variant">Ticket History</p><div className="mt-3 space-y-3">{ticketHistory.map((item) => <div key={item.service_ticket_history_id} className="border-l-2 border-primary/30 pl-3"><p className="text-sm font-semibold">{item.from_status ? `${humanize(item.from_status)} → ` : ""}{item.to_status ? humanize(item.to_status) : humanize(item.event_type)}</p><p className="mt-1 text-sm text-on-surface-variant">{item.note}</p><p className="mt-1 text-xs text-on-surface-variant">{new Date(item.changed_at).toLocaleString("en-JM")} · {[item.changed_by_first_name, item.changed_by_last_name].filter(Boolean).join(" ") || "Legacy import"}</p></div>)}</div></div>}{modalError && <ErrorMessage text={modalError} />}<ModalActions saving={saving} label="Save Ticket" onCancel={() => setEditing(null)} /></form></Modal>}
    </div>
  );
}

const inputClass = "mt-1.5 w-full rounded-lg border border-outline-variant bg-white px-3 py-2.5 text-sm text-on-surface focus:border-primary";
const activeChip = "rounded-full bg-primary px-4 py-2 text-xs font-medium text-on-primary";
const idleChip = "rounded-full bg-surface-container px-4 py-2 text-xs font-medium text-on-surface-variant transition hover:bg-surface-container-high";

function Summary({ label, value, icon, tone }: { label: string; value: number; icon: string; tone: "primary" | "positive" | "warning" | "stalled" | "scheduled" }) { const tones = { primary: "bg-info/10 text-info", positive: "bg-tertiary/10 text-tertiary", warning: "bg-warning-container text-warning", stalled: "bg-stalled/10 text-stalled", scheduled: "bg-scheduled text-on-scheduled" }; return <div className="rounded-xl bg-surface-container-lowest p-4 shadow-sm"><div className="flex items-center justify-between"><div><p className="text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant">{label}</p><p className="mt-1 text-2xl font-medium text-on-surface">{value.toLocaleString()}</p></div><span className={`material-symbols-outlined rounded-lg p-2 ${tones[tone]}`}>{icon}</span></div></div>; }
/**
 * What the date means, per view.
 *
 * The date filters on the day a ticket MOVED INTO the status the chip names,
 * so its label has to move with the chip - a single fixed word would be wrong
 * for six of the eight. Reading "Opened on" above the box under the Open chip
 * is the whole explanation of what the filter does, delivered where it is
 * needed instead of in a tooltip nobody opens.
 *
 * Needs Attention names four statuses rather than one, so it gets the honest
 * general word: something moved into the pile that day.
 */
const ON_DATE_LABELS: Record<TicketView, string> = {
  // The one chip whose date is not a move in the history but the appointment
  // itself: "what is booked for Tuesday".
  rescheduled: "Booked for",
  open: "Opened on",
  assigned: "Assigned on",
  in_progress: "Started on",
  completed: "Completed on",
  unresolved: "Unresolved on",
  cancelled: "Cancelled on",
  all: "Any change on",
};

/**
 * One day, answering "when did a ticket reach the status beside it".
 *
 * The date is when that move was recorded, not when the customer first
 * reported the fault - the Reported column already answers that one.
 *
 * It sits in the section toolbar next to the search, not up with the summary
 * cards, because like the search it narrows the TABLE. The counts above stay
 * whole: they are the standing workload, and a Needs Attention figure that
 * moved every time somebody looked at last Tuesday would stop being the
 * number anyone could act on.
 */
function OnDateFilter({
  view, value, onChange,
}: {
  view: TicketView; value: string; onChange: (value: string) => void;
}) {
  const label = ON_DATE_LABELS[view] ?? ON_DATE_LABELS.open;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-medium uppercase tracking-wider text-on-surface-variant">{label}</span>
      <input type="date" aria-label={`${label} this date`} value={value} onChange={(event) => onChange(event.target.value)} className="rounded-lg bg-surface-container-low px-3 py-2 text-sm text-on-surface" />
      {value && (
        <button type="button" onClick={() => onChange("")} aria-label="Clear the date" className="rounded-full p-1.5 text-on-surface-variant transition hover:bg-surface-container">
          <span className="material-symbols-outlined text-lg">close</span>
        </button>
      )}
    </div>
  );
}

function SearchInput({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) { return <div className="relative w-full sm:w-80"><span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-outline">search</span><input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} className="w-full rounded-lg bg-surface-container-low py-2.5 pl-10 pr-4 text-sm" /></div>; }
function Heading({ children }: { children: React.ReactNode }) { return <th className="whitespace-nowrap px-5 py-4 text-xs font-semibold uppercase tracking-wider text-on-surface-variant">{children}</th>; }
function StatusBadge({ status }: { status: TicketStatus }) { const styles: Record<TicketStatus, string> = { open: "bg-surface-container-high text-on-surface-variant", assigned: "bg-info/10 text-info", in_progress: "bg-warning-container text-warning", completed: "bg-tertiary/10 text-tertiary", unresolved: "bg-stalled text-white", cancelled: "bg-surface-container-high text-on-surface-variant" }; return <span className={`inline-flex whitespace-nowrap rounded-full px-3 py-1 text-xs font-medium ${styles[status]}`}>{humanize(status)}</span>; }
/**
 * One technician in the assignee dropdown, with the load that decides whether
 * they can be picked at all.
 *
 * Disabled rather than hidden. A technician who has vanished from the list
 * looks like somebody who left the company; one greyed out with "5 of 10, must
 * clear first" explains itself and tells whoever is assigning when to come
 * back.
 *
 * Setting the ticket to Urgent re-enables every one of them, because urgent
 * work ignores the cap. The label changes with it, so the effect of that
 * choice is visible in the same place the choice is made rather than being
 * something you have to already know.
 */
function AssigneeOption({
  employee,
  urgent,
}: {
  employee: Assignee;
  /** An urgent ticket ignores the cap, so a full technician stays pickable. */
  urgent: boolean;
}) {
  const blocked = !employee.can_take_work && !urgent;

  const load = employee.can_take_work
    ? employee.open_jobs === 0
      ? "no jobs"
      : `${employee.open_jobs} of ${employee.job_limit} open`
    : urgent
      ? `${employee.open_jobs} of ${employee.job_limit}, urgent goes through`
      : `${employee.open_jobs} of ${employee.job_limit}, must clear first`;

  return (
    <option value={employee.employee_id} disabled={blocked}>
      {employee.first_name} {employee.last_name} — {load}
    </option>
  );
}

function PriorityBadge({ priority }: { priority: TicketPriority }) { const styles: Record<TicketPriority, string> = { low: "text-outline", normal: "text-on-surface-variant", high: "text-warning", urgent: "text-error" }; return <span className={`text-xs font-semibold uppercase ${styles[priority]}`}>{priority}</span>; }
function Pagination({ pagination, setPage }: { pagination: { page: number; limit: number; total: number; totalPages: number }; setPage: React.Dispatch<React.SetStateAction<number>> }) { return <div className="flex items-center justify-between border-t border-surface-container px-6 py-4 text-sm text-on-surface-variant"><p>Showing {(pagination.page - 1) * pagination.limit + 1}–{Math.min(pagination.page * pagination.limit, pagination.total)} of {pagination.total}</p><div className="flex items-center gap-3"><button type="button" disabled={pagination.page <= 1} onClick={() => setPage((current) => current - 1)} className={idleChip + " disabled:opacity-40"}>Previous</button><span className="text-xs font-medium">Page {pagination.page} of {pagination.totalPages}</span><button type="button" disabled={pagination.page >= pagination.totalPages} onClick={() => setPage((current) => current + 1)} className={idleChip + " disabled:opacity-40"}>Next</button></div></div>; }
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) { return <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/45 p-4" role="dialog" aria-modal="true"><div className="max-h-[92vh] w-full max-w-3xl overflow-y-auto rounded-2xl bg-surface-container-lowest shadow-2xl"><div className="sticky top-0 z-10 flex items-center justify-between border-b border-surface-container bg-surface-container-lowest px-6 py-4"><h2 className="text-xl font-semibold text-on-surface">{title}</h2><button type="button" onClick={onClose} className="rounded-full p-2 hover:bg-surface-container"><span className="material-symbols-outlined">close</span></button></div><div className="p-6">{children}</div></div></div>; }
function Field({ label, required = false, children }: { label: string; required?: boolean; children: React.ReactNode }) { return <label className="block text-sm font-semibold text-on-surface">{label}{required && <span className="text-error"> *</span>}{children}</label>; }
function ModalActions({ saving, label, onCancel }: { saving: boolean; label: string; onCancel: () => void }) { return <div className="flex justify-end gap-3 border-t border-surface-container pt-5"><button type="button" disabled={saving} onClick={onCancel} className="rounded-lg bg-surface-container px-5 py-2.5 text-sm font-medium text-on-surface-variant">Cancel</button><button type="submit" disabled={saving} className="rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-on-primary disabled:opacity-50">{saving ? "Saving..." : label}</button></div>; }
function EmptyState({ text }: { text: string }) { return <div className="px-6 py-14 text-center text-sm text-on-surface-variant">{text}</div>; }
function ErrorMessage({ text }: { text: string }) { return <p className="rounded-lg bg-error/10 p-3 text-sm text-error">{text}</p>; }
/**
 * Who reported a ticket, saying only what is actually known.
 *
 * `undefined` means the detail request has not landed yet, so no claim is made
 * at all rather than flashing a wrong one for a moment. An empty or null name
 * means the detail response really did come back without a creator, which in
 * this system only happens for the tickets imported from the Access database -
 * every ticket raised here records the employee who raised it.
 */
function reporterLabel(ticket: ServiceTicket) {
  if (ticket.created_by_name === undefined) return "Reported";
  return `Reported by ${ticket.created_by_name || "legacy import"}`;
}

/**
 * A stored instant as a datetime-local value, in the browser's own time.
 * Every screen this runs on is in Jamaica, which is what the server assumes
 * when it reads the value back.
 */
function toDateTimeLocal(value: string) { const d = new Date(value); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); }
/** The earliest the picker accepts: now. The server checks again with a proper clock. */
function minAppointment() { return toDateTimeLocal(new Date().toISOString()); }
/** "Sat 20 Sept, 9:00 am" — when the technician agreed to come back. */
function formatAppointment(value: string) { return new Date(value).toLocaleString("en-JM", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }); }
function humanize(value: string) { return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function formatDate(value: string | null) { if (!value) return "—"; return new Date(`${value.slice(0, 10)}T00:00:00`).toLocaleDateString("en-JM", { day: "numeric", month: "short", year: "numeric" }); }
function jamaicaToday() { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Jamaica", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }

export default ServiceRequestsPage;
