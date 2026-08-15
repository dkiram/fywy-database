/** Lists customer account states and opens the status-operation panel for a selected account. */
import { useCallback, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { apiFetch } from "../lib/api";

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
};

type AccountSummary = {
  active: number;
  disconnected: number;
  pending_reconnection: number;
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

function AccountOperationsPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [accounts, setAccounts] = useState<AccountRecord[]>([]);
  const [summary, setSummary] = useState<AccountSummary>(emptySummary);
  const [pagination, setPagination] = useState<Pagination>(emptyPagination);
  const [view, setView] = useState<AccountView>(
    (searchParams.get("view") as AccountView) || "attention"
  );
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

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
      if (data.pagination.page !== page) setPage(data.pagination.page);
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

  // Small debounce keeps typing in the search field from firing a request for
  // every individual keystroke.
  useEffect(() => {
    const timeout = window.setTimeout(loadAccounts, 180);
    return () => window.clearTimeout(timeout);
  }, [loadAccounts]);

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 py-6 lg:px-8 lg:py-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-on-surface">
          Account Operations
        </h1>
        <p className="mt-1 text-sm text-on-surface-variant">
          Review disconnected accounts and manage the reconnection queue.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <SummaryCard label="Active" value={summary.active} icon="check_circle" tone="positive" />
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
                ["active", "Active"],
                ["all", "All"],
              ] as Array<[AccountView, string]>
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => {
                  setView(value);
                  setPage(1);
                }}
                className={
                  view === value
                    ? "rounded-full bg-primary px-4 py-2 text-xs font-bold text-on-primary"
                    : "rounded-full bg-surface-container px-4 py-2 text-xs font-bold text-on-surface-variant transition hover:bg-surface-container-high"
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
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
              placeholder="Search customer, ID, phone, address..."
              className="w-full rounded-lg bg-surface-container-low py-2.5 pl-10 pr-4 text-sm outline-none focus:ring-2 focus:ring-primary/20"
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
                <th className="px-6 py-4 text-right text-xs font-bold uppercase tracking-wider text-on-surface-variant">
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
                    <td className="px-6 py-4 text-right">
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          navigate(`/customers/${account.customer_id}`);
                        }}
                        className="rounded-lg px-3 py-2 text-sm font-bold text-primary transition hover:bg-primary/10"
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
                onClick={() => setPage((current) => Math.max(current - 1, 1))}
                disabled={pagination.page <= 1}
                className="rounded-lg bg-surface-container px-3 py-2 text-xs font-bold text-on-surface transition hover:bg-surface-container-high disabled:cursor-not-allowed disabled:opacity-40"
              >
                Previous
              </button>
              <span className="min-w-24 text-center text-xs font-semibold">
                Page {pagination.page} of {pagination.totalPages}
              </span>
              <button
                type="button"
                onClick={() => setPage((current) => Math.min(current + 1, pagination.totalPages))}
                disabled={pagination.page >= pagination.totalPages}
                className="rounded-lg bg-surface-container px-3 py-2 text-xs font-bold text-on-surface transition hover:bg-surface-container-high disabled:cursor-not-allowed disabled:opacity-40"
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
    warning: "bg-amber-100 text-amber-800",
  };
  return (
    <div className="rounded-xl bg-surface-container-lowest p-5 shadow-sm">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-on-surface-variant">{label}</p>
          <p className="mt-2 text-3xl font-bold text-on-surface">{value.toLocaleString()}</p>
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
    pending_reconnection: "bg-amber-100 text-amber-800",
    closed: "bg-surface-container-high text-on-surface-variant",
    archived: "bg-surface-container-high text-on-surface-variant",
  };
  return (
    <span className={`inline-flex whitespace-nowrap rounded-full px-3 py-1 text-xs font-bold ${styles[status]}`}>
      {humanize(status)}
    </span>
  );
}

function TableHeading({ children }: { children: React.ReactNode }) {
  return <th className="px-6 py-4 text-xs font-bold uppercase tracking-wider text-on-surface-variant">{children}</th>;
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

function formatCurrency(value: string | null) {
  if (!value) return "—";
  return `J$${Number(value).toLocaleString("en-JM", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export default AccountOperationsPage;
