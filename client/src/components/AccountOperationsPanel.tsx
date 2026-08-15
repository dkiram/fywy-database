/** Shows one customer's status timeline and the actions allowed for their current state. */
import { useEffect, useState } from "react";
import type { EmployeeRole } from "../auth/AuthContext";
import { apiFetch } from "../lib/api";

// Customer-profile controls and timeline for the MVP 3 account state machine.
export type AccountStatus =
  | "active"
  | "disconnected"
  | "pending_reconnection"
  | "closed"
  | "archived";

export type AccountStatusUpdate = {
  status: AccountStatus;
  deactivation_date: string | null;
  reactivation_date: string | null;
};

type StatusHistory = {
  account_status_history_id: number;
  customer_id: number;
  from_status: AccountStatus | null;
  to_status: AccountStatus;
  reason: string;
  effective_date: string;
  application_id: number | null;
  changed_at: string;
  changed_by_first_name: string | null;
  changed_by_last_name: string | null;
};

type AccountAction = "deactivate" | "request-reconnection" | "reconnect";

// Centralizing labels and endpoints keeps the modal generic while each action
// still presents wording appropriate to its business meaning.
const actionDetails: Record<
  AccountAction,
  {
    title: string;
    button: string;
    endpoint: string;
    placeholder: string;
    destructive?: boolean;
  }
> = {
  deactivate: {
    title: "Deactivate account",
    button: "Deactivate Account",
    endpoint: "deactivate",
    placeholder: "Reason for disconnecting this account...",
    destructive: true,
  },
  "request-reconnection": {
    title: "Request reconnection",
    button: "Add to Reconnection Queue",
    endpoint: "request-reconnection",
    placeholder: "Payment checked or reason for requesting reconnection...",
  },
  reconnect: {
    title: "Confirm reconnection",
    button: "Reconnect Account",
    endpoint: "reconnect",
    placeholder: "Reason for approving reconnection...",
  },
};

function AccountOperationsPanel({
  customerId,
  status,
  employeeRole,
  onStatusChanged,
}: {
  customerId: number;
  status: AccountStatus;
  employeeRole: EmployeeRole;
  onStatusChanged: (update: AccountStatusUpdate) => void;
}) {
  const [history, setHistory] = useState<StatusHistory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [action, setAction] = useState<AccountAction | null>(null);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  // This mirrors server authorization. The server remains the final authority;
  // this check only prevents presenting actions the employee cannot perform.
  const canManage = employeeRole === "admin" || employeeRole === "head_office";

  // Replace the old placeholder activity list with persisted status history.
  useEffect(() => {
    const loadHistory = async () => {
      try {
        setLoading(true);
        setError("");
        const response = await apiFetch(
          `/api/customers/${customerId}/account-history`
        );
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || "Could not load account history.");
        }
        setHistory(data.statusHistory);
      } catch (loadError) {
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Could not load account history."
        );
      } finally {
        setLoading(false);
      }
    };

    loadHistory();
  }, [customerId]);

  // All three action dialogs submit through the same path. The API returns the
  // updated customer snapshot plus the history row committed with it.
  const submitAction = async () => {
    if (!action) return;
    try {
      setSaving(true);
      setError("");
      const details = actionDetails[action];
      const response = await apiFetch(
        `/api/customers/${customerId}/${details.endpoint}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason }),
        }
      );
      const data = await response.json();
      if (!response.ok) {
        throw new Error(
          data.error || `Could not ${details.title.toLowerCase()}.`
        );
      }

      onStatusChanged(data.customer);
      // Update the visible timeline immediately without another round trip.
      setHistory((current) => [data.statusHistory, ...current]);
      setAction(null);
      setReason("");
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Could not update account status."
      );
    } finally {
      setSaving(false);
    }
  };

  const startAction = (nextAction: AccountAction) => {
    setReason("");
    setError("");
    setAction(nextAction);
  };

  return (
    <>
      <section className="rounded-2xl bg-surface-container-lowest p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-surface-container pb-4">
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-on-surface-variant">
              Account Operations
            </p>
            <div className="mt-2">
              <StatusBadge status={status} />
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {/* Role and current status together determine the next legal action. */}
            {status === "active" && canManage && (
              <ActionButton
                label="Deactivate"
                icon="link_off"
                destructive
                onClick={() => startAction("deactivate")}
              />
            )}
            {status === "disconnected" && (
              <ActionButton
                label="Request Reconnection"
                icon="add_task"
                onClick={() => startAction("request-reconnection")}
              />
            )}
            {status === "pending_reconnection" && canManage && (
              <ActionButton
                label="Confirm Reconnection"
                icon="sync"
                onClick={() => startAction("reconnect")}
              />
            )}
          </div>
        </div>

        {error && !action && (
          <p className="mt-4 rounded-lg bg-error/10 p-3 text-sm text-error">
            {error}
          </p>
        )}
        {loading ? (
          <p className="py-8 text-center text-sm text-on-surface-variant">
            Loading account history...
          </p>
        ) : history.length > 0 ? (
          <div className="mt-5 space-y-5 border-l-2 border-surface-container pl-5">
            {/* Keep the profile compact while the API retains the full history. */}
            {history.slice(0, 6).map((item) => (
              <div key={item.account_status_history_id}>
                <p className="text-sm font-semibold text-on-surface">
                  {item.from_status ? `${humanize(item.from_status)} → ` : ""}
                  {humanize(item.to_status)}
                </p>
                <p className="mt-1 text-sm text-on-surface-variant">
                  {item.reason}
                </p>
                <p className="mt-1 text-xs text-on-surface-variant">
                  {formatDate(item.effective_date)} · {employeeName(item)}
                </p>
              </div>
            ))}
          </div>
        ) : (
          <p className="py-8 text-center text-sm text-on-surface-variant">
            No account status history yet.
          </p>
        )}
      </section>

      {action && (
        // A reason is mandatory because it becomes permanent history and audit
        // evidence for the account-status change.
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/45 p-4"
          role="dialog"
          aria-modal="true"
          aria-label={actionDetails[action].title}
        >
          <div className="w-full max-w-lg rounded-2xl bg-surface-container-lowest p-6 shadow-2xl">
            <h2 className="text-xl font-bold text-on-surface">
              {actionDetails[action].title}
            </h2>
            <p className="mt-2 text-sm text-on-surface-variant">
              This change becomes permanent account history and is recorded in
              Activity History.
            </p>
            <label className="mt-5 block text-sm font-semibold text-on-surface">
              Reason <span className="text-error">*</span>
              <textarea
                autoFocus
                rows={4}
                maxLength={500}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder={actionDetails[action].placeholder}
                className="mt-1.5 w-full resize-none rounded-lg border border-outline-variant bg-white px-3 py-2.5 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
              />
            </label>
            {error && (
              <p className="mt-3 rounded-lg bg-error/10 p-3 text-sm text-error">
                {error}
              </p>
            )}
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                disabled={saving}
                onClick={() => {
                  setAction(null);
                  setReason("");
                  setError("");
                }}
                className="rounded-lg bg-surface-container px-5 py-2.5 text-sm font-bold text-on-surface-variant disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={saving || reason.trim().length < 3}
                onClick={submitAction}
                className={`rounded-lg px-5 py-2.5 text-sm font-bold text-white disabled:opacity-50 ${
                  actionDetails[action].destructive ? "bg-error" : "bg-primary"
                }`}
              >
                {saving ? "Saving..." : actionDetails[action].button}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function ActionButton({
  label,
  icon,
  onClick,
  destructive = false,
}: {
  label: string;
  icon: string;
  onClick: () => void;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-bold transition ${
        destructive
          ? "bg-error/10 text-error hover:bg-error/15"
          : "bg-primary/10 text-primary hover:bg-primary/15"
      }`}
    >
      <span className="material-symbols-outlined text-base">{icon}</span>
      {label}
    </button>
  );
}

function StatusBadge({ status }: { status: AccountStatus }) {
  const styles: Record<AccountStatus, string> = {
    active: "bg-tertiary/10 text-tertiary",
    disconnected: "bg-error/10 text-error",
    pending_reconnection: "bg-amber-100 text-amber-800",
    closed: "bg-surface-container-high text-on-surface-variant",
    archived: "bg-surface-container-high text-on-surface-variant",
  };
  return (
    <span
      className={`inline-flex rounded-full px-3 py-1 text-xs font-bold ${styles[status]}`}
    >
      {humanize(status)}
    </span>
  );
}

function employeeName(item: StatusHistory) {
  // Backfilled legacy snapshots intentionally have no employee actor.
  const name = [item.changed_by_first_name, item.changed_by_last_name]
    .filter(Boolean)
    .join(" ");
  return name || "Legacy import";
}

function humanize(value: string) {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDate(value: string) {
  // Preserve PostgreSQL DATE values without browser timezone conversion.
  const datePart = value.slice(0, 10);
  return new Date(`${datePart}T00:00:00`).toLocaleDateString("en-JM", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export default AccountOperationsPanel;
