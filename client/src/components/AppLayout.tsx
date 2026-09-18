/** Provides the persistent sidebar/header frame used by every authenticated page. */
import { useEffect, useState, type ReactNode } from "react";
import { useLocation } from "react-router";
import Sidebar from "./Sidebar";
import Header from "./Header";

type AppLayoutProps = {
  children: ReactNode;
};

function AppLayout({ children }: AppLayoutProps) {
  // Below the lg breakpoint the sidebar is an off-canvas drawer opened from
  // the header's menu button; at lg and up it is always pinned and this state
  // is ignored. Navigating closes the drawer so a tap on a link lands on the
  // page rather than on the still-open menu.
  const [navOpen, setNavOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    setNavOpen(false);
  }, [location.pathname]);

  return (
    <div className="min-h-screen bg-surface text-on-surface">
      <Sidebar open={navOpen} onClose={() => setNavOpen(false)} />

      <div className="lg:pl-72">
        <Header onMenuClick={() => setNavOpen(true)} />

        <main className="min-h-screen pt-16 lg:pt-20">
          {children}
        </main>
      </div>
    </div>
  );
}

export default AppLayout;
