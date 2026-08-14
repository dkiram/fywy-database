import { useState } from "react";
import { useNavigate } from "react-router";

function LoginPage() {
const navigate = useNavigate();

const [username, setUsername] = useState("");
const [password, setPassword] = useState("");
const [showPassword, setShowPassword] = useState(false);

const [loading, setLoading] = useState(false);
const [error, setError] = useState("");

const handleLogin = async (
  event: React.FormEvent<HTMLFormElement>
) => {
  event.preventDefault();

  try {
    setLoading(true);
    setError("");

    const response = await fetch(
      "http://localhost:3000/api/auth/login",
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
        },

        credentials: "include",

        body: JSON.stringify({
          username,
          password,
        }),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        data.error || "Could not log in."
      );
    }

    navigate("/customers");
  } catch (error) {
    if (error instanceof Error) {
      setError(error.message);
    } else {
      setError("Could not log in.");
    }
  } finally {
    setLoading(false);
  }
};

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
  type="text"
  value={username}
  onChange={(event) =>
    setUsername(event.target.value)
  }
  autoComplete="username"
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
  type={showPassword ? "text" : "password"}
  value={password}
  onChange={(event) =>
    setPassword(event.target.value)
  }
  autoComplete="current-password"
/>

{error && (
  <div className="rounded-lg bg-error/10 px-4 py-3 text-sm text-error">
    {error}
  </div>
)}

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
  disabled={loading}
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-primary py-3 text-sm font-medium text-on-primary shadow-sm transition hover:bg-tertiary active:scale-[0.98]"
            >
               {loading ? "Signing in..." : "Sign In"}

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