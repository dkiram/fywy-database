/** Lets administrators review staff accounts and change role, office, access and passwords. */
import { useEffect, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { apiFetch } from "../lib/api";

type Employee = {
  employee_id: number;
  first_name: string;
  last_name: string;
  username: string | null;
  role: string;
  is_active: boolean;
  last_login_at: string | null;
  location_id: number | null;
  location_name: string | null;
};

type Location = {
  location_id: number;
  name: string;
  code: string;
  is_head_office: boolean;
};

/**
 * Roles that can be chosen here. 'technician' is absent on purpose: migration
 * 034 defines a technician as someone with no username and no password hash,
 * so moving in or out of that role creates or destroys a login rather than
 * editing a field. The server rejects it too — this is not just a UI omission.
 */
const ROLE_OPTIONS = [
  { value: "branch", label: "Branch Staff" },
  { value: "head_office", label: "Head Office" },
  { value: "admin", label: "Administrator" },
];

function AdminControlsPage() {
  const { employee: currentUser } = useAuth();

  const [employees, setEmployees] = useState<Employee[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState<Employee | null>(null);
  const [viewingSessions, setViewingSessions] = useState<Employee | null>(null);

  const loadEmployees = async () => {
    try {
      setLoading(true);
      setError("");

      const [employeeResponse, locationResponse] = await Promise.all([
        apiFetch("/api/admin/employees"),
        apiFetch("/api/locations"),
      ]);

      if (!employeeResponse.ok) throw new Error("Could not load employees.");

      const employeeData = await employeeResponse.json();
      setEmployees(employeeData.employees);

      // A failed office list only costs the Office dropdown, so it must not
      // take the whole page down with it.
      if (locationResponse.ok) {
        const locationData = await locationResponse.json();
        setLocations(locationData.locations ?? []);
      }
    } catch (loadError) {
      console.error(loadError);
      setError("Could not load employee accounts.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Authorization is enforced again by the admin-only server endpoints.
    loadEmployees();
  }, []);

  return (
    <div className="p-8">
      <div>
        <h1 className="text-2xl font-semibold text-on-surface">Admin Controls</h1>
        <p className="mt-1 text-sm text-on-surface-variant">
          Manage staff accounts, roles and system access.
        </p>
      </div>

      <div className="mt-8">
        <h2 className="text-lg font-semibold text-on-surface">Employees</h2>

        {loading && (
          <p className="mt-4 text-sm text-on-surface-variant">Loading employees...</p>
        )}

        {error && (
          <div className="mt-4 rounded-lg bg-error/10 p-4 text-sm text-error">{error}</div>
        )}

        {notice && (
          <div className="mt-4 flex items-start justify-between gap-4 rounded-lg bg-tertiary/10 p-4 text-sm text-tertiary">
            <span>{notice}</span>
            <button type="button" onClick={() => setNotice("")} className="font-medium">
              Dismiss
            </button>
          </div>
        )}

        {!loading && !error && (
          <div className="mt-4 overflow-hidden rounded-xl bg-surface-container-lowest shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead className="bg-surface-container-low">
                  <tr>
                    <TableHeading>Employee</TableHeading>
                    <TableHeading>Username</TableHeading>
                    <TableHeading>Role</TableHeading>
                    <TableHeading>Location</TableHeading>
                    <TableHeading>Status</TableHeading>
                    <th className="px-6 py-4" />
                  </tr>
                </thead>

                <tbody>
                  {employees.map((employee) => (
                    <tr
                      key={employee.employee_id}
                      className="border-t border-surface-container"
                    >
                      <td className="px-6 py-4 text-sm font-semibold text-on-surface">
                        {employee.first_name} {employee.last_name}
                        {employee.employee_id === currentUser?.employeeId && (
                          <span className="ml-2 text-xs font-normal text-on-surface-variant">
                            (you)
                          </span>
                        )}
                      </td>

                      {/* Technicians have no username by design, so an empty
                          cell here would read as missing data rather than as
                          the intended state. */}
                      <td className="px-6 py-4 text-sm text-on-surface-variant">
                        {employee.username || "No login"}
                      </td>

                      <td className="px-6 py-4 text-sm text-on-surface-variant">
                        {formatRole(employee.role)}
                      </td>

                      <td className="px-6 py-4 text-sm text-on-surface-variant">
                        {employee.location_name || "—"}
                      </td>

                      <td className="px-6 py-4">
                        <span
                          className={
                            employee.is_active
                              ? "rounded-full bg-tertiary/10 px-3 py-1 text-xs font-medium text-tertiary"
                              : "rounded-full bg-error/10 px-3 py-1 text-xs font-medium text-error"
                          }
                        >
                          {employee.is_active ? "Active" : "Inactive"}
                        </span>
                      </td>

                      <td className="px-6 py-4 text-right">
                        <div className="flex justify-end gap-2">
                          {/* Technicians never sign in, so there is no login
                              history to show and the button would only lead to
                              a permanently empty panel. */}
                          {employee.username && (
                            <button
                              type="button"
                              onClick={() => {
                                setNotice("");
                                setViewingSessions(employee);
                              }}
                              className="rounded-lg bg-surface-container px-4 py-2 text-sm font-medium text-on-surface"
                            >
                              Sessions
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => {
                              setNotice("");
                              setEditing(employee);
                            }}
                            className="rounded-lg bg-surface-container px-4 py-2 text-sm font-medium text-on-surface"
                          >
                            Edit
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {viewingSessions && (
        <SessionHistoryModal
          employee={viewingSessions}
          onClose={() => setViewingSessions(null)}
        />
      )}

      {editing && (
        <EditEmployeeModal
          employee={editing}
          locations={locations}
          isSelf={editing.employee_id === currentUser?.employeeId}
          onClose={() => setEditing(null)}
          onSaved={(message) => {
            setEditing(null);
            setNotice(message);
            loadEmployees();
          }}
        />
      )}
    </div>
  );
}

type LoginSession = {
  login_session_id: number;
  outcome: "success" | "failed";
  failure_reason: string | null;
  username_attempted: string;
  location_name: string | null;
  started_at: string;
  last_seen_at: string | null;
  ended_at: string | null;
  end_reason: "logout" | "expired" | null;
  is_active: boolean;
};

const FAILURE_LABELS: Record<string, string> = {
  unknown_username: "No such username",
  wrong_password: "Wrong password",
  inactive_account: "Account is inactive",
  rate_limited: "Blocked by rate limit",
};

const SESSIONS_PAGE_SIZE = 25;

function SessionHistoryModal({
  employee,
  onClose,
}: {
  employee: Employee;
  onClose: () => void;
}) {
  const [sessions, setSessions] = useState<LoginSession[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");

  const load = async (offset: number) => {
    const response = await apiFetch(
      `/api/admin/employees/${employee.employee_id}/sessions?limit=${SESSIONS_PAGE_SIZE}&offset=${offset}`
    );
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not load login history.");
    return data;
  };

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        setLoading(true);
        setError("");
        const data = await load(0);
        if (!cancelled) {
          setSessions(data.sessions ?? []);
          setTotal(data.total ?? 0);
        }
      } catch (loadError) {
        console.error(loadError);
        if (!cancelled) setError("Could not load login history.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [employee.employee_id]);

  const loadMore = async () => {
    try {
      setLoadingMore(true);
      const data = await load(sessions.length);
      setSessions((current) => [...current, ...(data.sessions ?? [])]);
      setTotal(data.total ?? 0);
    } catch (loadError) {
      console.error(loadError);
      setError("Could not load more history.");
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:items-center">
      <div className="my-4 flex max-h-[calc(100dvh-2rem)] w-full max-w-2xl flex-col rounded-2xl bg-surface-container-lowest shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-surface-container px-6 py-5">
          <div>
            <h3 className="text-lg font-semibold text-on-surface">
              {employee.first_name} {employee.last_name}
            </h3>
            <p className="mt-1 text-sm text-on-surface-variant">
              Sign-ins and failed attempts, newest first
              {total > 0 ? ` · showing ${sessions.length} of ${total}` : ""}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-surface-container px-4 py-2 text-sm font-medium text-on-surface-variant"
          >
            Close
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {loading && <p className="text-sm text-on-surface-variant">Loading...</p>}

          {error && (
            <p className="rounded-lg bg-error/10 p-4 text-sm text-error">{error}</p>
          )}

          {!loading && !error && sessions.length === 0 && (
            <p className="text-sm text-on-surface-variant">
              Nothing recorded yet. History starts from when this was switched on — earlier
              sign-ins were never stored.
            </p>
          )}

          {sessions.length > 0 && (
            <ul className="divide-y divide-surface-container">
              {sessions.map((session) => (
                <li key={session.login_session_id} className="py-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <p className="font-medium text-on-surface">
                      {session.outcome === "failed"
                        ? FAILURE_LABELS[session.failure_reason ?? ""] || "Failed sign-in"
                        : "Signed in"}
                      {session.location_name ? ` · ${session.location_name}` : ""}
                    </p>
                    <time className="shrink-0 text-xs text-on-surface-variant">
                      {formatMoment(session.started_at)}
                    </time>
                  </div>
                  <p className="mt-1 text-sm text-on-surface-variant">
                    {describeSession(session)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>

        {sessions.length < total && (
          <div className="border-t border-surface-container p-4 text-center">
            <button
              type="button"
              onClick={loadMore}
              disabled={loadingMore}
              className="rounded-lg bg-surface-container px-5 py-2.5 text-sm font-medium text-on-surface disabled:opacity-50"
            >
              {loadingMore ? "Loading..." : "Load more"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Says what happened in a sentence, and is careful not to claim more than is
 * known. A session that lapsed has no true end time — only the last moment it
 * was seen being used — so it says that rather than inventing one.
 */
function describeSession(session: LoginSession) {
  if (session.outcome === "failed") {
    return `Attempted as "${session.username_attempted}"`;
  }

  if (session.is_active) {
    return `Still signed in · last active ${formatMoment(session.last_seen_at ?? session.started_at)}`;
  }

  if (session.end_reason === "logout") {
    return `Signed out ${formatMoment(session.ended_at)}`;
  }

  return `No sign-out recorded · last active ${formatMoment(session.last_seen_at ?? session.ended_at)}`;
}

function formatMoment(value: string | null) {
  if (!value) return "unknown";
  return new Date(value).toLocaleString("en-JM", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Jamaica",
  });
}

function EditEmployeeModal({
  employee,
  locations,
  isSelf,
  onClose,
  onSaved,
}: {
  employee: Employee;
  locations: Location[];
  isSelf: boolean;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const isTechnician = employee.role === "technician";

  const [firstName, setFirstName] = useState(employee.first_name);
  const [lastName, setLastName] = useState(employee.last_name);
  const [role, setRole] = useState(employee.role);
  const [locationId, setLocationId] = useState(
    employee.location_id === null ? "" : String(employee.location_id)
  );
  const [isActive, setIsActive] = useState(employee.is_active);
  const [reason, setReason] = useState("");

  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPasswordForm, setShowPasswordForm] = useState(false);

  const [saving, setSaving] = useState(false);
  const [modalError, setModalError] = useState("");

  const save = async (event: React.FormEvent) => {
    event.preventDefault();

    try {
      setSaving(true);
      setModalError("");

      const body: Record<string, unknown> = {
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        isActive,
        locationId: locationId === "" ? null : Number(locationId),
      };

      // Role is only ever sent for someone who can hold one, so a technician's
      // request never reaches the server's rejection path at all.
      if (!isTechnician) body.role = role;
      if (reason.trim()) body.reason = reason.trim();

      const response = await apiFetch(`/api/admin/employees/${employee.employee_id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not save changes.");

      onSaved(
        data.changed === 0
          ? "Nothing changed."
          : `Updated ${data.employee.first_name} ${data.employee.last_name}.`
      );
    } catch (saveError) {
      setModalError(
        saveError instanceof Error ? saveError.message : "Could not save changes."
      );
    } finally {
      setSaving(false);
    }
  };

  const resetPassword = async () => {
    if (newPassword !== confirmPassword) {
      setModalError("The two passwords do not match.");
      return;
    }

    try {
      setSaving(true);
      setModalError("");

      const response = await apiFetch(
        `/api/admin/employees/${employee.employee_id}/reset-password`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            newPassword,
            reason: reason.trim() || undefined,
          }),
        }
      );

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not reset the password.");

      onSaved(data.message);
    } catch (resetError) {
      setModalError(
        resetError instanceof Error
          ? resetError.message
          : "Could not reset the password."
      );
    } finally {
      setSaving(false);
    }
  };

  const inputClass =
    "mt-1.5 w-full rounded-lg border border-outline-variant bg-white px-3 py-2.5 text-sm";

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:items-center">
      <div className="my-4 w-full max-w-lg rounded-2xl bg-surface-container-lowest shadow-2xl">
        <div className="border-b border-surface-container px-6 py-5">
          <h3 className="text-lg font-semibold text-on-surface">
            {employee.first_name} {employee.last_name}
          </h3>
          <p className="mt-1 text-sm text-on-surface-variant">
            {employee.username ? `Username ${employee.username}` : "No login — technician"}
          </p>
        </div>

        <form onSubmit={save} className="space-y-5 px-6 py-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm font-semibold text-on-surface">
              First name
              <input
                value={firstName}
                maxLength={100}
                required
                onChange={(event) => setFirstName(event.target.value)}
                className={inputClass}
              />
            </label>

            <label className="block text-sm font-semibold text-on-surface">
              Last name
              <input
                value={lastName}
                maxLength={100}
                required
                onChange={(event) => setLastName(event.target.value)}
                className={inputClass}
              />
            </label>
          </div>

          <label className="block text-sm font-semibold text-on-surface">
            Role
            <select
              value={isTechnician ? "technician" : role}
              disabled={isTechnician || isSelf}
              onChange={(event) => setRole(event.target.value)}
              className={`${inputClass} disabled:opacity-60`}
            >
              {isTechnician ? (
                <option value="technician">Technician</option>
              ) : (
                ROLE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))
              )}
            </select>
          </label>

          {isTechnician && (
            <p className="-mt-3 text-xs text-on-surface-variant">
              Technicians are assigned work but never log in, so they have no username or
              password and their role cannot be changed here.
            </p>
          )}

          {isSelf && !isTechnician && (
            <p className="-mt-3 text-xs text-on-surface-variant">
              You cannot change your own role. Ask another administrator.
            </p>
          )}

          <label className="block text-sm font-semibold text-on-surface">
            Office
            <select
              value={locationId}
              onChange={(event) => setLocationId(event.target.value)}
              className={inputClass}
            >
              <option value="">No office</option>
              {locations.map((location) => (
                <option key={location.location_id} value={location.location_id}>
                  {location.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex items-start gap-3 text-sm font-semibold text-on-surface">
            <input
              type="checkbox"
              checked={isActive}
              disabled={isSelf}
              onChange={(event) => setIsActive(event.target.checked)}
              className="mt-0.5 size-4 disabled:opacity-60"
            />
            <span>
              Active
              <span className="mt-0.5 block text-xs font-normal text-on-surface-variant">
                {isSelf
                  ? "You cannot deactivate yourself."
                  : "Inactive staff cannot log in and drop out of the technician list. Their history stays on old tickets and payments."}
              </span>
            </span>
          </label>

          <label className="block text-sm font-semibold text-on-surface">
            Reason (optional)
            <input
              value={reason}
              maxLength={500}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Recorded in the activity trail"
              className={inputClass}
            />
          </label>

          {modalError && (
            <p className="rounded-lg bg-error/10 p-3 text-sm text-error">{modalError}</p>
          )}

          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <button
              type="button"
              disabled={saving}
              onClick={onClose}
              className="rounded-lg bg-surface-container px-4 py-2.5 text-sm font-medium text-on-surface-variant"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || !firstName.trim() || !lastName.trim()}
              className="rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-on-primary disabled:opacity-50"
            >
              {saving ? "Saving..." : "Save changes"}
            </button>
          </div>
        </form>

        {/* Only offered to people who actually have a login to reset. */}
        {employee.username && (
          <div className="border-t border-surface-container px-6 py-5">
            {!showPasswordForm ? (
              <button
                type="button"
                onClick={() => setShowPasswordForm(true)}
                className="text-sm font-medium text-primary"
              >
                Reset password
              </button>
            ) : (
              <div className="space-y-4">
                <div>
                  <h4 className="font-semibold text-on-surface">Reset password</h4>
                  <p className="mt-1 text-sm text-on-surface-variant">
                    You choose it and hand it over directly. It is never shown again
                    afterwards, and never written to the activity trail.
                  </p>
                </div>

                <label className="block text-sm font-semibold text-on-surface">
                  New password
                  <input
                    type="text"
                    value={newPassword}
                    onChange={(event) => setNewPassword(event.target.value)}
                    placeholder="At least 12 characters"
                    className={inputClass}
                  />
                </label>

                <label className="block text-sm font-semibold text-on-surface">
                  Confirm
                  <input
                    type="text"
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    className={inputClass}
                  />
                </label>

                <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => {
                      setShowPasswordForm(false);
                      setNewPassword("");
                      setConfirmPassword("");
                      setModalError("");
                    }}
                    className="rounded-lg bg-surface-container px-4 py-2.5 text-sm font-medium text-on-surface-variant"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={saving || newPassword.length < 12 || !confirmPassword}
                    onClick={resetPassword}
                    className="rounded-lg bg-error px-5 py-2.5 text-sm font-medium text-white disabled:opacity-50"
                  >
                    {saving ? "Resetting..." : "Reset password"}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function TableHeading({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-6 py-4 text-xs font-semibold uppercase tracking-wider text-on-surface-variant">
      {children}
    </th>
  );
}

/**
 * The old version fell through to "Branch Staff" for anything it did not
 * recognise, which is why technicians appeared as branch staff after migration
 * 034 added the role. Unknown roles now show their raw value rather than being
 * quietly relabelled as something they are not.
 */
function formatRole(role: string) {
  if (role === "admin") return "Administrator";
  if (role === "head_office") return "Head Office";
  if (role === "branch") return "Branch Staff";
  if (role === "technician") return "Technician";
  return role;
}

export default AdminControlsPage;
