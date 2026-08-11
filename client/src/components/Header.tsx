function Header() {
  return (
    <header className="fixed left-72 right-0 top-0 z-40 flex h-20 items-center justify-between bg-surface/90 px-8 shadow-sm backdrop-blur-xl">
      <div className="relative w-96">
        <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-outline">
          search
        </span>

        <input
          type="text"
          placeholder="Search records..."
          className="w-full rounded-xl bg-surface-container-low py-2.5 pl-12 pr-4 text-sm text-on-surface outline-none transition focus:ring-2 focus:ring-primary/20"
        />
      </div>

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
            <div className="text-sm font-bold text-on-surface">
              Alex Rivers
            </div>

            <div className="mt-1 text-xs text-on-surface-variant">
              Administrator
            </div>
          </div>

          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary">
            <span className="material-symbols-outlined text-on-primary">
              person
            </span>
          </div>
        </div>
      </div>
    </header>
  );
}

export default Header;