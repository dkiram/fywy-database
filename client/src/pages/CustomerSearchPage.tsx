/** Searches the customer directory and links each result to its full profile. */
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { apiFetch } from "../lib/api";
import { useOpenCustomerProfile } from "../hooks/useOpenCustomerProfile";
import { useScrollRestoration } from "../hooks/useScrollRestoration";

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
  const openCustomer = useOpenCustomerProfile();
  const [searchParams, setSearchParams] = useSearchParams();

  const [customers, setCustomers] = useState<Customer[]>([]);
  // The live search remains debounced, but its current value is also the URL.
  // Returning from a profile therefore remounts this page with the same query.
  const search = searchParams.get("search") ?? "";
  const setSearch = (value: string) => {
    setLoading(true);
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (value) next.set("search", value);
        else next.delete("search");
        return next;
      },
      { replace: true }
    );
  };
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useScrollRestoration(!loading);

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
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-5 sm:px-6 sm:py-6 lg:gap-8 lg:px-8 lg:py-8">
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

      {/* Customer table. Below md the same rows render as a card list — a
          seven-column table on a phone is a horizontal scroll nobody reads. */}
      <div className="overflow-hidden rounded-xl bg-surface-container-lowest shadow-sm">
        <ul className="divide-y divide-surface-container md:hidden">
          {!loading &&
            customers.map((customer) => (
              <li key={customer.customer_id}>
                <button
                  type="button"
                  onClick={() => openCustomer(customer.customer_id)}
                  aria-label={`Open ${customer.name || "unnamed customer"}`}
                  className="flex w-full items-start gap-3 px-4 py-4 text-left transition active:bg-surface-container-low/60"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      <p className="text-base font-semibold text-on-surface">
                        {customer.name || "Unnamed customer"}
                      </p>
                      <span className="font-mono text-xs text-on-surface-variant">
                        {customer.account_ids.map((id) => `#${id}`).join(", ")}
                      </span>
                    </div>

                    {customer.address && (
                      <p className="mt-1 line-clamp-2 text-sm text-on-surface-variant">
                        {customer.address}
                      </p>
                    )}

                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-on-surface-variant">
                      {customer.package_names.length > 0 && (
                        <span>{customer.package_names.join(" · ")}</span>
                      )}
                      {customer.telephone && (
                        <span className="font-mono text-xs">{customer.telephone}</span>
                      )}
                    </div>

                    <div className="mt-2 flex flex-wrap gap-1">
                      {customer.account_statuses.map((status, index) => (
                        <StatusBadge key={`${status}-${index}`} status={status} />
                      ))}
                      {customer.account_count > 1 && (
                        <span className="text-xs font-medium text-primary">
                          {customer.account_count} service accounts
                        </span>
                      )}
                    </div>
                  </div>

                  <span className="material-symbols-outlined mt-0.5 shrink-0 text-outline">
                    chevron_right
                  </span>
                </button>
              </li>
            ))}
        </ul>

        <div className="hidden overflow-x-auto md:block">
          <table className="w-full min-w-[44rem] text-left md:min-w-0">
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
                    onClick={() => openCustomer(customer.customer_id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        openCustomer(customer.customer_id);
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
                          openCustomer(customer.customer_id);
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
