/**
 * Displays and edits the identifiers that locate one customer's ONT.
 *
 * Production users normally use this card for read-only mapping verification.
 * A separately gated test section can request audited backend ONT actions for
 * one explicitly allowlisted spare/company customer.
 */
import { useEffect, useId, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { apiFetch } from "../lib/api";
import type { AccountStatus, AccountStatusUpdate } from "./AccountOperationsPanel";

type NetworkAccess = {
  customer_ont_assignment_id: number;
  olt_id: number;
  olt_name: string;
  management_ip: string;
  frame_number: number;
  slot_number: number;
  pon_port_number: number;
  ont_id: number;
  source: "manual" | "u2000_import" | "api_sync";
  mapping_status: "unverified" | "verified" | "mismatch";
  ont_description_override: string | null;
  description_override_reason: string | null;
  description_overridden_at: string | null;
  verified_at: string | null;
  verified_by_first_name: string | null;
  verified_by_last_name: string | null;
  updated_at: string;
};

type VerificationResult = {
  status: "verified" | "mismatch";
  message: string;
  checkedAt: string;
  live: {
    controlFlag: "active" | "deactivated";
    runState: "online" | "offline";
    description: string | null;
  } | null;
  overrideEligible?: boolean;
};

type OltOption = {
  olt_id: number;
  name: string;
  management_ip: string;
};

type OntControlAvailability = {
  enabled: boolean;
  allowlisted: boolean;
  available: boolean;
  reason: string | null;
};

type OntControlAction = "deactivate" | "activate";

type FormState = {
  oltName: string;
  managementIp: string;
  frameNumber: string;
  slotNumber: string;
  ponPortNumber: string;
  ontId: string;
  reason: string;
};

const emptyForm: FormState = {
  oltName: "",
  managementIp: "",
  frameNumber: "0",
  slotNumber: "",
  ponPortNumber: "",
  ontId: "",
  reason: "",
};

function formFromAssignment(value: NetworkAccess | null): FormState {
  if (!value) return { ...emptyForm };
  return {
    oltName: value.olt_name,
    managementIp: value.management_ip,
    frameNumber: String(value.frame_number),
    slotNumber: String(value.slot_number),
    ponPortNumber: String(value.pon_port_number),
    ontId: String(value.ont_id),
    reason: "",
  };
}

function Field({
  label,
  value,
  onChange,
  required = false,
  type = "text",
  placeholder,
  list,
  help,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  type?: "text" | "number";
  placeholder?: string;
  list?: string;
  help?: string;
}) {
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="font-medium">
        {label}{required && <span className="ml-1 text-error">*</span>}
      </span>
      <input
        type={type}
        min={type === "number" ? 0 : undefined}
        required={required}
        value={value}
        list={list}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="rounded-lg border border-outline-variant bg-surface px-3 py-2.5 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/15"
      />
      {help && <span className="text-xs text-on-surface-variant">{help}</span>}
    </label>
  );
}

function Value({ label, value }: { label: string; value: string | number | null }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-on-surface-variant">{label}</p>
      <p className="mt-1 break-words font-medium">{value ?? "—"}</p>
    </div>
  );
}

function statusStyles(status: NetworkAccess["mapping_status"]) {
  if (status === "verified") return "bg-green-100 text-green-800";
  if (status === "mismatch") return "bg-error-container text-on-error-container";
  return "bg-amber-100 text-amber-900";
}

export default function CustomerNetworkAccessCard({
  customerId,
  canEdit,
  accountStatus,
  onStatusSynced,
}: {
  customerId: number;
  canEdit: boolean;
  accountStatus: AccountStatus;
  onStatusSynced?: (update: AccountStatusUpdate) => void;
}) {
  const { employee } = useAuth();
  const adminMayOmitOverrideReason = employee?.role === "admin";
  const oltListId = useId();
  const [networkAccess, setNetworkAccess] = useState<NetworkAccess | null>(null);
  const [olts, setOlts] = useState<OltOption[]>([]);
  const [form, setForm] = useState<FormState>({ ...emptyForm });
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verification, setVerification] = useState<VerificationResult | null>(null);
  const [ontControl, setOntControl] = useState<OntControlAvailability | null>(null);
  const [controlAction, setControlAction] = useState<OntControlAction | null>(null);
  const [controlReason, setControlReason] = useState("");
  const [controlConfirmation, setControlConfirmation] = useState("");
  const [controlling, setControlling] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [showDescriptionOverride, setShowDescriptionOverride] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");
  const [overrideConfirmation, setOverrideConfirmation] = useState("");
  const [overridingDescription, setOverridingDescription] = useState(false);
  const [showRemove, setShowRemove] = useState(false);
  const [removeReason, setRemoveReason] = useState("");
  const [removing, setRemoving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    async function load() {
      try {
        setLoading(true);
        setError("");
        const [assignmentResponse, oltsResponse] = await Promise.all([
          apiFetch(`/api/customers/${customerId}/network-access`, { signal: controller.signal }),
          apiFetch("/api/olts", { signal: controller.signal }),
        ]);
        const assignmentData = await assignmentResponse.json();
        const oltsData = await oltsResponse.json();
        if (!assignmentResponse.ok) {
          throw new Error(assignmentData.error || "Could not load OLT information.");
        }
        if (!oltsResponse.ok) {
          throw new Error(oltsData.error || "Could not load the OLT list.");
        }
        if (!cancelled) {
          setNetworkAccess(assignmentData.networkAccess);
          setOntControl(assignmentData.ontControl ?? null);
          setOlts(oltsData.olts);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "Could not load OLT information.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [customerId]);

  function updateForm(field: keyof FormState, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function selectOlt(name: string) {
    const match = olts.find(
      (olt) => olt.name.trim().toLowerCase() === name.trim().toLowerCase()
    );
    setForm((current) => ({
      ...current,
      oltName: name,
      ...(match
        ? {
            managementIp: match.management_ip,
          }
        : {}),
    }));
  }

  function beginEditing() {
    setForm(formFromAssignment(networkAccess));
    setError("");
    setNotice("");
    setEditing(true);
    setExpanded(true);
  }

  async function verifyWithOlt() {
    try {
      setVerifying(true);
      setError("");
      setNotice("");
      setVerification(null);
      const response = await apiFetch(
        `/api/customers/${customerId}/network-access/verify`,
        { method: "POST" }
      );
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Could not verify this mapping with the OLT.");
      }
      setNetworkAccess(data.networkAccess);
      setOntControl((current) =>
        current
          ? {
              ...current,
              available: current.enabled && current.allowlisted,
              reason:
                current.enabled && current.allowlisted
                  ? null
                  : current.reason,
            }
          : current
      );
      setVerification(data.verification);
      setExpanded(true);
      setNotice(data.verification.message);
    } catch (verifyError) {
      setError(
        verifyError instanceof Error
          ? verifyError.message
          : "Could not verify this mapping with the OLT."
      );
    } finally {
      setVerifying(false);
    }
  }

  function beginOntControl(action: OntControlAction) {
    setControlAction(action);
    setControlReason("");
    setControlConfirmation("");
    setError("");
    setNotice("");
  }

  async function submitOntControl() {
    if (!controlAction) return;
    try {
      setControlling(true);
      setError("");
      setNotice("");
      const response = await apiFetch(
        `/api/customers/${customerId}/network-access/ont-control`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: controlAction,
            reason: controlReason,
            confirmation: controlConfirmation,
          }),
        }
      );
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Could not complete the live ONT action.");
      }

      setVerification({
        status: "verified",
        message: data.action.message,
        checkedAt: new Date().toISOString(),
        live: {
          controlFlag: data.action.after.controlFlag,
          runState: data.action.after.runState,
          description: null,
        },
      });
      setNotice(data.action.message);
      setControlAction(null);
      setControlReason("");
      setControlConfirmation("");
      setExpanded(true);
    } catch (controlError) {
      setError(
        controlError instanceof Error
          ? controlError.message
          : "Could not complete the live ONT action."
      );
    } finally {
      setControlling(false);
    }
  }

  async function submitDescriptionOverride() {
    try {
      setOverridingDescription(true);
      setError("");
      setNotice("");
      const response = await apiFetch(
        `/api/customers/${customerId}/network-access/description-override`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            reason: overrideReason,
            confirmation: overrideConfirmation,
          }),
        }
      );
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Could not confirm the Huawei description override.");
      }
      setNetworkAccess(data.networkAccess);
      setVerification(data.verification);
      setNotice(data.verification.message);
      setShowDescriptionOverride(false);
      setOverrideReason("");
      setOverrideConfirmation("");
      setExpanded(true);
    } catch (overrideError) {
      setError(
        overrideError instanceof Error
          ? overrideError.message
          : "Could not confirm the Huawei description override."
      );
    } finally {
      setOverridingDescription(false);
    }
  }

  async function syncStatusWithOlt() {
    if (
      !window.confirm(
        "Sync this account's workflow status to match the live OLT? No command is sent to the OLT, no reconnection fee is charged, and no balance needs to be cleared — this only corrects the database record."
      )
    ) {
      return;
    }
    try {
      setSyncing(true);
      setError("");
      setNotice("");
      const response = await apiFetch(
        `/api/customers/${customerId}/sync-status-with-olt`,
        { method: "POST" }
      );
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Could not sync the account status with the live OLT.");
      }
      onStatusSynced?.(data.customer);
      setVerification((current) =>
        current
          ? {
              ...current,
              live: current.live ? { ...current.live, controlFlag: data.live.controlFlag, runState: data.live.runState } : current.live,
            }
          : current
      );
      setNotice(`Account workflow status synced to match the live OLT (now ${data.customer.status.replaceAll("_", " ")}).`);
    } catch (syncError) {
      setError(
        syncError instanceof Error
          ? syncError.message
          : "Could not sync the account status with the live OLT."
      );
    } finally {
      setSyncing(false);
    }
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      setSaving(true);
      setError("");
      setNotice("");
      const response = await apiFetch(`/api/customers/${customerId}/network-access`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not save OLT information.");
      setNetworkAccess(data.networkAccess);
      setOntControl((current) =>
        current
          ? {
              ...current,
              available: false,
              reason: "Verify this mapping and ONT serial before using live controls.",
            }
          : current
      );
      setVerification(null);
      setEditing(false);
      setNotice("OLT information saved. This mapping is unverified until it is checked against the OLT.");
      if (!olts.some((olt) => olt.olt_id === data.networkAccess.olt_id)) {
        setOlts((current) => [
          ...current,
          {
            olt_id: data.networkAccess.olt_id,
            name: data.networkAccess.olt_name,
            management_ip: data.networkAccess.management_ip,
          },
        ]);
      }
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save OLT information.");
    } finally {
      setSaving(false);
    }
  }

  // Releasing ends the mapping rather than deleting it: the customer keeps the
  // record that they used to sit on this port, and the location and ONT serial
  // become free for the next customer immediately.
  async function removeAssignment() {
    if (!networkAccess) return;
    const releasedOlt = networkAccess.olt_name;
    const releasedLocation = `${networkAccess.frame_number}/${networkAccess.slot_number}/${networkAccess.pon_port_number}/${networkAccess.ont_id}`;
    try {
      setRemoving(true);
      setError("");
      setNotice("");
      const response = await apiFetch(`/api/customers/${customerId}/network-access`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: removeReason.trim() || null }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not remove OLT information.");
      setNetworkAccess(null);
      setOntControl(data.ontControl ?? null);
      setVerification(null);
      setEditing(false);
      setExpanded(false);
      setShowRemove(false);
      setRemoveReason("");
      setNotice(
        `OLT information removed. ${releasedOlt} ${releasedLocation} is now free to assign to another customer.`
      );
    } catch (removeError) {
      setError(
        removeError instanceof Error ? removeError.message : "Could not remove OLT information."
      );
    } finally {
      setRemoving(false);
    }
  }

  const location = networkAccess
    ? `${networkAccess.frame_number}/${networkAccess.slot_number}/${networkAccess.pon_port_number}/${networkAccess.ont_id}`
    : null;
  const requiredControlConfirmation = controlAction
    ? `${controlAction.toUpperCase()} ${customerId}`
    : "";
  const statusMismatch = verification?.live
    ? (accountStatus === "active") !== (verification.live.controlFlag === "active")
    : false;

  return (
    <section className="rounded-2xl bg-surface-container-lowest p-6 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-tertiary-container text-on-tertiary-container">
            <span className="material-symbols-outlined">lan</span>
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-semibold">OLT Information</h2>
              {networkAccess && (
                <span className={`rounded-full px-2 py-0.5 text-xs font-semibold capitalize ${statusStyles(networkAccess.mapping_status)}`}>
                  {networkAccess.mapping_status}
                </span>
              )}
            </div>
            <p className="mt-1 text-sm text-on-surface-variant">
              {networkAccess
                ? `${networkAccess.olt_name} · ONT location ${location}`
                : "No ONT or OLT mapping has been recorded for this customer."}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {networkAccess && !editing && (
            <button
              type="button"
              onClick={() => setExpanded((value) => !value)}
              className="rounded-lg border border-outline-variant px-3 py-2 text-sm font-medium transition hover:bg-surface-container"
            >
              {expanded ? "Hide details" : "View OLT information"}
            </button>
          )}
          {canEdit && networkAccess && !editing && !loading && (
            <button
              type="button"
              disabled={verifying}
              onClick={verifyWithOlt}
              className="rounded-lg bg-tertiary px-3 py-2 text-sm font-medium text-on-tertiary transition hover:opacity-90 disabled:cursor-wait disabled:opacity-60"
            >
              {verifying ? "Checking live OLT..." : "Verify with OLT"}
            </button>
          )}
          {canEdit && !editing && !loading && (
            <button
              type="button"
              onClick={beginEditing}
              className="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-on-primary transition hover:opacity-90"
            >
              {networkAccess ? "Edit OLT information" : "Add OLT information"}
            </button>
          )}
        </div>
      </div>

      {loading && <p className="mt-5 text-sm text-on-surface-variant">Loading OLT information...</p>}

      {!loading && error && !editing && (
        <p className="mt-5 rounded-lg bg-error-container p-3 text-sm text-on-error-container">{error}</p>
      )}

      {notice && (
        <p className="mt-5 rounded-lg bg-tertiary-container p-3 text-sm text-on-tertiary-container">{notice}</p>
      )}

      {verification?.live && (
        <div className={`mt-5 rounded-lg p-4 text-sm ${statusMismatch || verification.status === "mismatch" ? "bg-error-container text-on-error-container" : "bg-green-100 text-green-900"}`}>
          <div className="grid gap-2 sm:grid-cols-2">
            <p>
              <span className="font-semibold">Account workflow:</span>{" "}
              {accountStatus.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase())}
            </p>
            <p>
              <span className="font-semibold">Live Huawei OLT:</span>{" "}
              {verification.live.controlFlag === "active" ? "Active" : "Deactivated"}
              {" · "}{verification.live.runState === "online" ? "Online" : "Offline"}
            </p>
          </div>
          <p className="mt-2 font-semibold">
            {verification.status === "mismatch"
              ? "Mapping mismatch: correct and re-verify the saved ONT before relying on this state comparison."
              : statusMismatch
                ? "Out of sync: the account workflow and Huawei service control disagree. Use Account Operations to complete the matching reconnection or deactivation workflow."
                : "In sync: the account workflow and Huawei service control agree."}
          </p>
          <p className="mt-1">
            Checked {new Date(verification.checkedAt).toLocaleString()}.
          </p>
          <p className="mt-1 text-xs opacity-80">
            Sync uses Huawei’s Active/Deactivated control flag. Online/Offline only shows whether the ONT is currently registering and does not by itself change billing status.
          </p>
          {canEdit && verification.overrideEligible && (
            <button
              type="button"
              onClick={() => {
                setShowDescriptionOverride(true);
                setOverrideReason("");
                setOverrideConfirmation("");
                setError("");
              }}
              className="mt-3 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-on-primary transition hover:opacity-90"
            >
              Confirm description override
            </button>
          )}
          {canEdit &&
            statusMismatch &&
            verification?.status !== "mismatch" &&
            ["active", "disconnected", "pending_reconnection"].includes(accountStatus) && (
              <button
                type="button"
                disabled={syncing}
                onClick={syncStatusWithOlt}
                className="mt-3 rounded-lg bg-error px-3 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-wait disabled:opacity-60"
              >
                {syncing ? "Syncing..." : "Sync account status to match OLT"}
              </button>
            )}
        </div>
      )}

      {!loading && expanded && networkAccess && !editing && (
        <div className="mt-6 border-t border-surface-container pt-6">
          <div className="grid grid-cols-2 gap-x-8 gap-y-5 md:grid-cols-4">
            <Value label="OLT name" value={networkAccess.olt_name} />
            <Value label="Management IP" value={networkAccess.management_ip} />
            <Value label="Frame" value={networkAccess.frame_number} />
            <Value label="Card / slot" value={networkAccess.slot_number} />
            <Value label="PON port" value={networkAccess.pon_port_number} />
            <Value label="Virtual port / ONT ID" value={networkAccess.ont_id} />
            <Value
              label="Source"
              value={networkAccess.source === "u2000_import" ? "U2000 import" : networkAccess.source === "api_sync" ? "API sync" : "Manual entry"}
            />
            <Value
              label="Last verified"
              value={
                networkAccess.verified_at
                  ? new Date(networkAccess.verified_at).toLocaleString()
                  : "Not verified"
              }
            />
            <Value
              label="Verified by"
              value={
                networkAccess.verified_by_first_name
                  ? `${networkAccess.verified_by_first_name} ${networkAccess.verified_by_last_name ?? ""}`.trim()
                  : "—"
              }
            />
            {networkAccess.ont_description_override && (
              <Value
                label="Approved Huawei description"
                value={networkAccess.ont_description_override}
              />
            )}
          </div>
          {networkAccess.ont_description_override && (
            <p className="mt-4 rounded-lg bg-amber-50 p-3 text-xs text-amber-950">
              Description override active: future verification and ONT actions must
              match this exact Huawei description plus the saved serial and location.
            </p>
          )}
          <p className="mt-5 text-xs text-on-surface-variant">
            Location format: Frame / Card or Slot / PON Port / Virtual Port (ONT ID).
            Live controls re-check the ONT serial, location, and approved description before every command.
          </p>

          {canEdit && ontControl?.allowlisted && (
            <div className="mt-6 rounded-xl border border-amber-300 bg-amber-50 p-4 text-amber-950">
              <p className="text-sm font-semibold">Test-only live ONT controls</p>
              <p className="mt-1 text-xs">
                This changes the allowlisted ONT only. It does not update billing or the
                customer&apos;s account status during the test phase.
              </p>
              {ontControl.available ? (
                <div className="mt-4 flex flex-wrap gap-3">
                  <button
                    type="button"
                    disabled={controlling}
                    onClick={() => beginOntControl("deactivate")}
                    className="rounded-lg bg-error px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                  >
                    Deactivate test ONT
                  </button>
                  <button
                    type="button"
                    disabled={controlling}
                    onClick={() => beginOntControl("activate")}
                    className="rounded-lg bg-green-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                  >
                    Activate test ONT
                  </button>
                </div>
              ) : (
                <p className="mt-3 text-xs font-semibold">{ontControl.reason}</p>
              )}
            </div>
          )}
        </div>
      )}

      {!loading && editing && (
        <form onSubmit={save} className="mt-6 border-t border-surface-container pt-6">
          <div className="mb-6">
            <h3 className="font-semibold">OLT and ONT mapping</h3>
            <p className="mt-1 text-sm text-on-surface-variant">
              Enter the values shown in U2000 or confirmed through the MA5680T CLI.
            </p>
          </div>

          <datalist id={oltListId}>
            {olts.map((olt) => <option key={olt.olt_id} value={olt.name} />)}
          </datalist>

          <div className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3">
            <Field label="OLT name" value={form.oltName} onChange={selectOlt} required list={oltListId} placeholder="Example: MANDEVILLE" />
            <Field label="OLT management IP" value={form.managementIp} onChange={(value) => updateForm("managementIp", value)} required placeholder="Example: 192.168.1.4" />
            <Field label="Frame" value={form.frameNumber} onChange={(value) => updateForm("frameNumber", value)} required type="number" />
            <Field label="Card / slot" value={form.slotNumber} onChange={(value) => updateForm("slotNumber", value)} required type="number" />
            <Field label="PON port" value={form.ponPortNumber} onChange={(value) => updateForm("ponPortNumber", value)} required type="number" />
            <Field label="Virtual port / ONT ID" value={form.ontId} onChange={(value) => updateForm("ontId", value)} required type="number" />
            <Field label="Change note" value={form.reason} onChange={(value) => updateForm("reason", value)} placeholder="Optional" />
          </div>

          <div className="mt-6 rounded-lg bg-secondary-container p-3 text-sm text-on-secondary-container">
            Saving records this mapping as <strong>Unverified</strong>. That prevents a future automated action from trusting manually entered data without an OLT check.
          </div>

          {error && (
            <p className="mt-4 rounded-lg bg-error-container p-3 text-sm text-on-error-container">{error}</p>
          )}

          <div className="mt-6 flex flex-wrap gap-3">
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-on-primary disabled:opacity-60"
            >
              {saving ? "Saving..." : "Save OLT information"}
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => {
                setEditing(false);
                setError("");
                if (!networkAccess) setExpanded(false);
              }}
              className="rounded-lg border border-outline-variant px-4 py-2.5 text-sm font-medium"
            >
              Cancel
            </button>
            {networkAccess && (
              <button
                type="button"
                disabled={saving || removing}
                onClick={() => {
                  setError("");
                  setRemoveReason("");
                  setShowRemove(true);
                }}
                className="ml-auto rounded-lg border border-error px-4 py-2.5 text-sm font-medium text-error transition hover:bg-error-container disabled:opacity-50"
              >
                Remove OLT information
              </button>
            )}
          </div>
        </form>
      )}

      {showRemove && networkAccess && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Remove OLT information"
        >
          <div className="w-full max-w-lg rounded-2xl bg-surface-container-lowest p-6 shadow-2xl">
            <h3 className="text-xl font-semibold">Remove OLT information</h3>
            <p className="mt-2 text-sm text-on-surface-variant">
              This releases <strong>{networkAccess.olt_name} {location}</strong> from customer{" "}
              {customerId} so it can be assigned to somebody else. No command is sent to the
              OLT — this only frees the record. The mapping stays in this customer's history.
            </p>

            {accountStatus === "active" && (
              <p className="mt-4 rounded-lg bg-error-container p-3 text-sm text-on-error-container">
                This account is still <strong>active</strong>. Only remove the OLT information
                if this customer is genuinely off the port on the U2000.
              </p>
            )}

            <label className="mt-5 block text-sm font-semibold">
              Change note
              <textarea
                rows={3}
                maxLength={500}
                value={removeReason}
                onChange={(event) => setRemoveReason(event.target.value)}
                className="mt-1.5 w-full resize-none rounded-lg border border-outline-variant bg-white px-3 py-2.5 text-sm"
                placeholder="Optional — e.g. removed from the U2000, port reassigned"
              />
            </label>

            {error && (
              <p className="mt-4 rounded-lg bg-error-container p-3 text-sm text-on-error-container">
                {error}
              </p>
            )}

            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                disabled={removing}
                onClick={() => {
                  setShowRemove(false);
                  setRemoveReason("");
                  setError("");
                }}
                className="rounded-lg bg-surface-container px-4 py-2.5 text-sm font-medium disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={removing}
                onClick={removeAssignment}
                className="rounded-lg bg-error px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
              >
                {removing ? "Removing..." : "Remove OLT information"}
              </button>
            </div>
          </div>
        </div>
      )}

      {controlAction && networkAccess && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-label={`${controlAction} test ONT`}
        >
          <div className="w-full max-w-lg rounded-2xl bg-surface-container-lowest p-6 shadow-2xl">
            <h3 className="text-xl font-semibold capitalize">
              {controlAction} test ONT
            </h3>
            <p className="mt-2 text-sm text-on-surface-variant">
              The backend will first re-check customer {customerId}, serial, and location
              {` ${location}`}. If anything differs, no command will be sent.
            </p>

            <label className="mt-5 block text-sm font-semibold">
              Reason <span className="text-error">*</span>
              <textarea
                rows={3}
                maxLength={500}
                value={controlReason}
                onChange={(event) => setControlReason(event.target.value)}
                className="mt-1.5 w-full resize-none rounded-lg border border-outline-variant bg-white px-3 py-2.5 text-sm"
                placeholder="Test account and technician present..."
              />
            </label>

            <label className="mt-4 block text-sm font-semibold">
              Type <strong>{requiredControlConfirmation}</strong> to confirm
              <input
                value={controlConfirmation}
                onChange={(event) => setControlConfirmation(event.target.value)}
                autoComplete="off"
                className="mt-1.5 w-full rounded-lg border border-outline-variant bg-white px-3 py-2.5 font-mono text-sm"
              />
            </label>

            {error && (
              <p className="mt-4 rounded-lg bg-error-container p-3 text-sm text-on-error-container">
                {error}
              </p>
            )}

            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                disabled={controlling}
                onClick={() => {
                  setControlAction(null);
                  setControlReason("");
                  setControlConfirmation("");
                  setError("");
                }}
                className="rounded-lg bg-surface-container px-4 py-2.5 text-sm font-medium disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={
                  controlling ||
                  controlReason.trim().length < 3 ||
                  controlConfirmation !== requiredControlConfirmation
                }
                onClick={submitOntControl}
                className={`rounded-lg px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50 ${
                  controlAction === "deactivate" ? "bg-error" : "bg-green-700"
                }`}
              >
                {controlling ? "Checking and applying..." : `${controlAction === "deactivate" ? "Deactivate" : "Activate"} ONT`}
              </button>
            </div>
          </div>
        </div>
      )}

      {showDescriptionOverride && networkAccess && verification?.live && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Confirm Huawei ONT description override"
        >
          <div className="w-full max-w-lg rounded-2xl bg-surface-container-lowest p-6 shadow-2xl">
            <h3 className="text-xl font-semibold">Confirm description override</h3>
            <p className="mt-2 text-sm text-on-surface-variant">
              The backend will re-read location {location} and its ONT serial. It will
              accept only the exact live Huawei description shown below.
            </p>
            <div className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-950">
              <p><strong>Live Huawei description:</strong> {verification.live.description || "—"}</p>
              <p className="mt-2 text-xs">
                This ignores only the customer-name mismatch. A duplicate serial,
                occupied OLT location, missing ONT, or changed serial always blocks it.
              </p>
            </div>

            <label className="mt-5 block text-sm font-semibold">
              Reason {adminMayOmitOverrideReason ? (
                <span className="font-normal text-on-surface-variant">(optional for Admin)</span>
              ) : (
                <span className="text-error">*</span>
              )}
              <textarea
                rows={3}
                maxLength={500}
                value={overrideReason}
                onChange={(event) => setOverrideReason(event.target.value)}
                className="mt-1.5 w-full resize-none rounded-lg border border-outline-variant bg-white px-3 py-2.5 text-sm"
                placeholder={
                  adminMayOmitOverrideReason
                    ? "Optional note about how this mapping was confirmed..."
                    : "Staff confirmed this legacy Huawei description belongs to this customer..."
                }
              />
            </label>

            <label className="mt-4 block text-sm font-semibold">
              Type <strong>OVERRIDE DESCRIPTION {customerId}</strong> to confirm
              <input
                value={overrideConfirmation}
                onChange={(event) => setOverrideConfirmation(event.target.value)}
                autoComplete="off"
                className="mt-1.5 w-full rounded-lg border border-outline-variant bg-white px-3 py-2.5 font-mono text-sm"
              />
            </label>

            {error && (
              <p className="mt-4 rounded-lg bg-error-container p-3 text-sm text-on-error-container">
                {error}
              </p>
            )}

            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                disabled={overridingDescription}
                onClick={() => {
                  setShowDescriptionOverride(false);
                  setOverrideReason("");
                  setOverrideConfirmation("");
                  setError("");
                }}
                className="rounded-lg bg-surface-container px-4 py-2.5 text-sm font-medium disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={
                  overridingDescription ||
                  (!adminMayOmitOverrideReason && overrideReason.trim().length < 3) ||
                  (overrideReason.trim().length > 0 && overrideReason.trim().length < 3) ||
                  overrideConfirmation !== `OVERRIDE DESCRIPTION ${customerId}`
                }
                onClick={submitDescriptionOverride}
                className="rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-on-primary disabled:opacity-50"
              >
                {overridingDescription ? "Rechecking live OLT..." : "Confirm override"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
