/** Loads a compact service-ticket history for display inside a customer profile. */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { apiFetch } from "../lib/api";

// Customer-scoped view of the same service-ticket records used by the main
// queue. New-ticket links return to the main workspace with this customer set.
type CustomerTicket = {
  service_ticket_id: number; issue_summary: string; priority: string; status: string;
  reported_date: string; assigned_employee_name: string | null; service_date: string | null;
  resolution_notes: string | null; pole_box_number: string | null; port_number: string | null;
};

function CustomerServiceHistory({ customerId }: { customerId: number }) {
  const navigate = useNavigate();
  const [tickets, setTickets] = useState<CustomerTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    setLoading(true); setError("");
    apiFetch(`/api/service-tickets?customerId=${customerId}&view=all&page=1`).then(async (response) => {
      const data = await response.json(); if (!response.ok) throw new Error(data.error || "Could not load support history."); setTickets(data.tickets);
    }).catch((loadError) => setError(loadError instanceof Error ? loadError.message : "Could not load support history.")).finally(() => setLoading(false));
  }, [customerId]);

  return <section className="overflow-hidden rounded-2xl bg-surface-container-lowest shadow-sm">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-surface-container px-6 py-5"><div><h2 className="text-lg font-semibold text-on-surface">Support History</h2><p className="mt-1 text-sm text-on-surface-variant">Service tickets reported for this customer.</p></div><button type="button" onClick={() => navigate(`/service-requests?customerId=${customerId}`)} className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-on-primary"><span className="material-symbols-outlined text-lg">add</span>New Ticket</button></div>
    {error && <p className="m-5 rounded-lg bg-error/10 p-4 text-sm text-error">{error}</p>}
    {loading ? <div className="px-6 py-14 text-center text-sm text-on-surface-variant">Loading support history...</div> : tickets.length === 0 ? <div className="px-6 py-14 text-center"><span className="material-symbols-outlined text-4xl text-outline">support_agent</span><p className="mt-2 text-sm font-semibold">No service tickets recorded.</p></div> : <div className="divide-y divide-surface-container">{tickets.map((ticket) => <button key={ticket.service_ticket_id} type="button" onClick={() => navigate(`/service-requests?search=${ticket.service_ticket_id}`)} className="grid w-full gap-3 px-6 py-5 text-left transition hover:bg-surface-container-low sm:grid-cols-[7rem_1fr_10rem_8rem]"><div><p className="font-mono text-sm font-medium text-primary">#{ticket.service_ticket_id}</p><p className="mt-1 text-xs text-on-surface-variant">{formatDate(ticket.reported_date)}</p></div><div><p className="font-semibold text-on-surface">{ticket.issue_summary}</p><p className="mt-1 text-xs text-on-surface-variant">Pole {ticket.pole_box_number || "—"} · Port {ticket.port_number || "—"}{ticket.resolution_notes ? ` · ${ticket.resolution_notes}` : ""}</p></div><p className="text-sm text-on-surface-variant">{ticket.assigned_employee_name || "Unassigned"}</p><span className="h-fit rounded-full bg-primary/10 px-3 py-1 text-center text-xs font-medium text-primary">{humanize(ticket.status)}</span></button>)}</div>}
  </section>;
}

function formatDate(value: string) { return new Date(`${value.slice(0,10)}T00:00:00`).toLocaleDateString("en-JM", { day: "numeric", month: "short", year: "numeric" }); }
function humanize(value: string) { return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }

export default CustomerServiceHistory;
