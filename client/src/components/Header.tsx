/** Displays session actions, notifications affordance, and signed-in employee identity. */
import { useAuth } from "../auth/AuthContext";
import { useNavigate } from "react-router";

type HeaderProps = {
  notificationCount?: number;
  /** Opens the navigation drawer; the button only renders below lg. */
  onMenuClick?: () => void;
};

function Header({ notificationCount = 0, onMenuClick }: HeaderProps) {

const { employee, logout } = useAuth();
const navigate = useNavigate();

const employeeInitials = employee
  ? `${employee.firstName.trim().charAt(0)}${employee.lastName
      .trim()
      .charAt(0)}`.toUpperCase()
  : "?";

const roleLabel =
  employee?.role === "admin"
    ? "Administrator"
    : employee?.role === "head_office"
      ? "Head Office"
      : "Branch Staff";

  return (
<header className="fixed left-0 right-0 top-0 z-30 flex h-16 items-center justify-between bg-surface/90 px-4 shadow-sm backdrop-blur-xl sm:px-6 lg:left-72 lg:h-20 lg:justify-end lg:px-8">

      {/* Menu + brand, phone/tablet only. The brand sits here because the
          sidebar (which normally carries it) is off-screen. */}
      <div className="flex items-center gap-2 lg:hidden">
        <button
          type="button"
          onClick={onMenuClick}
          aria-label="Open navigation"
          className="-ml-2 rounded-full p-2 text-on-surface-variant transition hover:bg-surface-container-high"
        >
          <span className="material-symbols-outlined">menu</span>
        </button>

        <p className="text-sm font-semibold tracking-wide text-on-surface">
          FYWY
        </p>
      </div>

      <div className="flex items-center gap-3 sm:gap-6">
        <button
          type="button"
          aria-label={
            notificationCount > 0
              ? `Notifications, ${notificationCount} unread`
              : "Notifications"
          }
          className="relative rounded-full p-2 transition hover:bg-surface-container-high"
        >
          <span className="material-symbols-outlined text-on-surface-variant">
            notifications
          </span>

          {notificationCount > 0 && (
            <span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-error" />
          )}
        </button>

        <div className="flex items-center gap-3 border-l border-outline-variant pl-3 sm:pl-4">
          <div className="hidden text-right sm:block">
            <p className="text-sm font-semibold text-on-surface">
  {employee
    ? `${employee.firstName} ${employee.lastName}`
    : "—"}
</p>

<p className="text-xs text-on-surface-variant">
  {roleLabel}
</p>
          </div>

          <div
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary lg:h-10 lg:w-10"
            aria-label={employee ? `${employee.firstName} ${employee.lastName}` : "Employee"}
            title={employee ? `${employee.firstName} ${employee.lastName} · ${roleLabel}` : undefined}
          >
            <span className="text-sm font-medium tracking-wide text-on-primary">
              {employeeInitials}
            </span>
          </div>

          <button
            type="button"
            onClick={async () => {
              await logout();
              navigate("/");
            }}
            className="ml-1 text-sm text-on-surface-variant hover:text-on-surface"
          >
            Logout
          </button>
        </div>
      </div>
    </header>
  );
}

export default Header;
