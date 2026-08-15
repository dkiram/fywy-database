/** Guards private routes and optionally limits a screen to specific employee roles. */
import { Navigate } from "react-router";

import {
  useAuth,
  type EmployeeRole,
} from "./AuthContext";

type ProtectedRouteProps = {
  children: React.ReactNode;
  allowedRoles?: EmployeeRole[];
};

function ProtectedRoute({
  children,
  allowedRoles,
}: ProtectedRouteProps) {
  const { employee, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface">
        <p className="text-sm text-on-surface-variant">
          Loading...
        </p>
      </div>
    );
  }

  if (!employee) {
    return <Navigate to="/" replace />;
  }

  if (
    allowedRoles &&
    !allowedRoles.includes(employee.role)
  ) {
    return (
      <Navigate
        to="/customers"
        replace
      />
    );
  }

  return children;
}

export default ProtectedRoute;
