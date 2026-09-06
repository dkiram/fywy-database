/** The standalone technician phone app: passcode sign-in, job queue, and field updates. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "../lib/api";

/**
 * A separate app that happens to share a build.
 *
 * Nothing here renders AppLayout, reads AuthContext, or calls a staff
 * endpoint. A technician signs in with a code and a passcode (migration 075),
 * gets their own session identity, and can reach exactly one thing: the jobs
 * assigned to them. The office app and this app pass on the server, not in
 * the browser.
 *
 * Everything below assumes a phone held in one hand, outdoors, on a
 * connection that comes and goes: one column, targets big enough to hit
 * without looking, the address and telephone readable without tapping
 * anything, and no screen that can be reached only by navigating away from
 * the queue.
 */

type JobStatus =
  | "assigned"
  | "in_progress"
  | "completed"
  | "unresolved"
  | "cancelled";

type JobPriority = "low" | "normal" | "high" | "urgent";

type HistoryNote = {
  note: string;
  to_status: string | null;
  changed_at: string;
  changed_by: string | null;
};

type Job = {
  service_ticket_id: number;
  issue_summary: string;
  description: string | null;
  priority: JobPriority;
  status: JobStatus;
  reported_date: string;
  pole_box_number: string | null;
  port_number: string | null;
  service_date: string | null;
  resolution_notes: string | null;
  updated_at: string;
  customer_id: number | null;
  customer_name: string | null;
  address: string | null;
  telephone: string | null;
  recent_notes: HistoryNote[];
};

type Technician = {
  employeeId: number;
  firstName: string;
  lastName: string;
  loginCode: string;
};

/** How often the queue refreshes itself while the app is on screen. */
const REFRESH_MS = 20_000;

function TechnicianAppPage() {
  const [booting, setBooting] = useState(true);
  const [technician, setTechnician] = useState<Technician | null>(null);

  // Stable identity. The queue's polling effect is rebuilt whenever this
  // changes, so an inline arrow here would restart the twenty-second timer
  // every time this component happened to render.
  const signOut = useCallback(() => setTechnician(null), []);

  // The session is a plain cookie check. It runs once on mount so a phone
  // reopened from the home screen lands straight on the queue.
  useEffect(() => {
    apiFetch("/api/tech/me")
      .then(async (response) => {
        if (!response.ok) return;
        const data = await response.json();
        setTechnician(data.technician);
      })
      .catch(() => undefined)
      .finally(() => setBooting(false));
  }, []);

  if (booting) {
    return (
      <TechnicianShell>
        <p className="px-6 py-16 text-center text-sm text-white/60">Loading…</p>
      </TechnicianShell>
    );
  }

  return technician ? (
    <JobQueue technician={technician} onSignedOut={signOut} />
  ) : (
    <SignIn onSignedIn={setTechnician} />
  );
}

/**
 * The dark frame both screens sit in.
 *
 * Padded for the notch and the home indicator, because once this is added to
 * a home screen it runs without browser chrome and iOS will otherwise put the
 * header under the clock.
 */
function TechnicianShell({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="flex min-h-screen flex-col bg-sidebar"
      style={{
        paddingTop: "env(safe-area-inset-top)",
        paddingBottom: "env(safe-area-inset-bottom)",
      }}
    >
      {/* A flex column so the pale job panel can stretch to the bottom of the
          screen. Without it a technician with two jobs left gets a band of
          navy under the last card, which reads as the page having failed to
          load the rest. */}
      <div className="mx-auto flex w-full max-w-lg flex-1 flex-col">
        {children}
      </div>
    </div>
  );
}

function SignIn({ onSignedIn }: { onSignedIn: (technician: Technician) => void }) {
  const [loginCode, setLoginCode] = useState("");
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();

    try {
      setBusy(true);
      setError("");

      const response = await apiFetch("/api/tech/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ loginCode, passcode }),
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not sign in.");

      onSignedIn(data.technician);
    } catch (signInError) {
      setError(
        signInError instanceof Error ? signInError.message : "Could not sign in."
      );
      setPasscode("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <TechnicianShell>
      <div className="px-6 pb-10 pt-16">
        <h1 className="text-2xl font-semibold text-white">SPCL Field</h1>
        <p className="mt-2 text-sm text-white/60">
          Sign in with the code and passcode the office gave you.
        </p>

        <form onSubmit={submit} className="mt-10 space-y-5">
          <label className="block text-sm font-semibold text-white/80">
            Technician code
            <input
              value={loginCode}
              onChange={(event) => setLoginCode(event.target.value.toUpperCase())}
              // Six characters off a printed card, and never lower case.
              // Autocorrect turns them into words and autocapitalise only
              // gets the first one, so both are switched off and the value
              // is upper-cased on the way in instead.
              autoCapitalize="characters"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              maxLength={8}
              required
              placeholder="ABC234"
              className="mt-2 w-full rounded-xl border border-white/15 bg-white/10 px-4 py-4 text-center font-mono text-2xl tracking-[0.35em] text-white placeholder:text-white/25"
            />
          </label>

          <label className="block text-sm font-semibold text-white/80">
            Passcode
            <input
              value={passcode}
              onChange={(event) =>
                setPasscode(event.target.value.replace(/\D/g, ""))
              }
              // Six digits, so ask the phone for the number pad rather than
              // making somebody find the digits on a full keyboard. type is
              // password so it is not readable over a shoulder in a yard.
              type="password"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              required
              placeholder="••••••"
              className="mt-2 w-full rounded-xl border border-white/15 bg-white/10 px-4 py-4 text-center font-mono text-2xl tracking-[0.35em] text-white placeholder:text-white/25"
            />
          </label>

          {error && (
            <p className="rounded-xl bg-error/20 px-4 py-3 text-sm text-red-200">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-xl bg-primary-container px-4 py-4 text-base font-semibold text-white disabled:opacity-50"
          >
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <p className="mt-8 text-xs leading-5 text-white/40">
          Add this page to your home screen and it opens like an app. Your jobs
          appear here as soon as the office assigns them.
        </p>
      </div>
    </TechnicianShell>
  );
}

function JobQueue({
  technician,
  onSignedOut,
}: {
  technician: Technician;
  onSignedOut: () => void;
}) {
  // Stable across renders so the polling effect below is not torn down and
  // rebuilt every time the queue re-renders.
  const onExpired = useCallback(() => onSignedOut(), [onSignedOut]);

  const [jobs, setJobs] = useState<Job[]>([]);
  const [recent, setRecent] = useState<Job[]>([]);
  const [tab, setTab] = useState<"jobs" | "recent">("jobs");
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [newJobCount, setNewJobCount] = useState(0);

  /**
   * Draft notes, held per ticket and outside the job list.
   *
   * The queue reloads itself every twenty seconds. If the note lived on the
   * job object, a refresh landing while somebody was typing would wipe what
   * they had written — on a phone, mid-sentence, with no undo.
   */
  const [drafts, setDrafts] = useState<Record<number, string>>({});

  // Which ids we have already shown, so a refresh can tell a genuinely new
  // assignment from the same seven jobs coming back again.
  const knownIds = useRef<Set<number> | null>(null);

  const load = useCallback(async (options: { quiet?: boolean } = {}) => {
    try {
      if (!options.quiet) setLoading(true);

      const response = await apiFetch("/api/tech/jobs");

      // A session that has lapsed — or been revoked from the office after a
      // phone went missing — sends the app back to its own sign-in screen
      // rather than leaving a stale queue on the display with an error
      // underneath it.
      if (response.status === 401) {
        onExpired();
        return;
      }

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load your jobs.");

      const incoming: Job[] = data.jobs;

      if (knownIds.current === null) {
        // First load of the session. Everything is "new" and none of it is
        // worth announcing.
        knownIds.current = new Set(incoming.map((job) => job.service_ticket_id));
      } else {
        const arrivals = incoming.filter(
          (job) => !knownIds.current!.has(job.service_ticket_id)
        );

        if (arrivals.length > 0) {
          setNewJobCount((current) => current + arrivals.length);

          // A short buzz, where the phone supports it. Not available on iOS,
          // which is why the banner below carries the message on its own.
          navigator.vibrate?.([120, 60, 120]);
        }

        for (const job of incoming) knownIds.current.add(job.service_ticket_id);
      }

      setJobs(incoming);
      setRecent(data.recent);
      setError("");
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : "Could not load your jobs."
      );
    } finally {
      setLoading(false);
    }
  }, [onExpired]);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * Keeps the queue current without anybody pulling to refresh.
   *
   * Polling stops while the app is in the background, which on a phone is
   * most of the day: a van driving between jobs should not be spending data
   * and battery on a screen nobody is looking at. Coming back to the app
   * refreshes immediately, so what is on screen is never stale by more than
   * the moment it took to look at it.
   */
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") load({ quiet: true });
    };

    const interval = window.setInterval(tick, REFRESH_MS);
    document.addEventListener("visibilitychange", tick);

    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [load]);

  const signOut = async () => {
    await apiFetch("/api/tech/logout", { method: "POST" }).catch(() => undefined);
    onSignedOut();
  };

  const visible = tab === "jobs" ? jobs : recent;

  const activeCount = useMemo(
    () => jobs.filter((job) => job.status === "in_progress").length,
    [jobs]
  );

  return (
    <TechnicianShell>
      <header className="sticky top-0 z-10 bg-sidebar px-5 pb-4 pt-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-white/40">
              SPCL Field
            </p>
            <h1 className="mt-1 text-xl font-semibold text-white">
              {technician.firstName} {technician.lastName}
            </h1>
          </div>

          <button
            type="button"
            onClick={signOut}
            className="rounded-lg px-3 py-2 text-xs font-medium text-white/50"
          >
            Sign out
          </button>
        </div>

        <div className="mt-4 flex gap-2">
          <TabButton
            active={tab === "jobs"}
            onClick={() => setTab("jobs")}
            label={`My jobs${jobs.length ? ` (${jobs.length})` : ""}`}
          />
          <TabButton
            active={tab === "recent"}
            onClick={() => setTab("recent")}
            label="Finished"
          />
        </div>

        {activeCount > 0 && tab === "jobs" && (
          <p className="mt-3 text-xs text-white/50">
            {activeCount === 1 ? "1 job in progress" : `${activeCount} jobs in progress`}
          </p>
        )}
      </header>

      <div className="flex-1 rounded-t-3xl bg-surface px-4 pb-24 pt-5">
        {newJobCount > 0 && (
          <button
            type="button"
            onClick={() => {
              setNewJobCount(0);
              setTab("jobs");
            }}
            className="mb-4 flex w-full items-center gap-3 rounded-xl bg-primary px-4 py-3 text-left text-sm font-semibold text-on-primary"
          >
            <span className="material-symbols-outlined">notifications_active</span>
            {newJobCount === 1
              ? "1 new job assigned to you"
              : `${newJobCount} new jobs assigned to you`}
          </button>
        )}

        {error && (
          <div className="mb-4 rounded-xl bg-error/10 px-4 py-3 text-sm text-error">
            {error}
          </div>
        )}

        {loading && visible.length === 0 && (
          <p className="py-16 text-center text-sm text-on-surface-variant">
            Loading your jobs…
          </p>
        )}

        {!loading && visible.length === 0 && (
          <div className="py-16 text-center">
            <span className="material-symbols-outlined text-4xl text-outline">
              {tab === "jobs" ? "check_circle" : "history"}
            </span>
            <p className="mt-3 text-sm text-on-surface-variant">
              {tab === "jobs"
                ? "Nothing assigned to you right now."
                : "Nothing finished in the last week."}
            </p>
          </div>
        )}

        <div className="space-y-3">
          {visible.map((job) => (
            <JobCard
              key={job.service_ticket_id}
              job={job}
              expanded={expandedId === job.service_ticket_id}
              onToggle={() =>
                setExpandedId((current) =>
                  current === job.service_ticket_id ? null : job.service_ticket_id
                )
              }
              draft={drafts[job.service_ticket_id] ?? ""}
              onDraftChange={(value) =>
                setDrafts((current) => ({
                  ...current,
                  [job.service_ticket_id]: value,
                }))
              }
              onSaved={() => {
                setDrafts((current) => {
                  const next = { ...current };
                  delete next[job.service_ticket_id];
                  return next;
                });
                load({ quiet: true });
              }}
            />
          ))}
        </div>
      </div>
    </TechnicianShell>
  );
}

function TabButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        active
          ? "rounded-full bg-white px-4 py-2 text-sm font-semibold text-sidebar"
          : "rounded-full bg-white/10 px-4 py-2 text-sm font-medium text-white/70"
      }
    >
      {label}
    </button>
  );
}

/**
 * One job, collapsed or expanded.
 *
 * Collapsed already carries everything needed to decide whether to drive
 * there: who, where, what phone number, what the problem is. Expanding adds
 * the detail and the buttons — it does not reveal the address, because a
 * technician scanning seven jobs for the nearest one should not have to open
 * seven cards to do it.
 */
function JobCard({
  job,
  expanded,
  onToggle,
  draft,
  onDraftChange,
  onSaved,
}: {
  job: Job;
  expanded: boolean;
  onToggle: () => void;
  draft: string;
  onDraftChange: (value: string) => void;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const closed = job.status !== "assigned" && job.status !== "in_progress";

  const save = async (status: JobStatus | null) => {
    try {
      setBusy(true);
      setError("");

      const response = await apiFetch(`/api/tech/jobs/${job.service_ticket_id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: status ?? undefined, note: draft }),
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not save that.");

      onSaved();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save that.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <article
      className={`overflow-hidden rounded-2xl bg-surface-container-lowest shadow-sm ${
        job.status === "in_progress" ? "ring-2 ring-warning/40" : ""
      }`}
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-start gap-3 p-4 text-left"
        aria-expanded={expanded}
      >
        <PriorityStripe priority={job.priority} />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <JobStatusPill status={job.status} />
            <span className="font-mono text-xs text-on-surface-variant">
              #{job.service_ticket_id}
            </span>
          </div>

          <h2 className="mt-2 truncate text-base font-semibold text-on-surface">
            {job.customer_name || "Customer unavailable"}
          </h2>

          {/* Address and phone stay on the collapsed card on purpose: they are
              the two things a technician reads before deciding anything. */}
          <p className="mt-1 flex items-start gap-1.5 text-sm leading-5 text-on-surface-variant">
            <span className="material-symbols-outlined text-base leading-5">
              location_on
            </span>
            <span className="min-w-0">{job.address || "No address on file"}</span>
          </p>

          <p className="mt-2 line-clamp-2 text-sm text-on-surface">
            {job.issue_summary}
          </p>
        </div>

        <span
          className={`material-symbols-outlined text-outline transition ${
            expanded ? "rotate-180" : ""
          }`}
        >
          expand_more
        </span>
      </button>

      {/* Tap-to-call sits outside the expander so it is reachable in one tap
          from the list. A technician ringing ahead is the single most common
          thing that happens before a visit. */}
      <div className="flex gap-2 border-t border-surface-container px-4 py-3">
        {job.telephone ? (
          <a
            href={`tel:${job.telephone.replace(/[^\d+]/g, "")}`}
            onClick={(event) => event.stopPropagation()}
            className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-surface-container px-3 py-3 text-sm font-semibold text-on-surface"
          >
            <span className="material-symbols-outlined text-lg">call</span>
            {job.telephone}
          </a>
        ) : (
          <span className="flex-1 rounded-xl bg-surface-container px-3 py-3 text-center text-sm text-on-surface-variant">
            No phone on file
          </span>
        )}

        {job.address && (
          <a
            href={`https://maps.google.com/?q=${encodeURIComponent(job.address)}`}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => event.stopPropagation()}
            className="flex items-center justify-center gap-2 rounded-xl bg-surface-container px-4 py-3 text-sm font-semibold text-on-surface"
          >
            <span className="material-symbols-outlined text-lg">directions</span>
          </a>
        )}

        {!expanded && !closed && (
          <button
            type="button"
            onClick={onToggle}
            className="rounded-xl bg-primary px-5 py-3 text-sm font-semibold text-on-primary"
          >
            {job.status === "in_progress" ? "Update" : "Start"}
          </button>
        )}
      </div>

      {expanded && (
        <div className="border-t border-surface-container bg-surface-container-low px-4 py-4">
          {job.description && (
            <p className="whitespace-pre-wrap text-sm leading-6 text-on-surface">
              {job.description}
            </p>
          )}

          <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
            <Detail label="Pole box" value={job.pole_box_number} />
            <Detail label="Port" value={job.port_number} />
            <Detail label="Reported" value={formatDate(job.reported_date)} />
            <Detail label="Priority" value={job.priority} />
          </dl>

          {job.recent_notes?.length > 0 && (
            <div className="mt-4 rounded-xl bg-surface-container-lowest p-3">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant">
                History
              </p>
              <div className="mt-2 space-y-3">
                {job.recent_notes.map((entry, index) => (
                  <div key={index} className="border-l-2 border-primary/30 pl-3">
                    <p className="text-sm leading-5 text-on-surface">{entry.note}</p>
                    <p className="mt-1 text-xs text-on-surface-variant">
                      {new Date(entry.changed_at).toLocaleString("en-JM", {
                        day: "numeric",
                        month: "short",
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                      {entry.changed_by ? ` · ${entry.changed_by}` : ""}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {closed ? (
            <p className="mt-4 rounded-xl bg-surface-container px-4 py-3 text-sm text-on-surface-variant">
              {job.status === "completed"
                ? "Signed off. Call the office if this needs reopening."
                : "The office has this one now."}
            </p>
          ) : (
            <div className="mt-4">
              <label className="block text-sm font-semibold text-on-surface">
                What happened?
                <textarea
                  value={draft}
                  onChange={(event) => onDraftChange(event.target.value)}
                  rows={3}
                  maxLength={1000}
                  placeholder="Replaced the drop cable at the pole…"
                  className="mt-2 w-full rounded-xl border border-outline-variant bg-white px-3 py-3 text-base text-on-surface"
                />
              </label>

              {error && (
                <p className="mt-3 rounded-xl bg-error/10 px-4 py-3 text-sm text-error">
                  {error}
                </p>
              )}

              {/* Three endings and one save. Done and Unresolved both need the
                  note above — the server says so, and so does the database. */}
              <div className="mt-3 grid gap-2">
                {job.status === "assigned" ? (
                  <ActionButton
                    busy={busy}
                    onClick={() => save("in_progress")}
                    className="bg-primary text-on-primary"
                    icon="play_arrow"
                    label="Start this job"
                  />
                ) : (
                  <ActionButton
                    busy={busy}
                    onClick={() => save(null)}
                    className="bg-surface-container-high text-on-surface"
                    icon="edit_note"
                    label="Save note only"
                    disabled={draft.trim().length === 0}
                  />
                )}

                <div className="grid grid-cols-2 gap-2">
                  <ActionButton
                    busy={busy}
                    onClick={() => save("completed")}
                    className="bg-success text-white"
                    icon="check"
                    label="Done"
                  />
                  <ActionButton
                    busy={busy}
                    onClick={() => save("unresolved")}
                    className="bg-stalled text-white"
                    icon="door_front"
                    label="Unresolved"
                  />
                </div>
              </div>

              <p className="mt-2 text-xs leading-5 text-on-surface-variant">
                Use <strong>Unresolved</strong> when nobody was home, nobody
                answered, or you could not get to the line. The office picks it
                back up.
              </p>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

function ActionButton({
  busy,
  onClick,
  className,
  icon,
  label,
  disabled = false,
}: {
  busy: boolean;
  onClick: () => void;
  className: string;
  icon: string;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy || disabled}
      className={`flex items-center justify-center gap-2 rounded-xl px-4 py-4 text-sm font-semibold disabled:opacity-40 ${className}`}
    >
      <span className="material-symbols-outlined text-lg">{icon}</span>
      {busy ? "Saving…" : label}
    </button>
  );
}

function Detail({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <dt className="text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant">
        {label}
      </dt>
      <dd className="mt-0.5 text-sm capitalize text-on-surface">{value || "—"}</dd>
    </div>
  );
}

/** A thin coloured edge rather than another pill, so the card stays readable. */
function PriorityStripe({ priority }: { priority: JobPriority }) {
  const colours: Record<JobPriority, string> = {
    urgent: "bg-error",
    high: "bg-warning",
    normal: "bg-outline-variant",
    low: "bg-outline-variant",
  };

  return (
    <span
      aria-label={`${priority} priority`}
      className={`mt-1 h-14 w-1 shrink-0 rounded-full ${colours[priority]}`}
    />
  );
}

function JobStatusPill({ status }: { status: JobStatus }) {
  // Mirrors the office queue's colours so a status means the same thing in
  // both places. 'unresolved' is the solid one — see --color-stalled.
  const styles: Record<JobStatus, string> = {
    assigned: "bg-info/10 text-info",
    in_progress: "bg-warning-container text-warning",
    completed: "bg-tertiary/10 text-tertiary",
    unresolved: "bg-stalled text-white",
    cancelled: "bg-surface-container-high text-on-surface-variant",
  };

  const labels: Record<JobStatus, string> = {
    assigned: "New",
    in_progress: "In progress",
    completed: "Done",
    unresolved: "Unresolved",
    cancelled: "Cancelled",
  };

  return (
    <span
      className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-semibold ${styles[status]}`}
    >
      {labels[status]}
    </span>
  );
}

function formatDate(value: string | null) {
  if (!value) return null;
  return new Date(`${value.slice(0, 10)}T00:00:00`).toLocaleDateString("en-JM", {
    day: "numeric",
    month: "short",
  });
}

export default TechnicianAppPage;
