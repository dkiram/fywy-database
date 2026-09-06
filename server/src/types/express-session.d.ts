/** Extends Express sessions with the minimal employee identity used for authorization. */
import "express-session";

declare module "express-session" {
  interface SessionData {
    employee?: {
      employeeId: number;
      firstName: string;
      lastName: string;
      username: string;
      role: "admin" | "head_office" | "branch";
      locationId: number | null;
      locationName: string | null;
    };

    /**
     * A technician signed in on their phone.
     *
     * Deliberately a separate field rather than an `employee` with role
     * 'technician'. Every staff guard in this codebase asks for
     * `session.employee`, so a technician session cannot satisfy one by
     * accident — not through a route added later, not through a role check
     * somebody forgets to write. The two identities never coexist on one
     * session: signing in as either replaces the other.
     */
    technician?: {
      employeeId: number;
      firstName: string;
      lastName: string;
      loginCode: string;
    };

    /** Row in login_sessions this browser session opened, so logout can close it. */
    loginSessionId?: number | null;

    /** When the heartbeat last wrote last_seen_at, to keep it to once a minute. */
    lastSeenWrittenAt?: number;
  }
}
