import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api";

type Note = {
  reference_id: string;
  detail: string | null;
};

export default function CustomerNotesCard({ customerId, onSeeMore }: {
  customerId: number;
  onSeeMore: () => void;
}) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function loadNotes() {
      setLoading(true);
      setError("");
      try {
        const response = await apiFetch(
          `/api/customers/${customerId}/activity?filter=note&limit=2&offset=0`
        );
        const data = await response.json();
        if (!response.ok) throw new Error("Could not load notes.");
        if (!cancelled) {
          setNotes(data.activity ?? []);
          setTotal(data.total ?? 0);
        }
      } catch {
        if (!cancelled) setError("Could not load notes.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    loadNotes();
    return () => { cancelled = true; };
  }, [customerId]);

  if (loading || (!error && notes.length === 0)) return null;

  return (
    <section data-customer-notes aria-labelledby="customer-notes-heading" className="relative min-w-0 rounded-2xl bg-surface-container-lowest shadow-sm">
      {/* Let the information card determine the shared desktop row height. */}
      <div className="flex flex-col p-5 sm:p-8 xl:absolute xl:inset-0 xl:px-5">
        <div className="mb-6 flex shrink-0 items-center gap-3 border-b border-surface-container pb-4">
          <span className="material-symbols-outlined text-primary" aria-hidden="true">notes</span>
          <h2 id="customer-notes-heading" className="text-lg font-semibold">Notes</h2>
        </div>
        {error ? (
          <p className="text-sm text-error" role="alert">{error}</p>
        ) : (
          <ol aria-label="Most recent notes" tabIndex={0} className="max-h-64 min-h-0 list-decimal space-y-4 overflow-y-auto pl-6 text-sm xl:max-h-none xl:flex-1">
            {notes.map((note) => (
              <li key={note.reference_id} className="pl-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{note.detail}</li>
            ))}
          </ol>
        )}
        {!error && total > 2 && (
          <button type="button" onClick={onSeeMore} className="mt-4 shrink-0 self-start rounded-lg px-3 py-2 text-sm font-medium text-primary transition hover:bg-primary/10">
            See more
          </button>
        )}
      </div>
    </section>
  );
}
