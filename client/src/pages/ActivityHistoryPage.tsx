/** Displays the latest auditable employee and system changes in readable form. */
import { useEffect, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import { apiFetch } from "../lib/api";
import { useScrollRestoration } from "../hooks/useScrollRestoration";
import { customerProfileState } from "../hooks/useOpenCustomerProfile";

type AuditLog = {
  audit_log_id: number;
  actor_name: string;
  action: string;
  entity_type: string;
  entity_id: string;
  field_name: string | null;
  old_value: string | null;
  new_value: string | null;
  reason: string | null;
  occurred_at: string;
  related_customer_id: string | null;
};

type AuditLogsResponse = {
  auditLogs: AuditLog[];
};

function ActivityHistoryPage() {
  const location = useLocation();
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // Kept in the URL, not just component state, so the browser back button
  // restores the exact search someone had typed instead of clearing it.
  const [searchParams, setSearchParams] = useSearchParams();
  const employeeSearch = searchParams.get("employee") ?? "";
  const setEmployeeSearch = (value: string) => {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (value) next.set("employee", value);
        else next.delete("employee");
        return next;
      },
      { replace: true }
    );
  };
  useScrollRestoration(!loading);

  useEffect(() => {
    // Debounce name searches so typing a full employee name does not issue one
    // database request for every keystroke.
    let cancelled = false;
    const loadAuditLogs = async () => {
      try {
        setLoading(true);
        setError("");

        const response = await apiFetch(
          `/api/audit-logs?employee=${encodeURIComponent(employeeSearch.trim())}`
        );
        const data = await response.json();

        if (!response.ok) {
          throw new Error(
            data.error || "Audit log request failed."
          );
        }

        if (!cancelled) {
          const auditData = data as AuditLogsResponse;
          setAuditLogs(auditData.auditLogs);
        }
      } catch (error) {
        console.error(error);
        if (!cancelled) setError("Could not load activity history.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    const timeout = window.setTimeout(loadAuditLogs, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [employeeSearch]);

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 p-8 lg:p-12">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight text-on-surface">
          Activity History
        </h1>

        <p className="mt-2 text-sm text-on-surface-variant">
          A permanent record of important employee actions.
        </p>
      </div>

      <div className="rounded-2xl bg-surface-container-lowest p-5 shadow-sm">
        <label htmlFor="audit-employee-search" className="mb-2 block text-sm font-medium text-on-surface">
          Search by employee
        </label>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <span className="material-symbols-outlined pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-xl text-outline">
              search
            </span>
            <input
              id="audit-employee-search"
              type="search"
              value={employeeSearch}
              onChange={(event) => setEmployeeSearch(event.target.value)}
              placeholder="Name or username..."
              className="h-11 w-full rounded-xl border border-outline-variant bg-surface pl-11 pr-4 text-sm text-on-surface transition focus:border-primary"
            />
          </div>
          {employeeSearch && (
            <button
              type="button"
              onClick={() => setEmployeeSearch("")}
              className="h-11 rounded-xl bg-surface-container px-4 text-sm font-medium text-primary transition hover:bg-surface-container-high"
            >
              Clear
            </button>
          )}
          {!loading && (
            <p className="shrink-0 text-sm text-on-surface-variant">
              {auditLogs.length} {auditLogs.length === 1 ? "record" : "records"}
            </p>
          )}
        </div>
        <p className="mt-2 text-xs text-on-surface-variant">
          Matches employee names, full names, usernames, and the name saved on older audit records.
        </p>
      </div>

      {error && (
        <div className="rounded-xl bg-error/10 p-4 text-sm text-error">
          {error}
        </div>
      )}

      {loading && (
        <div className="rounded-2xl bg-surface-container-lowest p-10 text-center text-sm text-on-surface-variant shadow-sm">
          Loading activity history...
        </div>
      )}

      {!loading && !error && auditLogs.length === 0 && (
        <div className="rounded-2xl bg-surface-container-lowest p-10 text-center shadow-sm">
          <span className="material-symbols-outlined text-4xl text-outline">
            history
          </span>

          <p className="mt-2 font-medium text-on-surface">
            {employeeSearch.trim()
              ? `No audit records found for “${employeeSearch.trim()}”`
              : "No activity recorded yet"}
          </p>
        </div>
      )}

      {!loading && auditLogs.length > 0 && (
        /* Keep every audit record self-contained so historical changes remain readable. */
        <div className="flex flex-col gap-4">
          {auditLogs.map((log) => (
            <article
              key={log.audit_log_id}
              className="overflow-hidden rounded-2xl bg-surface-container-lowest shadow-sm"
            >
              <div className="flex items-center gap-3 border-b border-surface-container px-6 py-5">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <span className="material-symbols-outlined">
                    history
                  </span>
                </div>

                <div>
                  <p className="font-semibold text-on-surface">
                    {log.action}
                  </p>

                  <p className="mt-0.5 text-sm text-on-surface-variant">
                    Audit record #{log.audit_log_id}
                  </p>
                </div>
              </div>

              <dl className="grid grid-cols-1 gap-px bg-surface-container sm:grid-cols-2 lg:grid-cols-3">
                <AuditDetail label="Who" value={log.actor_name} />
                <AuditDetail label="Did What" value={log.action} />

                <div className="bg-surface-container-lowest px-6 py-5">
                  <dt className="text-xs font-semibold uppercase tracking-wider text-on-surface-variant">
                    Customer
                  </dt>

                  <dd className="mt-1 font-medium text-on-surface">
                    {log.related_customer_id ? (
                      <Link
                        to={`/customers/${log.related_customer_id}`}
                        state={customerProfileState(location)}
                        className="text-primary hover:underline"
                      >
                        {log.related_customer_id}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </dd>
                </div>

                <AuditDetail
                  label={log.field_name === "network_access" ? "Previous OLT details" : "Old Value"}
                  value={formatAuditValue(log.field_name, log.old_value)}
                />

                <AuditDetail
                  label={log.field_name === "network_access" ? "Result" : "New Value"}
                  value={formatAuditValue(log.field_name, log.new_value)}
                  emphasized
                />

                <AuditDetail
                  label="When"
                  value={formatAuditDate(log.occurred_at)}
                />

                <AuditDetail
                  label="Reason"
                  value={log.reason || "—"}
                  wide
                />
              </dl>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

type AuditDetailProps = {
  label: string;
  value: string;
  emphasized?: boolean;
  wide?: boolean;
};

function AuditDetail({
  label,
  value,
  emphasized = false,
  wide = false,
}: AuditDetailProps) {
  return (
    <div
      className={[
        "bg-surface-container-lowest px-6 py-5",
        wide ? "sm:col-span-2 lg:col-span-3" : "",
      ].join(" ")}
    >
      <dt className="text-xs font-semibold uppercase tracking-wider text-on-surface-variant">
        {label}
      </dt>

      <dd
        className={
          emphasized
            ? "mt-1 break-words font-medium text-primary"
            : "mt-1 whitespace-pre-wrap break-words font-medium text-on-surface"
        }
      >
        {value}
      </dd>
    </div>
  );
}

function formatAuditValue(
  fieldName: string | null,
  value: string | null
) {
  if (value === null || value === "") {
    return "—";
  }

  // Monetary audit values are stored as text but should read like currency in the UI.
  if (fieldName === "monthly_fee") {
    const amount = Number(value);

    if (!Number.isNaN(amount)) {
      return `J$${amount.toLocaleString("en-US")}`;
    }
  }

  // OLT audit records deliberately retain the complete before/after objects in
  // PostgreSQL, but printing those objects as JSON makes the staff screen look
  // like a developer console. Keep the full audit evidence in the database and
  // turn only its presentation into the few facts a person needs to review.
  if (fieldName === "network_access") {
    return formatNetworkAccessAuditValue(value);
  }

  return value;
}

function formatNetworkAccessAuditValue(value: string) {
  let details: Record<string, unknown>;

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return "OLT details recorded";
    }
    details = parsed as Record<string, unknown>;
  } catch {
    // Older data may not be JSON. Preserve it instead of hiding potentially
    // useful historical information.
    return value;
  }

  const lines: string[] = [];
  const oltName = readableText(details.olt_name);
  const locationParts = [
    readableInteger(details.frame_number),
    readableInteger(details.slot_number),
    readableInteger(details.pon_port_number),
    readableInteger(details.ont_id),
  ];

  if (oltName || locationParts.some((part) => part !== null)) {
    const location = locationParts.every((part) => part !== null)
      ? `ONT ${locationParts.join("/")}`
      : "ONT location incomplete";
    lines.push(oltName ? `${oltName} · ${location}` : location);
  }

  const mappingStatus = readableText(details.mapping_status);
  if (mappingStatus) {
    lines.push(`Mapping: ${friendlyStatus(mappingStatus)}`);
  }

  const controlFlag = readableText(details.liveControlFlag);
  const runState = readableText(details.liveRunState);
  if (controlFlag || runState) {
    const liveState = [controlFlag, runState]
      .filter((part): part is string => Boolean(part))
      .map(friendlyStatus)
      .join(" · ");
    lines.push(`Live OLT: ${liveState}`);
  }

  const mismatchReasons = Array.isArray(details.mismatchReasons)
    ? details.mismatchReasons
        .map(readableText)
        .filter((reason): reason is string => Boolean(reason))
    : [];
  if (mismatchReasons.length > 0) {
    lines.push(`Issue: ${mismatchReasons.join("; ")}`);
  }

  return lines.length > 0 ? lines.join("\n") : "OLT details recorded";
}

function readableText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readableInteger(value: unknown) {
  if (typeof value === "number" && Number.isInteger(value)) return String(value);
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return value.trim();
  return null;
}

function friendlyStatus(value: string) {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatAuditDate(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "—";
  }

  const datePart = date.toLocaleDateString("en-US", {
    timeZone: "America/Jamaica",
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  const timePart = date.toLocaleTimeString("en-US", {
    timeZone: "America/Jamaica",
    hour: "numeric",
    minute: "2-digit",
  });

  return `${datePart} ${timePart}`;
}

export default ActivityHistoryPage;
