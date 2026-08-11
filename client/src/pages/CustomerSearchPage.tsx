import { useNavigate } from "react-router";

type Customer = {
  id: string;
  name: string;
  address: string;
  package: string;
  status: string;
  phone: string;
};

const customers: Customer[] = [
  {
    id: "CUST-10234",
    name: "John Smith",
    address: "24 Harbour View Drive, Montego Bay",
    package: "Premium Cable",
    status: "Active",
    phone: "(876) 555-0142",
  },
  {
    id: "CUST-10235",
    name: "Maria Brown",
    address: "18 Rose Hall Road, Montego Bay",
    package: "Basic Cable",
    status: "Active",
    phone: "(876) 555-0188",
  },
  {
    id: "CUST-10236",
    name: "David Campbell",
    address: "7 Westgate Avenue, Montego Bay",
    package: "Premium Cable",
    status: "Disconnected",
    phone: "(876) 555-0195",
  },
];

function CustomerSearchPage() {
  const navigate = useNavigate();

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-8 py-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-on-surface">
          Customer Search
        </h1>

        <p className="mt-1 text-sm text-on-surface-variant">
          Search and view customer accounts
        </p>
      </div>

      <div className="relative max-w-md">
        <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-outline">
          search
        </span>

        <input
          type="text"
          placeholder="Search by name, customer ID, or phone..."
          className="w-full rounded-lg bg-surface-container-low py-2.5 pl-10 pr-4 text-sm outline-none transition focus:ring-2 focus:ring-primary/20"
        />
      </div>

      <div className="overflow-hidden rounded-xl bg-surface-container-lowest shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead className="bg-surface-container-low/50">
              <tr>
                <th className="px-6 py-4 text-xs font-bold uppercase tracking-wider text-on-surface-variant">
                  Customer ID
                </th>
                <th className="px-6 py-4 text-xs font-bold uppercase tracking-wider text-on-surface-variant">
                  Customer Name
                </th>
                <th className="px-6 py-4 text-xs font-bold uppercase tracking-wider text-on-surface-variant">
                  Address
                </th>
                <th className="px-6 py-4 text-xs font-bold uppercase tracking-wider text-on-surface-variant">
                  Package
                </th>
                <th className="px-6 py-4 text-xs font-bold uppercase tracking-wider text-on-surface-variant">
                  Status
                </th>
                <th className="px-6 py-4 text-xs font-bold uppercase tracking-wider text-on-surface-variant">
                  Contact
                </th>
                <th className="px-6 py-4 text-right text-xs font-bold uppercase tracking-wider text-on-surface-variant">
                  Actions
                </th>
              </tr>
            </thead>

            <tbody>
              {customers.map((customer) => (
                <tr
                  key={customer.id}
                  className="border-t border-surface-container transition hover:bg-surface-container-low/40"
                >
                  <td className="px-6 py-4 text-sm text-on-surface-variant">
                    {customer.id}
                  </td>

                  <td className="px-6 py-4 text-sm font-bold text-on-surface">
                    {customer.name}
                  </td>

                  <td className="px-6 py-4 text-sm text-on-surface-variant">
                    {customer.address}
                  </td>

                  <td className="px-6 py-4 text-sm text-on-surface-variant">
                    {customer.package}
                  </td>

                  <td className="px-6 py-4">
                    <span
                      className={
                        customer.status === "Active"
                          ? "rounded-full bg-tertiary/10 px-3 py-1 text-xs font-bold text-tertiary"
                          : "rounded-full bg-error/10 px-3 py-1 text-xs font-bold text-error"
                      }
                    >
                      {customer.status}
                    </span>
                  </td>

                  <td className="px-6 py-4 text-sm text-on-surface-variant">
                    {customer.phone}
                  </td>

                  <td className="px-6 py-4 text-right">
                    <button
  type="button"
  onClick={() =>
    navigate(`/customers/${customer.id}`)
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
      </div>
    </div>
  );
}

export default CustomerSearchPage;