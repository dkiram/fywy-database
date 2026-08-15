/** Keeps the signed-in employee available across the app and owns login/logout requests. */
import {
  createContext,
  useContext,
  useEffect,
  useState,
} from "react";

import { apiFetch } from "../lib/api";

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
