/** Displays session actions, notifications affordance, and signed-in employee identity. */
import { useAuth } from "../auth/AuthContext";
import { useNavigate } from "react-router";


function Header() {

const { employee, logout } = useAuth();
const navigate = useNavigate();

const employeeInitials = employee
  ? `${employee.firstName.trim().charAt(0)}${employee.lastName
      .trim()
      .charAt(0)}`.toUpperCase()
  : "?";

  return (
<header className="fixed left-72 right-0 top-0 z-40 flex h-20 items-center justify-end bg-surface/90 px-8 shadow-sm backdrop-blur-xl">

<button
  type="button"
  onClick={async () => {
    await logout();
    navigate("/");
  }}
  className="text-sm text-on-surface-variant hover:text-on-surface"
>
  Logout
</button>

      <div className="flex items-center gap-6">
        <button
          type="button"
          className="relative rounded-full p-2 transition hover:bg-surface-container-high"
        >
          <span className="material-symbols-outlined text-on-surface-variant">
            notifications
          </span>

          <span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-error" />
        </button>

        <div className="flex items-center gap-3 border-l border-outline-variant pl-4">
          <div className="text-right">
            <p className="text-sm font-semibold text-on-surface">
  {employee
    ? `${employee.firstName} ${employee.lastName}`
    : "—"}
</p>

<p className="text-xs text-on-surface-variant">
  {employee?.role === "admin"
    ? "Administrator"
    : employee?.role === "head_office"
      ? "Head Office"
      : "Branch Staff"}
</p>
          </div>

          <div
            className="flex h-10 w-10 items-center justify-center rounded-full bg-primary"
            aria-label={employee ? `${employee.firstName} ${employee.lastName}` : "Employee"}
          >
            <span className="text-sm font-bold tracking-wide text-on-primary">
              {employeeInitials}
            </span>
          </div>
        </div>
      </div>
    </header>
  );
}

export default Header;
