/** Lists customer account states and opens the status-operation panel for a selected account. */
import { useCallback, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useAuth } from "../auth/AuthContext";
import { apiFetch } from "../lib/api";
import { useScrollRestoration } from "../hooks/useScrollRestoration";

// MVP 3 queue page for finding accounts that need a service-status decision.
// Status-changing actions stay on the customer profile so the operator can
// review the full account before changing service.
type AccountStatus =
  | "active"
  | "disconnected"
  | "pending_reconnection"
  | "closed"
  | "archived";

type AccountRecord = {
  customer_id: number;
  name: string | null;
  address: string | null;
  telephone: string | null;
  status: AccountStatus;
  monthly_fee: string | null;
  package_name: string | null;
  activation_date: string | null;
  deactivation_date: string | null;
  reactivation_date: string | null;
  latest_status_reason: string | null;
  latest_status_date: string | null;
  outstanding_balance: string;
  ready_for_reconnection: boolean;
  automatic_reconnection_enabled: boolean;
  automatic_reconnection_status: string | null;
  automatic_reconnection_message: string | null;
  automatic_reconnection_attempt_count: number | null;
};

type AccountSummary = {
  active?: number;
  disconnected: number;
  pending_reconnection: number;
};

type WaiverApprovalRequest = {
  waiver_request_id: number;
  customer_id: number;
  customer_name: string | null;
  telephone: string | null;
  amount: string;
  reason: string;
  status: "pending";
  requested_at: string;
  requested_by_name: string | null;
  outstanding_balance: string;
};

type ReconnectionApprovalRequest = {
  reconnection_request_id: number;
  customer_id: number;
  customer_name: string | null;
  telephone: string | null;
  customer_status: AccountStatus;
  outstanding_balance_snapshot: string;
  outstanding_balance: string;
  reason: string;
  status: "pending";
  requested_at: string;
  requested_by_name: string | null;
};

type Pagination = {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
};

type AccountView =
  | "attention"
  | "pending_reconnection"
  | "disconnected"
  | "active"
  | "all";

const emptySummary: AccountSummary = {
  active: 0,
  disconnected: 0,
  pending_reconnection: 0,
};

const emptyPagination: Pagination = {
  page: 1,
  limit: 10,
  total: 0,
  totalPages: 1,
};

function automaticReconnectLabel(status: string | null) {
  if (status === "failed") return "Automatic reconnect needs attention";
  if (status === "uncertain") return "Check the OLT before retrying";
  if (status?.startsWith("blocked")) return "Automatic reconnect blocked";
  if (status === "waiting_balance") return "Waiting for clear balance";
  return "Automatic reconnect queued";
}

function AccountOperationsPage() {
  const navigate = useNavigate();
  const { employee } = useAuth();
  const isAdmin = employee?.role === "admin";
  // Kept in the URL rather than component state, so the browser back button
  // restores the exact view, search, and page someone was on instead of
  // resetting to the first page of the default view.
  const [searchParams, setSearchParams] = useSearchParams();
  const [accounts, setAccounts] = useState<AccountRecord[]>([]);
  const [summary, setSummary] = useState<AccountSummary>(emptySummary);
  const [pagination, setPagination] = useState<Pagination>(emptyPagination);
  const requestedView = (searchParams.get("view") as AccountView) || "attention";
  const view: AccountView =
    !isAdmin && ["active", "all"].includes(requestedView) ? "attention" : requestedView;
  const search = searchParams.get("search") ?? "";
  const page = Math.max(Number.parseInt(searchParams.get("page") ?? "1", 10) || 1, 1);
  const updateParams = (
    patch: Partial<Record<"view" | "search" | "page", string | null>>
  ) => {
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
  };
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [approvingCustomerId, setApprovingCustomerId] = useState<number | null>(null);
  const [cancellingCustomerId, setCancellingCustomerId] = useState<number | null>(null);
  const [waiverRequests, setWaiverRequests] = useState<WaiverApprovalRequest[]>([]);
  const [reviewingWaiverId, setReviewingWaiverId] = useState<number | null>(null);
  const [reconnectionRequests, setReconnectionRequests] = useState<ReconnectionApprovalRequest[]>([]);
  const [reviewingReconnectionId, setReviewingReconnectionId] = useState<number | null>(null);
  const canApprove = employee?.role === "admin" || employee?.role === "head_office";
  useScrollRestoration(!loading);

  // The server owns filtering and pagination because the customer table is too
  // large to load into the browser as one list.
  const loadAccounts = useCallback(async () => {
    try {
      setLoading(true);
      setError("");
      const response = await apiFetch(
        `/api/account-operations?view=${view}&search=${encodeURIComponent(search)}&page=${page}`
      );
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Could not load account operations.");
      }

      setAccounts(data.accounts);
      setSummary(data.summary);
      setPagination(data.pagination);
      if (data.pagination.page !== page) updateParams({ page: String(data.pagination.page) });
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Could not load account operations."
      );
    } finally {
      setLoading(false);
    }
  }, [page, search, view]);

  const loadWaiverRequests = useCallback(async () => {
    if (!isAdmin) return;
    try {
      const response = await apiFetch("/api/waiver-requests");
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load discount approvals.");
      setWaiverRequests(data.waiverRequests);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load discount approvals.");
    }
  }, [isAdmin]);

  const loadReconnectionRequests = useCallback(async () => {
    if (!isAdmin) return;
    try {
      const response = await apiFetch("/api/reconnection-requests");
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load reconnection approvals.");
      setReconnectionRequests(data.reconnectionRequests);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load reconnection approvals.");
    }
  }, [isAdmin]);

  const reviewWaiverRequest = async (
    waiverRequestId: number,
    decision: "approve" | "reject"
  ) => {
    let reviewNote = "";
    if (decision === "reject") {
      const enteredReason = window.prompt("Why is this discount request being rejected?");
      if (enteredReason === null) return;
      reviewNote = enteredReason.trim();
      if (reviewNote.length < 3) {
        setError("Enter a rejection reason of at least 3 characters.");
        return;
      }
    } else if (!window.confirm("Approve and immediately apply this balance discount?")) {
      return;
    }

    try {
      setReviewingWaiverId(waiverRequestId);
      setError("");
      const response = await apiFetch(`/api/waiver-requests/${waiverRequestId}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, reviewNote }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not review discount request.");
      await Promise.all([loadWaiverRequests(), loadAccounts()]);
    } catch (reviewError) {
      setError(reviewError instanceof Error ? reviewError.message : "Could not review discount request.");
    } finally {
      setReviewingWaiverId(null);
    }
  };

  const reviewReconnectionRequest = async (
    reconnectionRequestId: number,
    decision: "approve" | "reject"
  ) => {
    let reviewNote = "";
    if (decision === "reject") {
      const enteredReason = window.prompt("Why should this account remain disconnected?");
      if (enteredReason === null) return;
      reviewNote = enteredReason.trim();
      if (reviewNote.length < 3) {
        setError("Enter a rejection reason of at least 3 characters.");
        return;
      }
    } else if (!window.confirm("Approve placing this unpaid account into Pending Reconnection? This will not activate service.")) {
      return;
    }

    try {
      setReviewingReconnectionId(reconnectionRequestId);
      setError("");
      const response = await apiFetch(`/api/reconnection-requests/${reconnectionRequestId}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, reviewNote }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not review reconnection request.");
      await Promise.all([loadReconnectionRequests(), loadAccounts()]);
    } catch (reviewError) {
      setError(reviewError instanceof Error ? reviewError.message : "Could not review reconnection request.");
    } finally {
      setReviewingReconnectionId(null);
    }
  };

  const cancelPendingReconnection = async (customerId: number) => {
    const reason = window.prompt("Why should this account remain disconnected?");
    if (reason === null) return;
    if (reason.trim().length < 3) {
      setError("Enter a cancellation reason of at least 3 characters.");
      return;
    }
    try {
      setCancellingCustomerId(customerId);
      setError("");
      const response = await apiFetch(`/api/customers/${customerId}/cancel-reconnection`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not cancel pending reconnection.");
      await loadAccounts();
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : "Could not cancel pending reconnection.");
    } finally {
      setCancellingCustomerId(null);
    }
  };

  // Manual fallback for customers outside automation or a deliberate Admin
  // balance override. Eligible integrated accounts are handled by the worker.
  const approveReconnection = async (
    customerId: number,
    adminBalanceOverride = false
  ) => {
    let reason = "Manager checkbox approval after full balance and reconnection fee verification";
    if (adminBalanceOverride) {
      const enteredReason = window.prompt(
        "Why should service be reconnected before this balance is cleared? This reason is permanently audited."
      );
      if (enteredReason === null) return;
      reason = enteredReason.trim();
      if (reason.length < 3) {
        setError("Enter an Admin override reason of at least 3 characters.");
        return;
      }
      if (!window.confirm(
        "Reconnect service without clearing the balance? The balance remains, and the account may be disconnected again unless a hold or valid discount is added."
      )) return;
    }

    try {
      setApprovingCustomerId(customerId);
      setError("");
      const response = await apiFetch(`/api/customers/${customerId}/reconnect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reason,
          adminBalanceOverride,
          // Reconnection is restorative, but the backend still requires the
          // same customer-specific confirmation used on the profile dialog.
          confirmation: `RECONNECT ${customerId}`,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not approve reconnection.");
      await loadAccounts();
    } catch (approvalError) {
      setError(approvalError instanceof Error ? approvalError.message : "Could not approve reconnection.");
    } finally {
      setApprovingCustomerId(null);
    }
  };

  // Small debounce keeps typing in the search field from firing a request for
  // every individual keystroke.
  useEffect(() => {
    const timeout = window.setTimeout(loadAccounts, 180);
    return () => window.clearTimeout(timeout);
  }, [loadAccounts]);

  useEffect(() => {
    loadWaiverRequests();
  }, [loadWaiverRequests]);

  useEffect(() => {
    loadReconnectionRequests();
  }, [loadReconnectionRequests]);

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 py-6 lg:px-8 lg:py-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-on-surface">
          Account Operations
        </h1>
        <p className="mt-1 text-sm text-on-surface-variant">
          Review disconnected accounts and manage the reconnection queue.
        </p>
      </div>

      {isAdmin && (
        <section className="overflow-hidden rounded-2xl border border-primary/15 bg-surface-container-lowest shadow-sm">
          <div className="flex items-center justify-between border-b border-surface-container px-5 py-4">
            <div>
              <h2 className="font-semibold text-on-surface">Pending Discount Approvals</h2>
              <p className="mt-1 text-xs text-on-surface-variant">Review the customer, amount, and employee reason before applying a waiver.</p>
            </div>
            <span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
              {waiverRequests.length} pending
            </span>
          </div>

          {waiverRequests.length === 0 ? (
            <div className="px-5 py-7 text-center text-sm text-on-surface-variant">No discount requests are waiting.</div>
          ) : (
            <div className="divide-y divide-surface-container">
              {waiverRequests.map((request) => (
                <div key={request.waiver_request_id} className="grid gap-4 px-5 py-4 lg:grid-cols-[1.2fr_0.7fr_1.5fr_auto] lg:items-center">
                  <div>
                    <button type="button" onClick={() => navigate(`/customers/${request.customer_id}`)} className="font-semibold text-primary hover:underline">
                      {request.customer_name || `Customer #${request.customer_id}`}
                    </button>
                    <p className="mt-1 text-xs text-on-surface-variant">#{request.customer_id} · {request.telephone || "No telephone"}</p>
                  </div>
                  <div>
                    <p className="text-lg font-semibold text-on-surface">{formatCurrency(request.amount)}</p>
                    <p className="text-xs text-on-surface-variant">Outstanding {formatCurrency(request.outstanding_balance)}</p>
                  </div>
                  <div>
                    <p className="text-sm text-on-surface">{request.reason}</p>
                    <p className="mt-1 text-xs text-on-surface-variant">
                      Requested by {request.requested_by_name || "Unknown employee"} · {formatDateTime(request.requested_at)}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2 lg:justify-end">
                    <button
                      type="button"
                      disabled={reviewingWaiverId !== null}
                      onClick={() => reviewWaiverRequest(request.waiver_request_id, "approve")}
                      className="flex items-center gap-1 rounded-lg bg-tertiary px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
                    >
                      <span className="material-symbols-outlined text-base">check</span>
                      {reviewingWaiverId === request.waiver_request_id ? "Applying..." : "Approve & Apply"}
                    </button>
                    <button
                      type="button"
                      disabled={reviewingWaiverId !== null}
                      onClick={() => reviewWaiverRequest(request.waiver_request_id, "reject")}
                      className="rounded-lg bg-error/10 px-3 py-2 text-xs font-semibold text-error disabled:opacity-50"
                    >
                      Reject
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {isAdmin && (
        <section className="overflow-hidden rounded-2xl border border-amber-200 bg-surface-container-lowest shadow-sm">
          <div className="flex items-center justify-between border-b border-surface-container px-5 py-4">
            <div>
              <h2 className="font-semibold text-on-surface">Unpaid Reconnection Requests</h2>
              <p className="mt-1 text-xs text-on-surface-variant">Approval adds the account to Pending Reconnection but does not activate service or bypass the final balance check.</p>
            </div>
            <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-900">
              {reconnectionRequests.length} pending
            </span>
          </div>

          {reconnectionRequests.length === 0 ? (
            <div className="px-5 py-7 text-center text-sm text-on-surface-variant">No unpaid reconnection requests are waiting.</div>
          ) : (
            <div className="divide-y divide-surface-container">
              {reconnectionRequests.map((request) => (
                <div key={request.reconnection_request_id} className="grid gap-4 px-5 py-4 lg:grid-cols-[1.2fr_0.8fr_1.5fr_auto] lg:items-center">
                  <div>
                    <button type="button" onClick={() => navigate(`/customers/${request.customer_id}`)} className="font-semibold text-primary hover:underline">
                      {request.customer_name || `Customer #${request.customer_id}`}
                    </button>
                    <p className="mt-1 text-xs text-on-surface-variant">#{request.customer_id} · {request.telephone || "No telephone"}</p>
                  </div>
                  <div>
                    <p className="text-lg font-semibold text-error">{formatCurrency(request.outstanding_balance)}</p>
                    <p className="text-xs text-on-surface-variant">At request: {formatCurrency(request.outstanding_balance_snapshot)}</p>
                  </div>
                  <div>
                    <p className="text-sm text-on-surface">{request.reason}</p>
                    <p className="mt-1 text-xs text-on-surface-variant">
                      Requested by {request.requested_by_name || "Unknown employee"} · {formatDateTime(request.requested_at)}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2 lg:justify-end">
                    <button
                      type="button"
                      disabled={reviewingReconnectionId !== null}
                      onClick={() => reviewReconnectionRequest(request.reconnection_request_id, "approve")}
                      className="flex items-center gap-1 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-on-primary disabled:opacity-50"
                    >
                      <span className="material-symbols-outlined text-base">playlist_add_check</span>
                      {reviewingReconnectionId === request.reconnection_request_id ? "Approving..." : "Approve Queue Entry"}
                    </button>
                    <button
                      type="button"
                      disabled={reviewingReconnectionId !== null}
                      onClick={() => reviewReconnectionRequest(request.reconnection_request_id, "reject")}
                      className="rounded-lg bg-error/10 px-3 py-2 text-xs font-semibold text-error disabled:opacity-50"
                    >
                      Decline
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      <div className={`grid grid-cols-1 gap-4 ${isAdmin ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}>
        {isAdmin && (
          <SummaryCard label="Active" value={summary.active ?? 0} icon="check_circle" tone="positive" />
        )}
        <SummaryCard label="Disconnected" value={summary.disconnected} icon="link_off" tone="negative" />
        <SummaryCard label="Pending Reconnection" value={summary.pending_reconnection} icon="sync" tone="warning" />
      </div>

      <section className="overflow-hidden rounded-2xl bg-surface-container-lowest shadow-sm">
        <div className="flex flex-col gap-3 border-b border-surface-container px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap gap-2">
            {(
              // Each tab maps directly to a server-side status filter.
              [
                ["attention", "Needs Attention"],
                ["pending_reconnection", "Reconnection Queue"],
                ["disconnected", "Disconnected"],
                ...(isAdmin
                  ? ([
                      ["active", "Active"],
                      ["all", "All"],
                    ] as Array<[AccountView, string]>)
                  : []),
              ] as Array<[AccountView, string]>
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => updateParams({ view: value, page: null })}
                className={
                  view === value
                    ? "rounded-full bg-primary px-4 py-2 text-xs font-medium text-on-primary"
                    : "rounded-full bg-surface-container px-4 py-2 text-xs font-medium text-on-surface-variant transition hover:bg-surface-container-high"
                }
              >
                {label}
              </button>
            ))}
          </div>

          <div className="relative w-full lg:w-80">
            <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-outline">
              search
            </span>
            <input
              value={search}
              onChange={(event) => updateParams({ search: event.target.value || null, page: null })}
              placeholder="Search customer, ID, phone, address..."
              className="w-full rounded-lg bg-surface-container-low py-2.5 pl-10 pr-4 text-sm"
            />
          </div>
        </div>

        {error && (
          <div className="m-6 rounded-lg bg-error/10 p-4 text-sm text-error">
            {error}
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead className="bg-surface-container-low">
              <tr>
                <TableHeading>Customer</TableHeading>
                <TableHeading>Package</TableHeading>
                <TableHeading>Status</TableHeading>
                <TableHeading>Status Date</TableHeading>
                <TableHeading>Latest Note</TableHeading>
                <TableHeading>Reconnection</TableHeading>
                <th className="px-6 py-4 text-right text-xs font-semibold uppercase tracking-wider text-on-surface-variant">
                  Account
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-container">
              {!loading &&
                accounts.map((account) => (
                  // The whole row opens the profile; the explicit Open button
                  // is retained for discoverability and keyboard users.
                  <tr
                    key={account.customer_id}
                    className="cursor-pointer transition hover:bg-surface-container-low/60"
                    onClick={() => navigate(`/customers/${account.customer_id}`)}
                  >
                    <td className="px-6 py-4">
                      <p className="font-semibold text-on-surface">
                        {account.name || "Unnamed customer"}
                      </p>
                      <p className="mt-1 text-xs text-on-surface-variant">
                        #{account.customer_id} · {account.telephone || "No telephone"}
                      </p>
                    </td>
                    <td className="px-6 py-4 text-sm text-on-surface-variant">
                      <p>{account.package_name || "No package"}</p>
                      <p className="mt-1 text-xs">{formatCurrency(account.monthly_fee)}</p>
                    </td>
                    <td className="px-6 py-4">
                      <StatusBadge status={account.status} />
                    </td>
                    <td className="whitespace-nowrap px-6 py-4 text-sm text-on-surface-variant">
                      {formatDate(account.latest_status_date)}
                    </td>
                    <td className="max-w-xs px-6 py-4 text-sm text-on-surface-variant">
                      <p className="line-clamp-2">{account.latest_status_reason || "—"}</p>
                    </td>
                    <td className="px-6 py-4" onClick={(event) => event.stopPropagation()}>
                      {account.status === "pending_reconnection" && canApprove ? (
                        <div className="flex min-w-40 flex-col items-start gap-2">
                          {account.ready_for_reconnection && account.automatic_reconnection_enabled ? (
                            <div className="max-w-64 text-xs">
                              <p className="font-semibold text-primary">
                                {automaticReconnectLabel(account.automatic_reconnection_status)}
                              </p>
                              <p className="mt-1 text-on-surface-variant">
                                {account.automatic_reconnection_message ||
                                  "The system will verify the live ONT, activate it if needed, and synchronize this account."}
                              </p>
                            </div>
                          ) : account.ready_for_reconnection ? (
                            <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-medium text-primary" title="Approve reconnection">
                              <input
                                type="checkbox"
                                checked={false}
                                disabled={approvingCustomerId !== null || cancellingCustomerId !== null}
                                onChange={() => approveReconnection(account.customer_id)}
                                className="h-5 w-5 rounded border-outline-variant text-primary focus:ring-primary"
                              />
                              {approvingCustomerId === account.customer_id
                                ? "Approving..."
                                : "Confirm Reconnection"}
                            </label>
                          ) : isAdmin ? (
                            <button
                              type="button"
                              disabled={approvingCustomerId !== null || cancellingCustomerId !== null}
                              onClick={() => approveReconnection(account.customer_id, true)}
                              className="rounded-lg bg-amber-100 px-3 py-2 text-xs font-semibold text-amber-950 disabled:opacity-50"
                              title="Reconnect service without clearing the balance; permanently audited"
                            >
                              {approvingCustomerId === account.customer_id
                                ? "Reconnecting..."
                                : "Admin Reconnect"}
                            </button>
                          ) : (
                            <span className="text-xs font-medium text-on-surface-variant" title="Outstanding balance must be cleared first">
                              Balance Outstanding
                            </span>
                          )}
                          <button
                            type="button"
                            disabled={approvingCustomerId !== null || cancellingCustomerId !== null}
                            onClick={() => cancelPendingReconnection(account.customer_id)}
                            className="text-xs font-semibold text-error hover:underline disabled:opacity-50"
                          >
                            {cancellingCustomerId === account.customer_id ? "Cancelling..." : "Cancel Pending"}
                          </button>
                        </div>
                      ) : (
                        <span className="text-xs text-on-surface-variant">—</span>
                      )}
                    </td>
                    <td className="px-6 py-4 text-right">
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          navigate(`/customers/${account.customer_id}`);
                        }}
                        className="rounded-lg px-3 py-2 text-sm font-medium text-primary transition hover:bg-primary/10"
                      >
                        Open
                      </button>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>

        {loading && (
          <div className="px-6 py-14 text-center text-sm text-on-surface-variant">
            Loading account operations...
          </div>
        )}

        {!loading && !error && accounts.length === 0 && (
          <div className="px-6 py-14 text-center">
            <span className="material-symbols-outlined text-4xl text-outline">manage_accounts</span>
            <p className="mt-2 text-sm font-medium text-on-surface">No accounts found</p>
            <p className="mt-1 text-sm text-on-surface-variant">Try another status view or search.</p>
          </div>
        )}

        {!loading && accounts.length > 0 && (
          <div className="flex flex-col gap-3 border-t border-surface-container px-6 py-4 text-sm text-on-surface-variant sm:flex-row sm:items-center sm:justify-between">
            <p>
              Showing {(pagination.page - 1) * pagination.limit + 1}–
              {Math.min(pagination.page * pagination.limit, pagination.total)} of{" "}
              {pagination.total.toLocaleString()}
            </p>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => updateParams({ page: String(Math.max(page - 1, 1)) })}
                disabled={pagination.page <= 1}
                className="rounded-lg bg-surface-container px-3 py-2 text-xs font-medium text-on-surface transition hover:bg-surface-container-high disabled:cursor-not-allowed disabled:opacity-40"
              >
                Previous
              </button>
              <span className="min-w-24 text-center text-xs font-semibold">
                Page {pagination.page} of {pagination.totalPages}
              </span>
              <button
                type="button"
                onClick={() => updateParams({ page: String(Math.min(page + 1, pagination.totalPages)) })}
                disabled={pagination.page >= pagination.totalPages}
                className="rounded-lg bg-surface-container px-3 py-2 text-xs font-medium text-on-surface transition hover:bg-surface-container-high disabled:cursor-not-allowed disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function SummaryCard({ label, value, icon, tone }: { label: string; value: number; icon: string; tone: "positive" | "negative" | "warning" }) {
  // Tone distinguishes normal active volume from accounts needing attention.
  const tones = {
    positive: "bg-tertiary/10 text-tertiary",
    negative: "bg-error/10 text-error",
    warning: "bg-warning-container text-warning",
  };
  return (
    <div className="rounded-xl bg-surface-container-lowest p-5 shadow-sm">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-on-surface-variant">{label}</p>
          <p className="mt-2 text-3xl font-medium text-on-surface">{value.toLocaleString()}</p>
        </div>
        <span className={`material-symbols-outlined flex h-11 w-11 items-center justify-center rounded-lg ${tones[tone]}`}>
          {icon}
        </span>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: AccountStatus }) {
  // Reuse the same status language and colours used on the customer profile.
  const styles: Record<AccountStatus, string> = {
    active: "bg-tertiary/10 text-tertiary",
    disconnected: "bg-error/10 text-error",
    pending_reconnection: "bg-warning-container text-warning",
    closed: "bg-surface-container-high text-on-surface-variant",
    archived: "bg-surface-container-high text-on-surface-variant",
  };
  return (
    <span className={`inline-flex whitespace-nowrap rounded-full px-3 py-1 text-xs font-medium ${styles[status]}`}>
      {humanize(status)}
    </span>
  );
}

function TableHeading({ children }: { children: React.ReactNode }) {
  return <th className="px-6 py-4 text-xs font-semibold uppercase tracking-wider text-on-surface-variant">{children}</th>;
}

function humanize(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDate(value: string | null) {
  if (!value) return "—";
  // Date-only values are parsed at local midnight to prevent timezone shifts.
  const datePart = value.slice(0, 10);
  return new Date(`${datePart}T00:00:00`).toLocaleDateString("en-JM", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString("en-JM", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Jamaica",
  });
}

function formatCurrency(value: string | null) {
  if (!value) return "—";
  return `J$${Number(value).toLocaleString("en-JM", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export default AccountOperationsPage;
