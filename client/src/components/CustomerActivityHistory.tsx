/**
 * The History tab: one merged timeline of everything that has happened to a
 * customer's account, newest first.
 *
 * Payments are not here on purpose — they have their own tab, with amounts,
 * receipt numbers and void state. Showing them twice would double the length
 * of this list and give two places to read the same figure from.
 */
import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api";

type ActivityKind =
  | "note"
  | "status_change"
  | "rate_change"
  | "ticket_opened"
  | "ticket_event"
  | "waiver"
  | "reconnection"
  | "hold"
  | "staff_edit";

type ActivityEntry = {
  occurred_at: string;
  kind: ActivityKind;
  title: string;
  detail: string | null;
  reason: string | null;
  actor: string | null;
  reference_id: string | null;
};

/**
 * Colour marks an exception, not a category — the same rule the status badges
 * follow. A routine rate change or staff edit stays neutral so that a
 * disconnection actually stands out when someone scans the column.
 */
const KIND_STYLES: Record<ActivityKind, { label: string; icon: string; tone: string }> = {
  note:          { label: "Note",         icon: "sticky_note_2",     tone: "bg-primary/10 text-primary" },
  status_change: { label: "Status",       icon: "swap_horiz",        tone: "bg-surface-container text-on-surface-variant" },
  rate_change:   { label: "Rate",         icon: "payments",          tone: "bg-surface-container text-on-surface-variant" },
  ticket_opened: { label: "Ticket",       icon: "build",             tone: "bg-surface-container text-on-surface-variant" },
  ticket_event:  { label: "Ticket",       icon: "build",             tone: "bg-surface-container text-on-surface-variant" },
  waiver:        { label: "Waiver",       icon: "receipt_long",      tone: "bg-warning-container text-warning" },
  reconnection:  { label: "Reconnection", icon: "restart_alt",       tone: "bg-surface-container text-on-surface-variant" },
  hold:          { label: "Hold",         icon: "pause_circle",      tone: "bg-warning-container text-warning" },
  staff_edit:    { label: "Edit",         icon: "edit_note",         tone: "bg-surface-container text-on-surface-variant" },
};

/**
 * These values are sent to the server, which owns the filtering. "ticket"
 * covers both ticket kinds; the grouping lives in the API so that paging a
 * filtered list returns whole pages of matches instead of pages that happen
 * to contain some.
 */
type ActivityFilter =
  | "all"
  | "note"
  | "status_change"
  | "ticket"
  | "rate_change"
  | "waiver"
  | "reconnection"
  | "hold"
  | "staff_edit";

const FILTERS: { value: ActivityFilter; label: string }[] = [
  { value: "all",           label: "Everything" },
  { value: "note",          label: "Notes" },
  { value: "status_change", label: "Status" },
  { value: "ticket",        label: "Tickets" },
  { value: "rate_change",   label: "Rates" },
  { value: "waiver",        label: "Waivers" },
  { value: "staff_edit",    label: "Edits" },
];

const PAGE_SIZE = 25;

function CustomerActivityHistory({ customerId }: { customerId: number | string }) {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const [addingNote, setAddingNote] = useState(false);
  const [note, setNote] = useState("");
  const [noteDate, setNoteDate] = useState(jamaicaToday());
  const [savingNote, setSavingNote] = useState(false);
  const [noteError, setNoteError] = useState("");
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editNote, setEditNote] = useState("");
  const [editNoteDate, setEditNoteDate] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const [editNoteError, setEditNoteError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  // Changing the filter throws away the loaded pages and starts again from the
  // top, because the server is paging a different list now.
  useEffect(() => {
    let cancelled = false;

    const loadFirstPage = async () => {
      try {
        setLoading(true);
        setError("");

        const response = await apiFetch(
          `/api/customers/${customerId}/activity?filter=${filter}&limit=${PAGE_SIZE}&offset=0`
        );
        const data = await response.json();

        if (!response.ok) throw new Error(data.error || "Activity request failed.");
        if (!cancelled) {
          setEntries(data.activity ?? []);
          setTotal(data.total ?? 0);
        }
      } catch (loadError) {
        console.error(loadError);
        if (!cancelled) setError("Could not load this customer's history.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    loadFirstPage();
    return () => {
      cancelled = true;
    };
  }, [customerId, filter, refreshKey]);

  const saveNote = async () => {
    try {
      setSavingNote(true);
      setNoteError("");
      const response = await apiFetch(`/api/customers/${customerId}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note, noteDate }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not add note.");

      setNote("");
      setNoteDate(jamaicaToday());
      setAddingNote(false);
      setFilter("all");
      setRefreshKey((current) => current + 1);
    } catch (saveError) {
      setNoteError(saveError instanceof Error ? saveError.message : "Could not add note.");
    } finally {
      setSavingNote(false);
    }
  };

  const saveNoteEdit = async () => {
    if (!editingNoteId) return;
    try {
      setSavingEdit(true);
      setEditNoteError("");
      const response = await apiFetch(
        `/api/customers/${customerId}/notes/${editingNoteId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ note: editNote, noteDate: editNoteDate }),
        }
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not edit note.");

      setEditingNoteId(null);
      setEditNote("");
      setEditNoteDate("");
      setRefreshKey((current) => current + 1);
    } catch (saveError) {
      setEditNoteError(
        saveError instanceof Error ? saveError.message : "Could not edit note."
      );
    } finally {
      setSavingEdit(false);
    }
  };

  const loadMore = async () => {
    try {
      setLoadingMore(true);
      setError("");

      const response = await apiFetch(
        `/api/customers/${customerId}/activity?filter=${filter}&limit=${PAGE_SIZE}&offset=${entries.length}`
      );
      const data = await response.json();

      if (!response.ok) throw new Error(data.error || "Activity request failed.");

      // Appended rather than replaced, so earlier pages stay on screen and the
      // reader does not lose their place.
      setEntries((current) => [...current, ...(data.activity ?? [])]);
      setTotal(data.total ?? 0);
    } catch (loadError) {
      console.error(loadError);
      setError("Could not load more history.");
    } finally {
      setLoadingMore(false);
    }
  };

  const visible = entries;
  const hasMore = entries.length < total;

  if (loading) {
    return (
      <section className="rounded-2xl bg-surface-container-lowest p-8 shadow-sm">
        <p className="text-sm text-on-surface-variant">Loading history...</p>
      </section>
    );
  }

  if (error) {
    return (
      <section className="rounded-2xl bg-surface-container-lowest p-8 shadow-sm">
        <p className="rounded-lg bg-error/10 p-4 text-sm text-error">{error}</p>
      </section>
    );
  }

  return (
    <section className="rounded-2xl bg-surface-container-lowest shadow-sm">
      <div className="flex flex-col gap-4 border-b border-surface-container p-6 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-on-surface">Account history</h2>
          <p className="mt-1 text-sm text-on-surface-variant">
            Notes, status changes, service tickets, rate changes, waivers and staff edits. Payments are on the Payments tab.
          </p>
          {total > 0 && (
            <p className="mt-1 text-xs text-on-surface-variant">
              Showing {visible.length} of {total}
            </p>
          )}
        </div>

        <div className="flex flex-col items-start gap-3 lg:items-end">
          <button
            type="button"
            onClick={() => {
              setAddingNote((current) => !current);
              setEditingNoteId(null);
              setNoteError("");
            }}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-on-primary"
          >
            <span className="material-symbols-outlined text-lg">add_notes</span>
            Add note
          </button>
          <div className="flex flex-wrap gap-1 rounded-lg bg-surface-container p-1">
            {FILTERS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setFilter(option.value)}
                aria-pressed={filter === option.value}
                className={`rounded-md px-3 py-1.5 text-xs font-medium ${
                  filter === option.value
                    ? "bg-surface-container-lowest text-on-surface shadow-sm"
                    : "text-on-surface-variant"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {addingNote && (
        <div className="border-b border-surface-container bg-surface-container-low p-6">
          <div className="grid gap-4 md:grid-cols-[11rem_1fr]">
            <label className="text-sm font-semibold text-on-surface">
              Note date
              <input
                type="date"
                max={jamaicaToday()}
                value={noteDate}
                onChange={(event) => setNoteDate(event.target.value)}
                className="mt-1.5 w-full rounded-lg border border-outline-variant bg-white px-3 py-2.5 text-sm"
              />
            </label>
            <label className="text-sm font-semibold text-on-surface">
              Account note
              <textarea
                autoFocus
                rows={3}
                minLength={3}
                maxLength={2000}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="Example: Customer requested account suspension until further notice."
                className="mt-1.5 w-full resize-y rounded-lg border border-outline-variant bg-white px-3 py-2.5 text-sm"
              />
            </label>
          </div>
          {noteError && (
            <p className="mt-3 rounded-lg bg-error/10 p-3 text-sm text-error">{noteError}</p>
          )}
          <div className="mt-4 flex justify-end gap-3">
            <button
              type="button"
              disabled={savingNote}
              onClick={() => {
                setAddingNote(false);
                setNote("");
                setNoteError("");
              }}
              className="rounded-lg bg-surface-container px-4 py-2 text-sm font-medium text-on-surface-variant disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={savingNote || note.trim().length < 3 || !noteDate}
              onClick={saveNote}
              className="rounded-lg bg-primary px-5 py-2 text-sm font-medium text-on-primary disabled:opacity-50"
            >
              {savingNote ? "Saving..." : "Save note"}
            </button>
          </div>
        </div>
      )}

      {visible.length === 0 ? (
        <p className="p-8 text-sm text-on-surface-variant">
          {entries.length === 0
            ? "Nothing has been recorded against this account yet."
            : "No entries of that type."}
        </p>
      ) : (
        <ol className="p-6">
          {visible.map((entry, index) => {
            const style = KIND_STYLES[entry.kind] ?? KIND_STYLES.staff_edit;
            const isLast = index === visible.length - 1;
            const isEditingNote =
              entry.kind === "note" && editingNoteId === entry.reference_id;

            return (
              <li key={`${entry.kind}-${entry.reference_id}-${entry.occurred_at}-${index}`} className="flex gap-4">
                {/* The rail: a marker per entry with a line joining them, so a
                    run of events on the same day reads as one sequence. */}
                <div className="flex flex-col items-center">
                  <span className={`flex size-9 shrink-0 items-center justify-center rounded-full ${style.tone}`}>
                    <span className="material-symbols-outlined text-lg">{style.icon}</span>
                  </span>
                  {!isLast && <span className="w-px flex-1 bg-surface-container" aria-hidden="true" />}
                </div>

                <div className={isLast ? "flex-1 pb-1" : "flex-1 pb-6"}>
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <p className="font-medium text-on-surface">{entry.title}</p>
                    <div className="flex items-center gap-3">
                      {entry.kind === "note" && entry.reference_id && !isEditingNote && (
                        <button
                          type="button"
                          onClick={() => {
                            setAddingNote(false);
                            setEditingNoteId(entry.reference_id);
                            setEditNote(entry.detail ?? "");
                            setEditNoteDate(toJamaicaDateInput(entry.occurred_at));
                            setEditNoteError("");
                          }}
                          className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-primary hover:bg-primary/10"
                        >
                          <span className="material-symbols-outlined text-base">edit</span>
                          Edit
                        </button>
                      )}
                      <time
                        dateTime={entry.occurred_at}
                        className="shrink-0 text-xs text-on-surface-variant"
                        title={formatExact(entry.occurred_at)}
                      >
                        {formatRelative(entry.occurred_at)}
                      </time>
                    </div>
                  </div>

                  {isEditingNote ? (
                    <div className="mt-3 rounded-xl border border-primary/20 bg-primary/5 p-4">
                      <div className="grid gap-3 md:grid-cols-[11rem_1fr]">
                        <label className="text-xs font-semibold text-on-surface">
                          Note date
                          <input
                            type="date"
                            max={jamaicaToday()}
                            value={editNoteDate}
                            onChange={(event) => setEditNoteDate(event.target.value)}
                            className="mt-1.5 w-full rounded-lg border border-outline-variant bg-white px-3 py-2 text-sm"
                          />
                        </label>
                        <label className="text-xs font-semibold text-on-surface">
                          Account note
                          <textarea
                            autoFocus
                            rows={3}
                            minLength={3}
                            maxLength={2000}
                            value={editNote}
                            onChange={(event) => setEditNote(event.target.value)}
                            className="mt-1.5 w-full resize-y rounded-lg border border-outline-variant bg-white px-3 py-2 text-sm"
                          />
                        </label>
                      </div>
                      {editNoteError && (
                        <p className="mt-3 rounded-lg bg-error/10 p-3 text-sm text-error">
                          {editNoteError}
                        </p>
                      )}
                      <div className="mt-3 flex justify-end gap-2">
                        <button
                          type="button"
                          disabled={savingEdit}
                          onClick={() => {
                            setEditingNoteId(null);
                            setEditNoteError("");
                          }}
                          className="rounded-lg bg-surface-container px-3 py-2 text-xs font-medium disabled:opacity-50"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          disabled={savingEdit || editNote.trim().length < 3 || !editNoteDate}
                          onClick={saveNoteEdit}
                          className="rounded-lg bg-primary px-4 py-2 text-xs font-medium text-on-primary disabled:opacity-50"
                        >
                          {savingEdit ? "Saving..." : "Save changes"}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      {entry.detail && (
                        <p className="mt-1 text-sm text-on-surface-variant">{entry.detail}</p>
                      )}

                      {entry.reason && (
                        <p className="mt-1.5 border-l-2 border-surface-container-high pl-3 text-sm italic text-on-surface-variant">
                          {entry.reason}
                        </p>
                      )}
                    </>
                  )}

                  <p className="mt-1.5 text-xs text-on-surface-variant">
                    {style.label}
                    {entry.actor ? ` · ${entry.actor}` : " · system"}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {hasMore && (
        <div className="border-t border-surface-container p-4 text-center">
          <button
            type="button"
            onClick={loadMore}
            disabled={loadingMore}
            className="rounded-lg bg-surface-container px-5 py-2.5 text-sm font-medium text-on-surface disabled:opacity-50"
          >
            {loadingMore ? "Loading..." : `Load ${Math.min(PAGE_SIZE, total - entries.length)} more`}
          </button>
        </div>
      )}

      {/* A failure part-way through paging must not wipe the entries already
          on screen, so it reports underneath them instead of replacing them. */}
      {error && entries.length > 0 && (
        <p className="border-t border-surface-container p-4 text-sm text-error">{error}</p>
      )}
    </section>
  );
}

function formatExact(value: string) {
  return new Date(value).toLocaleString("en-JM", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: "America/Jamaica",
  });
}

function jamaicaToday() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Jamaica",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function toJamaicaDateInput(value: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Jamaica",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

/**
 * Recent entries read better as "3 days ago" when someone is catching up on
 * what just happened; anything older is more useful as an actual date. The
 * exact timestamp is always one hover away in the title attribute.
 */
function formatRelative(value: string) {
  const then = new Date(value);
  const days = Math.floor((Date.now() - then.getTime()) / 86_400_000);

  if (days < 0) return formatShortDate(then);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days} days ago`;

  return formatShortDate(then);
}

function formatShortDate(date: Date) {
  return date.toLocaleDateString("en-JM", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "America/Jamaica",
  });
}

export default CustomerActivityHistory;
