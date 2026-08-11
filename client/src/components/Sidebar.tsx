function Sidebar() {
  return (
    <aside className="fixed left-0 top-0 z-50 flex h-screen w-72 flex-col bg-sidebar px-4 pb-8 pt-8">
      <div className="mb-10 px-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary">
            <span className="material-symbols-outlined text-on-primary">
              account_balance_wallet
            </span>
          </div>

          <span className="text-xl font-bold tracking-tight text-sidebar-text">
            FYWY Management
          </span>
        </div>
      </div>

      <nav className="flex flex-1 flex-col gap-1">
        <button
          type="button"
          className="flex items-center rounded-xl px-6 py-3.5 text-left text-sm text-sidebar-text/70 transition hover:bg-white/10 hover:text-sidebar-text"
        >
          <span className="material-symbols-outlined mr-4">
            dashboard
          </span>
          Dashboard
        </button>

        <button
          type="button"
          className="flex items-center rounded-xl bg-primary px-6 py-3.5 text-left text-sm font-bold text-on-primary"
        >
          <span className="material-symbols-outlined mr-4">
            group
          </span>
          Customers
        </button>

        <button
          type="button"
          className="flex items-center rounded-xl px-6 py-3.5 text-left text-sm text-sidebar-text/70 transition hover:bg-white/10 hover:text-sidebar-text"
        >
          <span className="material-symbols-outlined mr-4">
            analytics
          </span>
          Analytics
        </button>

        <button
          type="button"
          className="flex items-center rounded-xl px-6 py-3.5 text-left text-sm text-sidebar-text/70 transition hover:bg-white/10 hover:text-sidebar-text"
        >
          <span className="material-symbols-outlined mr-4">
            settings
          </span>
          Settings
        </button>
      </nav>
    </aside>
  );
}

export default Sidebar;