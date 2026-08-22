/** Shows one customer's status timeline and the actions allowed for their current state. */
import { useCallback, useEffect, useState } from "react";
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

type BillingStatus = {
  outstanding_balance: string;
  credit_balance: string;
  oldest_unpaid_due_date: string | null;
  grace_end_date: string | null;
  scheduled_disconnection_date: string | null;
  is_delinquent: boolean;
  eligible_for_disconnection: boolean;
  is_on_hold: boolean;
  hold_expires_on: string | null;
  unverified_entries: number;
};

type LedgerEntry = {
  account_ledger_entry_id: number;
  entry_type: string;
  amount: string;
  effective_date: string;
  description: string;
  is_verified: boolean;
};

type WaiverRequest = {
  waiver_request_id: number;
  amount: string;
  reason: string;
  status: "pending" | "approved" | "rejected" | "reversed";
  requested_at: string;
  reviewed_at: string | null;
  review_note: string | null;
  requested_by_name: string | null;
  reviewed_by_name: string | null;
  reversed_at: string | null;
  reversal_note: string | null;
  reversed_by_name: string | null;
};

type ReconnectionRequest = {
  reconnection_request_id: number;
  outstanding_balance_snapshot: string;
  reason: string;
  status: "pending" | "approved" | "rejected";
  requested_at: string;
  reviewed_at: string | null;
  review_note: string | null;
  requested_by_name: string | null;
  reviewed_by_name: string | null;
};

type OltAccountActions = {
  enabled: boolean;
  allowlisted: boolean;
  integrated: boolean;
  ready: boolean;
  reason: string | null;
};

type AccountAction = "deactivate" | "request-reconnection" | "reconnect" | "cancel-reconnection";

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
  "cancel-reconnection": {
    title: "Cancel pending reconnection",
    button: "Keep Account Disconnected",
    endpoint: "cancel-reconnection",
    placeholder: "Why should this account remain disconnected?",
    destructive: true,
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
  const [notice, setNotice] = useState("");
  const [action, setAction] = useState<AccountAction | null>(null);
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [saving, setSaving] = useState(false);
  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [exceptionAction, setExceptionAction] = useState<"hold" | "waiver" | null>(null);
  const [exceptionValue, setExceptionValue] = useState("");
  const [exceptionReason, setExceptionReason] = useState("");
  const [waiverRequests, setWaiverRequests] = useState<WaiverRequest[]>([]);
  const [reconnectionRequests, setReconnectionRequests] = useState<ReconnectionRequest[]>([]);
  const [reversingWaiverId, setReversingWaiverId] = useState<number | null>(null);
  const [oltAccountActions, setOltAccountActions] = useState<OltAccountActions | null>(null);

  // This mirrors server authorization. The server remains the final authority;
  // this check only prevents presenting actions the employee cannot perform.
  const canManage = employeeRole === "admin" || employeeRole === "head_office";

  // Replace the old placeholder activity list with persisted status history.
  const loadAccountData = useCallback(async () => {
      try {
        setLoading(true);
        setError("");
        const [historyResponse, billingResponse, waiverResponse, reconnectionResponse, capabilityResponse] = await Promise.all([
          apiFetch(`/api/customers/${customerId}/account-history`),
          apiFetch(`/api/customers/${customerId}/billing-status`),
          canManage
            ? apiFetch(`/api/customers/${customerId}/waiver-requests`)
            : Promise.resolve(null),
          apiFetch(`/api/customers/${customerId}/reconnection-requests`),
          apiFetch(`/api/customers/${customerId}/account-action-capabilities`),
        ]);
        const [historyData, billingData, waiverData, reconnectionData, capabilityData] = await Promise.all([
          historyResponse.json(),
          billingResponse.json(),
          waiverResponse ? waiverResponse.json() : Promise.resolve({ waiverRequests: [] }),
          reconnectionResponse.json(),
          capabilityResponse.json(),
        ]);
        if (!historyResponse.ok || !billingResponse.ok || (waiverResponse && !waiverResponse.ok) || !reconnectionResponse.ok || !capabilityResponse.ok) {
          throw new Error(historyData.error || billingData.error || waiverData.error || reconnectionData.error || capabilityData.error || "Could not load account information.");
        }
        setHistory(historyData.statusHistory);
        setBilling(billingData.billing);
        setLedger(billingData.ledger);
        setWaiverRequests(waiverData.waiverRequests);
        setReconnectionRequests(reconnectionData.reconnectionRequests);
        setOltAccountActions(capabilityData.oltAccountActions);
      } catch (loadError) {
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Could not load account history."
        );
      } finally {
        setLoading(false);
      }
  }, [canManage, customerId]);

  useEffect(() => { loadAccountData(); }, [loadAccountData]);

  // All three action dialogs submit through the same path. The API returns the
  // updated customer snapshot plus the history row committed with it.
  const submitAction = async () => {
    if (!action) return;
    try {
      setSaving(true);
      setError("");
      setNotice("");
      const details = actionDetails[action];
      const response = await apiFetch(
        `/api/customers/${customerId}/${details.endpoint}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason, confirmation }),
        }
      );
      const data = await response.json();
      if (!response.ok) {
        throw new Error(
          data.error || `Could not ${details.title.toLowerCase()}.`
        );
      }

      if (data.approvalRequired) {
        setNotice("The unpaid reconnection request was sent to Admin for review. The account remains disconnected.");
        await loadAccountData();
      } else {
        onStatusChanged(data.customer);
        // Update the visible timeline immediately without another round trip.
        setHistory((current) => [data.statusHistory, ...current]);
        if (data.ontAction?.message) setNotice(data.ontAction.message);
      }
      setAction(null);
      setReason("");
      setConfirmation("");
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
    setConfirmation("");
    setError("");
    setNotice("");
    setAction(nextAction);
  };

  const actionUsesOlt =
    oltAccountActions?.integrated === true &&
    (action === "deactivate" || action === "reconnect");
  const requiredConfirmation = action === "deactivate"
    ? `DEACTIVATE ${customerId}`
    : `RECONNECT ${customerId}`;

  // Management passes require an exact date or amount plus a permanent reason.
  const submitException = async () => {
    if (!exceptionAction) return;
    try {
      setSaving(true);
      setError("");
      const endpoint = exceptionAction === "hold" ? "disconnection-holds" : "waiver-requests";
      const body = exceptionAction === "hold"
        ? { expiresOn: exceptionValue, reason: exceptionReason }
        : { amount: exceptionValue, reason: exceptionReason };
      const response = await apiFetch(`/api/customers/${customerId}/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not save management pass.");
      setExceptionAction(null);
      setExceptionValue("");
      setExceptionReason("");
      await loadAccountData();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save management pass.");
    } finally {
      setSaving(false);
    }
  };

  const pendingWaiverRequest = waiverRequests.find((request) => request.status === "pending");
  const reversibleWaivers = waiverRequests.filter((request) => request.status === "approved");
  const pendingReconnectionRequest = reconnectionRequests.find((request) => request.status === "pending");

  const reverseWaiver = async (waiverRequestId: number) => {
    const reason = window.prompt("Why are you reversing this approved discount?");
    if (reason === null) return;
    if (reason.trim().length < 3) {
      setError("Enter a reversal reason of at least 3 characters.");
      return;
    }
    if (!window.confirm("Restore the waived amount to this customer's outstanding balance?")) return;

    try {
      setReversingWaiverId(waiverRequestId);
      setError("");
      setNotice("");
      const response = await apiFetch(`/api/waiver-requests/${waiverRequestId}/reverse`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not reverse approved discount.");
      if (data.customer) onStatusChanged(data.customer);
      setNotice(`The J$${Number(data.reversal.amount).toLocaleString()} discount was reversed and restored to the account balance.`);
      await loadAccountData();
    } catch (reverseError) {
      setError(reverseError instanceof Error ? reverseError.message : "Could not reverse approved discount.");
    } finally {
      setReversingWaiverId(null);
    }
  };

  return (
    <>
      <section className="rounded-2xl bg-surface-container-lowest p-6 shadow-sm lg:p-7">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-surface-container pb-5">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <span className="material-symbols-outlined">manage_accounts</span>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-on-surface-variant">
                Account Operations
              </p>
              <p className="mt-1 text-sm text-on-surface-variant">
                Status, billing position, and account actions
              </p>
            </div>
            <StatusBadge status={status} />
          </div>
          <div className="flex flex-wrap gap-2">
            {/* Role and current status together determine the next legal action. */}
            {status === "active" && canManage && (
              <ActionButton
                label="Deactivate"
                icon="link_off"
                destructive
                disabled={oltAccountActions?.integrated === true && !oltAccountActions.ready}
                title={oltAccountActions?.integrated === true && !oltAccountActions.ready
                  ? oltAccountActions.reason || "Verify the OLT mapping first."
                  : undefined}
                onClick={() => startAction("deactivate")}
              />
            )}
            {status === "disconnected" && !pendingReconnectionRequest && (
              <ActionButton
                label="Request Reconnection"
                icon="add_task"
                onClick={() => startAction("request-reconnection")}
              />
            )}
            {status === "pending_reconnection" && canManage && (
              <>
                <ActionButton
                  label={billing && Number(billing.outstanding_balance) <= 0 ? "Confirm Reconnection" : "Balance Outstanding"}
                  icon="sync"
                  disabled={!billing || Number(billing.outstanding_balance) > 0 || (oltAccountActions?.integrated === true && !oltAccountActions.ready)}
                  title={billing && Number(billing.outstanding_balance) > 0
                    ? "The outstanding balance must be cleared before service can be reconnected."
                    : oltAccountActions?.integrated === true && !oltAccountActions.ready
                      ? oltAccountActions.reason || "Verify the OLT mapping first."
                      : undefined}
                  onClick={() => startAction("reconnect")}
                />
                <ActionButton
                  label="Cancel Pending"
                  icon="cancel"
                  destructive
                  onClick={() => startAction("cancel-reconnection")}
                />
              </>
            )}
            {canManage && (
              <ActionButton
                label="Hold Until Date"
                icon="event_busy"
                onClick={() => {
                  setExceptionAction("hold");
                  setExceptionValue("");
                  setExceptionReason("");
                }}
              />
            )}
            {canManage && !pendingWaiverRequest && (
              <ActionButton
                label="Request Discount"
                icon="money_off"
                onClick={() => {
                  setExceptionAction("waiver");
                  setExceptionValue("");
                  setExceptionReason("");
                }}
              />
            )}
          </div>
        </div>

        {error && !action && (
          <p className="mt-4 rounded-lg bg-error/10 p-3 text-sm text-error">
            {error}
          </p>
        )}
        {notice && !action && (
          <p className="mt-4 rounded-lg bg-primary/10 p-3 text-sm text-primary">
            {notice}
          </p>
        )}
        {pendingReconnectionRequest && status === "disconnected" && (
          <div className="mt-4 flex flex-col gap-2 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-semibold">Unpaid reconnection awaiting Admin review</p>
              <p className="mt-1 text-xs">
                Requested with J${Number(pendingReconnectionRequest.outstanding_balance_snapshot).toLocaleString()} outstanding: {pendingReconnectionRequest.reason}
              </p>
            </div>
            <span className="whitespace-nowrap text-xs font-bold uppercase tracking-wider">Account remains disconnected</span>
          </div>
        )}
        {pendingWaiverRequest && (
          <div className="mt-4 flex flex-col gap-2 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-semibold">Discount approval pending</p>
              <p className="mt-1 text-xs">
                J${Number(pendingWaiverRequest.amount).toLocaleString()} requested by {pendingWaiverRequest.requested_by_name || "Management"}: {pendingWaiverRequest.reason}
              </p>
            </div>
            <span className="whitespace-nowrap text-xs font-bold uppercase tracking-wider">Admin review required</span>
          </div>
        )}
        {reversibleWaivers.map((request) => (
          <div key={request.waiver_request_id} className="mt-4 flex flex-col gap-3 rounded-xl border border-primary/20 bg-primary/5 p-4 text-sm sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-semibold text-on-surface">Approved discount · J${Number(request.amount).toLocaleString()}</p>
              <p className="mt-1 text-xs text-on-surface-variant">
                Approved by {request.reviewed_by_name || "Admin"}: {request.reason}
              </p>
            </div>
            {employeeRole === "admin" && (
              <button
                type="button"
                disabled={reversingWaiverId !== null}
                onClick={() => reverseWaiver(request.waiver_request_id)}
                className="whitespace-nowrap rounded-lg bg-error/10 px-3 py-2 text-xs font-semibold text-error disabled:opacity-50"
              >
                {reversingWaiverId === request.waiver_request_id ? "Reversing..." : "Reverse Discount"}
              </button>
            )}
          </div>
        ))}
        {billing && (
          <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
            {/* Balance and dates explain exactly why an account is delinquent. */}
            <BillingFact label="Outstanding" value={formatCurrency(billing.outstanding_balance)} />
            <BillingFact label="Credit" value={formatCurrency(billing.credit_balance)} />
            <BillingFact label="Grace Ends" value={billing.grace_end_date ? formatDate(billing.grace_end_date) : "—"} />
            <BillingFact label="Disconnect On" value={billing.scheduled_disconnection_date ? formatDate(billing.scheduled_disconnection_date) : "—"} />
            {billing.is_on_hold && (
              <p className="rounded-lg bg-warning-container p-3 text-xs font-semibold text-warning sm:col-span-2 lg:col-span-4">
                Disconnection pass active through {billing.hold_expires_on ? formatDate(billing.hold_expires_on) : "the approved date"}.
              </p>
            )}
            {billing.unverified_entries > 0 && (
              <p className="rounded-lg bg-surface-container p-3 text-xs text-on-surface-variant sm:col-span-2 lg:col-span-4">
                {billing.unverified_entries} legacy balance entr{billing.unverified_entries === 1 ? "y is" : "ies are"} estimated and awaiting verification.
              </p>
            )}
          </div>
        )}
        {loading ? (
          <p className="py-8 text-center text-sm text-on-surface-variant">
            Loading account history...
          </p>
        ) : history.length > 0 ? (
          <div className="mt-6">
            <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-on-surface-variant">
              Recent Status History
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
            {/* Keep the profile compact while the API retains the full history. */}
            {history.slice(0, 4).map((item) => (
              <div key={item.account_status_history_id} className="rounded-xl border border-surface-container bg-surface-container-low p-4">
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
          </div>
        ) : (
          <p className="py-8 text-center text-sm text-on-surface-variant">
            No account status history yet.
          </p>
        )}
        {ledger.length > 0 && (
          <details className="mt-6 border-t border-surface-container pt-4">
            <summary className="cursor-pointer text-sm font-medium text-primary">Recent balance entries</summary>
            <div className="mt-3 space-y-2">
              {ledger.slice(0, 8).map((entry) => (
                <div key={entry.account_ledger_entry_id} className="flex items-start justify-between gap-4 text-xs">
                  <div><p className="font-semibold text-on-surface">{entry.description}</p><p className="text-on-surface-variant">{formatDate(entry.effective_date)}{entry.is_verified ? "" : " · Legacy estimate"}</p></div>
                  <span className={Number(entry.amount) < 0 ? "font-medium text-tertiary" : "font-medium text-on-surface"}>{formatSignedCurrency(entry.amount)}</span>
                </div>
              ))}
            </div>
          </details>
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
            <h2 className="text-xl font-semibold text-on-surface">
              {actionDetails[action].title}
            </h2>
            <p className="mt-2 text-sm text-on-surface-variant">
              {actionUsesOlt
                ? "The backend will re-check the saved customer, ONT serial, and OLT location. It will confirm the physical ONT state before updating the account database."
                : "This change becomes permanent account history and is recorded in Activity History."}
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
                className="mt-1.5 w-full resize-none rounded-lg border border-outline-variant bg-white px-3 py-2.5 text-sm focus:border-primary"
              />
            </label>
            {actionUsesOlt && (
              <label className="mt-4 block text-sm font-semibold text-on-surface">
                Type <span className="font-mono text-error">{requiredConfirmation}</span> to confirm
                <input
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  autoComplete="off"
                  className="mt-1.5 w-full rounded-lg border border-outline-variant bg-white px-3 py-2.5 font-mono text-sm focus:border-primary"
                />
              </label>
            )}
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
                  setConfirmation("");
                  setError("");
                }}
                className="rounded-lg bg-surface-container px-5 py-2.5 text-sm font-medium text-on-surface-variant disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={saving || reason.trim().length < 3 || (actionUsesOlt && confirmation !== requiredConfirmation)}
                onClick={submitAction}
                className={`rounded-lg px-5 py-2.5 text-sm font-medium text-white disabled:opacity-50 ${
                  actionDetails[action].destructive ? "bg-error" : "bg-primary"
                }`}
              >
                {saving ? "Saving..." : actionDetails[action].button}
              </button>
            </div>
          </div>
        </div>
      )}

      {exceptionAction && (
        // Waivers become pending requests; only the Admin queue can apply them.
        <div className="fixed inset-0 z-[60] flex items-center justify-center overflow-y-auto bg-black/45 p-4" role="dialog" aria-modal="true">
          <div className="my-auto max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-y-auto rounded-2xl bg-surface-container-lowest p-6 shadow-2xl">
            <h2 className="text-xl font-semibold text-on-surface">
              {exceptionAction === "hold" ? "Postpone disconnection" : "Request balance discount"}
            </h2>
            <p className="mt-2 text-sm text-on-surface-variant">
              {exceptionAction === "hold"
                ? "A reason is required and will be recorded in Activity History."
                : "Submitting this request does not change the balance. An Admin must review it and choose Approve & Apply."}
            </p>

            <label className="mt-5 block text-sm font-semibold text-on-surface">
              {exceptionAction === "hold" ? "Hold until" : "Waiver amount"}
              <input
                type={exceptionAction === "hold" ? "date" : "number"}
                min={exceptionAction === "hold" ? jamaicaToday() : "0.01"}
                step={exceptionAction === "hold" ? undefined : "0.01"}
                value={exceptionValue}
                onChange={(event) => setExceptionValue(event.target.value)}
                className="mt-1.5 w-full rounded-lg border border-outline-variant bg-white px-3 py-2.5 text-sm"
              />
            </label>

            <label className="mt-4 block text-sm font-semibold text-on-surface">
              Reason <span className="text-error">*</span>
              <textarea
                rows={4}
                maxLength={500}
                value={exceptionReason}
                onChange={(event) => setExceptionReason(event.target.value)}
                className="mt-1.5 w-full resize-none rounded-lg border border-outline-variant bg-white px-3 py-2.5 text-sm"
                placeholder={exceptionAction === "hold" ? "Why is this pass being approved?" : "Why should this customer receive a discount?"}
              />
            </label>

            {exceptionAction === "waiver" && (
              <div className="mt-4 rounded-xl border border-primary/20 bg-primary/5 p-4">
                <p className="text-sm font-semibold text-primary">Admin approval required</p>
                <p className="mt-1 text-xs text-on-surface-variant">
                  The request will appear in the Admin-only Discount Approvals queue. Activity History records both the requester and reviewer.
                </p>
              </div>
            )}

            {error && <p className="mt-3 rounded-lg bg-error/10 p-3 text-sm text-error">{error}</p>}
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                disabled={saving}
                onClick={() => {
                  setExceptionAction(null);
                  setError("");
                }}
                className="rounded-lg bg-surface-container px-5 py-2.5 text-sm font-medium disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={
                  saving ||
                  !exceptionValue ||
                  exceptionReason.trim().length < 3
                }
                onClick={submitException}
                className="rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-on-primary disabled:opacity-50"
              >
                {saving ? "Saving..." : exceptionAction === "waiver" ? "Send for Admin Approval" : "Approve Pass"}
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
  disabled = false,
  title,
}: {
  label: string;
  icon: string;
  onClick: () => void;
  destructive?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={`flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${
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

function BillingFact({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg bg-surface-container-low p-3"><p className="text-[10px] font-semibold uppercase tracking-wider text-on-surface-variant">{label}</p><p className="mt-1 text-sm font-medium text-on-surface">{value}</p></div>;
}

function StatusBadge({ status }: { status: AccountStatus }) {
  const styles: Record<AccountStatus, string> = {
    active: "bg-tertiary/10 text-tertiary",
    disconnected: "bg-error/10 text-error",
    pending_reconnection: "bg-warning-container text-warning",
    closed: "bg-surface-container-high text-on-surface-variant",
    archived: "bg-surface-container-high text-on-surface-variant",
  };
  return (
    <span
      className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${styles[status]}`}
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

function formatCurrency(value: unknown) {
  return `J$${Number(value || 0).toLocaleString("en-JM", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatSignedCurrency(value: unknown) {
  const amount = Number(value || 0);
  return `${amount < 0 ? "−" : "+"}${formatCurrency(Math.abs(amount))}`;
}

function jamaicaToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Jamaica", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

export default AccountOperationsPanel;
