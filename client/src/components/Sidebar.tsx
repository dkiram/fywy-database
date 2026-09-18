/** Defines the main navigation and hides administrator-only links from other roles. */
import { useEffect } from "react";
import { NavLink } from "react-router";
import { useAuth } from "../auth/AuthContext";

type SidebarProps = {
  /** Drawer state below the lg breakpoint; ignored once the sidebar is pinned. */
  open: boolean;
  onClose: () => void;
};

type NavItemProps = {
  to: string;
  icon: string;
  label: string;
};

function NavItem({ to, icon, label }: NavItemProps) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        [
          "flex items-center gap-3 rounded-lg px-4 py-3 text-sm transition lg:py-2.5",
          isActive
            ? "bg-primary font-semibold text-on-primary"
            : "text-sidebar-text/70 hover:bg-white/5 hover:text-white",
        ].join(" ")
      }
    >
      <span className="material-symbols-outlined text-xl">
        {icon}
      </span>

      <span>{label}</span>
    </NavLink>
  );
}

function Sidebar({ open, onClose }: SidebarProps) {
  const { employee } = useAuth();
  // Branch staff have a deliberately small workspace; broader operations stay with managers.
  const isBranchStaff = employee?.role === "branch";
  const isAdmin = employee?.role === "admin";

  // Escape closes the drawer, matching every other overlay in the app.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <>
      {/* Backdrop — phone/tablet only, and only while the drawer is out. */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/45 lg:hidden"
          onClick={onClose}
          role="presentation"
        />
      )}

    <aside
      className={[
        "fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col bg-sidebar text-sidebar-text",
        "transition-transform duration-200 ease-out motion-reduce:transition-none",
        "lg:max-w-none lg:translate-x-0",
        open ? "translate-x-0 shadow-2xl" : "-translate-x-full",
      ].join(" ")}
      aria-label="Main navigation"
    >
      {/* Brand */}
      <div className="flex items-start justify-between px-6 pb-5 pt-[calc(1.25rem+var(--safe-top))] lg:pb-6 lg:pt-[calc(1.5rem+var(--safe-top))]">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-sidebar-text/50">
            FYWY
          </p>

          <h1 className="mt-1 text-lg font-semibold">
            Management
          </h1>
        </div>

        <button
          type="button"
          onClick={onClose}
          aria-label="Close navigation"
          className="-mr-2 -mt-1 rounded-full p-2 text-sidebar-text/70 transition hover:bg-white/10 hover:text-white lg:hidden"
        >
          <span className="material-symbols-outlined">close</span>
        </button>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-4 pb-[calc(1.5rem+var(--safe-bottom))]">
        <NavSection title="Main">
          {isAdmin && (
            <NavItem
              to="/dashboard"
              icon="dashboard"
              label="Dashboard"
            />
          )}

          <NavItem
            to="/customers"
            icon="group"
            label="Customers"
          />
        </NavSection>

        <NavSection title="Operations">
          {isAdmin && (
            <NavItem
              to="/payments"
              icon="payments"
              label="Daily Payments"
            />
          )}

          <NavItem
            to="/applications"
            icon="description"
            label="Applications"
          />

          {!isBranchStaff && (
            <NavItem
              to="/account-operations"
              icon="manage_accounts"
              label="Account Operations"
            />
          )}

          <NavItem
            to="/service-requests"
            icon="build"
            label="Service Tickets"
          />

          {!isBranchStaff && (
            <NavItem
              to="/pole-boxes"
              icon="dns"
              label="Pole Boxes"
            />
          )}
        </NavSection>

        <NavSection title="Reporting">
          {!isBranchStaff && (
            <NavItem
              to="/reports"
              icon="analytics"
              label="Reports & Analytics"
            />
          )}

          <NavItem
            to="/activity-history"
            icon="history"
            label="Activity History"
          />
        </NavSection>

        <NavSection title="Administration">
          {employee?.role === "admin" && (
  <NavItem
    to="/admin"
    icon="admin_panel_settings"
    label="Admin Controls"
  />
)}

          <NavItem
            to="/settings"
            icon="settings"
            label="Settings"
          />
        </NavSection>
      </nav>
    </aside>
    </>
  );
}

type NavSectionProps = {
  title: string;
  children: React.ReactNode;
};

function NavSection({
  title,
  children,
}: NavSectionProps) {
  return (
    <div className="mb-7">
      <p className="mb-2 px-4 text-[11px] font-semibold uppercase tracking-widest text-sidebar-text/40">
        {title}
      </p>

      <div className="space-y-1">
        {children}
      </div>
    </div>
  );
}

export default Sidebar;
