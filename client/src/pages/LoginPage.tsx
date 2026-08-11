import { useState } from "react";
import { useNavigate } from "react-router";

function LoginPage() {
  const navigate = useNavigate();
  const [showPassword, setShowPassword] = useState(false);

  function handleLogin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    // Fake login for now.
    navigate("/customers");
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-surface p-6 text-on-surface">
      {/* App title */}
      <div className="mb-8 flex flex-col items-center gap-4">
        <h1 className="text-2xl font-semibold tracking-tight text-primary">
          FYWY Management App
        </h1>
      </div>

      {/* Login card */}
      <main className="w-full max-w-[440px]">
        <div className="w-full rounded-xl bg-surface-container-lowest p-8 shadow-xl">
          {/* Logo / heading */}
          <div className="mb-6 flex flex-col items-center gap-3">
            <div className="flex h-16 w-16 items-center justify-center rounded-xl bg-primary">
              <span className="material-symbols-outlined text-3xl text-on-primary">
                account_balance_wallet
              </span>
            </div>

            <h2 className="text-2xl font-semibold tracking-tight">
              Welcome back
            </h2>

            <p className="text-center text-sm text-on-surface-variant">
              Please enter your details to sign in.
            </p>
          </div>

          <form
            onSubmit={handleLogin}
            className="flex flex-col gap-5"
          >
            {/* Email */}
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="email"
                className="text-sm font-medium"
              >
                Email
              </label>

              <div className="relative">
                <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-xl text-on-surface-variant/50">
                  mail
                </span>

                <input
                  id="email"
                  type="email"
                  placeholder="name@company.com"
                  className="w-full rounded-lg bg-surface-container-low py-2.5 pl-10 pr-4 text-sm outline-none transition placeholder:text-on-surface-variant/50 focus:ring-2 focus:ring-primary/20"
                />
              </div>
            </div>

            {/* Password */}
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="password"
                className="text-sm font-medium"
              >
                Password
              </label>

              <div className="relative">
                <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-xl text-on-surface-variant/50">
                  lock
                </span>

                <input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  placeholder="••••••••"
                  className="w-full rounded-lg bg-surface-container-low py-2.5 pl-10 pr-11 text-sm outline-none transition placeholder:text-on-surface-variant/50 focus:ring-2 focus:ring-primary/20"
                />

                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-on-surface-variant/50 transition hover:text-on-surface"
                >
                  <span className="material-symbols-outlined text-xl">
                    {showPassword
                      ? "visibility"
                      : "visibility_off"}
                  </span>
                </button>
              </div>
            </div>

            {/* Remember me / forgot */}
            <div className="flex items-center justify-between">
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-primary"
                />

                <span className="text-sm text-on-surface-variant">
                  Remember me
                </span>
              </label>

              <button
                type="button"
                disabled
                title="Coming later"
                className="cursor-not-allowed text-sm font-medium text-primary opacity-60"
              >
                Forgot password?
              </button>
            </div>

            {/* Fake sign in */}
            <button
              type="submit"
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-primary py-3 text-sm font-medium text-on-primary shadow-sm transition hover:bg-tertiary active:scale-[0.98]"
            >
              Sign In

              <span className="material-symbols-outlined text-lg">
                arrow_forward
              </span>
            </button>
          </form>
        </div>
      </main>

      <div className="mt-12 flex gap-6 text-sm text-on-surface-variant">
        <button
          type="button"
          disabled
          className="cursor-not-allowed opacity-60"
        >
          Privacy Policy
        </button>

        <button
          type="button"
          disabled
          className="cursor-not-allowed opacity-60"
        >
          Terms
        </button>
      </div>
    </div>
  );
}

export default LoginPage;