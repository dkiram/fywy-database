import { NavLink } from "react-router";
import { useAuth } from "../auth/AuthContext";

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
          "flex items-center gap-3 rounded-lg px-4 py-2.5 text-sm transition",
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

function Sidebar() {
  const { employee } = useAuth();
  
  return (
    <aside className="fixed inset-y-0 left-0 z-40 flex w-72 flex-col bg-sidebar text-sidebar-text">
      {/* Brand */}
      <div className="px-6 py-6">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-sidebar-text/50">
          FYWY
        </p>

        <h1 className="mt-1 text-lg font-bold">
          Management
        </h1>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-4 pb-6">
        <NavSection title="Main">
          <NavItem
            to="/dashboard"
            icon="dashboard"
            label="Dashboard"
          />

          <NavItem
            to="/customers"
            icon="group"
            label="Customers"
          />
        </NavSection>

        <NavSection title="Operations">
          <NavItem
            to="/applications"
            icon="description"
            label="Applications"
          />

          <NavItem
            to="/service-requests"
            icon="build"
            label="Service Requests"
          />

          <NavItem
            to="/pole-boxes"
            icon="dns"
            label="Pole Boxes"
          />
        </NavSection>

        <NavSection title="Reporting">
          <NavItem
            to="/reports"
            icon="analytics"
            label="Reports & Analytics"
          />

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
      <p className="mb-2 px-4 text-[11px] font-bold uppercase tracking-widest text-sidebar-text/40">
        {title}
      </p>

      <div className="space-y-1">
        {children}
      </div>
    </div>
  );
}

export default Sidebar;
