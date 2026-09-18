/** Lets Admin and Head Office employees correct customer profile details. */
import { useEffect, useState, type FormEvent } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import { apiFetch } from "../lib/api";
import { getCustomerReturnContext } from "../hooks/useOpenCustomerProfile";

type EditableCustomer = {
  customer_id: number;
  name: string | null;
  address: string | null;
  occupation: string | null;
  telephone: string | null;
  email: string | null;
  id_type: string | null;
  id_number: string | null;
  pole_box_number: string | null;
  port_number: string | null;
  adult_channel: boolean;
};

type EditForm = {
  name: string;
  address: string;
  occupation: string;
  telephone: string;
  email: string;
  idType: string;
  idNumber: string;
  poleBoxNumber: string;
  portNumber: string;
  adultChannel: boolean;
  reason: string;
};

const emptyForm: EditForm = {
  name: "",
  address: "",
  occupation: "",
  telephone: "",
  email: "",
  idType: "",
  idNumber: "",
  poleBoxNumber: "",
  portNumber: "",
  adultChannel: false,
  reason: "",
};

const inputClass = "h-12 w-full rounded-xl border border-outline-variant bg-surface-container-lowest px-4 text-sm text-on-surface transition focus:border-primary";
const textareaClass = `${inputClass} h-auto py-3`;

function EditCustomerProfilePage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { customerId } = useParams();
  const [form, setForm] = useState<EditForm>(emptyForm);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const returnToCustomer = () => {
    if (getCustomerReturnContext(location.state) && Number(window.history.state?.idx) > 0) {
      navigate(-1);
      return;
    }
    navigate(`/customers/${customerId}`, { state: location.state });
  };

  useEffect(() => {
    const loadCustomer = async () => {
      try {
        setLoading(true);
        setError("");
        const response = await apiFetch(`/api/customers/${customerId}`);
        const data: EditableCustomer & { error?: string } = await response.json();
        if (!response.ok) throw new Error(data.error || "Could not load customer.");
        setForm({
          name: data.name ?? "",
          address: data.address ?? "",
          occupation: data.occupation ?? "",
          telephone: data.telephone ?? "",
          email: data.email ?? "",
          idType: data.id_type ?? "",
          idNumber: data.id_number ?? "",
          poleBoxNumber: data.pole_box_number ?? "",
          portNumber: data.port_number ?? "",
          adultChannel: data.adult_channel,
          reason: "",
        });
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : "Could not load customer.");
      } finally {
        setLoading(false);
      }
    };
    loadCustomer();
  }, [customerId]);

  const updateField = <Key extends keyof EditForm>(field: Key, value: EditForm[Key]) => {
    setForm((current) => ({ ...current, [field]: value }));
  };

  const saveProfile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      setSaving(true);
      setError("");
      const response = await apiFetch(`/api/customers/${customerId}/profile`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not update customer profile.");
      returnToCustomer();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not update customer profile.");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="p-12 text-on-surface-variant">Loading customer profile...</div>;
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-5 sm:px-6 sm:py-6 lg:px-8 lg:py-8 lg:gap-8">
      <button
        type="button"
        onClick={returnToCustomer}
        className="flex w-fit items-center gap-2 text-sm font-semibold text-primary transition hover:opacity-70"
      >
        <span className="material-symbols-outlined text-lg">arrow_back</span>
        Back to Customer
      </button>

      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">Admin &amp; Head Office</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-on-surface">Edit Customer Profile</h1>
        <p className="mt-2 text-sm text-on-surface-variant">
          Correct identity, contact, and service-record details. Billing and account status are managed separately.
        </p>
      </div>

      <form onSubmit={saveProfile} className="space-y-6">
        <FormSection title="Customer information" icon="person">
          <Field label="Full name" required>
            <input required minLength={2} maxLength={160} value={form.name} onChange={(event) => updateField("name", event.target.value)} className={inputClass} />
          </Field>
          <Field label="Occupation">
            <input maxLength={160} value={form.occupation} onChange={(event) => updateField("occupation", event.target.value)} className={inputClass} />
          </Field>
          <Field label="Telephone">
            <input maxLength={50} value={form.telephone} onChange={(event) => updateField("telephone", event.target.value)} className={inputClass} />
          </Field>
          <Field label="Email">
            <input type="email" maxLength={254} value={form.email} onChange={(event) => updateField("email", event.target.value)} className={inputClass} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Service address">
              <textarea rows={3} maxLength={500} value={form.address} onChange={(event) => updateField("address", event.target.value)} className={textareaClass} />
            </Field>
          </div>
        </FormSection>

        <FormSection title="Identification" icon="badge">
          <Field label="ID type">
            <select value={form.idType} onChange={(event) => updateField("idType", event.target.value)} className={inputClass}>
              <option value="">Not recorded</option>
              <option value="Driver's Licence">Driver&apos;s Licence</option>
              <option value="Passport">Passport</option>
              <option value="National ID">National ID</option>
              <option value="TRN">TRN</option>
              {form.idType && !["Driver's Licence", "Passport", "National ID", "TRN"].includes(form.idType) && (
                <option value={form.idType}>{form.idType}</option>
              )}
            </select>
          </Field>
          <Field label="ID number">
            <input maxLength={100} value={form.idNumber} onChange={(event) => updateField("idNumber", event.target.value)} className={inputClass} />
          </Field>
        </FormSection>

        <FormSection title="Service record" icon="router">
          <Field label="Pole box">
            <input maxLength={80} value={form.poleBoxNumber} onChange={(event) => updateField("poleBoxNumber", event.target.value)} className={inputClass} />
          </Field>
          <Field label="Port">
            <input maxLength={80} value={form.portNumber} onChange={(event) => updateField("portNumber", event.target.value)} className={inputClass} />
          </Field>
          <label className="flex items-center gap-3 rounded-xl border border-outline-variant bg-surface-container-low px-4 py-4 text-sm font-semibold sm:col-span-2">
            <input type="checkbox" checked={form.adultChannel} onChange={(event) => updateField("adultChannel", event.target.checked)} className="h-4 w-4 accent-primary" />
            Adult channel enabled
          </label>
        </FormSection>

        <section className="rounded-2xl bg-surface-container-lowest p-6 shadow-sm">
          <Field label="Reason for edit" required>
            <textarea
              required
              minLength={3}
              maxLength={500}
              rows={3}
              value={form.reason}
              onChange={(event) => updateField("reason", event.target.value)}
              placeholder="Explain why this customer record is being corrected..."
              className={textareaClass}
            />
          </Field>
          <p className="mt-2 text-xs text-on-surface-variant">Every changed field will be recorded in Activity History.</p>
        </section>

        {error && <div role="alert" className="rounded-xl bg-error/10 p-4 text-sm text-error">{error}</div>}

        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <button type="button" disabled={saving} onClick={returnToCustomer} className="rounded-xl border border-outline-variant px-6 py-3 text-sm font-medium text-on-surface disabled:opacity-60">Cancel</button>
          <button type="submit" disabled={saving} className="flex items-center justify-center gap-2 rounded-xl bg-primary px-6 py-3 text-sm font-medium text-on-primary shadow-md transition hover:bg-primary-container disabled:opacity-60">
            <span className="material-symbols-outlined text-lg">save</span>
            {saving ? "Saving..." : "Save Changes"}
          </button>
        </div>
      </form>
    </div>
  );
}

function FormSection({ title, icon, children }: { title: string; icon: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl bg-surface-container-lowest p-6 shadow-sm">
      <div className="mb-5 flex items-center gap-3 border-b border-surface-container pb-4">
        <span className="material-symbols-outlined text-primary">{icon}</span>
        <h2 className="text-lg font-semibold text-on-surface">{title}</h2>
      </div>
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">{children}</div>
    </section>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-2 block text-sm font-semibold text-on-surface">
        {label}{required && <span className="ml-1 text-error">*</span>}
      </span>
      {children}
    </label>
  );
}

export default EditCustomerProfilePage;
