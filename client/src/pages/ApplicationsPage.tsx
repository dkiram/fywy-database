/** Manages the application queue from intake through service, cancellation, or decline. */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { useAuth } from "../auth/AuthContext";
import PaymentReceiptModal, { type PaymentReceipt } from "../components/PaymentReceiptModal";
import { apiFetch } from "../lib/api";
import { useOpenCustomerProfile } from "../hooks/useOpenCustomerProfile";
import { useScrollRestoration } from "../hooks/useScrollRestoration";

type ApplicationStatus =
  | "pending"
  | "serviced"
  | "cancelled"
  | "declined"
  | "legacy_unresolved"
  | "match_review"
  // Confirmed to be somebody already in the customer list. Not an activation:
  // no account was created and no customer record was touched.
  | "confirmed_existing";

type ApplicationRecord = {
  application_id: number;
  legacy_application_id: number | null;
  legacy_source: string | null;
  name: string;
  alias: string | null;
  address: string | null;
  occupation: string | null;
  telephone: string | null;
  email: string | null;
  id_type: string | null;
  id_number: string | null;
  package_id: number | null;
  package_name: string | null;
  monthly_fee: string | null;
  application_date: string;
  activation_date: string | null;
  adult_channel: boolean;
  additional_box: number | null;
  pole_box_number: string | null;
  port_number: string | null;
  status: ApplicationStatus;
  customer_id: number | null;
  suggested_customer_id: number | null;
  suggested_customer_name: string | null;
  additional_service_for_customer_id: number | null;
  additional_service_customer_name: string | null;
  linked_customer_name: string | null;
  match_method: string | null;
  closure_reason: string | null;
  match_confirmed_at: string | null;
  match_confirmed_by_name: string | null;
  // The installation fee collected when this application was taken, if any.
  // It follows the application: activation moves it onto the new customer's
  // record, closing the application voids it.
  installation_payment_id: number | null;
  installation_amount: string | null;
  installation_receipt_number: string | null;
  installation_voided: boolean;
  is_overdue: boolean;
  // The latest installation job sent to a technician for this application,
  // if any (migration 079). An installation rides the service-ticket rail, so
  // its status is a ticket status: assigned, in_progress, completed,
  // unresolved or cancelled.
  install_ticket_id: number | null;
  install_status: string | null;
  install_notes: string | null;
  install_updated_at: string | null;
  install_technician_name: string | null;
};

// Minimal shape of /api/customers, used by the Match Review customer picker.
type CustomerOption = {
  customer_id: number;
  name: string | null;
  address: string | null;
  telephone: string | null;
  status: string;
};

type Package = {
  package_id: number;
  name: string;
  default_monthly_charge: string | null;
  installation_fee: string | null;
  service_type: "cable" | "internet" | "cable_internet";
  plan_tier: string | null;
  speed_mbps: number | null;
};

type ApplicationSummary = {
  active: number;
  closed: number;
  confirmed: number;
  overdue: number;
  out_for_install: number;
  installed: number;
  install_failed: number;
};

type ApplicationPagination = {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
};

type ApplicationView =
  | "active"
  | "review"
  | "serviced"
  | "closed"
  // The Access import artefact, NOT a technician who could not install. The
  // two were both called "unresolved" and that was genuinely confusing on
  // screen, so this one is labelled Legacy in the tab strip.
  | "unresolved"
  | "confirmed"
  // Where an installation sent to a technician has got to. All three hold
  // applications that are still pending, because the office has not activated
  // them yet.
  | "out_for_install"
  | "installed"
  | "install_failed"
  | "all";

type OltOption = {
  olt_id: number;
  name: string;
  management_ip: string;
};

type ActivationOltForm = {
  oltName: string;
  managementIp: string;
  frame: string;
  slot: string;
  ponPort: string;
  ontId: string;
};

type NewApplicationForm = {
  name: string;
  alias: string;
  address: string;
  occupation: string;
  telephone: string;
  email: string;
  idType: string;
  idNumber: string;
  packageId: string;
  monthlyFee: string;
  // Prefilled from the package and editable at the counter. Blank or zero
  // means nothing was collected, and no payment is recorded.
  installationFee: string;
  applicationDate: string;
  adultChannel: boolean;
  additionalBox: string;
  additionalServiceForCustomerId: number | null;
};

const emptySummary: ApplicationSummary = {
  active: 0,
  closed: 0,
  confirmed: 0,
  overdue: 0,
  out_for_install: 0,
  installed: 0,
  install_failed: 0,
};

const emptyPagination: ApplicationPagination = {
  page: 1,
  limit: 5,
  total: 0,
  totalPages: 1,
};

function jamaicaToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Jamaica",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function packageOptionLabel(item: Package) {
  const price = item.default_monthly_charge
    ? `J$${Number(item.default_monthly_charge).toLocaleString()}/month`
    : "Price unavailable";
  return `${item.name} — ${price}`;
}

const emptyActivationOlt: ActivationOltForm = {
  oltName: "",
  managementIp: "",
  frame: "",
  slot: "",
  ponPort: "",
  ontId: "",
};

function initialNewApplication(): NewApplicationForm {
  return {
    name: "",
    alias: "",
    address: "",
    occupation: "",
    telephone: "",
    email: "",
    idType: "",
    idNumber: "",
    packageId: "",
    monthlyFee: "",
    installationFee: "",
    applicationDate: jamaicaToday(),
    adultChannel: false,
    additionalBox: "0",
    additionalServiceForCustomerId: null,
  };
}

function ApplicationsPage() {
  const openCustomer = useOpenCustomerProfile();
  const [searchParams, setSearchParams] = useSearchParams();
  const { employee } = useAuth();
  const canDecide =
    employee?.role === "admin" || employee?.role === "head_office";

  const [applications, setApplications] = useState<ApplicationRecord[]>([]);
  const [summary, setSummary] = useState<ApplicationSummary>(emptySummary);
  const [packages, setPackages] = useState<Package[]>([]);
  const view = (searchParams.get("view") as ApplicationView) || "active";
  const search = searchParams.get("search") ?? "";
  const page = Math.max(Number.parseInt(searchParams.get("page") ?? "1", 10) || 1, 1);
  const updateListParams = useCallback((
    patch: Partial<Record<"view" | "search" | "page", string | null>>
  ) => {
    setLoading(true);
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        for (const [key, value] of Object.entries(patch)) {
          if (!value) next.delete(key);
          else next.set(key, value);
        }
        return next;
      },
      { replace: true }
    );
  }, [setSearchParams]);
  const setView = (value: ApplicationView) => updateListParams({ view: value, page: null });
  const setSearch = (value: string) => updateListParams({ search: value || null, page: null });
  const setPage = useCallback((value: React.SetStateAction<number>) => {
    const next = typeof value === "function" ? value(page) : value;
    updateListParams({ page: next > 1 ? String(next) : null });
  }, [page, updateListParams]);
  const [pagination, setPagination] =
    useState<ApplicationPagination>(emptyPagination);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [noticeCustomerId, setNoticeCustomerId] = useState<number | null>(null);
  useScrollRestoration(!loading);

  const [dispatching, setDispatching] = useState<ApplicationRecord | null>(null);
  const [selected, setSelected] = useState<ApplicationRecord | null>(null);
  // Shown right after an installation fee is collected, and reprintable from
  // the application drawer afterwards.
  const [receipt, setReceipt] = useState<PaymentReceipt | null>(null);
  const [showNewForm, setShowNewForm] = useState(false);
  const [newForm, setNewForm] = useState<NewApplicationForm>(
    initialNewApplication
  );
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [newApplicationKind, setNewApplicationKind] = useState<"new" | "additional">("new");
  const [additionalServiceCustomer, setAdditionalServiceCustomer] =
    useState<CustomerOption | null>(null);
  const [additionalServiceSearch, setAdditionalServiceSearch] = useState("");
  const [additionalServiceResults, setAdditionalServiceResults] =
    useState<CustomerOption[]>([]);

  const [decision, setDecision] = useState<
    "service" | "close" | "confirm-match" | "reopen-match" | null
  >(null);
  // Match Review customer picker. Most reviews arrive with a suggestion, but
  // the matcher only suggests where it found strong evidence - plenty of real
  // matches are ones only a person recognises, so the reviewer must be able to
  // go and find the customer themselves.
  const [matchCustomer, setMatchCustomer] = useState<CustomerOption | null>(null);
  const [matchSearch, setMatchSearch] = useState("");
  const [matchResults, setMatchResults] = useState<CustomerOption[]>([]);
  const [serviceMode, setServiceMode] = useState<"link" | "create" | "additional">("create");
  const [decisionNote, setDecisionNote] = useState("");
  const [closeStatus, setCloseStatus] = useState<"cancelled" | "declined">(
    "cancelled"
  );
  const [decisionError, setDecisionError] = useState("");
  // Final installation/account values are confirmed during activation instead
  // of assuming the values submitted on the original application are final.
  const [activationPackageId, setActivationPackageId] = useState("");
  const [activationMonthlyFee, setActivationMonthlyFee] = useState("");
  const [activationPoleBox, setActivationPoleBox] = useState("");
  const [activationPort, setActivationPort] = useState("");
  const [activationDate, setActivationDate] = useState(jamaicaToday());
  // OLT mapping entered at activation. Mandatory for a brand-new (non-legacy)
  // application: the server checks this ONT location against the live OLT and
  // refuses the activation if nothing answers there.
  const [olts, setOlts] = useState<OltOption[]>([]);
  const [activationOlt, setActivationOlt] =
    useState<ActivationOltForm>(emptyActivationOlt);

  const loadApplications = useCallback(async () => {
    try {
      setLoading(true);
      setError("");
      const response = await apiFetch(
        `/api/applications?view=${view}&search=${encodeURIComponent(search)}&page=${page}`
      );
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Could not load applications.");
      }
      setApplications(data.applications);
      setSummary(data.summary);
      setPagination(data.pagination);
      if (data.pagination.page !== page) {
        setPage(data.pagination.page);
      }
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Could not load applications."
      );
    } finally {
      setLoading(false);
    }
  }, [page, search, setPage, view]);

  useEffect(() => {
    const timeout = window.setTimeout(loadApplications, 180);
    return () => window.clearTimeout(timeout);
  }, [loadApplications]);

  useEffect(() => {
    const loadPackages = async () => {
      const response = await apiFetch("/api/packages");
      const data = await response.json();
      if (response.ok) setPackages(data.packages);
    };
    loadPackages().catch(() => setPackages([]));
  }, []);

  useEffect(() => {
    const loadOlts = async () => {
      const response = await apiFetch("/api/olts");
      const data = await response.json();
      if (response.ok) setOlts(data.olts);
    };
    loadOlts().catch(() => setOlts([]));
  }, []);

  // "Add another service" on a profile opens this form with that customer
  // already selected. Staff can still edit the service address and contact
  // details because the second service may be at a different location.
  const additionalServiceParam = searchParams.get("additionalServiceFor");
  useEffect(() => {
    if (!additionalServiceParam || !/^\d+$/.test(additionalServiceParam)) return;
    apiFetch(`/api/customers?search=${encodeURIComponent(additionalServiceParam)}`)
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error();
        const customer = (data as CustomerOption[]).find(
          (item) => item.customer_id === Number(additionalServiceParam)
        );
        if (!customer) return;
        setAdditionalServiceCustomer(customer);
        setAdditionalServiceSearch("");
        setAdditionalServiceResults([]);
        setNewApplicationKind("additional");
        setNewForm({
          ...initialNewApplication(),
          name: customer.name ?? "",
          address: customer.address ?? "",
          telephone: customer.telephone ?? "",
          additionalServiceForCustomerId: customer.customer_id,
        });
        setFormError("");
        setShowNewForm(true);
      })
      .catch(() => undefined);
  }, [additionalServiceParam]);

  useEffect(() => {
    if (
      !showNewForm ||
      newApplicationKind !== "additional" ||
      additionalServiceCustomer ||
      additionalServiceSearch.trim().length < 2
    ) {
      setAdditionalServiceResults([]);
      return;
    }
    const timeout = window.setTimeout(async () => {
      try {
        const response = await apiFetch(
          `/api/customers?search=${encodeURIComponent(additionalServiceSearch.trim())}`
        );
        const data = await response.json();
        setAdditionalServiceResults(response.ok ? (data as CustomerOption[]).slice(0, 8) : []);
      } catch {
        setAdditionalServiceResults([]);
      }
    }, 200);
    return () => window.clearTimeout(timeout);
  }, [
    additionalServiceCustomer,
    additionalServiceSearch,
    newApplicationKind,
    showNewForm,
  ]);

  useEffect(() => {
    if (decision !== "confirm-match" || matchCustomer || matchSearch.trim().length < 2) {
      setMatchResults([]);
      return;
    }
    const timeout = window.setTimeout(async () => {
      try {
        const response = await apiFetch(
          `/api/customers?search=${encodeURIComponent(matchSearch.trim())}`
        );
        const data = await response.json();
        setMatchResults(response.ok ? data.slice(0, 8) : []);
      } catch {
        setMatchResults([]);
      }
    }, 200);
    return () => window.clearTimeout(timeout);
  }, [decision, matchCustomer, matchSearch]);

  const activeApplication = useMemo(
    () =>
      applications.find(
        (item) => item.application_id === selected?.application_id
      ) ?? selected,
    [applications, selected]
  );

  const activationOltIncomplete = useMemo(
    () =>
      [
        activationOlt.oltName,
        activationOlt.managementIp,
        activationOlt.frame,
        activationOlt.slot,
        activationOlt.ponPort,
        activationOlt.ontId,
      ].some((value) => value.trim() === ""),
    [activationOlt]
  );

  const openServiceDecision = (application: ApplicationRecord) => {
    setSelected(application);
    setServiceMode(
      application.additional_service_for_customer_id
        ? "additional"
        : application.suggested_customer_id
          ? "link"
          : "create"
    );
    setDecisionNote("");
    setDecisionError("");
    // Pre-fill the activation form from the application, while allowing staff
    // to correct package, rate, pole, port, or date before committing.
    setActivationPackageId(String(application.package_id ?? ""));
    setActivationMonthlyFee(application.monthly_fee ?? "");
    setActivationPoleBox(application.pole_box_number ?? "");
    setActivationPort(application.port_number ?? "");
    setActivationDate(application.activation_date?.slice(0, 10) ?? jamaicaToday());
    setActivationOlt(emptyActivationOlt);
    setDecision("service");
  };

  // Match Review's third outcome. Separate from Activate on purpose: this
  // creates nothing and bills nobody, and putting it behind the same tick was
  // exactly why reviewers left confirmed matches sitting in the queue.
  const openConfirmMatch = (application: ApplicationRecord) => {
    setSelected(application);
    setDecisionNote("");
    setDecisionError("");
    setMatchSearch("");
    setMatchResults([]);
    // A suggestion pre-fills the picker; the reviewer can still clear it and
    // choose somebody else if the matcher guessed the wrong person.
    setMatchCustomer(
      application.suggested_customer_id
        ? {
            customer_id: application.suggested_customer_id,
            name: application.suggested_customer_name,
            address: null,
            telephone: null,
            status: "active",
          }
        : null
    );
    setDecision("confirm-match");
  };

  const openReopenMatch = (application: ApplicationRecord) => {
    setSelected(application);
    setDecisionNote("");
    setDecisionError("");
    setDecision("reopen-match");
  };

  // Reprints the slip for an installation fee already collected. The receipt
  // route serves applicant-stage payments as well as customer ones.
  const openInstallationReceipt = async (paymentId: number) => {
    try {
      setError("");
      const response = await apiFetch(`/api/payments/${paymentId}/receipt`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load receipt.");
      setReceipt(data.payment);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load receipt.");
    }
  };

  const openCloseDecision = (application: ApplicationRecord) => {
    setSelected(application);
    setCloseStatus("cancelled");
    setDecisionNote("");
    setDecisionError("");
    setDecision("close");
  };

  const createApplication = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      setSaving(true);
      setFormError("");
      const response = await apiFetch("/api/applications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newForm),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Could not create application.");
      }
      setShowNewForm(false);
      setNewForm(initialNewApplication());
      setNewApplicationKind("new");
      setAdditionalServiceCustomer(null);
      setAdditionalServiceSearch("");
      setView("active");
      setNotice(
        data.installationPayment
          ? `Application #${data.application.application_id} was created and an installation fee of ${formatCurrency(data.installationPayment.amount_paid)} was recorded.`
          : `Application #${data.application.application_id} was created.`
      );
      setNoticeCustomerId(null);
      // The applicant paid cash and is standing at the counter, so put the
      // receipt on screen straight away rather than making the clerk find the
      // payment on the daily ledger to print it.
      if (data.installationPayment) setReceipt(data.installationPayment);
      await loadApplications();
    } catch (saveError) {
      setFormError(
        saveError instanceof Error
          ? saveError.message
          : "Could not create application."
      );
    } finally {
      setSaving(false);
    }
  };

  const submitServiceDecision = async () => {
    if (!activeApplication) return;
    try {
      setSaving(true);
      setDecisionError("");
      const response = await apiFetch(
        `/api/applications/${activeApplication.application_id}/activate`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            // A suggested match links to the existing customer; otherwise the
            // server creates a new active customer in the same transaction.
            customerId:
              serviceMode === "link"
                ? activeApplication.suggested_customer_id
                : undefined,
            createNew: serviceMode === "create",
            additionalServiceForCustomerId:
              serviceMode === "additional"
                ? activeApplication.additional_service_for_customer_id
                : undefined,
            note: decisionNote,
            packageId: activationPackageId,
            monthlyFee: activationMonthlyFee,
            poleBoxNumber: activationPoleBox,
            portNumber: activationPort,
            activationDate,
            oltName: activationOlt.oltName,
            oltManagementIp: activationOlt.managementIp,
            frameNumber: activationOlt.frame,
            slotNumber: activationOlt.slot,
            ponPortNumber: activationOlt.ponPort,
            ontId: activationOlt.ontId,
          }),
        }
      );
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Could not activate application.");
      }
      setDecision(null);
      setSelected(null);
      const feeNote = data.installationPayment
        ? ` The ${formatCurrency(data.installationPayment.amount_paid)} installation fee is now their first payment.`
        : "";
      const oltNote = data.oltMapping
        ? data.oltMapping.verificationMethod === "hanover_unverified_fallback"
          ? ` Hanover ONT location ${data.oltMapping.location} was recorded as unverified and can be verified later when the direct link is available.`
          : ` ONT location ${data.oltMapping.location} verified live on ${data.oltMapping.oltName}.` +
            (data.oltMapping.descriptionOverrideApplied
              ? " Hanover's no-description placeholder was accepted for this exact ONT serial and location."
              : data.oltMapping.descriptionMatches
              ? ""
              : " The live ONT description does not match the customer name — check it on the OLT.")
        : "";
      setNotice(
        (data.additionalService
          ? `Additional service activated as account #${data.customerId}.`
          : data.createdCustomer
          ? `Application activated. Customer #${data.customerId} was created.`
          : `Application linked to existing customer #${data.customerId}.`) +
          feeNote +
          oltNote
      );
      setNoticeCustomerId(data.customerId);
      await loadApplications();
    } catch (saveError) {
      setDecisionError(
        saveError instanceof Error
          ? saveError.message
          : "Could not activate application."
      );
    } finally {
      setSaving(false);
    }
  };

  const submitConfirmMatch = async () => {
    if (!activeApplication) return;
    try {
      setSaving(true);
      setDecisionError("");
      const response = await apiFetch(
        `/api/applications/${activeApplication.application_id}/confirm-match`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            customerId: matchCustomer?.customer_id,
            note: decisionNote,
          }),
        }
      );
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Could not confirm the match.");
      }
      setDecision(null);
      setSelected(null);
      setNotice(
        `Confirmed as customer #${data.customerId}. The application has left the review queue; nothing about the customer was changed.` +
          (data.installationPayment
            ? ` The ${formatCurrency(data.installationPayment.amount_paid)} installation fee collected on it moved to their payment history.`
            : "")
      );
      setNoticeCustomerId(data.customerId);
      await loadApplications();
    } catch (saveError) {
      setDecisionError(
        saveError instanceof Error
          ? saveError.message
          : "Could not confirm the match."
      );
    } finally {
      setSaving(false);
    }
  };

  const submitReopenMatch = async () => {
    if (!activeApplication) return;
    try {
      setSaving(true);
      setDecisionError("");
      const response = await apiFetch(
        `/api/applications/${activeApplication.application_id}/reopen-match`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: decisionNote }),
        }
      );
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Could not reopen the match.");
      }
      setDecision(null);
      setSelected(null);
      setNotice(`Application #${data.applicationId} is back in Match Review.`);
      setNoticeCustomerId(null);
      await loadApplications();
    } catch (saveError) {
      setDecisionError(
        saveError instanceof Error
          ? saveError.message
          : "Could not reopen the match."
      );
    } finally {
      setSaving(false);
    }
  };

  const submitCloseDecision = async () => {
    if (!activeApplication) return;
    try {
      setSaving(true);
      setDecisionError("");
      const response = await apiFetch(
        `/api/applications/${activeApplication.application_id}/close`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: closeStatus, reason: decisionNote }),
        }
      );
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Could not close application.");
      }
      setDecision(null);
      setSelected(null);
      setNotice(
        `Application marked ${closeStatus}.` +
          (data.voidedPayment
            ? ` The ${formatCurrency(data.voidedPayment.amount_paid)} installation fee was voided — return the cash at the counter.`
            : "")
      );
      setNoticeCustomerId(null);
      await loadApplications();
    } catch (saveError) {
      setDecisionError(
        saveError instanceof Error
          ? saveError.message
          : "Could not close application."
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 py-6 lg:px-8 lg:py-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0 flex-1 basis-80">
          <h1 className="text-2xl font-semibold tracking-tight text-on-surface">
            Applications
          </h1>
          <p className="mt-1 text-sm text-on-surface-variant">
            Review applicants, activate service, and keep application history.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setNewForm(initialNewApplication());
            setNewApplicationKind("new");
            setAdditionalServiceCustomer(null);
            setAdditionalServiceSearch("");
            setAdditionalServiceResults([]);
            setFormError("");
            setShowNewForm(true);
          }}
          className="flex w-fit shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-on-primary shadow-sm transition hover:bg-primary-container"
        >
          <span className="material-symbols-outlined text-lg">add</span>
          New Application
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <SummaryCard label="Active Queue" value={summary.active} icon="pending_actions" />
        {/* The one the office is waiting on. An installation finished
            yesterday afternoon shows up here this morning without anybody
            reading down the table to find it. */}
        <SummaryCard label="Installed, To Activate" value={summary.installed} icon="task_alt" />
        <SummaryCard label="Out For Install" value={summary.out_for_install} icon="engineering" />
        <SummaryCard label="Over 14 Days" value={summary.overdue} icon="schedule" warning />
      </div>

      {notice && (
        <div className="flex items-center justify-between gap-4 rounded-xl bg-tertiary/10 px-5 py-4 text-sm text-tertiary">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined">check_circle</span>
            <span className="font-medium">{notice}</span>
          </div>
          {noticeCustomerId && (
            <button type="button" onClick={() => openCustomer(noticeCustomerId)} className="font-medium underline">
              View customer
            </button>
          )}
        </div>
      )}

      <section className="overflow-hidden rounded-2xl bg-surface-container-lowest shadow-sm">
        <div className="flex flex-col gap-3 border-b border-surface-container px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap gap-2">
            {(
              [
                ["active", "Active"],
                ["review", "Match Review"],
                // Where an installation has got to. Installed is the one that
                // matters day to day: a technician has finished and the office
                // has not activated the customer yet, which is exactly the
                // thing that used to be found only by opening applications one
                // at a time to look.
                ["out_for_install", "Out for Install"],
                ["installed", "Installed"],
                ["install_failed", "Couldn't Install"],
                ["serviced", "Serviced"],
                ["closed", "Closed"],
                // No tab for confirmed_existing. It is an artefact of the
                // one-off Access import and will only ever hold a handful of
                // rows; the status, who confirmed it and when all stay in the
                // database, and the rows are still reachable under All.
                //
                // Labelled Legacy, not Unresolved. 'legacy_unresolved' is an
                // import artefact and has nothing to do with a technician who
                // could not install - two different things sharing one word on
                // screen was worse than a slightly longer label.
                ["unresolved", "Legacy"],
                ["all", "All"],
              ] as Array<[ApplicationView, string]>
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => {
                  setView(value);
                }}
                className={
                  view === value
                    ? "rounded-full bg-primary px-4 py-2 text-xs font-medium text-on-primary"
                    : "rounded-full bg-surface-container px-4 py-2 text-xs font-medium text-on-surface-variant transition hover:bg-surface-container-high"
                }
              >
                {label}
              </button>
            ))}
          </div>
          <div className="relative w-full lg:w-80">
            <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-outline">search</span>
            <input
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
              }}
              placeholder="Search name, ID, phone, or address..."
              className="w-full rounded-lg bg-surface-container-low py-2.5 pl-10 pr-4 text-sm"
            />
          </div>
        </div>

        {error && <div className="m-6 rounded-lg bg-error/10 p-4 text-sm text-error">{error}</div>}

        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead className="bg-surface-container-low">
              <tr>
                <TableHeading>Application</TableHeading>
                <TableHeading>Applicant</TableHeading>
                <TableHeading>Package</TableHeading>
                <TableHeading>Date</TableHeading>
                <TableHeading>Status</TableHeading>
                <th className="px-6 py-4 text-right text-xs font-semibold uppercase tracking-wider text-on-surface-variant">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-container">
              {!loading &&
                applications.map((application) => (
                  <tr key={application.application_id} onClick={() => setSelected(application)} className="cursor-pointer transition hover:bg-surface-container-low/70">
                    <td className="px-6 py-4">
                      <p className="font-mono text-sm font-medium text-on-surface">#{application.application_id}</p>
                    </td>
                    <td className="px-6 py-4">
                      <p className="font-semibold text-on-surface">{application.name}</p>
                      <p className="mt-1 text-sm text-on-surface-variant">{application.telephone || "No telephone"}</p>
                    </td>
                    <td className="px-6 py-4 text-sm text-on-surface-variant">
                      <p>{application.package_name || "No package"}</p>
                      <p className="mt-1 text-xs">{formatCurrency(application.monthly_fee)}</p>
                    </td>
                    <td className="px-6 py-4 text-sm text-on-surface-variant">
                      <p>{formatDate(application.application_date)}</p>
                      {application.is_overdue && <span className="mt-1 inline-flex rounded-full bg-warning-container px-2 py-0.5 text-[11px] font-medium text-warning">Over 14 days</span>}
                    </td>
                    <td className="px-6 py-4">
                      <StatusBadge status={application.status} />
                      {/* The installation, on the row. This is the whole point
                          of the change: whether a job came back done, failed
                          or is still out has to be readable down a column,
                          not one drawer at a time. */}
                      <InstallBadge application={application} />
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex justify-end gap-2">
                        {canDecide && canTakeDecision(application) && (
                          <>
                            {/* Every Match Review gets this, suggested match or
                                not. A pending application keeps just the tick
                                and the cross - there is nobody for a brand new
                                applicant to already be. */}
                            {application.status === "match_review" && (
                              <IconButton icon="how_to_reg" label={application.suggested_customer_id ? `Same person as customer #${application.suggested_customer_id}` : "Same person as an existing customer"} tone="neutral" onClick={(event) => { event.stopPropagation(); openConfirmMatch(application); }} />
                            )}
                            <IconButton icon="check" label="Activate customer" tone="positive" onClick={(event) => { event.stopPropagation(); openServiceDecision(application); }} />
                            <IconButton icon="close" label="Close application" onClick={(event) => { event.stopPropagation(); openCloseDecision(application); }} />
                          </>
                        )}
                        {canDecide && application.status === "confirmed_existing" && (
                          <IconButton icon="undo" label="Reopen this match" tone="neutral" onClick={(event) => { event.stopPropagation(); openReopenMatch(application); }} />
                        )}
                        <button type="button" onClick={(event) => { event.stopPropagation(); setSelected(application); }} className="rounded-lg px-3 py-2 text-sm font-medium text-primary transition hover:bg-primary/10">View</button>
                      </div>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>

        {loading && <div className="px-6 py-14 text-center text-sm text-on-surface-variant">Loading applications...</div>}
        {!loading && !error && applications.length === 0 && (
          <div className="px-6 py-14 text-center">
            <span className="material-symbols-outlined text-4xl text-outline">inbox</span>
            <p className="mt-2 text-sm text-on-surface-variant">No applications found in this view.</p>
          </div>
        )}
        {!loading && applications.length > 0 && (
          <div className="flex flex-col gap-3 border-t border-surface-container px-6 py-4 text-sm text-on-surface-variant sm:flex-row sm:items-center sm:justify-between">
            <p>
              Showing {(pagination.page - 1) * pagination.limit + 1}–
              {Math.min(pagination.page * pagination.limit, pagination.total)} of{" "}
              {pagination.total}
            </p>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setPage((current) => Math.max(current - 1, 1))}
                disabled={pagination.page <= 1}
                className="rounded-lg bg-surface-container px-3 py-2 text-xs font-medium text-on-surface transition hover:bg-surface-container-high disabled:cursor-not-allowed disabled:opacity-40"
              >
                Previous
              </button>
              <span className="min-w-24 text-center text-xs font-semibold">
                Page {pagination.page} of {pagination.totalPages}
              </span>
              <button
                type="button"
                onClick={() =>
                  setPage((current) =>
                    Math.min(current + 1, pagination.totalPages)
                  )
                }
                disabled={pagination.page >= pagination.totalPages}
                className="rounded-lg bg-surface-container px-3 py-2 text-xs font-medium text-on-surface transition hover:bg-surface-container-high disabled:cursor-not-allowed disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </section>

      {showNewForm && (
        <Modal title="New Application" onClose={() => !saving && setShowNewForm(false)} wide>
          <form onSubmit={createApplication} className="space-y-6">
            <FormSection title="Who is this service for?">
              <label className={`cursor-pointer rounded-xl border p-4 ${newApplicationKind === "new" ? "border-primary bg-primary/5" : "border-outline-variant"}`}>
                <input
                  type="radio"
                  name="newApplicationKind"
                  checked={newApplicationKind === "new"}
                  onChange={() => {
                    setNewApplicationKind("new");
                    setAdditionalServiceCustomer(null);
                    setAdditionalServiceSearch("");
                    setNewForm({ ...newForm, additionalServiceForCustomerId: null });
                  }}
                  className="mr-3 accent-primary"
                />
                <span className="font-medium">A new customer</span>
                <p className="ml-7 mt-1 text-xs text-on-surface-variant">
                  Creates their first service account when approved.
                </p>
              </label>
              <label className={`cursor-pointer rounded-xl border p-4 ${newApplicationKind === "additional" ? "border-primary bg-primary/5" : "border-outline-variant"}`}>
                <input
                  type="radio"
                  name="newApplicationKind"
                  checked={newApplicationKind === "additional"}
                  onChange={() => setNewApplicationKind("additional")}
                  className="mr-3 accent-primary"
                />
                <span className="font-medium">An existing customer adding another service</span>
                <p className="ml-7 mt-1 text-xs text-on-surface-variant">
                  Creates a separate account under the same customer display. Billing and service controls remain independent.
                </p>
              </label>

              {newApplicationKind === "additional" && (
                <div className="relative sm:col-span-2">
                  {additionalServiceCustomer ? (
                    <div className="flex items-start justify-between gap-3 rounded-xl border border-secondary/20 bg-secondary-container/50 p-4">
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wider text-secondary">Add service for</p>
                        <p className="mt-1 font-semibold">
                          {additionalServiceCustomer.name || "Existing customer"} · #{additionalServiceCustomer.customer_id}
                        </p>
                        <p className="mt-1 text-xs text-on-surface-variant">
                          {additionalServiceCustomer.address || "No address on file"}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setAdditionalServiceCustomer(null);
                          setAdditionalServiceSearch("");
                          setNewForm({ ...newForm, additionalServiceForCustomerId: null });
                        }}
                        className="text-sm font-medium text-primary underline"
                      >
                        Change
                      </button>
                    </div>
                  ) : (
                    <Field label="Find the existing customer" required>
                      <input
                        autoFocus
                        value={additionalServiceSearch}
                        onChange={(event) => setAdditionalServiceSearch(event.target.value)}
                        className={inputClass}
                        placeholder="Search name, account number, or phone..."
                      />
                    </Field>
                  )}
                  {!additionalServiceCustomer && additionalServiceResults.length > 0 && (
                    <div className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-outline-variant bg-white shadow-xl">
                      {additionalServiceResults.map((customer) => (
                        <button
                          key={customer.customer_id}
                          type="button"
                          onClick={() => {
                            setAdditionalServiceCustomer(customer);
                            setAdditionalServiceResults([]);
                            setNewForm({
                              ...newForm,
                              name: newForm.name || customer.name || "",
                              address: newForm.address || customer.address || "",
                              telephone: newForm.telephone || customer.telephone || "",
                              additionalServiceForCustomerId: customer.customer_id,
                            });
                          }}
                          className="block w-full border-b border-surface-container px-4 py-3 text-left last:border-0 hover:bg-surface-container-low"
                        >
                          <span className="font-semibold">{customer.name || "Unnamed customer"}</span>
                          <span className="ml-2 font-mono text-xs text-primary">#{customer.customer_id}</span>
                          <p className="mt-1 text-xs text-on-surface-variant">
                            {customer.telephone || "No phone"} · {customer.address || "No address"}
                          </p>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </FormSection>
            <FormSection title="Applicant information">
              <Field label="Full name" required><input required value={newForm.name} onChange={(event) => setNewForm({ ...newForm, name: event.target.value })} className={inputClass} /></Field>
              <Field label="Alias"><input value={newForm.alias} onChange={(event) => setNewForm({ ...newForm, alias: event.target.value })} className={inputClass} /></Field>
              <Field label="Telephone" required><input required value={newForm.telephone} onChange={(event) => setNewForm({ ...newForm, telephone: event.target.value })} className={inputClass} /></Field>
              <Field label="Email"><input type="email" value={newForm.email} onChange={(event) => setNewForm({ ...newForm, email: event.target.value })} className={inputClass} /></Field>
              <div className="sm:col-span-2"><Field label="Service address" required><textarea required rows={2} value={newForm.address} onChange={(event) => setNewForm({ ...newForm, address: event.target.value })} className={inputClass} /></Field></div>
              <Field label="Occupation"><input value={newForm.occupation} onChange={(event) => setNewForm({ ...newForm, occupation: event.target.value })} className={inputClass} /></Field>
              <Field label="Application date"><input type="date" value={newForm.applicationDate} onChange={(event) => setNewForm({ ...newForm, applicationDate: event.target.value })} className={inputClass} /></Field>
            </FormSection>

            <FormSection title="Identification">
              <Field label="ID type">
                <select value={newForm.idType} onChange={(event) => setNewForm({ ...newForm, idType: event.target.value })} className={inputClass}>
                  <option value="">Select type</option>
                  <option value="Driver's Licence">Driver&apos;s Licence</option>
                  <option value="Passport">Passport</option>
                  <option value="National ID">National ID</option>
                  <option value="TRN">TRN</option>
                </select>
              </Field>
              <Field label="ID number"><input value={newForm.idNumber} onChange={(event) => setNewForm({ ...newForm, idNumber: event.target.value })} className={inputClass} /></Field>
            </FormSection>

            <FormSection title="Requested service">
              <Field label="Package" required>
                <select
                  required
                  value={newForm.packageId}
                  onChange={(event) => {
                    const packageId = event.target.value;
                    const selectedPackage = packages.find((item) => String(item.package_id) === packageId);
                    setNewForm({
                      ...newForm,
                      packageId,
                      monthlyFee: selectedPackage?.default_monthly_charge ?? newForm.monthlyFee,
                      installationFee: selectedPackage?.installation_fee ?? newForm.installationFee,
                    });
                  }}
                  className={inputClass}
                >
                  <option value="">Select package</option>
                  {packages.map((item) => <option key={item.package_id} value={item.package_id}>{packageOptionLabel(item)}</option>)}
                </select>
              </Field>
              <Field label="Monthly fee (J$)" required><input required min="0" step="0.01" type="number" value={newForm.monthlyFee} onChange={(event) => setNewForm({ ...newForm, monthlyFee: event.target.value })} className={inputClass} /></Field>
              <Field label="Additional boxes"><input min="0" step="1" type="number" value={newForm.additionalBox} onChange={(event) => setNewForm({ ...newForm, additionalBox: event.target.value })} className={inputClass} /></Field>
              <label className="flex items-center gap-3 self-end rounded-lg bg-surface-container-low px-4 py-3 text-sm font-medium">
                <input type="checkbox" checked={newForm.adultChannel} onChange={(event) => setNewForm({ ...newForm, adultChannel: event.target.checked })} className="h-4 w-4 accent-primary" />
                Adult channel requested
              </label>
            </FormSection>

            {/* Money taken at the counter, recorded here so it lands in today's
                takings instead of waiting for somebody to activate the account
                days later. Clearing the field records no payment. */}
            <FormSection title="Installation fee collected">
              <Field label="Amount received today (J$)">
                <input min="0" step="0.01" type="number" value={newForm.installationFee} onChange={(event) => setNewForm({ ...newForm, installationFee: event.target.value })} className={inputClass} placeholder="0.00" />
              </Field>
              <div className="self-end rounded-lg bg-surface-container-low px-4 py-3 text-xs text-on-surface-variant">
                {Number(newForm.installationFee) > 0
                  ? "Recorded as a payment today with a printable receipt. It becomes this customer's first payment on activation, and is voided if the application is cancelled."
                  : "Nothing is recorded. Clear this only when the applicant has not paid yet."}
              </div>
            </FormSection>

            {formError && <p className="rounded-lg bg-error/10 p-3 text-sm text-error">{formError}</p>}
            <ModalActions
              saving={saving || (newApplicationKind === "additional" && !additionalServiceCustomer)}
              primaryLabel="Create Application"
              onCancel={() => setShowNewForm(false)}
            />
          </form>
        </Modal>
      )}

      {activeApplication && !decision && (
        <ApplicationDrawer
          application={activeApplication}
          onClose={() => setSelected(null)}
          footer={
            canDecide && canTakeDecision(activeApplication) ? (
              <div className="flex flex-col gap-3">
                {activeApplication.status === "match_review" && (
                  <button type="button" onClick={() => openConfirmMatch(activeApplication)} className="flex items-center justify-center gap-2 rounded-lg bg-secondary/15 px-4 py-3 text-sm font-medium text-secondary transition hover:bg-secondary/25"><span className="material-symbols-outlined">how_to_reg</span>{activeApplication.suggested_customer_id ? `Same Person as Customer #${activeApplication.suggested_customer_id}` : "Same Person as an Existing Customer"}</button>
                )}
                {/* Sending someone out is a step BEFORE activation, so it
                    sits above the two decisions rather than beside them: the
                    technician installs, reports back, and only then does the
                    office activate from what they found. */}
                {activeApplication.status === "pending" && (
                  <InstallationDispatchRow
                    application={activeApplication}
                    onDispatch={() => setDispatching(activeApplication)}
                  />
                )}
                <div className="flex flex-col gap-3 sm:flex-row">
                  <button type="button" onClick={() => openServiceDecision(activeApplication)} className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-tertiary px-4 py-3 text-sm font-medium text-white transition hover:bg-tertiary/90"><span className="material-symbols-outlined">check</span>Activate Customer</button>
                  <button type="button" onClick={() => openCloseDecision(activeApplication)} className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-error/10 px-4 py-3 text-sm font-medium text-error transition hover:bg-error/15"><span className="material-symbols-outlined">close</span>Not Serviced</button>
                </div>
              </div>
            ) : canDecide && activeApplication.status === "confirmed_existing" ? (
              <button type="button" onClick={() => openReopenMatch(activeApplication)} className="flex w-full items-center justify-center gap-2 rounded-lg bg-surface-container px-4 py-3 text-sm font-medium transition hover:bg-surface-container-high"><span className="material-symbols-outlined">undo</span>Reopen This Match</button>
            ) : undefined
          }
        >
          <div className="space-y-8">
            <DrawerSection title="Applicant information" icon="person">
              <div className="grid grid-cols-1 gap-x-8 gap-y-5 sm:grid-cols-2">
                <Detail label="Full name" value={activeApplication.name} />
                <Detail label="Alias" value={activeApplication.alias} />
                <Detail label="Telephone" value={activeApplication.telephone} />
                <Detail label="Email" value={activeApplication.email} />
                <Detail label="Occupation" value={activeApplication.occupation} />
              </div>
            </DrawerSection>

            <DrawerSection title="Identification" icon="badge">
              <div className="grid grid-cols-1 gap-x-8 gap-y-5 sm:grid-cols-2">
                <Detail label="ID type" value={activeApplication.id_type} />
                <Detail label="ID number" value={activeApplication.id_number} />
              </div>
            </DrawerSection>

            <DrawerSection title="Requested service" icon="settings_input_antenna">
              <div className="grid grid-cols-1 gap-x-8 gap-y-5 sm:grid-cols-2">
                <div className="sm:col-span-2"><Detail label="Service address" value={activeApplication.address} /></div>
                <Detail label="Package" value={activeApplication.package_name} />
                <Detail label="Monthly fee" value={formatCurrency(activeApplication.monthly_fee)} />
                <Detail label="Application date" value={formatDate(activeApplication.application_date)} />
                <Detail label="Activation date" value={formatDate(activeApplication.activation_date)} />
                <Detail label="Adult channel" value={activeApplication.adult_channel ? "Requested" : "Not requested"} />
                <Detail label="Additional boxes" value={String(activeApplication.additional_box ?? 0)} />
                <Detail label="Pole box number" value={activeApplication.pole_box_number} />
                <Detail label="Port number" value={activeApplication.port_number} />
              </div>
            </DrawerSection>

            {activeApplication.installation_payment_id !== null && (
              <DrawerSection title="Installation fee" icon="payments">
                <div className="grid grid-cols-1 gap-x-8 gap-y-5 sm:grid-cols-2">
                  <Detail label="Amount collected" value={formatCurrency(activeApplication.installation_amount)} />
                  <Detail label="Receipt" value={activeApplication.installation_receipt_number} />
                </div>
                <p className="mt-4 text-xs text-on-surface-variant">
                  {activeApplication.installation_voided
                    ? "Voided. It no longer counts towards any day's takings."
                    : activeApplication.customer_id
                      ? `Now the first payment on customer #${activeApplication.customer_id}.`
                      : "Held against this application. It moves onto the customer record when this application is activated, and is voided if it is not."}
                </p>
                <button type="button" onClick={() => openInstallationReceipt(activeApplication.installation_payment_id!)} className="mt-3 text-sm font-medium text-primary underline">
                  {activeApplication.installation_voided ? "View voided receipt" : "Reprint receipt"}
                </button>
              </DrawerSection>
            )}

            {activeApplication.suggested_customer_id && !activeApplication.additional_service_for_customer_id && (
              <div className="rounded-xl border border-secondary/20 bg-secondary-container/50 p-4">
                <p className="text-xs font-semibold uppercase tracking-wider text-secondary">Possible existing customer</p>
                <p className="mt-2 font-semibold">{activeApplication.suggested_customer_name || "Existing customer"} · #{activeApplication.suggested_customer_id}</p>
                <p className="mt-1 text-xs text-on-surface-variant">Match basis: {humanize(activeApplication.match_method || "review required")}</p>
                <button type="button" onClick={() => openCustomer(activeApplication.suggested_customer_id!)} className="mt-3 text-sm font-medium text-primary underline">Open customer profile</button>
              </div>
            )}

            {activeApplication.additional_service_for_customer_id && (
              <div className="rounded-xl border border-primary/20 bg-primary/5 p-4">
                <p className="text-xs font-semibold uppercase tracking-wider text-primary">Additional service requested</p>
                <p className="mt-2 font-semibold">
                  For {activeApplication.additional_service_customer_name || "existing customer"} · account #{activeApplication.additional_service_for_customer_id}
                </p>
                <p className="mt-1 text-xs text-on-surface-variant">
                  Activation will create a new, independently billed account and show both accounts on one customer profile.
                </p>
                <button type="button" onClick={() => openCustomer(activeApplication.additional_service_for_customer_id!)} className="mt-3 text-sm font-medium text-primary underline">Open existing profile</button>
              </div>
            )}

            {activeApplication.status === "confirmed_existing" && (
              <div className="rounded-xl border border-secondary/20 bg-secondary-container/50 p-4">
                <p className="text-xs font-semibold uppercase tracking-wider text-secondary">Confirmed as an existing customer</p>
                <p className="mt-2 font-semibold">{activeApplication.linked_customer_name || "Customer"} · #{activeApplication.customer_id}</p>
                <p className="mt-1 text-xs text-on-surface-variant">
                  Confirmed by {activeApplication.match_confirmed_by_name || "a reviewer"}
                  {activeApplication.match_confirmed_at ? ` on ${formatDate(activeApplication.match_confirmed_at)}` : ""}.
                  No customer record was changed.
                </p>
                <button type="button" onClick={() => openCustomer(activeApplication.customer_id!)} className="mt-3 text-sm font-medium text-primary underline">Open customer profile</button>
              </div>
            )}

            {activeApplication.closure_reason && (
              <DrawerSection title="Closure note" icon="event_busy">
                <Detail label="Reason" value={activeApplication.closure_reason} />
              </DrawerSection>
            )}
          </div>
        </ApplicationDrawer>
      )}

      {dispatching && (
        <DispatchInstallationModal
          application={dispatching}
          onClose={() => setDispatching(null)}
          onSent={(message) => {
            setDispatching(null);
            setNotice(message);
            loadApplications();
          }}
        />
      )}

      {activeApplication && decision === "service" && (
        // Activation collects the operational details required to turn an
        // application into a live service account.
        <Modal
          title={serviceMode === "additional" ? "Activate new service account" : "Activate customer"}
          onClose={() => !saving && setDecision(null)}
        >
          <div className="space-y-5">
            <p className="text-sm text-on-surface-variant">
              {serviceMode === "additional" ? "Confirm the new account details for" : "Confirm how"} <strong>{activeApplication.name}</strong>{serviceMode === "additional" ? "." : " should become an active customer."}
            </p>
            {activeApplication.suggested_customer_id && !activeApplication.additional_service_for_customer_id && (
              <label className={`block cursor-pointer rounded-xl border p-4 ${serviceMode === "link" ? "border-primary bg-primary/5" : "border-outline-variant"}`}>
                <input type="radio" name="serviceMode" checked={serviceMode === "link"} onChange={() => setServiceMode("link")} className="mr-3 accent-primary" />
                <span className="font-medium">Link existing customer #{activeApplication.suggested_customer_id}</span>
                <p className="ml-7 mt-1 text-sm text-on-surface-variant">Use {activeApplication.suggested_customer_name || "the suggested customer"}; do not create a duplicate.</p>
              </label>
            )}
            {activeApplication.additional_service_for_customer_id && (
              <label className={`block cursor-pointer rounded-xl border p-4 ${serviceMode === "additional" ? "border-primary bg-primary/5" : "border-outline-variant"}`}>
                <input type="radio" name="serviceMode" checked={serviceMode === "additional"} onChange={() => setServiceMode("additional")} className="mr-3 accent-primary" />
                <span className="font-medium">
                  Add a service account for {activeApplication.additional_service_customer_name || `customer #${activeApplication.additional_service_for_customer_id}`}
                </span>
                <p className="ml-7 mt-1 text-sm text-on-surface-variant">
                  Create a separate account with its own billing date, balance, payments, equipment, and connection status.
                </p>
              </label>
            )}
            {!activeApplication.additional_service_for_customer_id && (
              <label className={`block cursor-pointer rounded-xl border p-4 ${serviceMode === "create" ? "border-primary bg-primary/5" : "border-outline-variant"}`}>
                <input type="radio" name="serviceMode" checked={serviceMode === "create"} onChange={() => setServiceMode("create")} className="mr-3 accent-primary" />
                <span className="font-medium">Create a new customer</span>
                <p className="ml-7 mt-1 text-sm text-on-surface-variant">Copy this application&apos;s contact, package, and rate into a new active account.</p>
              </label>
            )}
            {(serviceMode === "create" || serviceMode === "additional") && (
              // Imported applications may not contain pole/port information;
              // newly entered applications must supply both fields.
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Package" required>
                  <select
                    required
                    value={activationPackageId}
                    onChange={(event) => {
                      const packageId = event.target.value;
                      const selectedPackage = packages.find((item) => String(item.package_id) === packageId);
                      setActivationPackageId(packageId);
                      if (selectedPackage?.default_monthly_charge) {
                        setActivationMonthlyFee(selectedPackage.default_monthly_charge);
                      }
                    }}
                    className={inputClass}
                  >
                    <option value="">Select package</option>
                    {packages.map((item) => <option key={item.package_id} value={item.package_id}>{packageOptionLabel(item)}</option>)}
                  </select>
                </Field>
                <Field label="Monthly fee (J$)" required><input required min="0" step="0.01" type="number" value={activationMonthlyFee} onChange={(event) => setActivationMonthlyFee(event.target.value)} className={inputClass} /></Field>
                <Field label="Pole box" required={!activeApplication.legacy_source}><input required={!activeApplication.legacy_source} value={activationPoleBox} onChange={(event) => setActivationPoleBox(event.target.value)} className={inputClass} placeholder="e.g. PB-104" /></Field>
                <Field label="Port" required={!activeApplication.legacy_source}><input required={!activeApplication.legacy_source} value={activationPort} onChange={(event) => setActivationPort(event.target.value)} className={inputClass} placeholder="e.g. 6" /></Field>
                <Field label="Activation date" required><input required type="date" value={activationDate} onChange={(event) => setActivationDate(event.target.value)} className={inputClass} /></Field>
              </div>
            )}
            {(serviceMode === "create" || serviceMode === "additional") && (
              // OLT information is mandatory for a new (non-legacy) application.
              // Activating checks this ONT location against the live OLT and is
              // refused if no ONT answers there.
              <div className="rounded-xl border border-outline-variant p-4">
                <p className="text-sm font-semibold text-on-surface">OLT information{!activeApplication.legacy_source && <span className="ml-1 text-error">*</span>}</p>
                <p className="mt-1 text-xs text-on-surface-variant">
                  Activating checks this ONT location against the live OLT. If no ONT answers there, the activation is refused.
                </p>
                <datalist id="activation-olt-names">
                  {olts.map((olt) => <option key={olt.olt_id} value={olt.name} />)}
                </datalist>
                <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Field label="OLT name" required={!activeApplication.legacy_source}>
                    <input
                      list="activation-olt-names"
                      required={!activeApplication.legacy_source}
                      value={activationOlt.oltName}
                      onChange={(event) => {
                        const oltName = event.target.value;
                        const match = olts.find(
                          (olt) => olt.name.trim().toLowerCase() === oltName.trim().toLowerCase()
                        );
                        setActivationOlt((current) => ({
                          ...current,
                          oltName,
                          managementIp: match ? match.management_ip : current.managementIp,
                        }));
                      }}
                      className={inputClass}
                      placeholder="e.g. MANDEVILLE"
                    />
                  </Field>
                  <Field label="OLT management IP" required={!activeApplication.legacy_source}><input required={!activeApplication.legacy_source} value={activationOlt.managementIp} onChange={(event) => setActivationOlt((current) => ({ ...current, managementIp: event.target.value }))} className={inputClass} placeholder="e.g. 192.168.1.4" /></Field>
                  <Field label="Frame" required={!activeApplication.legacy_source}><input required={!activeApplication.legacy_source} min="0" step="1" type="number" value={activationOlt.frame} onChange={(event) => setActivationOlt((current) => ({ ...current, frame: event.target.value }))} className={inputClass} /></Field>
                  <Field label="Card / slot" required={!activeApplication.legacy_source}><input required={!activeApplication.legacy_source} min="0" step="1" type="number" value={activationOlt.slot} onChange={(event) => setActivationOlt((current) => ({ ...current, slot: event.target.value }))} className={inputClass} /></Field>
                  <Field label="PON port" required={!activeApplication.legacy_source}><input required={!activeApplication.legacy_source} min="0" step="1" type="number" value={activationOlt.ponPort} onChange={(event) => setActivationOlt((current) => ({ ...current, ponPort: event.target.value }))} className={inputClass} /></Field>
                  <Field label="Virtual port / ONT ID" required={!activeApplication.legacy_source}><input required={!activeApplication.legacy_source} min="0" step="1" type="number" value={activationOlt.ontId} onChange={(event) => setActivationOlt((current) => ({ ...current, ontId: event.target.value }))} className={inputClass} /></Field>
                </div>
                {activationOlt.oltName.trim().toUpperCase() === "HANOVER" && (
                  <p className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950">
                    Hanover is temporarily using manual OLT operations. The app will try a live check; if it cannot verify this location, activation will continue and the mapping will be clearly saved as unverified. Automated ONT actions remain blocked until it is verified later.
                  </p>
                )}
              </div>
            )}
            <Field label="Optional activation note"><textarea rows={3} maxLength={500} value={decisionNote} onChange={(event) => setDecisionNote(event.target.value)} className={inputClass} placeholder="Installation or activation note..." /></Field>
            {decisionError && <p className="rounded-lg bg-error/10 p-3 text-sm text-error">{decisionError}</p>}
            <ModalActions
              saving={
                saving ||
                ((serviceMode === "create" || serviceMode === "additional") &&
                  !activeApplication.legacy_source &&
                  activationOltIncomplete)
              }
              primaryLabel={serviceMode === "additional" ? "Activate New Service Account" : "Activate Customer"}
              onPrimary={submitServiceDecision}
              onCancel={() => setDecision(null)}
            />
          </div>
        </Modal>
      )}

      {activeApplication && decision === "confirm-match" && (
        <Modal title="Same person?" onClose={() => !saving && setDecision(null)}>
          <div className="space-y-5">
            <p className="text-sm text-on-surface-variant">
              Confirm that <strong>{activeApplication.name}</strong> on this application is the customer already on file.
            </p>
            {matchCustomer ? (
              <div className="rounded-xl border border-secondary/20 bg-secondary-container/50 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-secondary">Existing customer</p>
                    <p className="mt-2 font-semibold">{matchCustomer.name || "Existing customer"} · #{matchCustomer.customer_id}</p>
                    <p className="mt-1 text-xs text-on-surface-variant">
                      {matchCustomer.customer_id === activeApplication.suggested_customer_id
                        ? `Suggested by the matcher · ${humanize(activeApplication.match_method || "review required")}`
                        : "Chosen by you"}
                    </p>
                  </div>
                  <button type="button" onClick={() => { setMatchCustomer(null); setMatchSearch(""); }} className="whitespace-nowrap text-sm font-medium text-primary underline">Change</button>
                </div>
              </div>
            ) : (
              <Field label="Which existing customer is this?" required>
                <div className="relative">
                  <input autoFocus value={matchSearch} onChange={(event) => setMatchSearch(event.target.value)} className={inputClass} placeholder="Search name, customer ID, or phone..." />
                  {matchResults.length > 0 && (
                    <div className="absolute z-10 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-outline-variant bg-white shadow-xl">
                      {matchResults.map((customer) => (
                        <button key={customer.customer_id} type="button" onClick={() => { setMatchCustomer(customer); setMatchResults([]); }} className="block w-full border-b border-surface-container px-4 py-3 text-left last:border-0 hover:bg-surface-container-low">
                          <span className="font-semibold">{customer.name || "Unnamed customer"}</span>
                          <span className="ml-2 text-xs text-on-surface-variant">#{customer.customer_id} · {customer.telephone || "No phone"} · {humanize(customer.status)}</span>
                          <p className="mt-1 truncate text-xs text-on-surface-variant">{customer.address || "No address"}</p>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {/* The applicant's own details, so the reviewer can compare
                    without leaving the modal. */}
                <p className="mt-2 text-xs text-on-surface-variant">Applicant: {activeApplication.telephone || "no phone"} · {activeApplication.address || "no address"}</p>
              </Field>
            )}
            {/* Says plainly what this does and does not do. The whole reason
                this action exists is that Activate looked like it might bill
                somebody twice. */}
            <ul className="space-y-1.5 rounded-xl bg-surface-container-low p-4 text-sm text-on-surface-variant">
              <li className="flex gap-2"><span className="material-symbols-outlined text-base text-tertiary">check</span>The application leaves the review queue.</li>
              <li className="flex gap-2"><span className="material-symbols-outlined text-base text-tertiary">check</span>It records which customer it turned out to be, and who decided that.</li>
              <li className="flex gap-2"><span className="material-symbols-outlined text-base text-on-surface-variant">block</span>No new customer is created, and nobody is charged anything.</li>
              <li className="flex gap-2"><span className="material-symbols-outlined text-base text-on-surface-variant">block</span>Customer {matchCustomer ? `#${matchCustomer.customer_id}` : "chosen here"} is not modified — same address, package, rate and balance as now.</li>
              {activeApplication.installation_payment_id !== null && !activeApplication.installation_voided && (
                <li className="flex gap-2"><span className="material-symbols-outlined text-base text-tertiary">check</span>The {formatCurrency(activeApplication.installation_amount)} already collected on this application moves to their payment history. Their balance does not change — installation fees never post to the ledger.</li>
              )}
            </ul>
            <Field label="Optional note"><textarea rows={3} maxLength={500} value={decisionNote} onChange={(event) => setDecisionNote(event.target.value)} className={inputClass} placeholder="How you established it is the same person..." /></Field>
            {decisionError && <p className="rounded-lg bg-error/10 p-3 text-sm text-error">{decisionError}</p>}
            <ModalActions saving={saving || !matchCustomer} primaryLabel="Confirm Same Person" onPrimary={submitConfirmMatch} onCancel={() => setDecision(null)} />
          </div>
        </Modal>
      )}

      {activeApplication && decision === "reopen-match" && (
        <Modal title="Reopen this match?" onClose={() => !saving && setDecision(null)}>
          <div className="space-y-5">
            <p className="text-sm text-on-surface-variant">
              This puts application #{activeApplication.application_id} back into Match Review and clears the customer it was confirmed against. Nothing was changed on the customer when it was confirmed, so there is nothing to undo there.
            </p>
            <Field label="Reason" required><textarea required rows={3} minLength={3} maxLength={500} value={decisionNote} onChange={(event) => setDecisionNote(event.target.value)} className={inputClass} placeholder="Why this confirmation was wrong..." /></Field>
            {decisionError && <p className="rounded-lg bg-error/10 p-3 text-sm text-error">{decisionError}</p>}
            <ModalActions saving={saving || decisionNote.trim().length < 3} primaryLabel="Reopen Match" onPrimary={submitReopenMatch} onCancel={() => setDecision(null)} />
          </div>
        </Modal>
      )}

      {activeApplication && decision === "close" && (
        <Modal title="Application not serviced" onClose={() => !saving && setDecision(null)}>
          <div className="space-y-5">
            <p className="text-sm text-on-surface-variant">Record why this application should leave the active queue.</p>
            {/* The money is the part somebody has to act on in the real world,
                so it is said plainly before the button is pressed rather than
                reported afterwards. */}
            {activeApplication.installation_payment_id !== null && !activeApplication.installation_voided && (
              <div className="rounded-xl border border-error/20 bg-error/5 p-4 text-sm">
                <p className="font-semibold text-error">This voids the {formatCurrency(activeApplication.installation_amount)} installation fee</p>
                <p className="mt-1 text-on-surface-variant">
                  Receipt {activeApplication.installation_receipt_number} drops out of the day&apos;s takings and every report. The receipt stays in history marked voided. Returning the cash at the counter is a separate step.
                </p>
              </div>
            )}
            <Field label="Outcome" required>
              <select value={closeStatus} onChange={(event) => setCloseStatus(event.target.value as "cancelled" | "declined")} className={inputClass}>
                <option value="cancelled">Cancelled by applicant</option>
                <option value="declined">Declined by SPCL</option>
              </select>
            </Field>
            <Field label="Optional note"><textarea rows={4} value={decisionNote} onChange={(event) => setDecisionNote(event.target.value)} className={inputClass} placeholder="Reason or context..." /></Field>
            {decisionError && <p className="rounded-lg bg-error/10 p-3 text-sm text-error">{decisionError}</p>}
            <ModalActions saving={saving} primaryLabel={`Mark ${humanize(closeStatus)}`} destructive onPrimary={submitCloseDecision} onCancel={() => setDecision(null)} />
          </div>
        </Modal>
      )}

      {receipt && <PaymentReceiptModal payment={receipt} onClose={() => setReceipt(null)} onVoided={() => loadApplications()} onDeleted={() => { setReceipt(null); loadApplications(); }} />}
    </div>
  );
}

const inputClass = "mt-1.5 w-full rounded-lg border border-outline-variant bg-white px-3 py-2.5 text-sm text-on-surface transition focus:border-primary";

function isActionable(status: ApplicationStatus) {
  return ["pending", "legacy_unresolved", "match_review"].includes(status);
}

// Mirrors isImportedDecisionAllowed on the server, which is the real control.
// Anything still in an active status can be decided, imported or not. The old
// rule additionally required a 2026 date on legacy rows, which is why the
// legacy_unresolved half of the active queue showed no buttons at all.
function canTakeDecision(application: ApplicationRecord) {
  return isActionable(application.status);
}

function humanize(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDate(value: string | null) {
  if (!value) return "—";
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return "—";

  const [, year, month, day] = match;
  const date = new Date(
    Date.UTC(Number(year), Number(month) - 1, Number(day))
  );

  return date.toLocaleDateString("en-JM", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function formatCurrency(value: string | null) {
  if (!value) return "—";
  return `J$${Number(value).toLocaleString("en-JM", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function SummaryCard({ label, value, icon, warning = false }: { label: string; value: number; icon: string; warning?: boolean }) {
  return (
    <div className="min-w-0 rounded-xl border border-surface-container bg-surface-container-lowest p-4 shadow-sm">
      <div className="flex min-w-0 items-center gap-3">
        <span
          aria-hidden="true"
          className={`material-symbols-outlined flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg text-xl ${warning ? "bg-warning-container text-warning" : "bg-primary/10 text-primary"}`}
        >
          {icon}
        </span>

        <div className="min-w-0 flex-1">
          <p className="break-words text-xs font-semibold uppercase tracking-wider text-on-surface-variant">
            {label}
          </p>

          <p className={`mt-1 text-2xl font-medium leading-none ${warning ? "text-warning" : "text-on-surface"}`}>
            {value}
          </p>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: ApplicationStatus }) {
  const styles: Record<ApplicationStatus, string> = {
    pending: "bg-surface-container-high text-on-surface-variant",
    serviced: "bg-tertiary/10 text-tertiary",
    cancelled: "bg-surface-container-high text-on-surface-variant",
    declined: "bg-error/10 text-error",
    legacy_unresolved: "bg-warning-container text-warning",
    match_review: "bg-info/10 text-info",
    confirmed_existing: "bg-secondary/15 text-secondary",
  };
  return <span className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${styles[status]}`}>{humanize(status)}</span>;
}

function TableHeading({ children }: { children: React.ReactNode }) {
  return <th className="px-6 py-4 text-xs font-semibold uppercase tracking-wider text-on-surface-variant">{children}</th>;
}

function IconButton({ icon, label, onClick, tone = "destructive" }: { icon: string; label: string; onClick: React.MouseEventHandler<HTMLButtonElement>; tone?: "positive" | "neutral" | "destructive" }) {
  const styles = {
    positive: "bg-tertiary/10 text-tertiary hover:bg-tertiary/20",
    neutral: "bg-secondary/15 text-secondary hover:bg-secondary/25",
    destructive: "bg-error/10 text-error hover:bg-error/20",
  } as const;
  return (
    <button type="button" title={label} aria-label={label} onClick={onClick} className={`flex h-9 w-9 items-center justify-center rounded-lg transition ${styles[tone]}`}><span className="material-symbols-outlined text-lg">{icon}</span></button>
  );
}

function ApplicationDrawer({ application, onClose, children, footer }: { application: ApplicationRecord; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode }) {
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };

    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  return (
    <div
      className="application-drawer-backdrop fixed inset-0 z-50 flex justify-end bg-black/45"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        className="application-drawer relative flex h-dvh w-full flex-col bg-surface-container-lowest shadow-2xl sm:max-w-xl lg:max-w-2xl xl:max-w-3xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="application-drawer-title"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close application details"
          className="absolute left-0 top-8 z-20 hidden h-14 w-14 -translate-x-full items-center justify-center bg-error text-white shadow-lg transition hover:bg-error/90 sm:flex"
        >
          <span className="material-symbols-outlined text-3xl">close</span>
        </button>

        <header className="shrink-0 border-b border-surface-container px-6 py-6 sm:px-8">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">
                Application #{application.application_id}
              </p>
              <h2 id="application-drawer-title" className="mt-2 break-words text-2xl font-semibold tracking-tight text-on-surface sm:text-3xl">
                {application.name}
              </h2>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close application details"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-surface-container text-on-surface-variant transition hover:bg-surface-container-high sm:hidden"
            >
              <span className="material-symbols-outlined">close</span>
            </button>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <StatusBadge status={application.status} />
            {application.is_overdue && <span className="rounded-full bg-warning-container px-3 py-1 text-xs font-medium text-warning">Over 14 days</span>}
            {application.legacy_source && <span className="rounded-full bg-surface-container px-3 py-1 text-xs font-medium text-on-surface-variant">Imported legacy record</span>}
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-7 sm:px-8">
          {children}
        </div>

        {footer && (
          <footer className="shrink-0 border-t border-surface-container bg-surface-container-lowest px-6 py-4 shadow-[0_-8px_24px_rgba(24,28,29,0.06)] sm:px-8">
            {footer}
          </footer>
        )}
      </aside>
    </div>
  );
}

function DrawerSection({ title, icon, children }: { title: string; icon: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-5 flex items-center gap-3 border-b border-surface-container pb-3">
        <span className="material-symbols-outlined flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-lg text-primary">
          {icon}
        </span>
        <h3 className="text-sm font-semibold uppercase tracking-[0.12em] text-on-surface">
          {title}
        </h3>
      </div>
      {children}
    </section>
  );
}

/**
 * Where an application's installation stands, and the button that starts one.
 *
 * Shown only while the application is pending, because that is the only state
 * in which anybody should be driving to the address: a serviced application
 * already has a customer, and a declined or cancelled one has nobody waiting.
 *
 * The technician's report is the whole point of the panel. Once they mark the
 * job done, this is where the office sees it and knows the address is ready
 * to be activated.
 */
/**
 * The installation state of one application, small enough to sit in a table row.
 *
 * Renders nothing when no technician has ever been sent, so an ordinary
 * application looks exactly as it did - the badge only appears once there is
 * something to say.
 *
 * Only shown while the application is still pending. Once the office
 * activates it the installation is history, and a "Done" badge on a serviced
 * row would just be repeating the status beside it.
 */
function InstallBadge({ application }: { application: ApplicationRecord }) {
  const status = application.install_status;

  if (!status || application.status !== "pending") return null;

  const who = application.install_technician_name;

  const shown: Record<string, { label: string; className: string }> = {
    assigned: { label: "Out for install", className: "bg-info/10 text-info" },
    in_progress: { label: "Being installed", className: "bg-warning-container text-warning" },
    // Solid, matching the unresolved pill on the service ticket queue, so the
    // one state that needs somebody to act reads the same in both places.
    unresolved: { label: "Couldn't install", className: "bg-stalled text-white" },
    completed: { label: "Installed", className: "bg-tertiary/10 text-tertiary" },
  };

  const badge = shown[status];
  if (!badge) return null;

  return (
    <span
      className={`mt-1.5 inline-flex whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-medium ${badge.className}`}
      title={who ? `${badge.label} — ${who}` : badge.label}
    >
      {badge.label}
    </span>
  );
}

function InstallationDispatchRow({
  application,
  onDispatch,
}: {
  application: ApplicationRecord;
  onDispatch: () => void;
}) {
  const status = application.install_status;
  const out = status === "assigned" || status === "in_progress";

  if (status === "completed") {
    return (
      <div className="rounded-xl bg-tertiary/10 p-4">
        <p className="flex items-center gap-2 text-sm font-semibold text-tertiary">
          <span className="material-symbols-outlined text-lg">task_alt</span>
          Installed by {application.install_technician_name || "a technician"}
        </p>
        {application.install_notes && (
          <p className="mt-1.5 text-sm text-on-surface-variant">{application.install_notes}</p>
        )}
        <p className="mt-1 text-xs text-on-surface-variant">
          Ready to activate. Fill in the pole box, port and package below.
        </p>
      </div>
    );
  }

  if (out) {
    return (
      <div className="rounded-xl bg-surface-container-low p-4">
        <p className="flex items-center gap-2 text-sm font-semibold text-on-surface">
          <span className="material-symbols-outlined text-lg">engineering</span>
          {status === "in_progress" ? "Being installed" : "Sent"} — {application.install_technician_name || "a technician"}
        </p>
        <p className="mt-1 text-xs text-on-surface-variant">
          It is on their phone. They mark it done when the service is in.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* An unresolved visit is not a failure to hide - it is the reason the
          office is being asked to send somebody again, so it says what
          happened and offers the same button. */}
      {status === "unresolved" && (
        <div className="rounded-xl bg-stalled/10 p-4">
          <p className="text-sm font-semibold text-stalled">
            {application.install_technician_name || "A technician"} could not complete this
          </p>
          {application.install_notes && (
            <p className="mt-1.5 text-sm text-on-surface-variant">{application.install_notes}</p>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={onDispatch}
        className="flex items-center justify-center gap-2 rounded-lg bg-primary/10 px-4 py-3 text-sm font-medium text-primary transition hover:bg-primary/20"
      >
        <span className="material-symbols-outlined">send_to_mobile</span>
        {status === "unresolved" ? "Send to a technician again" : "Send to a technician"}
      </button>
    </div>
  );
}

/** Picks the technician, against the installation cap rather than the repair one. */
function DispatchInstallationModal({
  application,
  onClose,
  onSent,
}: {
  application: ApplicationRecord;
  onClose: () => void;
  onSent: (message: string) => void;
}) {
  const [technicians, setTechnicians] = useState<
    Array<{
      employee_id: number; first_name: string; last_name: string;
      open_jobs: number; job_limit: number; can_take_work: boolean;
    }>
  >([]);
  const [chosen, setChosen] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    // jobType matters: the two caps are separate, so a technician full of
    // repairs is still free to install.
    apiFetch("/api/service-ticket-assignees?jobType=installation")
      .then(async (response) => {
        const data = await response.json();
        if (response.ok) setTechnicians(data.employees);
      })
      .catch(() => setTechnicians([]));
  }, []);

  const send = async () => {
    try {
      setSaving(true);
      setError("");

      const response = await apiFetch(
        `/api/applications/${application.application_id}/dispatch`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ assignedEmployeeId: chosen }),
        }
      );

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not send this out.");

      onSent(`${application.name}: ${data.message}`);
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "Could not send this out.");
    } finally {
      setSaving(false);
    }
  };

  const everyoneFull = technicians.length > 0 && technicians.every((t) => !t.can_take_work);

  return (
    <Modal title="Send for installation" onClose={() => !saving && onClose()}>
      <div className="space-y-5">
        <div className="rounded-xl bg-surface-container-low p-4">
          <p className="font-medium text-on-surface">{application.name}</p>
          <p className="mt-1 text-sm text-on-surface-variant">
            {application.address || "No address on file"}
            {application.telephone ? ` · ${application.telephone}` : ""}
          </p>
        </div>

        <Field label="Technician" required>
          <select value={chosen} onChange={(event) => setChosen(event.target.value)} className={inputClass}>
            <option value="">Choose a technician</option>
            {technicians.map((technician) => (
              <option key={technician.employee_id} value={technician.employee_id} disabled={!technician.can_take_work}>
                {technician.first_name} {technician.last_name} —{" "}
                {technician.can_take_work
                  ? technician.open_jobs === 0
                    ? "no installs"
                    : `${technician.open_jobs} of ${technician.job_limit} installs`
                  : `${technician.open_jobs} of ${technician.job_limit} installs, must clear first`}
              </option>
            ))}
          </select>
        </Field>

        {everyoneFull && (
          <p className="text-xs text-on-surface-variant">
            Every technician is working through a full installation queue. This
            one waits until somebody clears theirs.
          </p>
        )}

        <p className="text-xs leading-5 text-on-surface-variant">
          They see the name, address and phone number, and mark it done once the
          service is in. Activating the customer stays here.
        </p>

        {error && <p className="rounded-lg bg-error/10 p-3 text-sm text-error">{error}</p>}

        <ModalActions
          saving={saving || !chosen}
          primaryLabel="Send"
          onCancel={onClose}
          onPrimary={send}
        />
      </div>
    </Modal>
  );
}

function Modal({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className={`max-h-[92vh] w-full overflow-y-auto rounded-2xl bg-surface-container-lowest shadow-2xl ${wide ? "max-w-4xl" : "max-w-2xl"}`}>
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-surface-container bg-surface-container-lowest px-6 py-5"><h2 className="text-xl font-semibold text-on-surface">{title}</h2><button type="button" onClick={onClose} className="rounded-full p-2 text-on-surface-variant transition hover:bg-surface-container" aria-label="Close"><span className="material-symbols-outlined">close</span></button></div>
        <div className="p-6">{children}</div>
      </div>
    </div>
  );
}

function FormSection({ title, children }: { title: string; children: React.ReactNode }) {
  return <section><h3 className="mb-4 border-b border-surface-container pb-2 text-sm font-semibold uppercase tracking-wider text-primary">{title}</h3><div className="grid grid-cols-1 gap-4 sm:grid-cols-2">{children}</div></section>;
}

function Field({ label, children, required = false }: { label: string; children: React.ReactNode; required?: boolean }) {
  return <label className="block text-sm font-semibold text-on-surface">{label}{required && <span className="ml-1 text-error">*</span>}{children}</label>;
}

function Detail({ label, value }: { label: string; value: string | null | undefined }) {
  return <div><p className="text-xs font-semibold uppercase tracking-wider text-on-surface-variant">{label}</p><p className="mt-1.5 font-medium text-on-surface">{value || "—"}</p></div>;
}

function ModalActions({ saving, primaryLabel, onCancel, onPrimary, destructive = false }: { saving: boolean; primaryLabel: string; onCancel: () => void; onPrimary?: () => void; destructive?: boolean }) {
  return (
    <div className="flex justify-end gap-3 border-t border-surface-container pt-5">
      <button type="button" disabled={saving} onClick={onCancel} className="rounded-lg bg-surface-container px-5 py-2.5 text-sm font-medium text-on-surface-variant disabled:opacity-50">Cancel</button>
      <button type={onPrimary ? "button" : "submit"} disabled={saving} onClick={onPrimary} className={`rounded-lg px-5 py-2.5 text-sm font-medium text-white disabled:opacity-50 ${destructive ? "bg-error" : "bg-primary"}`}>{saving ? "Saving..." : primaryLabel}</button>
    </div>
  );
}

export default ApplicationsPage;
