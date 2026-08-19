/** Keeps the signed-in employee available across the app and owns login/logout requests. */
import {
  createContext,
  useContext,
  useEffect,
  useState,
} from "react";

import { apiFetch, setUnauthorizedHandler } from "../lib/api";

export type EmployeeRole =
  | "admin"
  | "head_office"
  | "branch";

export type Employee = {
  employeeId: number;
  firstName: string;
  lastName: string;
  username: string;
  role: EmployeeRole;
  locationId: number | null;
  locationName: string | null;
};

type AuthContextType = {
  employee: Employee | null;
  loading: boolean;

  /** True when the last sign-out was the idle timeout rather than a click. */
  sessionExpired: boolean;

  login: (
    username: string,
    password: string
  ) => Promise<void>;

  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextType | null>(
  null
);

type AuthProviderProps = {
  children: React.ReactNode;
};

export function AuthProvider({
  children,
}: AuthProviderProps) {
  // `loading` prevents protected routes from redirecting before session restore finishes.
  const [employee, setEmployee] =
    useState<Employee | null>(null);

  const [loading, setLoading] = useState(true);
  const [sessionExpired, setSessionExpired] = useState(false);

  // Any 401 from a normal endpoint means the hour lapsed while this tab sat
  // open. Clearing the employee is what sends ProtectedRoute back to login;
  // the flag is what lets the login screen say why.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setEmployee((current) => {
        if (current) setSessionExpired(true);
        return null;
      });
    });

    return () => setUnauthorizedHandler(null);
  }, []);

  useEffect(() => {
    // Ask the server whether its HTTP-only session cookie still identifies an employee.
    const checkSession = async () => {
      try {
        const response = await apiFetch("/api/auth/me");

        if (!response.ok) {
          setEmployee(null);
          return;
        }

        const data = await response.json();

        setEmployee(data.employee);
      } catch (error) {
        console.error(
          "Could not check login session:",
          error
        );

        setEmployee(null);
      } finally {
        setLoading(false);
      }
    };

    checkSession();
  }, []);

  const login = async (
    username: string,
    password: string
  ) => {
    // Only the server verifies passwords; the client stores the returned safe profile.
    const response = await apiFetch(
      "/api/auth/login",
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
        },

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

    setSessionExpired(false);
    setEmployee(data.employee);
  };

  const logout = async () => {
    // Destroy the server session before clearing local authentication state.
    await apiFetch("/api/auth/logout", {
      method: "POST",
    });

    setEmployee(null);
  };

  return (
    <AuthContext.Provider
      value={{
        employee,
        loading,
        sessionExpired,
        login,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);

  // Catch accidental use outside AuthProvider during development.
  if (!context) {
    throw new Error(
      "useAuth must be used inside AuthProvider"
    );
  }

  return context;
}
