import { useState } from "react";

type Payment = {
  date: string;
  receiptNumber: string;
  amount: string;
  method: string;
  cashier: string;
  location: string;
};

const payments: Payment[] = [
  {
    date: "Aug 5, 2026",
    receiptNumber: "RCP-9921",
    amount: "J$3,500",
    method: "Credit Card",
    cashier: "A. Brown",
    location: "Montego Bay",
  },
  {
    date: "Jul 7, 2026",
    receiptNumber: "RCP-8842",
    amount: "J$3,500",
    method: "Cash",
    cashier: "K. Samuels",
    location: "Montego Bay",
  },
  {
    date: "Jun 10, 2026",
    receiptNumber: "RCP-7712",
    amount: "J$3,500",
    method: "Credit Card",
    cashier: "A. Brown",
    location: "Montego Bay",
  },
  {
    date: "May 11, 2026",
    receiptNumber: "RCP-6601",
    amount: "J$3,500",
    method: "Bank Transfer",
    cashier: "Online",
    location: "Web Portal",
  },
  {
    date: "Apr 14, 2026",
    receiptNumber: "RCP-5529",
    amount: "J$3,500",
    method: "Cash",
    cashier: "K. Samuels",
    location: "Montego Bay",
  },
];

function PaymentHistory() {
  const [search, setSearch] = useState("");

  const filteredPayments = payments.filter((payment) => {
    const text = search.toLowerCase();

    return (
      payment.receiptNumber.toLowerCase().includes(text) ||
      payment.method.toLowerCase().includes(text) ||
      payment.cashier.toLowerCase().includes(text) ||
      payment.location.toLowerCase().includes(text)
    );
  });

  return (
    <div className="flex flex-col overflow-hidden rounded-2xl bg-surface-container-lowest shadow-sm">
      {/* Top section */}
      <div className="flex flex-col gap-4 px-6 py-5 lg:flex-row lg:items-center lg:justify-between">
        <h2 className="text-xl font-bold text-on-surface">
          Payment History
        </h2>

        <div className="flex flex-wrap items-center gap-2">
          {/* Search */}
          <div className="relative">
            <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-lg text-outline">
              search
            </span>

            <input
              type="text"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search payments..."
              className="w-52 rounded-lg bg-surface-container-low py-2 pl-10 pr-4 text-xs text-on-surface outline-none transition focus:ring-2 focus:ring-primary/20"
            />
          </div>

          {/* Date range - visual only for now */}
          <button
            type="button"
            className="flex items-center gap-2 rounded-lg bg-surface-container-low px-3 py-2 text-xs text-on-surface-variant transition hover:bg-surface-container"
          >
            <span className="material-symbols-outlined text-lg">
              calendar_today
            </span>

            All Dates

            <span className="material-symbols-outlined text-base">
              expand_more
            </span>
          </button>

          {/* Future filter */}
          <button
            type="button"
            disabled
            title="Coming later"
            className="cursor-not-allowed rounded-lg p-2 text-on-surface-variant opacity-60"
          >
            <span className="material-symbols-outlined">
              filter_list
            </span>
          </button>

          {/* Future download */}
          <button
            type="button"
            disabled
            title="Coming later"
            className="cursor-not-allowed rounded-lg p-2 text-on-surface-variant opacity-60"
          >
            <span className="material-symbols-outlined">
              download
            </span>
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full whitespace-nowrap text-left text-sm">
          <thead className="bg-surface-container text-xs font-bold uppercase tracking-wider text-on-surface-variant">
            <tr>
              <th className="px-6 py-4">Date</th>
              <th className="px-6 py-4">Receipt Number</th>
              <th className="px-6 py-4">Amount</th>
              <th className="px-6 py-4">Method</th>
              <th className="px-6 py-4">Cashier</th>
              <th className="px-6 py-4">Location</th>
              <th className="px-6 py-4 text-right">Action</th>
            </tr>
          </thead>

          <tbody>
            {filteredPayments.map((payment) => (
              <tr
                key={payment.receiptNumber}
                className="group border-b border-surface-container transition hover:bg-surface-container-low"
              >
                <td className="px-6 py-4">
                  {payment.date}
                </td>

                <td className="px-6 py-4 font-mono text-primary">
                  #{payment.receiptNumber}
                </td>

                <td className="px-6 py-4 font-bold">
                  {payment.amount}
                </td>

                <td className="px-6 py-4">
                  <div className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-base text-on-surface-variant">
                      {getPaymentIcon(payment.method)}
                    </span>

                    {payment.method}
                  </div>
                </td>

                <td className="px-6 py-4">
                  {payment.cashier}
                </td>

                <td className="px-6 py-4">
                  {payment.location}
                </td>

                <td className="px-6 py-4 text-right">
                  <button
                    type="button"
                    disabled
                    title="Receipt viewing coming later"
                    className="cursor-not-allowed text-on-surface-variant opacity-50"
                  >
                    <span className="material-symbols-outlined">
                      receipt
                    </span>
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {filteredPayments.length === 0 && (
          <div className="px-6 py-10 text-center text-sm text-on-surface-variant">
            No payments found.
          </div>
        )}
      </div>

      {/* Bottom */}
      <div className="flex items-center justify-between px-6 py-4 text-sm text-on-surface-variant">
        <span>
          Showing {filteredPayments.length} of {payments.length} records
        </span>

        <div className="flex items-center gap-1">
          <button
            type="button"
            disabled
            className="cursor-not-allowed rounded p-1 opacity-40"
          >
            <span className="material-symbols-outlined">
              chevron_left
            </span>
          </button>

          <button
            type="button"
            className="flex h-8 w-8 items-center justify-center rounded-full bg-primary font-bold text-on-primary"
          >
            1
          </button>

          <button
            type="button"
            disabled
            className="cursor-not-allowed rounded p-1 opacity-40"
          >
            <span className="material-symbols-outlined">
              chevron_right
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}

function getPaymentIcon(method: string) {
  if (method === "Cash") {
    return "payments";
  }

  if (method === "Bank Transfer") {
    return "account_balance";
  }

  return "credit_card";
}

export default PaymentHistory;