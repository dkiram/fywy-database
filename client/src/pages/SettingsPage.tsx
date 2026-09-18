/** Shows the current employee profile and provides password and session controls. */
import { useState } from "react";
import { useNavigate } from "react-router";
import { useAuth, type EmployeeRole } from "../auth/AuthContext";
import { apiFetch } from "../lib/api";

function SettingsPage() {
  const navigate = useNavigate();
  const { employee, logout } = useAuth();
  // Password values never leave this component except in the authenticated PATCH request.
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPasswords, setShowPasswords] = useState(false);
  const [saving, setSaving] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const initials = employee
    ? `${employee.firstName.charAt(0)}${employee.lastName.charAt(0)}`.toUpperCase()
    : "?";

  const changePassword = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    setSuccess("");

    // Give immediate feedback before making the server perform a password hash check.
    if (newPassword.length < 8) {
      setError("Your new password must be at least 8 characters.");
      return;
    }

    if (newPassword !== confirmPassword) {
      setError("The new passwords do not match.");
      return;
    }

    try {
      setSaving(true);
      // The API rechecks these rules and verifies the current password authoritatively.
      const response = await apiFetch("/api/auth/password", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Could not change password.");
      }

      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setSuccess("Your password has been updated.");
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Could not change password."
      );
    } finally {
      setSaving(false);
    }
  };

  const signOut = async () => {
    try {
      // Logout destroys the server session, then the user returns to the public route.
      setSigningOut(true);
      await logout();
      navigate("/");
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-5 sm:px-6 sm:py-6 lg:px-8 lg:py-8">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
          My account
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-on-surface">
          Settings
        </h1>
        <p className="mt-1 text-sm text-on-surface-variant">
          Review your employee details and manage your account security.
        </p>
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,0.82fr)_minmax(0,1.18fr)]">
        <div className="space-y-6">
          {/* Identity and access fields are controlled by administrators and remain read-only. */}
          <section className="overflow-hidden rounded-2xl bg-surface-container-lowest shadow-sm">
            <div className="bg-sidebar px-6 py-7 text-white">
              <div className="flex items-center gap-4">
                <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-primary text-xl font-medium tracking-wide shadow-lg">
                  {initials}
                </div>
                <div className="min-w-0">
                  <h2 className="truncate text-xl font-semibold">
                    {employee
                      ? `${employee.firstName} ${employee.lastName}`
                      : "Employee"}
                  </h2>
                  <p className="mt-1 text-sm text-sidebar-text/65">
                    {employee ? formatRole(employee.role) : "—"}
                  </p>
                </div>
              </div>
            </div>

            <div className="divide-y divide-surface-container px-6">
              <ProfileRow icon="alternate_email" label="Username" value={employee?.username || "—"} />
              <ProfileRow icon="badge" label="Employee ID" value={employee ? `#${employee.employeeId}` : "—"} />
              <ProfileRow icon="location_on" label="Assigned location" value={employee?.locationName || "Not assigned"} />
              <ProfileRow icon="admin_panel_settings" label="Access level" value={employee ? formatRole(employee.role) : "—"} />
            </div>

            <div className="border-t border-surface-container bg-surface-container-low px-6 py-4">
              <p className="flex items-start gap-2 text-xs leading-5 text-on-surface-variant">
                <span className="material-symbols-outlined mt-0.5 text-base text-primary" aria-hidden="true">
                  info
                </span>
                Contact an administrator if your name, role, or assigned location needs to change.
              </p>
            </div>
          </section>

          <section className="rounded-2xl border border-error/15 bg-surface-container-lowest p-6 shadow-sm">
            <div className="flex items-start gap-4">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-error/10 text-error">
                <span className="material-symbols-outlined text-xl" aria-hidden="true">
                  logout
                </span>
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="font-semibold text-on-surface">Sign out</h2>
                <p className="mt-1 text-sm leading-6 text-on-surface-variant">
                  End your session on this device. You will need your credentials to sign in again.
                </p>
                <button
                  type="button"
                  onClick={signOut}
                  disabled={signingOut}
                  className="mt-4 rounded-lg bg-error/10 px-4 py-2.5 text-sm font-medium text-error transition hover:bg-error/15 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {signingOut ? "Signing out..." : "Sign out of FYWY"}
                </button>
              </div>
            </div>
          </section>
        </div>

        {/* Employees can change their own password without gaining profile-edit permissions. */}
        <section className="rounded-2xl bg-surface-container-lowest p-6 shadow-sm sm:p-8">
          <div className="flex items-start gap-4 border-b border-surface-container pb-6">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <span className="material-symbols-outlined text-2xl" aria-hidden="true">
                password
              </span>
            </div>
            <div>
              <h2 className="text-lg font-semibold text-on-surface">Change password</h2>
              <p className="mt-1 text-sm leading-6 text-on-surface-variant">
                Use a password you do not use for another account.
              </p>
            </div>
          </div>

          <form onSubmit={changePassword} className="mt-6 space-y-5">
            <PasswordField
              id="current-password"
              label="Current password"
              value={currentPassword}
              onChange={setCurrentPassword}
              visible={showPasswords}
              autoComplete="current-password"
            />

            <div className="grid gap-5 sm:grid-cols-2">
              <PasswordField
                id="new-password"
                label="New password"
                value={newPassword}
                onChange={setNewPassword}
                visible={showPasswords}
                autoComplete="new-password"
              />
              <PasswordField
                id="confirm-password"
                label="Confirm new password"
                value={confirmPassword}
                onChange={setConfirmPassword}
                visible={showPasswords}
                autoComplete="new-password"
              />
            </div>

            <div className="flex flex-col gap-3 rounded-xl bg-surface-container-low px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="flex items-center gap-2 text-xs font-medium text-on-surface-variant">
                <span className={`material-symbols-outlined text-base ${newPassword.length >= 8 ? "text-tertiary" : "text-outline"}`} aria-hidden="true">
                  {newPassword.length >= 8 ? "check_circle" : "info"}
                </span>
                At least 8 characters
              </p>
              <label className="flex cursor-pointer items-center gap-2 text-xs font-semibold text-on-surface-variant">
                <input
                  type="checkbox"
                  checked={showPasswords}
                  onChange={(event) => setShowPasswords(event.target.checked)}
                  className="h-4 w-4 accent-primary"
                />
                Show passwords
              </label>
            </div>

            {error && <Message tone="error" icon="error" text={error} />}
            {success && <Message tone="success" icon="check_circle" text={success} />}

            <div className="flex justify-end border-t border-surface-container pt-5">
              <button
                type="submit"
                disabled={saving || !currentPassword || !newPassword || !confirmPassword}
                className="flex items-center justify-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-on-primary shadow-sm transition hover:bg-primary-container disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span className="material-symbols-outlined text-lg" aria-hidden="true">
                  lock_reset
                </span>
                {saving ? "Updating..." : "Update password"}
              </button>
            </div>
          </form>
        </section>
      </div>
    </div>
  );
}

function ProfileRow({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <div className="flex items-center gap-3 py-4">
      <span className="material-symbols-outlined text-xl text-outline" aria-hidden="true">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold uppercase tracking-wider text-on-surface-variant">{label}</p>
        <p className="mt-1 break-words text-sm font-semibold text-on-surface">{value}</p>
      </div>
    </div>
  );
}

function PasswordField({
  id,
  label,
  value,
  onChange,
  visible,
  autoComplete,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  visible: boolean;
  autoComplete: string;
}) {
  return (
    <label htmlFor={id} className="block text-sm font-semibold text-on-surface">
      {label}
      <div className="relative mt-2">
        <span className="material-symbols-outlined pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-lg text-outline" aria-hidden="true">
          lock
        </span>
        <input
          id={id}
          type={visible ? "text" : "password"}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete={autoComplete}
          required
          maxLength={128}
          className="h-12 w-full rounded-lg border border-outline-variant bg-white px-4 pl-11 text-sm font-normal text-on-surface transition focus:border-primary"
        />
      </div>
    </label>
  );
}

function Message({ tone, icon, text }: { tone: "error" | "success"; icon: string; text: string }) {
  const styles = tone === "error" ? "bg-error/10 text-error" : "bg-tertiary/10 text-tertiary";
  return (
    <div role={tone === "error" ? "alert" : "status"} className={`flex items-start gap-2 rounded-lg px-4 py-3 text-sm font-medium ${styles}`}>
      <span className="material-symbols-outlined mt-0.5 text-lg" aria-hidden="true">{icon}</span>
      <span>{text}</span>
    </div>
  );
}

function formatRole(role: EmployeeRole) {
  if (role === "admin") return "Administrator";
  if (role === "head_office") return "Head Office";
  return "Branch Staff";
}

export default SettingsPage;
