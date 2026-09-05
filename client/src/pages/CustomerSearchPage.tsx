/** Searches the customer directory and links each result to its full profile. */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { apiFetch } from "../lib/api";

type Customer = {
  customer_id: number;
  name: string | null;
  address: string | null;
  telephone: string | null;
  status: string;
  monthly_fee: string | null;
  package_id: number | null;
  package_name: string | null;
  account_count: number;
  account_ids: number[];
  package_names: string[];
  account_statuses: string[];
};

function CustomerSearchPage() {
  const navigate = useNavigate();

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    // Wait briefly while staff type and cancel the superseded request. The old
    // behavior sent one full directory query per keystroke, so slow responses
    // piled up and could arrive out of order.
    const controller = new AbortController();
    const loadCustomers = async () => {
      try {
        setLoading(true);
        setError("");

        const response = await apiFetch(
          `/api/customers?grouped=true&search=${encodeURIComponent(search)}`,
          { signal: controller.signal }
        );

        if (!response.ok) {
          throw new Error("Customer request failed");
        }

        const data: Customer[] = await response.json();

        setCustomers(data);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        console.error(error);
        setError("Could not load customers.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };

    const timeout = window.setTimeout(loadCustomers, search ? 180 : 0);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [search]);

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-8 py-8">
      {/* Page heading */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-on-surface">
          Customer Search
        </h1>

        <p className="mt-1 text-sm text-on-surface-variant">
          Search and view customer accounts
        </p>
      </div>

      {/* Search */}
      <div className="relative max-w-md">
        <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-outline">
          search
        </span>

        <input
          type="text"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search by name, customer ID, or phone..."
          className="w-full rounded-lg bg-surface-container-low py-2.5 pl-10 pr-4 text-sm transition"
        />
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-lg bg-error/10 p-4 text-sm text-error">
          {error}
        </div>
      )}

      {/* Customer table */}
      <div className="overflow-hidden rounded-xl bg-surface-container-lowest shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead className="bg-surface-container-low/50">
              <tr>
                <TableHeading>Account(s)</TableHeading>
                <TableHeading>Customer Name</TableHeading>
                <TableHeading>Address</TableHeading>
                <TableHeading>Package</TableHeading>
                <TableHeading>Status</TableHeading>
                <TableHeading>Contact</TableHeading>

                <th className="px-6 py-4 text-right text-xs font-semibold uppercase tracking-wider text-on-surface-variant">
                  Actions
                </th>
              </tr>
            </thead>

            <tbody>
              {!loading &&
                customers.map((customer) => (
                  // The whole row opens the profile, not just the button at
                  // the far right — on a wide table that button is a long way
                  // from the name you actually read. Kept keyboard-reachable
                  // because a row is not a link as far as the browser is
                  // concerned, and this screen gets used all day.
                  <tr
                    key={customer.customer_id}
                    role="link"
                    tabIndex={0}
                    aria-label={`Open ${customer.name || "unnamed customer"}`}
                    onClick={() => navigate(`/customers/${customer.customer_id}`)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        navigate(`/customers/${customer.customer_id}`);
                      }
                    }}
                    className="cursor-pointer border-t border-surface-container transition hover:bg-surface-container-low/40 focus-visible:bg-surface-container-low/40"
                  >
                    <td className="px-6 py-4 text-sm text-on-surface-variant">
                      <span className="font-mono">
                        {customer.account_ids.map((id) => `#${id}`).join(", ")}
                      </span>
                      {customer.account_count > 1 && (
                        <p className="mt-1 text-xs font-medium text-primary">
                          {customer.account_count} service accounts
                        </p>
                      )}
                    </td>

                    <td className="px-6 py-4 text-sm font-medium text-on-surface">
                      {customer.name || "Unnamed customer"}
                    </td>

                    <td className="max-w-xs truncate px-6 py-4 text-sm text-on-surface-variant">
                      {customer.address || "—"}
                    </td>

                    <td className="px-6 py-4 text-sm text-on-surface-variant">
                      {customer.package_names.join(" · ")}
                    </td>

                    <td className="px-6 py-4">
                      <div className="flex flex-wrap gap-1">
                        {customer.account_statuses.map((status, index) => (
                          <StatusBadge key={`${status}-${index}`} status={status} />
                        ))}
                      </div>
                    </td>

                    <td className="px-6 py-4 text-sm text-on-surface-variant">
                      {customer.telephone || "—"}
                    </td>

                    <td className="px-6 py-4 text-right">
                      {/* Kept as the visible affordance — someone scanning the
                          table should still see that a row goes somewhere. The
                          click is stopped so it does not also trigger the row
                          handler wrapping it. */}
                      <button
                        type="button"
                        tabIndex={-1}
                        onClick={(event) => {
                          event.stopPropagation();
                          navigate(`/customers/${customer.customer_id}`);
                        }}
                        className="rounded-lg px-3 py-2 text-sm font-medium text-primary transition hover:bg-primary/10"
                      >
                        View
                      </button>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>

        {/* Loading */}
        {loading && (
          <div className="px-6 py-12 text-center text-sm text-on-surface-variant">
            Loading customers...
          </div>
        )}

        {/* No results */}
        {!loading && customers.length === 0 && !error && (
          <div className="px-6 py-12 text-center text-sm text-on-surface-variant">
            No customers found.
          </div>
        )}

        {!loading && customers.length > 0 && (
          <div className="border-t border-surface-container px-6 py-4 text-sm text-on-surface-variant">
            Showing up to 50 customers
          </div>
        )}
      </div>
    </div>
  );
}

type TableHeadingProps = {
  children: React.ReactNode;
};

function TableHeading({ children }: TableHeadingProps) {
  return (
    <th className="px-6 py-4 text-xs font-semibold uppercase tracking-wider text-on-surface-variant">
      {children}
    </th>
  );
}

type StatusBadgeProps = {
  status: string;
};

function StatusBadge({ status }: StatusBadgeProps) {
  // Colour marks an exception. "closed" and "archived" are ordinary record
  // states, not failures, so they no longer render as red alarms.
  const styles: Record<string, string> = {
    active: "bg-tertiary/10 text-tertiary",
    disconnected: "bg-error/10 text-error",
    pending_reconnection: "bg-warning-container text-warning",
    closed: "bg-surface-container-high text-on-surface-variant",
    archived: "bg-surface-container-high text-on-surface-variant",
    offline: "bg-[#8a2d5f]/10 text-[#8a2d5f]",
    suspended: "bg-warning-container text-warning",
    terminated: "bg-surface-container-high text-on-surface-variant",
  };

  return (
    <span
      className={`rounded-full px-3 py-1 text-xs font-medium capitalize ${
        styles[status] || "bg-surface-container-high text-on-surface-variant"
      }`}
    >
      {status.replace("_", " ")}
    </span>
  );
}

export default CustomerSearchPage;
