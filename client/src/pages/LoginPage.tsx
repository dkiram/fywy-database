/** Authenticates employees through the branded public entry screen. */
import { useState } from "react";
import { useNavigate } from "react-router";
import loginArtwork from "../assets/login-green-art.jpg";
import { useAuth } from "../auth/AuthContext";

function LoginPage() {
  const navigate = useNavigate();
  const { login, sessionExpired } = useAuth();

  // Form and request state remain local because no other screen needs credentials.
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleLogin = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    try {
      // AuthContext sends the credentials and updates the shared employee session.
      setLoading(true);
      setError("");
      await login(username, password);
      navigate("/customers");
    } catch (loginError) {
      setError(
        loginError instanceof Error ? loginError.message : "Could not log in."
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative min-h-screen overflow-hidden bg-sidebar px-4 py-6 text-on-surface sm:px-6 lg:flex lg:items-center lg:px-10 lg:py-10">
      <div aria-hidden="true" className="pointer-events-none absolute -left-44 -top-44 h-96 w-96 rounded-full bg-primary/20 blur-3xl" />
      <div aria-hidden="true" className="pointer-events-none absolute -bottom-56 right-0 h-[32rem] w-[32rem] rounded-full bg-[#173d43]/55 blur-3xl" />

      <main className="relative mx-auto grid w-full max-w-6xl overflow-hidden rounded-[2rem] border border-white/10 bg-[#102336] p-2 shadow-[0_32px_90px_rgba(0,0,0,0.42)] sm:p-3 lg:grid-cols-[minmax(0,1.18fr)_minmax(390px,0.82fr)]">
        {/* Brand artwork becomes a compact banner above the form on smaller screens. */}
        <section className="relative min-h-56 overflow-hidden rounded-[1.45rem] sm:min-h-72 lg:min-h-[680px]">
          <img
            src={loginArtwork}
            alt="Abstract green layered forms"
            className="absolute inset-0 h-full w-full object-cover"
          />
          <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(4,18,22,0.08)_20%,rgba(4,18,22,0.84)_100%)]" />

          <div className="relative flex h-full min-h-56 flex-col justify-between p-6 text-white sm:min-h-72 sm:p-8 lg:min-h-[680px] lg:p-10">
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-white/20 bg-white/10 shadow-lg backdrop-blur-md">
                <span className="material-symbols-outlined text-2xl" aria-hidden="true">
                  connected_tv
                </span>
              </div>
              <div>
                <p className="text-lg font-medium tracking-tight">FYWY</p>
                <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-white/65">
                  Management System
                </p>
              </div>
            </div>

            <div className="max-w-md">
              <p className="mb-4 hidden w-fit rounded-full border border-white/15 bg-white/10 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.2em] text-white/80 backdrop-blur-md sm:block">
                Employee workspace
              </p>
              <h1 className="max-w-sm text-2xl font-semibold leading-tight tracking-[-0.03em] sm:text-4xl lg:text-[2.7rem]">
                Every customer connection, all in one place.
              </h1>
              <p className="mt-4 hidden max-w-sm text-sm leading-6 text-white/70 sm:block">
                Securely manage customer accounts, payments, applications, and daily operations.
              </p>
            </div>
          </div>
        </section>

        {/* The white card contains the only interactive controls on the public page. */}
        <section className="flex items-center justify-center px-3 py-4 sm:px-8 sm:py-8 lg:px-10 lg:py-12">
          <div className="w-full max-w-[430px] rounded-[1.6rem] bg-white p-6 shadow-[0_24px_65px_rgba(0,0,0,0.28)] sm:p-9 lg:p-10">
            <div className="mb-8">
              <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <span className="material-symbols-outlined text-2xl" aria-hidden="true">
                  shield_person
                </span>
              </div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
                Secure employee access
              </p>
              <h2 className="mt-2 text-3xl font-semibold tracking-[-0.035em] text-on-surface">
                Welcome back
              </h2>
              <p className="mt-2 text-sm leading-6 text-on-surface-variant">
                Sign in with your employee credentials to continue.
              </p>
            </div>

            <form onSubmit={handleLogin} className="space-y-5">
              <div>
                <label htmlFor="username" className="mb-2 block text-sm font-semibold text-on-surface">
                  Username
                </label>
                <div className="group relative">
                  <span className="material-symbols-outlined pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-xl text-outline transition group-focus-within:text-primary" aria-hidden="true">
                    person
                  </span>
                  <input
                    id="username"
                    type="text"
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    autoComplete="username"
                    required
                    placeholder="Enter your username"
                    className="h-12 w-full rounded-xl border border-outline-variant bg-surface px-4 pl-12 text-sm text-on-surface transition placeholder:text-outline focus:border-primary focus:bg-white"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="password" className="mb-2 block text-sm font-semibold text-on-surface">
                  Password
                </label>
                <div className="group relative">
                  <span className="material-symbols-outlined pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-xl text-outline transition group-focus-within:text-primary" aria-hidden="true">
                    lock
                  </span>
                  <input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    autoComplete="current-password"
                    required
                    placeholder="Enter your password"
                    className="h-12 w-full rounded-xl border border-outline-variant bg-surface px-12 text-sm text-on-surface transition placeholder:text-outline focus:border-primary focus:bg-white"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((visible) => !visible)}
                    className="absolute right-2.5 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-lg text-on-surface-variant transition hover:bg-surface-container hover:text-on-surface"
                    aria-label={showPassword ? "Hide password" : "Show password"}
                  >
                    <span className="material-symbols-outlined text-xl" aria-hidden="true">
                      {showPassword ? "visibility" : "visibility_off"}
                    </span>
                  </button>
                </div>
              </div>

              <div className="flex items-center justify-between gap-4">
                <label className="flex cursor-pointer items-center gap-2.5 text-sm text-on-surface-variant">
                  <input
                    type="checkbox"
                    checked={rememberMe}
                    onChange={(event) => setRememberMe(event.target.checked)}
                    className="h-4 w-4 rounded accent-primary"
                  />
                  Remember me
                </label>
                <button type="button" disabled title="Coming later" className="cursor-not-allowed text-sm font-semibold text-primary opacity-55">
                  Forgot password?
                </button>
              </div>

              {/* Shown instead of nothing when the hour lapsed with the tab
                  open, so being bounced to this screen has an explanation. A
                  real sign-in error takes precedence over it. */}
              {sessionExpired && !error && (
                <div role="status" className="flex items-start gap-2.5 rounded-xl border border-white/15 bg-white/8 px-4 py-3 text-sm text-white/85">
                  <span className="material-symbols-outlined mt-0.5 text-lg" aria-hidden="true">
                    schedule
                  </span>
                  <span>You were signed out after an hour of inactivity. Please sign in again.</span>
                </div>
              )}

              {error && (
                <div role="alert" className="flex items-start gap-2.5 rounded-xl border border-error/15 bg-error/8 px-4 py-3 text-sm text-error">
                  <span className="material-symbols-outlined mt-0.5 text-lg" aria-hidden="true">
                    error
                  </span>
                  <span>{error}</span>
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary px-5 text-sm font-medium text-on-primary shadow-[0_10px_24px_rgba(65,98,95,0.26)] transition hover:-translate-y-0.5 hover:bg-primary-container hover:shadow-[0_14px_28px_rgba(65,98,95,0.3)] active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {loading ? "Signing in..." : "Sign in"}
                {!loading && (
                  <span className="material-symbols-outlined text-lg" aria-hidden="true">
                    arrow_forward
                  </span>
                )}
              </button>
            </form>

            <div className="mt-8 flex items-center justify-center gap-2 border-t border-surface-container pt-5 text-xs text-on-surface-variant">
              <span className="material-symbols-outlined text-base text-primary" aria-hidden="true">
                lock
              </span>
              Authorized employees only
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

export default LoginPage;
