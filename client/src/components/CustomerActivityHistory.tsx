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
  | "status_change"
  | "ticket"
  | "rate_change"
  | "waiver"
  | "reconnection"
  | "hold"
  | "staff_edit";

const FILTERS: { value: ActivityFilter; label: string }[] = [
  { value: "all",           label: "Everything" },
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
  }, [customerId, filter]);

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
            Status changes, service tickets, rate changes, waivers and staff edits. Payments are on the Payments tab.
          </p>
          {total > 0 && (
            <p className="mt-1 text-xs text-on-surface-variant">
              Showing {visible.length} of {total}
            </p>
          )}
        </div>

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
                    <time
                      dateTime={entry.occurred_at}
                      className="shrink-0 text-xs text-on-surface-variant"
                      title={formatExact(entry.occurred_at)}
                    >
                      {formatRelative(entry.occurred_at)}
                    </time>
                  </div>

                  {entry.detail && (
                    <p className="mt-1 text-sm text-on-surface-variant">{entry.detail}</p>
                  )}

                  {entry.reason && (
                    <p className="mt-1.5 border-l-2 border-surface-container-high pl-3 text-sm italic text-on-surface-variant">
                      {entry.reason}
                    </p>
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
