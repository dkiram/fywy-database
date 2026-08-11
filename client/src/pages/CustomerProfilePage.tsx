import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import PaymentHistory from "../components/PaymentHistory";

function CustomerProfilePage() {
  const navigate = useNavigate();
  const { customerId } = useParams();
    const [activeTab, setActiveTab] = useState<"overview" | "payments">(
  "overview"
);

  return (
    <div className="flex w-full flex-col gap-8 bg-surface p-8 lg:p-12">
      {/* Back */}
      <button
        type="button"
        onClick={() => navigate("/")}
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
            <h1 className="text-4xl font-bold tracking-tight text-on-surface lg:text-5xl">
              John Smith
            </h1>

            <div className="flex items-center gap-2 rounded-full bg-tertiary/10 px-3 py-1 text-tertiary">
              <span className="h-1.5 w-1.5 rounded-full bg-tertiary" />

              <span className="text-xs font-bold uppercase tracking-wider">
                Active
              </span>
            </div>
          </div>

          <div className="flex w-fit items-center gap-2 rounded-md bg-surface-container px-3 py-1 font-mono text-sm text-on-surface-variant">
            <span className="material-symbols-outlined text-base">
              fingerprint
            </span>

            {customerId ?? "CUST-10234"}
          </div>
        </div>

        {/* Future actions */}
 <div className="flex items-center gap-4">
  {activeTab === "overview" ? (
    <button
      type="button"
      disabled
      title="Coming later"
      className="flex cursor-not-allowed items-center gap-2 rounded-lg bg-primary px-6 py-2.5 text-sm font-bold text-on-primary opacity-80 shadow-md"
    >
      <span className="material-symbols-outlined text-lg">
        edit
      </span>

      Edit Profile
    </button>
  ) : (
    <button
      type="button"
      disabled
      title="Record Payment coming next"
      className="flex cursor-not-allowed items-center gap-2 rounded-lg bg-primary px-6 py-2.5 text-sm font-bold text-on-primary opacity-80 shadow-md"
    >
      <span className="material-symbols-outlined text-lg">
        add
      </span>

      Record Payment
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
        ? "border-b-2 border-primary px-6 py-3 text-sm font-bold text-primary"
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
        ? "border-b-2 border-primary px-6 py-3 text-sm font-bold text-primary"
        : "px-6 py-3 text-sm font-medium text-on-surface-variant transition hover:text-on-surface"
    }
  >
    Payments
  </button>

  <button
    type="button"
    disabled
    title="Coming later"
    className="cursor-not-allowed px-6 py-3 text-sm font-medium text-on-surface-variant opacity-60"
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

              <h2 className="text-lg font-bold">
                Customer Information
              </h2>
            </div>

            <div className="grid grid-cols-1 gap-x-8 gap-y-6 sm:grid-cols-2">
              <InfoItem label="Full Name" value="John Smith" />

              <InfoItem
                label="Customer ID"
                value={customerId ?? "CUST-10234"}
              />

              <InfoItem
                label="Phone Number"
                value="(876) 555-0142"
              />

              <InfoItem
                label="Email Address"
                value="john.smith@example.com"
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
                    24 Harbour View Drive
                    <br />
                    Montego Bay, St. James
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

                <h2 className="font-bold">
                  Service / Equipment
                </h2>
              </div>

              <div className="flex flex-col gap-4">
                <DetailRow label="Pole Box" value="PB-104" />
                <DetailRow label="Port" value="08" />
                <DetailRow
                  label="Service Area"
                  value="Montego Bay"
                />
              </div>
            </section>

            <section className="rounded-2xl bg-surface-container-lowest p-6 shadow-sm">
              <div className="mb-5 flex items-center gap-2 border-b border-surface-container pb-3">
                <span className="material-symbols-outlined text-secondary">
                  manage_accounts
                </span>

                <h2 className="font-bold">
                  Account Info
                </h2>
              </div>

              <div className="flex flex-col gap-4">
                <DetailRow label="Status" value="Active" />
                <DetailRow
                  label="Date Joined"
                  value="March 14, 2021"
                />
                <DetailRow
                  label="Tenure"
                  value="5 years"
                />
              </div>
            </section>
          </div>
        </div>

        {/* Right column */}
        <div className="flex flex-col gap-6 lg:col-span-4">
          {/* Package */}
          <section className="relative overflow-hidden rounded-2xl bg-primary p-6 text-on-primary shadow-xl">
            <div className="mb-6 flex items-center gap-3 border-b border-white/20 pb-4">
              <span className="material-symbols-outlined">
                tv
              </span>

              <h2 className="text-lg font-bold">
                Current Package
              </h2>
            </div>

            <div className="mb-6">
              <p className="text-xs uppercase tracking-wider opacity-70">
                Subscribed Plan
              </p>

              <p className="mt-2 text-2xl font-bold">
                Premium Cable
              </p>
            </div>

            <div className="mb-6">
              <p className="text-xs uppercase tracking-wider opacity-70">
                Monthly Rate
              </p>

              <div className="mt-1 flex items-baseline gap-1">
                <span className="text-xl">J$</span>
                <span className="text-4xl font-bold">
                  3,500
                </span>
              </div>
            </div>

            <div className="mb-4 rounded-xl bg-black/10 p-4">
              <p className="text-xs opacity-70">
                Next Billing Date
              </p>

              <p className="mt-1 text-sm font-bold">
                September 14, 2026
              </p>
            </div>

            <button
              type="button"
              className="w-full rounded-lg bg-white py-3 font-bold text-primary transition hover:opacity-90"
            >
              Manage Subscription
            </button>
          </section>

          {/* Recent activity */}
          <section className="rounded-2xl bg-surface-container-lowest p-6 shadow-sm">
            <div className="mb-5 flex items-center justify-between">
              <h3 className="text-sm font-bold">
                Recent Activity
              </h3>

              <button
                type="button"
                className="text-xs font-medium text-primary"
              >
                View All
              </button>
            </div>

            <div className="flex flex-col gap-5 border-l-2 border-surface-container pl-5">
              <div>
                <p className="text-sm font-medium">
                  Payment Received
                </p>

                <p className="text-xs font-bold text-tertiary">
                  +J$3,500
                </p>

                <p className="mt-1 text-xs text-on-surface-variant">
                  August 5, 2026
                </p>
              </div>

              <div>
                <p className="text-sm font-medium">
                  Service Call
                </p>

                <p className="text-xs text-on-surface-variant">
                  Checked line noise on PB-104
                </p>

                <p className="mt-1 text-xs text-on-surface-variant">
                  July 22, 2026
                </p>
              </div>
            </div>
          </section>
        </div>
        </div>
) : (
  <PaymentHistory />
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

export default CustomerProfilePage;