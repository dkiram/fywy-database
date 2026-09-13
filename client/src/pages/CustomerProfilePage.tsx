/** Combines customer identity, billing, service history, and account actions in one screen. */
import { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import { useAuth } from "../auth/AuthContext";
import { apiFetch } from "../lib/api";
import PaymentReceiptModal, { type PaymentReceipt } from "../components/PaymentReceiptModal";
import RecordPaymentDrawer from "../components/RecordPaymentDrawer";
import AccountOperationsPanel, {
  type AccountStatus,
  type AccountStatusUpdate,
} from "../components/AccountOperationsPanel";
import CustomerServiceHistory from "../components/CustomerServiceHistory";
import CustomerActivityHistory from "../components/CustomerActivityHistory";
import CustomerNetworkAccessCard from "../components/CustomerNetworkAccessCard";
import { getCustomerReturnContext } from "../hooks/useOpenCustomerProfile";

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
  additional_cable_boxes: number;
  monthly_fee: string | null;

  application_date: string | null;
  activation_date: string | null;
  deactivation_date: string | null;
  reactivation_date: string | null;
  last_disconnected_on: string | null;
  last_reconnected_on: string | null;
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

type RelatedAccount = {
  customer_id: number;
  name: string | null;
  address: string | null;
  status: AccountStatus;
  monthly_fee: string | null;
  activation_date: string | null;
  account_group_id: number | null;
  package_name: string | null;
  outstanding_balance: string | null;
  next_billing_date: string | null;
};

type AccountGroup = {
  accountGroupId: number | null;
  displayName: string | null;
  accounts: RelatedAccount[];
};

type CustomerSearchOption = {
  customer_id: number;
  name: string | null;
  address: string | null;
  telephone: string | null;
  status: string;
  package_name: string | null;
};

import PaymentHistory from "../components/PaymentHistory";


function CustomerProfilePage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { customerId } = useParams();
  const { employee } = useAuth();


const canManageSubscription =
  employee?.role === "admin" ||
  employee?.role === "head_office";
  const [customer, setCustomer] = useState<Customer | null>(null);
const [accountGroup, setAccountGroup] = useState<AccountGroup | null>(null);
const [showAccountLinker, setShowAccountLinker] = useState(false);
const [accountLinkSearch, setAccountLinkSearch] = useState("");
const [accountLinkResults, setAccountLinkResults] = useState<CustomerSearchOption[]>([]);
const [linkingAccountId, setLinkingAccountId] = useState<number | null>(null);
const [accountLinkError, setAccountLinkError] = useState("");
const [loading, setLoading] = useState(true);
const [error, setError] = useState("");
    const [activeTab, setActiveTab] = useState<"overview" | "payments" | "support" | "history">(
  "overview"
);

const [packages, setPackages] = useState<PackageOption[]>([]);
const [editingSubscription, setEditingSubscription] = useState(false);
const [confirmingCableBox, setConfirmingCableBox] = useState<"add" | "remove" | null>(null);
const [savingCableBox, setSavingCableBox] = useState(false);
const [cableBoxError, setCableBoxError] = useState("");
const [selectedPackageId, setSelectedPackageId] = useState("");
const [subscriptionReason, setSubscriptionReason] = useState("");
const [savingSubscription, setSavingSubscription] = useState(false);
const [subscriptionError, setSubscriptionError] = useState("");
const [showTermination, setShowTermination] = useState(false);
const [terminationNote, setTerminationNote] = useState("");
const [terminating, setTerminating] = useState(false);
const [terminationError, setTerminationError] = useState("");
const [editingActivation, setEditingActivation] = useState(false);
const [activationInput, setActivationInput] = useState("");
const [activationReason, setActivationReason] = useState("");
const [savingActivation, setSavingActivation] = useState(false);
const [activationError, setActivationError] = useState("");
const [showPaymentForm, setShowPaymentForm] = useState(false);
const returnContext = getCustomerReturnContext(location.state);
const returnLabel = returnContext?.label ?? "Customers";
const returnToPreviousView = () => {
  // POP returns to the existing history entry, which lets the list page replay
  // its saved scroll position. A copied/deep profile URL has no trusted origin
  // state, so it safely falls back to Customer Search.
  if (returnContext && Number(window.history.state?.idx) > 0) {
    navigate(-1);
    return;
  }
  navigate(returnContext?.to ?? "/customers");
};

const loadAccountGroup = useCallback(async () => {
  if (!customerId) return;
  try {
    const response = await apiFetch(`/api/customers/${customerId}/accounts`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not load service accounts.");
    setAccountGroup(data);
  } catch {
    // The selected account remains usable even if the convenience selector
    // cannot load, so do not replace the whole profile with an error.
    setAccountGroup(null);
  }
}, [customerId]);

useEffect(() => {
  loadAccountGroup();
}, [loadAccountGroup]);

useEffect(() => {
  if (!showAccountLinker || accountLinkSearch.trim().length < 2) {
    setAccountLinkResults([]);
    return;
  }
  const timeout = window.setTimeout(async () => {
    try {
      const response = await apiFetch(
        `/api/customers?search=${encodeURIComponent(accountLinkSearch.trim())}`
      );
      const data = await response.json();
      const currentIds = new Set(
        (accountGroup?.accounts ?? []).map((account) => account.customer_id)
      );
      setAccountLinkResults(
        response.ok
          ? (data as CustomerSearchOption[])
              .filter((account) => !currentIds.has(account.customer_id))
              .slice(0, 8)
          : []
      );
    } catch {
      setAccountLinkResults([]);
    }
  }, 200);
  return () => window.clearTimeout(timeout);
}, [accountGroup, accountLinkSearch, showAccountLinker]);

const linkExistingAccount = async (otherCustomerId: number) => {
  if (!customer) return;
  try {
    setLinkingAccountId(otherCustomerId);
    setAccountLinkError("");
    const response = await apiFetch(`/api/customers/${customer.customer_id}/accounts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ otherCustomerId }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not link that account.");
    setShowAccountLinker(false);
    setAccountLinkSearch("");
    setAccountLinkResults([]);
    await loadAccountGroup();
  } catch (linkError) {
    setAccountLinkError(
      linkError instanceof Error ? linkError.message : "Could not link that account."
    );
  } finally {
    setLinkingAccountId(null);
  }
};

  // Correcting an activation date rebuilds the customer's billing schedule, so
  // the server refuses once anything has been settled against the old one. The
  // error it returns is written to be shown to staff as-is.
  const saveActivationDate = async () => {
    if (!customer) return;

    try {
      setSavingActivation(true);
      setActivationError("");

      const response = await apiFetch(
        `/api/customers/${customer.customer_id}/activation-date`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            activationDate: activationInput,
            reason: activationReason,
          }),
        }
      );

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Could not correct the activation date.");
      }

      setCustomer((current) =>
        current ? { ...current, activation_date: data.activationDate } : current
      );
      setEditingActivation(false);
      setActivationReason("");
    } catch (error) {
      setActivationError(
        error instanceof Error
          ? error.message
          : "Could not correct the activation date."
      );
    } finally {
      setSavingActivation(false);
    }
  };

const [paymentReceipt, setPaymentReceipt] = useState<PaymentReceipt | null>(null);
const [paymentRefreshKey, setPaymentRefreshKey] = useState(0);

const terminateSubscription = async () => {
  if (!customer) return;

  try {
    setTerminating(true);
    setTerminationError("");
    const response = await apiFetch(
      `/api/customers/${customer.customer_id}/terminate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: terminationNote.trim() || null }),
      }
    );
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Could not terminate the subscription.");
    }

    setCustomer((current) =>
      current
        ? {
            ...current,
            status: data.customer.status,
            deactivation_date: data.customer.deactivation_date,
            reactivation_date: data.customer.reactivation_date,
            next_billing_date: null,
            pole_box_number: null,
            port_number: null,
          }
        : current
    );
    setShowPaymentForm(false);
    setShowTermination(false);
    setTerminationNote("");
  } catch (terminationFailure) {
    setTerminationError(
      terminationFailure instanceof Error
        ? terminationFailure.message
        : "Could not terminate the subscription."
    );
  } finally {
    setTerminating(false);
  }
};


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
  apiFetch("/api/packages?context=subscription")
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
        onClick={returnToPreviousView}
        className="mt-4 text-primary"
      >
        ← Back to {returnLabel}
      </button>
    </div>
  );
}

  return (
    <div className="flex w-full flex-col gap-8 bg-surface p-8 lg:p-12">
      {/* Back */}
      <button
        type="button"
        onClick={returnToPreviousView}
        className="flex w-fit items-center gap-2 text-sm font-medium uppercase tracking-wide text-primary transition hover:opacity-70"
      >
        <span className="material-symbols-outlined text-sm">
          arrow_back
        </span>

        Back to {returnLabel}
      </button>

      {/* Customer heading */}
      <div className="flex flex-col justify-between gap-6 lg:flex-row lg:items-end">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-4">
            <h1 className="text-4xl font-semibold tracking-tight text-on-surface lg:text-5xl">
              {accountGroup?.displayName || customer.name || "Unnamed customer"}
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

            Account #{customer.customer_id}
          </div>
        </div>

        {/* Future actions */}
 <div className="flex items-center gap-4">
  {activeTab === "overview" ? (
    employee?.role === "admin" || employee?.role === "head_office" ? (
      <button
        type="button"
        onClick={() => navigate(`/customers/${customer.customer_id}/edit`, { state: location.state })}
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
    customer.status !== "terminated" ? (
      <button
        type="button"
        onClick={() => navigate(`/service-requests?customerId=${customer.customer_id}`)}
        className="flex items-center gap-2 rounded-lg bg-primary px-6 py-2.5 text-sm font-medium text-on-primary shadow-md transition hover:bg-primary-container"
      >
        <span className="material-symbols-outlined text-lg">add</span>
        New Service Ticket
      </button>
    ) : null
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

      {/* One customer-facing shell, with every operational action still
          scoped to the visibly selected service account. */}
      <section className="order-[10] rounded-2xl border border-outline-variant bg-surface-container-lowest p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-primary">account_tree</span>
              <h2 className="font-semibold text-on-surface">Service accounts</h2>
            </div>
            <p className="mt-1 text-sm text-on-surface-variant">
              Choose an account before taking a payment or changing service. Balances, billing dates, and connection status stay separate.
            </p>
          </div>
          <div className="flex gap-2">
            {canManageSubscription && (
              <button
                type="button"
                onClick={() => {
                  setShowAccountLinker((current) => !current);
                  setAccountLinkError("");
                }}
                className="rounded-lg border border-primary px-3 py-2 text-sm font-medium text-primary transition hover:bg-primary/10"
              >
                Link existing account
              </button>
            )}
            <button
              type="button"
              onClick={() => navigate(`/applications?additionalServiceFor=${customer.customer_id}`)}
              className="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-on-primary transition hover:bg-primary-container"
            >
              Add another service
            </button>
          </div>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {(accountGroup?.accounts ?? []).map((account, index) => {
            const selected = account.customer_id === customer.customer_id;
            return (
              <button
                key={account.customer_id}
                type="button"
                onClick={() => {
                  if (!selected) {
                    navigate(`/customers/${account.customer_id}`, {
                      replace: true,
                      state: location.state,
                    });
                  }
                }}
                aria-current={selected ? "page" : undefined}
                className={`rounded-xl border p-4 text-left transition ${
                  selected
                    ? "border-primary bg-primary/5 shadow-sm"
                    : "border-outline-variant hover:border-primary/50 hover:bg-surface-container-low"
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-on-surface-variant">
                      Account {index + 1}
                    </p>
                    <p className="mt-1 font-mono text-sm font-semibold text-primary">
                      #{account.customer_id}
                    </p>
                  </div>
                  <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold capitalize ${statusPillClass(account.status)}`}>
                    {account.status.replaceAll("_", " ")}
                  </span>
                </div>
                <p className="mt-3 font-semibold text-on-surface">
                  {account.package_name || "No package"}
                </p>
                <div className="mt-3 grid grid-cols-2 gap-3 text-xs text-on-surface-variant">
                  <div>
                    <p>Next bill</p>
                    <p className="mt-0.5 font-medium text-on-surface">
                      {account.next_billing_date ? formatDate(account.next_billing_date) : "Paused / none"}
                    </p>
                  </div>
                  <div>
                    <p>Outstanding</p>
                    <p className="mt-0.5 font-medium text-on-surface">
                      {formatCurrency(account.outstanding_balance)}
                    </p>
                  </div>
                </div>
                {selected && (
                  <p className="mt-3 text-xs font-semibold text-primary">Currently selected</p>
                )}
              </button>
            );
          })}
        </div>

        {showAccountLinker && (
          <div className="mt-4 rounded-xl border border-outline-variant bg-surface-container-low p-4">
            <p className="text-sm font-semibold text-on-surface">Link a legacy second account</p>
            <p className="mt-1 text-xs text-on-surface-variant">
              This only groups the displays. It does not combine payments, balances, billing, equipment, or service status.
            </p>
            <div className="relative mt-3">
              <input
                autoFocus
                value={accountLinkSearch}
                onChange={(event) => setAccountLinkSearch(event.target.value)}
                placeholder="Search by name, account number, or phone..."
                className="w-full rounded-lg border border-outline-variant bg-white px-4 py-2.5 text-sm"
              />
              {accountLinkResults.length > 0 && (
                <div className="absolute z-20 mt-1 max-h-72 w-full overflow-y-auto rounded-lg border border-outline-variant bg-white shadow-xl">
                  {accountLinkResults.map((account) => (
                    <button
                      key={account.customer_id}
                      type="button"
                      disabled={linkingAccountId !== null}
                      onClick={() => {
                        const confirmed = window.confirm(
                          `Show account #${account.customer_id} under the same customer as account #${customer.customer_id}? Payments, balances, billing dates, and service status will remain separate.`
                        );
                        if (confirmed) linkExistingAccount(account.customer_id);
                      }}
                      className="block w-full border-b border-surface-container px-4 py-3 text-left transition last:border-0 hover:bg-surface-container-low disabled:opacity-50"
                    >
                      <span className="font-semibold">{account.name || "Unnamed customer"}</span>
                      <span className="ml-2 font-mono text-xs text-primary">#{account.customer_id}</span>
                      <p className="mt-1 text-xs text-on-surface-variant">
                        {account.package_name || "No package"} · {account.address || "No address"}
                      </p>
                    </button>
                  ))}
                </div>
              )}
            </div>
            {accountLinkError && <p className="mt-3 text-sm text-error">{accountLinkError}</p>}
          </div>
        )}
      </section>

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

  <button
    type="button"
    onClick={() => setActiveTab("history")}
    className={
      activeTab === "history"
        ? "border-b-2 border-primary px-6 py-3 text-sm font-medium text-primary"
        : "px-6 py-3 text-sm font-medium text-on-surface-variant transition hover:text-on-surface"
    }
  >
    Timeline
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

                {/* The pole-box port is a field-service value. It is not the
                    Huawei PON port shown in the OLT card below. */}
                <DetailRow label="Pole Box Port" value={customer.port_number || "—"} />
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
                {customer.last_disconnected_on && (
                  <DetailRow
                    label="Last disconnected"
                    value={formatDate(customer.last_disconnected_on)}
                  />
                )}
                {customer.last_reconnected_on && (
                  <DetailRow
                    label="Last reconnected"
                    value={formatDate(customer.last_reconnected_on)}
                  />
                )}
              
<div className="flex flex-col gap-2">
  <DetailRow
    label="Date Joined"
    value={formatDate(customer.activation_date)}
  />

  {canManageSubscription && !editingActivation && (
    <button
      type="button"
      onClick={() => {
        setActivationInput(customer.activation_date?.slice(0, 10) ?? "");
        setActivationReason("");
        setActivationError("");
        setEditingActivation(true);
      }}
      className="self-start rounded-md border border-tertiary px-2 py-0.5 text-[11px] font-medium leading-5 text-tertiary transition hover:bg-tertiary/10"
    >
      Correct this date
    </button>
  )}

  {canManageSubscription && editingActivation && (
    <div className="flex flex-col gap-2 rounded-lg border border-surface-container p-3">
      {/* Only offered before the first bill goes out. The server checks the
          same thing and will refuse once they have been billed. */}
      <p className="text-xs text-on-surface-variant">
        This sets their billing date. It can only be changed up until their
        first bill.
      </p>

      <input
        type="date"
        value={activationInput}
        onChange={(event) => setActivationInput(event.target.value)}
        className="rounded-lg border border-surface-container px-3 py-2 text-sm"
      />

      <input
        type="text"
        value={activationReason}
        onChange={(event) => setActivationReason(event.target.value)}
        placeholder="Reason for the correction"
        className="rounded-lg border border-surface-container px-3 py-2 text-sm"
      />

      {activationError && (
        <p className="text-xs text-error">{activationError}</p>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          disabled={savingActivation}
          onClick={saveActivationDate}
          className="rounded-lg bg-primary px-3 py-2 text-xs font-medium text-on-primary disabled:opacity-60"
        >
          {savingActivation ? "Saving..." : "Save date"}
        </button>

        <button
          type="button"
          onClick={() => setEditingActivation(false)}
          className="rounded-lg px-3 py-2 text-xs font-medium text-on-surface-variant"
        >
          Cancel
        </button>
      </div>
    </div>
  )}
</div>

<DetailRow
  label="Tenure"
  value={calculateTenure(customer.activation_date)}
/>
              </div>
            </section>
          </div>

          <CustomerNetworkAccessCard
            key={`${customer.customer_id}-${customer.status}`}
            customerId={customer.customer_id}
            canEdit={canManageSubscription && customer.status !== "terminated"}
            accountStatus={customer.status}
            onStatusSynced={(update: AccountStatusUpdate) => {
              setCustomer((current) =>
                current
                  ? {
                      ...current,
                      status: update.status,
                      deactivation_date: update.deactivation_date,
                      reactivation_date: update.reactivation_date,
                      last_disconnected_on:
                        update.status === "disconnected"
                          ? update.deactivation_date
                          : current.last_disconnected_on,
                      last_reconnected_on:
                        update.status === "active"
                          ? update.reactivation_date
                          : current.last_reconnected_on,
                    }
                  : current
              );
            }}
          />

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
                        last_disconnected_on:
                          update.status === "disconnected"
                            ? update.deactivation_date
                            : current.last_disconnected_on,
                        last_reconnected_on:
                          update.status === "active"
                            ? update.reactivation_date
                            : current.last_reconnected_on,
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
                {customer.status === "terminated" ? "Former Package" : "Current Package"}
              </h2>
            </div>

            <div className="mb-6">
              <p className="text-xs uppercase tracking-wider opacity-70">
                {customer.status === "terminated" ? "Last Subscribed Plan" : "Subscribed Plan"}
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
    {customer.status === "terminated"
      ? "Last monthly rate before termination"
      : "This customer’s current billed monthly rate"}
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
      : customer.status === "terminated"
        ? "No future charges"
      : "Billing paused"}
</p>
{!customer.next_billing_date && customer.status !== "active" && (
  <p className="mt-1 text-xs opacity-70">
    {customer.status === "terminated"
      ? "The subscription has ended; previous balances and history are retained."
      : "Recurring charges resume when the account is active."}
  </p>
)}
            </div>

            {canManageSubscription && customer.status !== "terminated" && !editingSubscription && (
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
                  {customer.additional_cable_boxes > 0 && (
                    <> Cable plans retain the extra box charge of J${(customer.additional_cable_boxes * 1000).toLocaleString()}/month. Switching to internet only removes the extra boxes and their recurring charge.</>
                  )}
                </p>
                {subscriptionError && <p className="text-sm text-error">{subscriptionError}</p>}

                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={savingSubscription || savingCableBox}
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
                          additional_cable_boxes: data.additionalCableBoxes,
                          default_monthly_charge:
                            chosen?.default_monthly_charge ?? data.monthlyFee,
                        } : current);
                        setEditingSubscription(false);
                        setConfirmingCableBox(null);
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
                    disabled={savingSubscription || savingCableBox}
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

            {(customer.package_service_type === "cable" || customer.package_service_type === "cable_internet") && (
              <div className="mt-4 space-y-3 border-t border-white/20 pt-4">
                <div>
                  <p className="text-sm font-semibold">Number of cable boxes: {1 + customer.additional_cable_boxes}</p>
                  <p className="mt-1 text-xs opacity-75">
                    1 included · {customer.additional_cable_boxes} additional · J${(customer.additional_cable_boxes * 1000).toLocaleString()}/month extra
                  </p>
                </div>
                {canManageSubscription && customer.status !== "terminated" && (
                  confirmingCableBox ? (
                    <div className="space-y-3 rounded-xl bg-black/15 p-4">
                      <p className="text-sm">
                        {confirmingCableBox === "add" ? "This monthly bill will add J$1,000 to" : "Remove one cable box? Your monthly bill will decrease by J$1,000 to"} J${(Number(customer.monthly_fee) + (confirmingCableBox === "add" ? 1000 : -1000)).toLocaleString()}. Number of cable boxes: {customer.additional_cable_boxes + (confirmingCableBox === "add" ? 2 : 0)}.
                      </p>
                      <p className="text-xs leading-5 opacity-75">
                        Applies to future billing anniversaries. Staff record installation fees and payments separately.
                      </p>
                      {cableBoxError && <p role="alert" className="text-sm text-white">{cableBoxError}</p>}
                      <div className="flex gap-2">
                        <button
                          type="button"
                          disabled={savingCableBox || savingSubscription}
                          className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-primary disabled:opacity-60"
                          onClick={async () => {
                            setSavingCableBox(true);
                            setCableBoxError("");
                            try {
                              const response = await apiFetch(`/api/customers/${customer.customer_id}/cable-boxes`, {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ expectedCount: customer.additional_cable_boxes, action: confirmingCableBox }),
                              });
                              const data = await response.json();
                              if (!response.ok) throw new Error(data.error || "Could not update cable boxes.");
                              setCustomer((current) => current ? {
                                ...current,
                                additional_cable_boxes: data.additionalCableBoxes,
                                monthly_fee: data.monthlyFee,
                              } : current);
                              setConfirmingCableBox(null);
                            } catch (error) {
                              setCableBoxError(error instanceof Error ? error.message : "Could not update cable boxes.");
                            } finally {
                              setSavingCableBox(false);
                            }
                          }}
                        >{savingCableBox ? "Saving..." : confirmingCableBox === "add" ? "Confirm Add Cable Box" : "Confirm Remove Cable Box"}</button>
                        <button type="button" disabled={savingCableBox} onClick={() => setConfirmingCableBox(null)} className="rounded-lg bg-black/20 px-4 py-2 text-sm disabled:opacity-60">Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-2">
                    <button
                      type="button"
                      disabled={savingSubscription || customer.monthly_fee == null}
                      onClick={() => { setCableBoxError(""); setConfirmingCableBox("add"); }}
                      className="w-full rounded-lg bg-white py-3 font-medium text-primary transition hover:bg-white/90 disabled:opacity-60"
                    >Add Cable Box · +J$1,000/month</button>
                    <button
                      type="button"
                      disabled={savingSubscription || customer.monthly_fee == null || customer.additional_cable_boxes === 0}
                      onClick={() => { setCableBoxError(""); setConfirmingCableBox("remove"); }}
                      className="w-full rounded-lg bg-white py-3 font-medium text-primary transition hover:bg-white/90 disabled:opacity-60"
                    >Remove Cable Box · −J$1,000/month</button>
                    {customer.additional_cable_boxes === 0 && <p className="text-xs opacity-75">The included cable box cannot be removed.</p>}
                    </div>
                  )
                )}
              </div>
            )}
          </section>

        </div>
        </div>
) : activeTab === "payments" ? (
  <PaymentHistory refreshKey={paymentRefreshKey} />
 ) : activeTab === "support" ? (
  <CustomerServiceHistory customerId={customer.customer_id} />
 ) : (
  <CustomerActivityHistory customerId={customer.customer_id} />
)}

      {canManageSubscription && (
        <section className="order-[20] rounded-2xl border border-error/25 bg-error/5 p-6 shadow-sm">
          {customer.status === "terminated" ? (
            <div className="flex items-start gap-3">
              <span className="material-symbols-outlined text-on-surface-variant">
                person_cancel
              </span>
              <div>
                <h2 className="font-semibold text-on-surface">Subscription terminated</h2>
                <p className="mt-1 text-sm text-on-surface-variant">
                  This customer remains in the database, but recurring charges,
                  package changes, and OLT assignments are disabled. Existing
                  balances can still be settled.
                </p>
              </div>
            </div>
          ) : (
            <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
              <div>
                <h2 className="font-semibold text-on-surface">Terminate subscription</h2>
                <p className="mt-1 text-sm text-on-surface-variant">
                  Keep the customer record and history, but stop future billing
                  and remove any saved OLT information.
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setTerminationNote("");
                  setTerminationError("");
                  setShowTermination(true);
                }}
                className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg bg-error px-5 py-2.5 text-sm font-semibold text-white transition hover:opacity-90"
              >
                <span className="material-symbols-outlined text-lg">person_cancel</span>
                Terminate
              </button>
            </div>
          )}
        </section>
      )}

      {showTermination && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !terminating) {
              setShowTermination(false);
            }
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="terminate-subscription-title"
            className="w-full max-w-lg rounded-2xl bg-surface p-6 shadow-2xl"
          >
            <div className="flex items-start gap-3">
              <span className="material-symbols-outlined rounded-full bg-error/10 p-2 text-error">
                person_cancel
              </span>
              <div>
                <h2 id="terminate-subscription-title" className="text-xl font-semibold">
                  Terminate this subscription?
                </h2>
                <p className="mt-2 text-sm leading-6 text-on-surface-variant">
                  {customer.name || `Customer #${customer.customer_id}`} will remain searchable
                  with all existing history. No new recurring charges will be created,
                  and any current OLT information will be released and removed from the profile.
                </p>
              </div>
            </div>

            <label className="mt-5 block text-sm font-medium text-on-surface">
              Termination note <span className="font-normal text-on-surface-variant">(optional)</span>
              <textarea
                rows={4}
                maxLength={500}
                value={terminationNote}
                disabled={terminating}
                onChange={(event) => setTerminationNote(event.target.value)}
                placeholder="Reason or other details..."
                className="mt-2 w-full resize-none rounded-lg border border-outline-variant bg-surface px-3 py-2.5 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/15 disabled:opacity-60"
              />
            </label>

            {terminationError && (
              <p className="mt-3 rounded-lg bg-error/10 p-3 text-sm text-error">
                {terminationError}
              </p>
            )}

            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                disabled={terminating}
                onClick={() => setShowTermination(false)}
                className="rounded-lg border border-outline-variant px-4 py-2.5 text-sm font-medium transition hover:bg-surface-container disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={terminating}
                onClick={terminateSubscription}
                className="rounded-lg bg-error px-4 py-2.5 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-wait disabled:opacity-60"
              >
                {terminating ? "Terminating..." : "Terminate"}
              </button>
            </div>
          </section>
        </div>
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
    offline: "bg-[#8a2d5f]/10 text-[#8a2d5f]",
    suspended: "bg-warning-container text-warning",
    terminated: "bg-surface-container-high text-on-surface-variant",
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

function formatCurrency(value: string | null) {
  const amount = Number(value ?? 0);
  return `J$${Number.isFinite(amount) ? amount.toLocaleString("en-JM", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }) : "0.00"}`;
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
