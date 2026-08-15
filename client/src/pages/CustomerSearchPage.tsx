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
};

function CustomerSearchPage() {
  const navigate = useNavigate();

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    // Reload whenever the query changes; the API caps broad results at 50 customers.
    const loadCustomers = async () => {
      try {
        setLoading(true);
        setError("");

        const response = await apiFetch(
  `/api/customers?search=${encodeURIComponent(
    search
  )}`
);

        if (!response.ok) {
          throw new Error("Customer request failed");
        }

        const data: Customer[] = await response.json();

        setCustomers(data);
      } catch (error) {
        console.error(error);
        setError("Could not load customers.");
      } finally {
        setLoading(false);
      }
    };

    loadCustomers();
  }, [search]);

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-8 py-8">
      {/* Page heading */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-on-surface">
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
          className="w-full rounded-lg bg-surface-container-low py-2.5 pl-10 pr-4 text-sm outline-none transition focus:ring-2 focus:ring-primary/20"
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
                <TableHeading>Customer ID</TableHeading>
                <TableHeading>Customer Name</TableHeading>
                <TableHeading>Address</TableHeading>
                <TableHeading>Package</TableHeading>
                <TableHeading>Status</TableHeading>
                <TableHeading>Contact</TableHeading>

                <th className="px-6 py-4 text-right text-xs font-bold uppercase tracking-wider text-on-surface-variant">
                  Actions
                </th>
              </tr>
            </thead>

            <tbody>
              {!loading &&
                customers.map((customer) => (
                  <tr
                    key={customer.customer_id}
                    className="border-t border-surface-container transition hover:bg-surface-container-low/40"
                  >
                    <td className="px-6 py-4 text-sm text-on-surface-variant">
                      {customer.customer_id}
                    </td>

                    <td className="px-6 py-4 text-sm font-bold text-on-surface">
                      {customer.name || "Unnamed customer"}
                    </td>

                    <td className="max-w-xs truncate px-6 py-4 text-sm text-on-surface-variant">
                      {customer.address || "—"}
                    </td>

                    <td className="px-6 py-4 text-sm text-on-surface-variant">
                      {customer.package_name || "No package"}
                    </td>

                    <td className="px-6 py-4">
                      <StatusBadge status={customer.status} />
                    </td>

                    <td className="px-6 py-4 text-sm text-on-surface-variant">
                      {customer.telephone || "—"}
                    </td>

                    <td className="px-6 py-4 text-right">
                      <button
                        type="button"
                        onClick={() =>
                          navigate(
                            `/customers/${customer.customer_id}`
                          )
                        }
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
    <th className="px-6 py-4 text-xs font-bold uppercase tracking-wider text-on-surface-variant">
      {children}
    </th>
  );
}

type StatusBadgeProps = {
  status: string;
};

function StatusBadge({ status }: StatusBadgeProps) {
  const isActive = status === "active";

  return (
    <span
      className={
        isActive
          ? "rounded-full bg-tertiary/10 px-3 py-1 text-xs font-bold capitalize text-tertiary"
          : "rounded-full bg-error/10 px-3 py-1 text-xs font-bold capitalize text-error"
      }
    >
      {status.replace("_", " ")}
    </span>
  );
}

export default CustomerSearchPage;
