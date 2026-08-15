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
  }
}
