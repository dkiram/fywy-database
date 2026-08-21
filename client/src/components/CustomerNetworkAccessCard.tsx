/**
 * Displays and edits the identifiers that locate one customer's ONT.
 *
 * This card only records the mapping. It intentionally does not send commands
 * to the OLT; command execution will be a separate, audited backend service.
 */
import { useEffect, useId, useState } from "react";
import { apiFetch } from "../lib/api";

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
  verified_at: string | null;
  updated_at: string;
};

type OltOption = {
  olt_id: number;
  name: string;
  management_ip: string;
};

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
}: {
  customerId: number;
  canEdit: boolean;
}) {
  const oltListId = useId();
  const [networkAccess, setNetworkAccess] = useState<NetworkAccess | null>(null);
  const [olts, setOlts] = useState<OltOption[]>([]);
  const [form, setForm] = useState<FormState>({ ...emptyForm });
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        setLoading(true);
        setError("");
        const [assignmentResponse, oltsResponse] = await Promise.all([
          apiFetch(`/api/customers/${customerId}/network-access`),
          apiFetch("/api/olts"),
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

  const location = networkAccess
    ? `${networkAccess.frame_number}/${networkAccess.slot_number}/${networkAccess.pon_port_number}/${networkAccess.ont_id}`
    : null;

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
          </div>
          <p className="mt-5 text-xs text-on-surface-variant">
            Location format: Frame / Card or Slot / PON Port / Virtual Port (ONT ID).
            A future disconnect action must verify this mapping before contacting the OLT.
          </p>
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
            <Field label="OLT management IP" value={form.managementIp} onChange={(value) => updateForm("managementIp", value)} required placeholder="Example: 192.168.1.211" />
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
          </div>
        </form>
      )}
    </section>
  );
}
