import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api";

type Employee = {
  employee_id: number;
  first_name: string;
  last_name: string;
  username: string;
  role: string;
  is_active: boolean;
  last_login_at: string | null;
  location_name: string | null;
};

function AdminControlsPage() {
  const [employees, setEmployees] = useState<
    Employee[]
  >([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const loadEmployees = async () => {
      try {
        setLoading(true);
        setError("");

        const response = await apiFetch(
          "/api/admin/employees"
        );

        if (!response.ok) {
          throw new Error(
            "Could not load employees."
          );
        }

        const data = await response.json();

        setEmployees(data.employees);
      } catch (error) {
        console.error(error);

        setError(
          "Could not load employee accounts."
        );
      } finally {
        setLoading(false);
      }
    };

    loadEmployees();
  }, []);

  return (
    <div className="p-8">
      <div>
        <h1 className="text-2xl font-bold text-on-surface">
          Admin Controls
        </h1>

        <p className="mt-1 text-sm text-on-surface-variant">
          Manage staff accounts, roles and system
          access.
        </p>
      </div>

      <div className="mt-8">
        <h2 className="text-lg font-bold text-on-surface">
          Employees
        </h2>

        {loading && (
          <p className="mt-4 text-sm text-on-surface-variant">
            Loading employees...
          </p>
        )}

        {error && (
          <div className="mt-4 rounded-lg bg-error/10 p-4 text-sm text-error">
            {error}
          </div>
        )}

        {!loading && !error && (
          <div className="mt-4 overflow-hidden rounded-xl bg-surface-container-lowest shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead className="bg-surface-container-low">
                  <tr>
                    <TableHeading>
                      Employee
                    </TableHeading>

                    <TableHeading>
                      Username
                    </TableHeading>

                    <TableHeading>
                      Role
                    </TableHeading>

                    <TableHeading>
                      Location
                    </TableHeading>

                    <TableHeading>
                      Status
                    </TableHeading>
                  </tr>
                </thead>

                <tbody>
                  {employees.map((employee) => (
                    <tr
                      key={employee.employee_id}
                      className="border-t border-surface-container"
                    >
                      <td className="px-6 py-4 text-sm font-semibold text-on-surface">
                        {employee.first_name}{" "}
                        {employee.last_name}
                      </td>

                      <td className="px-6 py-4 text-sm text-on-surface-variant">
                        {employee.username}
                      </td>

                      <td className="px-6 py-4 text-sm text-on-surface-variant">
                        {formatRole(
                          employee.role
                        )}
                      </td>

                      <td className="px-6 py-4 text-sm text-on-surface-variant">
                        {employee.location_name ||
                          "—"}
                      </td>

                      <td className="px-6 py-4">
                        <span
                          className={
                            employee.is_active
                              ? "rounded-full bg-tertiary/10 px-3 py-1 text-xs font-bold text-tertiary"
                              : "rounded-full bg-error/10 px-3 py-1 text-xs font-bold text-error"
                          }
                        >
                          {employee.is_active
                            ? "Active"
                            : "Inactive"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function TableHeading({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <th className="px-6 py-4 text-xs font-bold uppercase tracking-wider text-on-surface-variant">
      {children}
    </th>
  );
}

function formatRole(role: string) {
  if (role === "admin") {
    return "Administrator";
  }

  if (role === "head_office") {
    return "Head Office";
  }

  return "Branch Staff";
}

export default AdminControlsPage;