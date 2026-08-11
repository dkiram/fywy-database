import type { ReactNode } from "react";
import Sidebar from "./Sidebar";
import Header from "./Header";

type AppLayoutProps = {
  children: ReactNode;
};

function AppLayout({ children }: AppLayoutProps) {
  return (
    <div className="min-h-screen bg-surface text-on-surface">
      <Sidebar />

      <div className="pl-72">
        <Header />

        <main className="min-h-screen pt-20">
          {children}
        </main>
      </div>
    </div>
  );
}

export default AppLayout;