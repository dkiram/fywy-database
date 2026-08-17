/** Combines customer identity, billing, service history, and account actions in one screen. */
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useAuth } from "../auth/AuthContext";
import { apiFetch } from "../lib/api";
import PaymentReceiptModal, { type PaymentReceipt } from "../components/PaymentReceiptModal";
import RecordPaymentDrawer from "../components/RecordPaymentDrawer";
import AccountOperationsPanel, {
  type AccountStatus,
  type AccountStatusUpdate,
} from "../components/AccountOperationsPanel";
import CustomerServiceHistory from "../components/CustomerServiceHistory";

type Customer = {
  customer_id: number;
  name: string | null;
  address: string | null;
  telephone: string | null;
  email: string | null;

  package_id: number | null;
  package_name: string | null;
  package_service_type: "cable" | "internet" | "cable_internet" | null;
  package_plan_tier: string | null;
  package_speed_mbps: number | null;
  monthly_fee: string | null;

  application_date: string | null;
  activation_date: string | null;
  deactivation_date: string | null;
  reactivation_date: string | null;
  next_billing_date: string | null;

  status: AccountStatus;
  adult_channel: boolean;

  pole_box_number: string | null;
  port_number: string | null;

  installation_fee: string | null;
  default_monthly_charge: string | null;
  reconnection_fee: string | null;
};

type PackageOption = {
  package_id: number;
  name: string;
  default_monthly_charge: string | null;
  service_type: "cable" | "internet" | "cable_internet";
  plan_tier: string | null;
  speed_mbps: number | null;
};

import PaymentHistory from "../components/PaymentHistory";


function CustomerProfilePage() {
  const navigate = useNavigate();
  const { customerId } = useParams();
  const { employee } = useAuth();


const canManageSubscription =
  employee?.role === "admin" ||
  employee?.role === "head_office";
  const [customer, setCustomer] = useState<Customer | null>(null);
const [loading, setLoading] = useState(true);
const [error, setError] = useState("");
    const [activeTab, setActiveTab] = useState<"overview" | "payments" | "support">(
  "overview"
);

const [packages, setPackages] = useState<PackageOption[]>([]);
const [editingSubscription, setEditingSubscription] = useState(false);
const [selectedPackageId, setSelectedPackageId] = useState("");
const [subscriptionReason, setSubscriptionReason] = useState("");
const [savingSubscription, setSavingSubscription] = useState(false);
const [subscriptionError, setSubscriptionError] = useState("");
const [showPaymentForm, setShowPaymentForm] = useState(false);
const [paymentReceipt, setPaymentReceipt] = useState<PaymentReceipt | null>(null);
const [paymentRefreshKey, setPaymentRefreshKey] = useState(0);


useEffect(() => {
  const loadCustomer = async () => {
    try {
      setLoading(true);
      setError("");

      const response = await apiFetch(
  `/api/customers/${customerId}`
);

      if (!response.ok) {
        throw new Error("Customer request failed");
      }

      const data: Customer = await response.json();

      setCustomer(data);
    } catch (error) {
      console.error(error);
      setError("Could not load customer.");
    } finally {
      setLoading(false);
    }
  };

  loadCustomer();
}, [customerId]);

useEffect(() => {
  if (!canManageSubscription) return;
  apiFetch("/api/packages")
    .then(async (response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load packages.");
      setPackages(data.packages);
    })
    .catch(() => setPackages([]));
}, [canManageSubscription]);

if (loading) {
  return (
    <div className="p-12 text-on-surface-variant">
      Loading customer...
    </div>
  );
}

if (error || !customer) {
  return (
    <div className="p-12">
      <p className="text-error">
        {error || "Customer not found."}
      </p>

      <button
        type="button"
        onClick={() => navigate("/customers")}
        className="mt-4 text-primary"
      >
        ← Back to Customers
      </button>
    </div>
  );
}

  return (
    <div className="flex w-full flex-col gap-8 bg-surface p-8 lg:p-12">
      {/* Back */}
      <button
        type="button"
        onClick={() => navigate("/customers")}
        className="flex w-fit items-center gap-2 text-sm font-medium uppercase tracking-wide text-primary transition hover:opacity-70"
      >
        <span className="material-symbols-outlined text-sm">
          arrow_back
        </span>

        Back to Customers
      </button>

      {/* Customer heading */}
      <div className="flex flex-col justify-between gap-6 lg:flex-row lg:items-end">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-4">
            <h1 className="text-4xl font-semibold tracking-tight text-on-surface lg:text-5xl">
              {customer.name || "Unnamed customer"}
            </h1>

            <div className={`flex items-center gap-2 rounded-full px-3 py-1 ${statusPillClass(customer.status)}`}>
              <span className="h-1.5 w-1.5 rounded-full bg-current" />

              <span className="text-xs font-semibold uppercase tracking-wider">
                {customer.status.replace("_", " ")}
              </span>
            </div>
          </div>

          <div className="flex w-fit items-center gap-2 rounded-md bg-surface-container px-3 py-1 font-mono text-sm text-on-surface-variant">
            <span className="material-symbols-outlined text-base">
              fingerprint
            </span>

            {customer.customer_id}
          </div>
        </div>

        {/* Future actions */}
 <div className="flex items-center gap-4">
  {activeTab === "overview" ? (
    employee?.role === "admin" || employee?.role === "head_office" ? (
      <button
        type="button"
        onClick={() => navigate(`/customers/${customer.customer_id}/edit`)}
        className="flex items-center gap-2 rounded-lg bg-primary px-6 py-2.5 text-sm font-medium text-on-primary shadow-md transition hover:bg-primary-container"
      >
        <span className="material-symbols-outlined text-lg">
          edit
        </span>

        Edit Profile
      </button>
    ) : null
  ) : activeTab === "payments" ? (
    <button
      type="button"
      onClick={() => setShowPaymentForm(true)}
      className="flex items-center gap-2 rounded-lg bg-primary px-6 py-2.5 text-sm font-medium text-on-primary shadow-md transition hover:bg-primary-container"
    >
      <span className="material-symbols-outlined text-lg">
        add
      </span>

      Record Payment
    </button>
  ) : (
    <button
      type="button"
      onClick={() => navigate(`/service-requests?customerId=${customer.customer_id}`)}
      className="flex items-center gap-2 rounded-lg bg-primary px-6 py-2.5 text-sm font-medium text-on-primary shadow-md transition hover:bg-primary-container"
    >
      <span className="material-symbols-outlined text-lg">add</span>
      New Service Ticket
    </button>
  )}

  <button
    type="button"
    disabled
    className="cursor-not-allowed rounded-lg bg-surface-container px-4 py-2.5 opacity-60"
  >
    <span className="material-symbols-outlined text-lg">
      more_vert
    </span>
  </button>
</div>
      </div>

      {/* Tabs */}
     <div className="flex border-b border-surface-container-highest">
  <button
    type="button"
    onClick={() => setActiveTab("overview")}
    className={
      activeTab === "overview"
        ? "border-b-2 border-primary px-6 py-3 text-sm font-medium text-primary"
        : "px-6 py-3 text-sm font-medium text-on-surface-variant transition hover:text-on-surface"
    }
  >
    Overview
  </button>

  <button
    type="button"
    onClick={() => setActiveTab("payments")}
    className={
      activeTab === "payments"
        ? "border-b-2 border-primary px-6 py-3 text-sm font-medium text-primary"
        : "px-6 py-3 text-sm font-medium text-on-surface-variant transition hover:text-on-surface"
    }
  >
    Payments
  </button>

  <button
    type="button"
    onClick={() => setActiveTab("support")}
    className={
      activeTab === "support"
        ? "border-b-2 border-primary px-6 py-3 text-sm font-medium text-primary"
        : "px-6 py-3 text-sm font-medium text-on-surface-variant transition hover:text-on-surface"
    }
  >
    Support History
  </button>
</div>

      {/* Main content */}
      {activeTab === "overview" ? (
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="flex flex-col gap-6 lg:col-span-8">
          {/* Customer information */}
          <section className="rounded-2xl bg-surface-container-lowest p-8 shadow-sm">
            <div className="mb-6 flex items-center gap-3 border-b border-surface-container pb-4">
              <span className="material-symbols-outlined text-primary">
                contact_mail
              </span>

              <h2 className="text-lg font-semibold">
                Customer Information
              </h2>
            </div>

            <div className="grid grid-cols-1 gap-x-8 gap-y-6 sm:grid-cols-2">
              <InfoItem label="Full Name" value={customer.name || "Unnamed customer"} />

              <InfoItem
                label="Customer ID" value={String(customer.customer_id)}/>

              <InfoItem
                label="Phone Number"
                value={customer.telephone || "—"}
              />

              <InfoItem
                label="Email Address"
                value={customer.email || "—"}
              />

              <div className="sm:col-span-2">
                <p className="text-xs uppercase tracking-wider text-on-surface-variant">
                  Service Address
                </p>

                <div className="mt-2 flex items-start gap-3">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-secondary-container">
                    <span className="material-symbols-outlined text-base">
                      location_on
                    </span>
                  </div>

                  <p className="font-medium leading-relaxed">
                   {customer.address || "—"}
                    <br />
                    Jamaica
                  </p>
                </div>
              </div>
            </div>
          </section>

          {/* Smaller cards */}
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            <section className="rounded-2xl bg-surface-container-lowest p-6 shadow-sm">
              <div className="mb-5 flex items-center gap-2 border-b border-surface-container pb-3">
                <span className="material-symbols-outlined text-tertiary">
                  router
                </span>

                <h2 className="font-semibold">
                  Service / Equipment
                </h2>
              </div>

              <div className="flex flex-col gap-4">
                <DetailRow
                 label="Pole Box"
                 value={customer.pole_box_number || "—"} />

                <DetailRow label="Port" value={customer.port_number || "—"} />
              </div>
            </section>

            <section className="rounded-2xl bg-surface-container-lowest p-6 shadow-sm">
              <div className="mb-5 flex items-center gap-2 border-b border-surface-container pb-3">
                <span className="material-symbols-outlined text-secondary">
                  manage_accounts
                </span>

                <h2 className="font-semibold">
                  Account Info
                </h2>
              </div>

              <div className="flex flex-col gap-4">
                <DetailRow label="Status" value={customer.status.replace("_", " ")} />
              
<DetailRow
  label="Date Joined"
  value={formatDate(customer.activation_date)}
/>

<DetailRow
  label="Tenure"
  value={calculateTenure(customer.activation_date)}
/>
              </div>
            </section>
          </div>

          {employee && (
            // Keep operational controls in the wider profile column so status,
            // balances, actions, and history can use a horizontal layout.
            <AccountOperationsPanel
              customerId={customer.customer_id}
              status={customer.status}
              employeeRole={employee.role}
              onStatusChanged={(update: AccountStatusUpdate) => {
                setCustomer((current) =>
                  current
                    ? {
                        ...current,
                        status: update.status,
                        deactivation_date: update.deactivation_date,
                        reactivation_date: update.reactivation_date,
                      }
                    : current
                );
              }}
            />
          )}
        </div>

        {/* Right column */}
        <div className="flex flex-col gap-6 lg:col-span-4">
          {/* Package */}
          <section className="relative overflow-hidden rounded-2xl bg-primary p-6 text-on-primary shadow-xl">
            <div className="mb-6 flex items-center gap-3 border-b border-white/20 pb-4">
              <span className="material-symbols-outlined">
                tv
              </span>

              <h2 className="text-lg font-semibold">
                Current Package
              </h2>
            </div>

            <div className="mb-6">
              <p className="text-xs uppercase tracking-wider opacity-70">
                Subscribed Plan
              </p>

              <p className="mt-2 text-2xl font-medium">
               {customer.package_name || "No package"}
              </p>
              {customer.package_speed_mbps && (
                <p className="mt-1 text-sm font-semibold opacity-80">
                  {customer.package_speed_mbps} Mbps
                </p>
              )}
            </div>

           <div>
  <p className="text-xs font-semibold uppercase tracking-wide opacity-70">
    Customer Monthly Rate
  </p>

  <div className="mt-1 flex items-baseline gap-1">
    {customer.monthly_fee ? (
      <>
        <span className="text-xl">J$</span>

        <span className="text-4xl font-medium">
          {Number(customer.monthly_fee).toLocaleString()}
        </span>
      </>
    ) : (
      <span className="text-4xl font-medium">—</span>
    )}
  </div>

  <p className="mt-2 text-xs opacity-70">
    This customer&apos;s current billed monthly rate
  </p>

</div>

      <div className="mt-5 border-t border-white/20 pt-4">
  <p className="text-xs opacity-70">
    Package Base Rate
  </p>

  <p className="mt-1 font-semibold">
    {customer.default_monthly_charge
      ? `J$${Number(
          customer.default_monthly_charge
        ).toLocaleString()}`
      : "—"}
  </p>

  <p className="mt-1 text-xs opacity-70">
    Reference/base rate only. Customer rates may differ.
  </p>
</div>

            <div className="mt-5 rounded-xl bg-black/10 p-4">
              <p className="text-xs opacity-70">
  Next Billing Date
</p>

<p className="mt-1 text-sm font-medium">
  {customer.next_billing_date
    ? formatDate(customer.next_billing_date)
    : customer.status === "active"
      ? "Activation date required"
      : "Billing paused"}
</p>
{!customer.next_billing_date && customer.status !== "active" && (
  <p className="mt-1 text-xs opacity-70">
    Recurring charges resume when the account is active.
  </p>
)}
            </div>

            {canManageSubscription && !editingSubscription && (
              <button
                type="button"
                onClick={() => {
                  setSelectedPackageId(String(customer.package_id ?? ""));
                  setSubscriptionReason("");
                  setSubscriptionError("");
                  setEditingSubscription(true);
                }}
                className="w-full rounded-lg bg-white py-3 font-medium text-primary transition hover:bg-white/90"
              >
                Manage Subscription
              </button>
            )}

            {editingSubscription && (
              <div className="mt-4 space-y-3 rounded-xl bg-black/15 p-4">
                <div>
                  <label className="mb-1 block text-xs font-semibold">New Package &amp; Speed</label>
                  <select
                    value={selectedPackageId}
                    onChange={(event) => setSelectedPackageId(event.target.value)}
                    className="w-full rounded-lg bg-white px-3 py-2 text-sm text-on-surface"
                  >
                    <option value="">Select package</option>
                    {packages.map((item) => (
                      <option key={item.package_id} value={item.package_id}>
                        {item.name} — {item.default_monthly_charge
                          ? `J$${Number(item.default_monthly_charge).toLocaleString()}/month`
                          : "Price unavailable"}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="mb-1 block text-xs font-semibold">Reason for Change</label>
                  <textarea
                    rows={3}
                    value={subscriptionReason}
                    onChange={(event) => setSubscriptionReason(event.target.value)}
                    placeholder="Upgrade requested by customer..."
                    className="w-full resize-none rounded-lg bg-white px-3 py-2 text-sm text-on-surface"
                  />
                </div>

                <p className="text-xs leading-5 opacity-75">
                  The catalog price applies to future billing anniversaries. Existing ledger charges are not changed.
                </p>
                {subscriptionError && <p className="text-sm text-error">{subscriptionError}</p>}

                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={savingSubscription}
                    onClick={async () => {
                      try {
                        setSavingSubscription(true);
                        setSubscriptionError("");
                        const response = await apiFetch(
                          `/api/customers/${customer.customer_id}/subscription`,
                          {
                            method: "PATCH",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                              packageId: selectedPackageId,
                              reason: subscriptionReason,
                            }),
                          }
                        );
                        const data = await response.json();
                        if (!response.ok) {
                          throw new Error(data.error || "Could not update subscription.");
                        }
                        const chosen = packages.find(
                          (item) => item.package_id === Number(data.packageId)
                        );
                        setCustomer((current) => current ? {
                          ...current,
                          package_id: data.packageId,
                          package_name: data.packageName,
                          package_service_type: data.serviceType,
                          package_plan_tier: data.planTier,
                          package_speed_mbps: data.speedMbps,
                          monthly_fee: data.monthlyFee,
                          default_monthly_charge:
                            chosen?.default_monthly_charge ?? data.monthlyFee,
                        } : current);
                        setEditingSubscription(false);
                        setSubscriptionReason("");
                      } catch (error) {
                        setSubscriptionError(
                          error instanceof Error ? error.message : "Could not update subscription."
                        );
                      } finally {
                        setSavingSubscription(false);
                      }
                    }}
                    className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-primary disabled:opacity-60"
                  >
                    {savingSubscription ? "Saving..." : "Save Package"}
                  </button>
                  <button
                    type="button"
                    disabled={savingSubscription}
                    onClick={() => {
                      setEditingSubscription(false);
                      setSubscriptionError("");
                    }}
                    className="rounded-lg bg-black/20 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </section>

        </div>
        </div>
) : activeTab === "payments" ? (
  <PaymentHistory refreshKey={paymentRefreshKey} />
 ) : (
  <CustomerServiceHistory customerId={customer.customer_id} />
)}

      {showPaymentForm && employee && (
        <RecordPaymentDrawer
          customer={customer}
          employee={employee}
          onClose={() => setShowPaymentForm(false)}
          onRecorded={(receipt) => {
            setShowPaymentForm(false);
            setPaymentReceipt(receipt);
            setPaymentRefreshKey((current) => current + 1);
          }}
        />
      )}

      {paymentReceipt && (
        <PaymentReceiptModal payment={paymentReceipt} onClose={() => setPaymentReceipt(null)} onVoided={() => setPaymentRefreshKey((current) => current + 1)} onDeleted={() => setPaymentRefreshKey((current) => current + 1)} />
      )}
    </div> 
  );
}

type InfoItemProps = {
  label: string;
  value: string;
};

function InfoItem({ label, value }: InfoItemProps) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wider text-on-surface-variant">
        {label}
      </p>

      <p className="mt-1 font-medium text-on-surface">
        {value}
      </p>
    </div>
  );
}

type DetailRowProps = {
  label: string;
  value: string;
};

function DetailRow({ label, value }: DetailRowProps) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm text-on-surface-variant">
        {label}
      </span>

      <span className="text-sm font-medium text-on-surface">
        {value}
      </span>
    </div>
  );
}

function statusPillClass(status: AccountStatus) {
  const styles: Record<AccountStatus, string> = {
    active: "bg-tertiary/10 text-tertiary",
    disconnected: "bg-error/10 text-error",
    pending_reconnection: "bg-warning-container text-warning",
    closed: "bg-surface-container-high text-on-surface-variant",
    archived: "bg-surface-container-high text-on-surface-variant",
  };
  return styles[status];
}


function parseDateOnly(date: string | null) {
  if (!date) {
    return null;
  }

  // Handles both:
  // "2020-07-31"
  // "2020-07-31T00:00:00.000Z"
  const datePart = date.slice(0, 10);

  const [year, month, day] = datePart
    .split("-")
    .map(Number);

  if (!year || !month || !day) {
    return null;
  }

  const parsed = new Date(year, month - 1, day);

  // Make sure JS didn't silently turn an invalid date
  // like Feb 30 into March 2.
  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day
  ) {
    return null;
  }

  return parsed;
}

function formatDate(date: string | null) {
  const parsed = parseDateOnly(date);

  if (!parsed) {
    return "—";
  }

  return parsed.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function calculateTenure(activationDate: string | null) {
  const start = parseDateOnly(activationDate);

  if (!start) {
    return "—";
  }

  const now = new Date();

  const today = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate()
  );

  if (start > today) {
    return "Invalid activation date";
  }

  let years = today.getFullYear() - start.getFullYear();
  let months = today.getMonth() - start.getMonth();

  // Current month isn't complete until we reach
  // the activation day of the month.
  if (today.getDate() < start.getDate()) {
    months--;
  }

  if (months < 0) {
    years--;
    months += 12;
  }

  const yearText =
    years === 1 ? "1 yr" : `${years} yrs`;

  const monthText =
    months === 1 ? "1 mo" : `${months} mos`;

  if (years === 0) {
    return monthText;
  }

  if (months === 0) {
    return yearText;
  }

  return `${yearText}, ${monthText}`;
}

export default CustomerProfilePage;
