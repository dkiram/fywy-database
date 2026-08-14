import { useEffect, useState } from "react";
import { useParams } from "react-router";

type Payment = {
  payment_id: number;
  legacy_payment_id: number | null;

  payment_type: string | null;
  legacy_payment_type: string | null;

  amount_paid: string | null;

  month_paid: string | null;
  payment_date: string | null;

  location: string | null;
  cashier_name: string | null;
};

type Pagination = {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
};

type PaymentsResponse = {
  payments: Payment[];
  pagination: Pagination;
};

function PaymentHistory() {
  const { customerId } = useParams();

  const [payments, setPayments] = useState<Payment[]>([]);
  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    limit: 5,
    total: 0,
    totalPages: 0,
  });

  const [page, setPage] = useState(1);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [searchInput, setSearchInput] = useState("");
const [search, setSearch] = useState("");

const [paymentType, setPaymentType] = useState("");
const [fromDate, setFromDate] = useState("");
const [toDate, setToDate] = useState("");

  useEffect(() => {
    setPage(1);
  }, [customerId]);

  useEffect(() => {
    const loadPayments = async () => {
      if (!customerId) {
        return;
      }

      try {
        setLoading(true);
        setError("");

        const params = new URLSearchParams();

params.set("page", String(page));

if (search) {
  params.set("search", search);
}

if (paymentType) {
  params.set("type", paymentType);
}

if (fromDate) {
  params.set("from", fromDate);
}

if (toDate) {
  params.set("to", toDate);
}

const response = await fetch(
  `http://localhost:3000/api/customers/${customerId}/payments?${params.toString()}`
);
        if (!response.ok) {
          throw new Error("Payment request failed");
        }

        const data: PaymentsResponse = await response.json();

        setPayments(data.payments);
        setPagination(data.pagination);
      } catch (error) {
        console.error(error);
        setError("Could not load payment history.");
      } finally {
        setLoading(false);
      }
    };

    loadPayments();
  }, [
  customerId,
  page,
  search,
  paymentType,
  fromDate,
  toDate,
]);

  return (
    <div className="space-y-6">
      {/* Heading */}
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-bold text-on-surface">
          Payment History
        </h2>

        <p className="text-sm text-on-surface-variant">
          {pagination.total.toLocaleString()} recorded payment
          {pagination.total === 1 ? "" : "s"}
        </p>
      </div>

<form
  onSubmit={(event) => {
    event.preventDefault();

    setPage(1);
    setSearch(searchInput.trim());
  }}
  className="flex flex-wrap items-end gap-3"
>
  <div className="min-w-64 flex-1">
    <label className="mb-1 block text-xs font-semibold text-on-surface-variant">
      Search Payments
    </label>

    <input
      type="text"
      value={searchInput}
      onChange={(event) => {
        setSearchInput(event.target.value);
      }}
      placeholder="Type, amount, location, cashier..."
      className="w-full rounded-lg bg-surface-container-low px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary/20"
    />
  </div>

  <div>
    <label className="mb-1 block text-xs font-semibold text-on-surface-variant">
      Payment Type
    </label>

    <select
      value={paymentType}
      onChange={(event) => {
        setPaymentType(event.target.value);
        setPage(1);
      }}
      className="rounded-lg bg-surface-container-low px-4 py-2.5 text-sm outline-none"
    >
      <option value="">All Types</option>
      <option value="Monthly Fee">Monthly Fee</option>
      <option value="Reconnection Fee">Reconnection Fee</option>
      <option value="Installation Fee">Installation Fee</option>
      <option value="Hurricane Discount">
        Hurricane Discount
      </option>
    </select>
  </div>

  <div>
    <label className="mb-1 block text-xs font-semibold text-on-surface-variant">
      From
    </label>

    <input
      type="date"
      value={fromDate}
      onChange={(event) => {
        setFromDate(event.target.value);
        setPage(1);
      }}
      className="rounded-lg bg-surface-container-low px-3 py-2.5 text-sm outline-none"
    />
  </div>

  <div>
    <label className="mb-1 block text-xs font-semibold text-on-surface-variant">
      To
    </label>

    <input
      type="date"
      value={toDate}
      onChange={(event) => {
        setToDate(event.target.value);
        setPage(1);
      }}
      className="rounded-lg bg-surface-container-low px-3 py-2.5 text-sm outline-none"
    />
  </div>

  <button
    type="submit"
    className="rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-on-primary"
  >
    Search
  </button>

  <button
    type="button"
    onClick={() => {
      setSearchInput("");
      setSearch("");
      setPaymentType("");
      setFromDate("");
      setToDate("");
      setPage(1);
    }}
    className="rounded-lg bg-surface-container px-4 py-2.5 text-sm font-medium text-on-surface"
  >
    Clear
  </button>
</form>

      {/* Error */}
      {error && (
        <div className="rounded-lg bg-error/10 p-4 text-sm text-error">
          {error}
        </div>
      )}

      {/* Table */}
      <div className="overflow-hidden rounded-xl bg-surface-container-lowest shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead className="bg-surface-container-low/60">
              <tr>
                <TableHeading>Date</TableHeading>
                <TableHeading>Payment Type</TableHeading>
                <TableHeading>Month Paid For</TableHeading>
                <TableHeading>Amount</TableHeading>
                <TableHeading>Location</TableHeading>
                <TableHeading>Cashier</TableHeading>

                <th className="px-6 py-4 text-right text-xs font-bold uppercase tracking-wider text-on-surface-variant">
                  Receipt
                </th>
              </tr>
            </thead>

            {!loading && (
              <tbody>
                {payments.map((payment) => (
                  <tr
                    key={payment.payment_id}
                    className="border-t border-surface-container transition hover:bg-surface-container-low/40"
                  >
                    <td className="whitespace-nowrap px-6 py-4 text-sm text-on-surface">
                      {formatDate(payment.payment_date)}
                    </td>

                    <td className="px-6 py-4">
                      <PaymentTypeBadge
                        type={
                          payment.payment_type ||
                          payment.legacy_payment_type ||
                          "Unknown"
                        }
                        recognized={payment.payment_type !== null}
                      />
                    </td>

                    <td className="whitespace-nowrap px-6 py-4 text-sm text-on-surface-variant">
                      {formatMonth(payment.month_paid)}
                    </td>

                    <td className="whitespace-nowrap px-6 py-4 text-sm font-bold text-on-surface">
                      {formatCurrency(payment.amount_paid)}
                    </td>

                    <td className="px-6 py-4 text-sm text-on-surface-variant">
                      {payment.location || "—"}
                    </td>

                    <td className="px-6 py-4 text-sm text-on-surface-variant">
                      {payment.cashier_name || "-"}
                    </td>

                    <td className="px-6 py-4 text-right">
                      <button
                        type="button"
                        disabled
                        title="Receipt viewing will be added later"
                        className="rounded-lg px-3 py-2 text-sm font-medium text-primary opacity-50"
                      >
                        View
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            )}
          </table>
        </div>

        {/* Loading */}
        {loading && (
          <div className="px-6 py-12 text-center text-sm text-on-surface-variant">
            Loading payments...
          </div>
        )}

        {/* Empty */}
        {!loading && payments.length === 0 && !error && (
          <div className="px-6 py-12 text-center">
            <span className="material-symbols-outlined text-4xl text-outline">
              payments
            </span>

            <p className="mt-2 text-sm font-medium text-on-surface">
              No payments found
            </p>

            <p className="mt-1 text-sm text-on-surface-variant">
             {search || paymentType || fromDate || toDate
  ? "No payments match the selected filters."
  : "This customer does not have any linked payment history."}
            </p>
          </div>
        )}

        {/* Pagination */}
        {!loading && payments.length > 0 && (
          <div className="flex flex-col gap-4 border-t border-surface-container px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-on-surface-variant">
              Showing{" "}
              <span className="font-medium text-on-surface">
                {(pagination.page - 1) * pagination.limit + 1}
              </span>
              {"–"}
              <span className="font-medium text-on-surface">
                {Math.min(
                  pagination.page * pagination.limit,
                  pagination.total
                )}
              </span>{" "}
              of{" "}
              <span className="font-medium text-on-surface">
                {pagination.total.toLocaleString()}
              </span>
            </p>

            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={pagination.page <= 1}
                onClick={() =>
                  setPage((currentPage) =>
                    Math.max(currentPage - 1, 1)
                  )
                }
                className="flex h-9 w-9 items-center justify-center rounded-lg bg-surface-container text-on-surface transition hover:bg-surface-container-high disabled:cursor-not-allowed disabled:opacity-40"
                aria-label="Previous page"
              >
                <span className="material-symbols-outlined text-lg">
                  chevron_left
                </span>
              </button>

              <span className="min-w-24 text-center text-sm text-on-surface-variant">
                Page{" "}
                <strong className="text-on-surface">
                  {pagination.page}
                </strong>{" "}
                of{" "}
                <strong className="text-on-surface">
                  {pagination.totalPages}
                </strong>
              </span>

              <button
                type="button"
                disabled={pagination.page >= pagination.totalPages}
                onClick={() =>
                  setPage((currentPage) => currentPage + 1)
                }
                className="flex h-9 w-9 items-center justify-center rounded-lg bg-surface-container text-on-surface transition hover:bg-surface-container-high disabled:cursor-not-allowed disabled:opacity-40"
                aria-label="Next page"
              >
                <span className="material-symbols-outlined text-lg">
                  chevron_right
                </span>
              </button>
            </div>
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

type PaymentTypeBadgeProps = {
  type: string;
  recognized: boolean;
};

function PaymentTypeBadge({
  type,
  recognized,
}: PaymentTypeBadgeProps) {
  return (
    <span
      className={
        recognized
          ? "inline-flex rounded-full bg-primary/10 px-3 py-1 text-xs font-bold text-primary"
          : "inline-flex rounded-full bg-error/10 px-3 py-1 text-xs font-bold text-error"
      }
    >
      {type}
    </span>
  );
}

function formatCurrency(amount: string | null) {
  if (amount === null) {
    return "—";
  }

  const number = Number(amount);

  if (Number.isNaN(number)) {
    return amount;
  }

  if (number < 0) {
    return `-J$${Math.abs(number).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }

  return `J$${number.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatDate(date: string | null) {
  if (!date) {
    return "—";
  }

  return new Date(date).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatMonth(date: string | null) {
  if (!date) {
    return "—";
  }

  return new Date(date).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
  });
}

export default PaymentHistory;