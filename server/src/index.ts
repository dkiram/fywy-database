/** Configures the Express API, session authentication, core customer routes, and routers. */
import express from "express";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { pool } from "./db.js";
import cors from "cors";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import bcrypt from "bcrypt";
import { randomInt } from "node:crypto";
import {
  checkLoginAllowed,
  recordFailedLogin,
  clearFailedLogins,
} from "./loginThrottle.js";
import applicationsRouter from "./routes/applications.js";
import paymentsRouter from "./routes/payments.js";
import accountsRouter from "./routes/accounts.js";
import serviceTicketsRouter from "./routes/serviceTickets.js";
import poleBoxesRouter from "./routes/poleBoxes.js";
import reportsRouter from "./routes/reports.js";
import dashboardRouter from "./routes/dashboard.js";
import networkAccessRouter from "./routes/networkAccess.js";
import technicianAppRouter from "./routes/technicianApp.js";
import { startDelinquentAutomation } from "./huawei/delinquentAutomation.js";
import { startReconnectionAutomation } from "./huawei/reconnectionAutomation.js";
import { startDisconnectionEmailReminders } from "./email/disconnectionReminderAutomation.js";

import type {
  Request,
  Response,
  NextFunction,
} from "express";

const app = express();

const PgSession = connectPgSimple(session);

const IS_PRODUCTION = process.env.NODE_ENV === "production";

// Allow isolated verification or deployment environments to choose a port,
// while preserving the existing local-development default.
const PORT = Number(process.env.PORT || 3000);

// Containers must bind every interface; local development stays on loopback.
const HOST = process.env.HOST || (IS_PRODUCTION ? "0.0.0.0" : "127.0.0.1");

// The session secret is the only thing standing between a stolen cookie and a
// staff account, so refuse to start in production without a real one.
const SESSION_SECRET = process.env.SESSION_SECRET;

if (!SESSION_SECRET) {
  throw new Error(
    "SESSION_SECRET is not set. Refusing to start without a session secret."
  );
}

if (IS_PRODUCTION && SESSION_SECRET.length < 32) {
  throw new Error(
    "SESSION_SECRET is too short for production. Use at least 32 characters."
  );
}

/**
 * Cross-origin requests are only needed when the frontend is served from a
 * different origin than the API. Production serves both from one origin and
 * local development proxies through Vite, so CORS stays off unless
 * CORS_ALLOWED_ORIGINS is deliberately set.
 */
const corsAllowedOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

if (corsAllowedOrigins.length > 0) {
  app.use(
    cors({
      origin: corsAllowedOrigins,
      credentials: true,
    })
  );
}

// Behind the Tailscale/HTTPS front door the real protocol arrives in headers,
// and express-session needs to trust them before it will set a secure cookie.
if (IS_PRODUCTION) {
  app.set("trust proxy", 1);
}

app.use(express.json());

/**
 * Decides whether the session cookie carries the Secure attribute, which tells
 * the browser to send it only over an encrypted connection.
 *
 *   "auto"  - decided per request from req.secure. Branch offices arriving
 *             through the Cloudflare tunnel get a Secure cookie; the home
 *             office on the plain-HTTP LAN address keeps working. This is the
 *             default, because it is the only setting that is correct for both
 *             at once.
 *   "true"  - always Secure. Correct once every office, including the home
 *             office, reaches the app over HTTPS. Setting this while anyone is
 *             still on http://<nas-ip>:<port> locks those staff out: the login
 *             appears to succeed and immediately bounces back to the form.
 *   "false" - never Secure. The old behaviour, kept as an escape hatch.
 *
 * "auto" depends on `trust proxy` being set above, otherwise req.secure can
 * never be true behind the tunnel and "auto" quietly degrades to "false".
 */
function resolveSecureCookieSetting(): boolean | "auto" {
  const configured = process.env.SESSION_COOKIE_SECURE?.trim().toLowerCase();

  if (configured === "true") {
    return true;
  }

  if (configured === "false") {
    return false;
  }

  if (configured === "auto") {
    return "auto";
  }

  if (configured) {
    console.warn(
      `SESSION_COOKIE_SECURE is "${configured}", which is not one of ` +
        `true, false, or auto. Falling back to the default.`
    );
  }

  // Development runs over plain HTTP with no proxy in front, so "auto" would
  // resolve to false on every request anyway. Being explicit is clearer.
  return IS_PRODUCTION ? "auto" : false;
}

/**
 * How long a session survives WITHOUT activity.
 *
 * This is an idle timeout, not a fixed lifetime: `rolling: true` below pushes
 * the expiry forward on every request, so somebody working through the day is
 * never interrupted, while a counter machine left alone closes itself.
 *
 * The trade-off is that an unattended browser at a branch is only exposed for
 * this long instead of a full shift. Raise it if staff start complaining that
 * a quiet afternoon signs them out mid-task.
 */
const SESSION_IDLE_MINUTES = (() => {
  const configured = Number.parseInt(process.env.SESSION_IDLE_MINUTES ?? "", 10);

  if (Number.isFinite(configured) && configured >= 5 && configured <= 720) {
    return configured;
  }

  if (process.env.SESSION_IDLE_MINUTES) {
    console.warn(
      `SESSION_IDLE_MINUTES is "${process.env.SESSION_IDLE_MINUTES}", which is not a ` +
        `number of minutes between 5 and 720. Falling back to 60.`
    );
  }

  return 60;
})();

const SECURE_COOKIE_SETTING = resolveSecureCookieSetting();

if (IS_PRODUCTION) {
  console.log(
    `Session cookie Secure attribute: ${SECURE_COOKIE_SETTING}` +
      (SECURE_COOKIE_SETTING === "auto"
        ? " (per request, from the connection protocol)"
        : "")
  );

  console.log(
    `Session idle timeout: ${SESSION_IDLE_MINUTES} minutes (refreshed on each request)`
  );
}

app.use(
  session({
    // Store sessions in PostgreSQL instead of process memory so restarts do not log everyone out.
    store: new PgSession({
      pool,
      tableName: "user_sessions",
      schemaName: "public",
    }),

    secret: SESSION_SECRET,

    resave: false,
    saveUninitialized: false,

    // Re-issues the cookie and touches the stored expiry on every response, so
    // the countdown restarts with any activity. Without this the maxAge below
    // would be a hard cut-off measured from login, and someone mid-payment at
    // 59 minutes would be signed out regardless of what they were doing.
    rolling: true,

    // Do not advertise the framework in the cookie name.
    name: process.env.SESSION_COOKIE_NAME || "spcl.sid",

    cookie: {
      httpOnly: true,

      // See resolveSecureCookieSetting above. Defaults to "auto" in
      // production so HTTPS clients are protected without cutting off the
      // offices still on the plain-HTTP LAN address.
      secure: SECURE_COOKIE_SETTING,

      sameSite: "lax",

      // Idle timeout, refreshed on every request by `rolling` above. The
      // browser drops the cookie by itself once this passes, so an abandoned
      // machine stops carrying a usable session even before anything asks
      // the server.
      maxAge: 1000 * 60 * SESSION_IDLE_MINUTES,
    },
  })
);

app.use("/api", applicationsRouter);
app.use("/api", paymentsRouter);
// MVP 3 service-status queue, history, and transition endpoints.
app.use("/api", accountsRouter);
// MVP 4 operational workflows and the summaries built from them.
app.use("/api", serviceTicketsRouter);
app.use("/api", poleBoxesRouter);
app.use("/api", reportsRouter);
app.use("/api", dashboardRouter);
// Customer-to-OLT inventory. Actual Huawei commands will be added only after
// a verified worker/service account is available on the management network.
app.use("/api", networkAccessRouter);
// The standalone technician phone app. Its own identity, its own sign-in, and
// no overlap with the staff routes above.
app.use("/api", technicianAppRouter);

// Shared guards cover the older routes that still live in this entry file.
function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
) {
  if (!req.session.employee) {
    return res.status(401).json({
      error: "Not authenticated.",
    });
  }

  next();
}


function requireRole(
  ...allowedRoles: Array<
    "admin" | "head_office" | "branch"
  >
) {
  return (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {
    const employee = req.session.employee;

    if (!employee) {
      return res.status(401).json({
        error: "Not authenticated.",
      });
    }

    if (!allowedRoles.includes(employee.role)) {
      return res.status(403).json({
        error: "You do not have permission to perform this action.",
      });
    }

    next();
  };
}


/**
 * Login history.
 *
 * Every attempt lands in login_sessions — successes as an open session,
 * failures as a moment. Recording is best-effort: a failure to write history
 * must never stop somebody signing in, so these swallow their errors and log
 * rather than throwing into the request.
 */
async function recordFailedAttempt(
  username: string,
  reason: "unknown_username" | "wrong_password" | "inactive_account" | "rate_limited",
  employeeId: number | null = null,
  actorName: string | null = null
) {
  try {
    await pool.query(
      `INSERT INTO public.login_sessions
         (employee_id, username_attempted, actor_name, outcome, failure_reason)
       VALUES ($1, $2, $3, 'failed', $4);`,
      [employeeId, username.trim().slice(0, 100), actorName, reason]
    );
  } catch (error) {
    console.error("Could not record failed login:", error);
  }
}

async function recordSuccessfulLogin(
  employee: {
    employee_id: number;
    username: string;
    first_name: string;
    last_name: string;
    location_id: number | null;
    location_name: string | null;
  },
  sessionId: string
): Promise<number | null> {
  try {
    const result = await pool.query(
      `INSERT INTO public.login_sessions
         (employee_id, username_attempted, actor_name, outcome,
          location_id, location_name, session_sid, last_seen_at)
       VALUES ($1, $2, $3, 'success', $4, $5, $6, CURRENT_TIMESTAMP)
       RETURNING login_session_id;`,
      [
        employee.employee_id,
        employee.username,
        `${employee.first_name} ${employee.last_name}`,
        employee.location_id,
        employee.location_name,
        sessionId,
      ]
    );

    return result.rows[0].login_session_id;
  } catch (error) {
    console.error("Could not record login session:", error);
    return null;
  }
}

/**
 * How stale last_seen_at is allowed to get before a request refreshes it.
 *
 * Without a heartbeat, a session nobody logs out of has a start time and
 * nothing else — and most sessions end that way, because people close the
 * laptop. One write per user per minute is nothing at this size, and it is
 * what lets the panel say "last active 3:47pm" instead of leaving a blank.
 */
const SESSION_HEARTBEAT_MS = 60_000;

app.use((req, _res, next) => {
  const loginSessionId = req.session?.loginSessionId;

  if (loginSessionId) {
    const last = req.session.lastSeenWrittenAt ?? 0;
    const now = Date.now();

    if (now - last > SESSION_HEARTBEAT_MS) {
      req.session.lastSeenWrittenAt = now;

      // Deliberately not awaited: the heartbeat is bookkeeping, and the
      // request should not wait on it or fail with it.
      pool
        .query(
          `UPDATE public.login_sessions
           SET last_seen_at = CURRENT_TIMESTAMP
           WHERE login_session_id = $1 AND ended_at IS NULL;`,
          [loginSessionId]
        )
        .catch((error) => console.error("Could not update session heartbeat:", error));
    }
  }

  next();
});

// In production "/" belongs to the built frontend, which is mounted further
// down. This placeholder only exists for API-only local development.
if (!IS_PRODUCTION) {
  app.get("/", (req, res) => {
    res.send("SPCL API is running");
  });
}

app.get("/health", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT NOW() AS database_time"
    );

    res.json({
      status: "ok",
      database: "connected",
      databaseTime: result.rows[0].database_time,
    });
  } catch (error) {
    console.error("Database connection failed:", error);

    res.status(500).json({
      status: "error",
      database: "disconnected",
    });
  }
});

app.get("/api/customers", requireAuth, async (req, res) => {
  try {
    // Empty searches return the latest accounts; actual searches sort alphabetically.
    const search =
      typeof req.query.search === "string"
        ? req.query.search.trim()
        : "";

    const searchPattern = `%${search}%`;

    // The customer directory is person-oriented. Operational pickers omit
    // this flag and continue receiving one row per service account.
    if (req.query.grouped === "true") {
      const groupedResult = await pool.query(
        `
        WITH matching_keys AS (
          SELECT DISTINCT
            COALESCE(c.account_group_id, -c.customer_id::BIGINT) AS account_key
          FROM public.customers c
          WHERE c.hidden_from_app = FALSE
            AND (
              $1 = ''
              OR c.customer_id::TEXT ILIKE $2
              OR c.name ILIKE $2
              OR c.telephone ILIKE $2
            )
        ), visible AS (
          SELECT
            c.*,
            p.name AS package_name,
            COALESCE(c.account_group_id, -c.customer_id::BIGINT) AS account_key
          FROM public.customers c
          JOIN matching_keys match
            ON match.account_key = COALESCE(c.account_group_id, -c.customer_id::BIGINT)
          LEFT JOIN public.packages p ON p.package_id = c.package_id
          WHERE c.hidden_from_app = FALSE
        ), grouped AS (
          SELECT
            account_key,
            MIN(customer_id) AS representative_customer_id,
            COUNT(*)::INTEGER AS account_count,
            ARRAY_AGG(customer_id ORDER BY customer_id) AS account_ids,
            ARRAY_AGG(COALESCE(package_name, 'No package') ORDER BY customer_id)
              AS package_names,
            ARRAY_AGG(status ORDER BY customer_id) AS account_statuses,
            MAX(application_date) AS latest_application_date
          FROM visible
          GROUP BY account_key
        )
        SELECT
          representative.customer_id,
          COALESCE(account_group.display_name, representative.name) AS name,
          representative.address,
          representative.telephone,
          representative.status,
          representative.monthly_fee,
          representative.package_id,
          representative.package_name,
          representative.account_group_id,
          grouped.account_count,
          grouped.account_ids,
          grouped.package_names,
          grouped.account_statuses
        FROM grouped
        JOIN visible representative
          ON representative.customer_id = grouped.representative_customer_id
        LEFT JOIN public.customer_account_groups account_group
          ON account_group.account_group_id = representative.account_group_id
        ORDER BY
          CASE WHEN $1 = '' THEN grouped.latest_application_date END DESC NULLS LAST,
          CASE WHEN $1 <> '' THEN LOWER(COALESCE(account_group.display_name, representative.name)) END ASC NULLS LAST,
          representative.customer_id DESC
        LIMIT 50;
        `,
        [search, searchPattern]
      );

      return res.json(groupedResult.rows);
    }

    const orderBy =
      search === ""
        ? `
          ORDER BY
            c.application_date DESC NULLS LAST,
            c.customer_id DESC
        `
        : `
          ORDER BY
            LOWER(c.name) ASC NULLS LAST,
            c.customer_id ASC
        `;

    const result = await pool.query(
      `
      SELECT
        c.customer_id,
        c.name,
        c.address,
        c.telephone,
        c.status,
        c.monthly_fee,
        c.package_id,
        -- Ticket customer search uses these to prefill infrastructure details.
        c.pole_box_number,
        c.port_number,
        p.name AS package_name
      FROM public.customers c

      LEFT JOIN public.packages p
        ON c.package_id = p.package_id

      -- The OR chain has to be parenthesised: without the brackets the
      -- hidden filter would bind to the last OR branch only and do nothing.
      WHERE c.hidden_from_app = FALSE
        AND (
          $1 = ''
          OR c.customer_id::TEXT ILIKE $2
          OR c.name ILIKE $2
          OR c.telephone ILIKE $2
        )

      ${orderBy}

      LIMIT 50;
      `,
      [search, searchPattern]
    );

    res.json(result.rows);
  } catch (error) {
    console.error("Could not load customers:", error);

    res.status(500).json({
      error: "Could not load customers",
    });
  }
});

// Load the account selector shown above a customer profile. Every returned row
// is still an independent account; this endpoint only supplies the grouping.
app.get("/api/customers/:customerId/accounts", requireAuth, async (req, res) => {
  const customerId = req.params.customerId;
  if (typeof customerId !== "string" || !/^\d+$/.test(customerId)) {
    return res.status(400).json({ error: "Invalid customer ID" });
  }

  try {
    const anchorResult = await pool.query(
      `SELECT customer_id, name, account_group_id
       FROM public.customers
       WHERE customer_id = $1 AND hidden_from_app = FALSE;`,
      [Number(customerId)]
    );
    const anchor = anchorResult.rows[0];
    if (!anchor) return res.status(404).json({ error: "Customer not found" });

    const accountsResult = await pool.query(
      `
      SELECT
        c.customer_id,
        c.name,
        c.address,
        c.status,
        c.monthly_fee,
        c.activation_date,
        c.account_group_id,
        p.name AS package_name,
        billing.outstanding_balance,
        CASE
          WHEN c.status = 'active'
            AND c.activation_date IS NOT NULL
            AND COALESCE(c.monthly_fee, 0) > 0
          THEN CASE
            WHEN c.activation_date >
              (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE
            THEN c.activation_date
            WHEN public.spcl_anniversary_date(
              c.activation_date,
              (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE
            ) > (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE
            THEN public.spcl_anniversary_date(
              c.activation_date,
              (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE
            )
            ELSE public.spcl_anniversary_date(
              c.activation_date,
              ((CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE + INTERVAL '1 month')::DATE
            )
          END
          ELSE NULL
        END AS next_billing_date
      FROM public.customers c
      LEFT JOIN public.packages p ON p.package_id = c.package_id
      -- The full customer_billing_status view ranks every ledger debit in the
      -- system. The selector only needs the balance for one small account
      -- group, so use the customer/date index directly instead.
      LEFT JOIN LATERAL (
        SELECT
          GREATEST(COALESCE(SUM(entry.amount), 0), 0)::NUMERIC(14,2)
            AS outstanding_balance
        FROM public.account_ledger_entries entry
        WHERE entry.customer_id = c.customer_id
      ) billing ON TRUE
      WHERE c.hidden_from_app = FALSE
        AND (
          ($2::BIGINT IS NULL AND c.customer_id = $1)
          OR ($2::BIGINT IS NOT NULL AND c.account_group_id = $2)
        )
      ORDER BY c.customer_id;
      `,
      [Number(customerId), anchor.account_group_id]
    );

    const groupResult = anchor.account_group_id
      ? await pool.query(
          `SELECT display_name FROM public.customer_account_groups WHERE account_group_id = $1;`,
          [anchor.account_group_id]
        )
      : null;

    res.json({
      accountGroupId: anchor.account_group_id,
      displayName: groupResult?.rows[0]?.display_name ?? anchor.name,
      accounts: accountsResult.rows,
    });
  } catch (error) {
    console.error("Could not load related customer accounts:", error);
    res.status(500).json({ error: "Could not load customer accounts." });
  }
});

// Manually joins legacy duplicate rows (for example "Name" and "Name 2")
// without touching either account's money, service state, or equipment.
app.post(
  "/api/customers/:customerId/accounts",
  requireRole("admin", "head_office"),
  async (req, res) => {
    const customerId = req.params.customerId;
    const otherCustomerId = String(req.body.otherCustomerId ?? "").trim();
    if (
      typeof customerId !== "string" ||
      !/^\d+$/.test(customerId) ||
      !/^\d+$/.test(otherCustomerId)
    ) {
      return res.status(400).json({ error: "Choose a valid customer account." });
    }
    if (customerId === otherCustomerId) {
      return res.status(400).json({ error: "That account is already selected." });
    }

    const employee = req.session.employee!;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const customersResult = await client.query(
        `SELECT customer_id, name, account_group_id
         FROM public.customers
         WHERE customer_id = ANY($1::INTEGER[])
           AND hidden_from_app = FALSE
         ORDER BY customer_id
         FOR UPDATE;`,
        [[Number(customerId), Number(otherCustomerId)]]
      );
      if (customersResult.rows.length !== 2) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "One of those customer accounts was not found." });
      }

      const current = customersResult.rows.find(
        (row) => Number(row.customer_id) === Number(customerId)
      );
      const other = customersResult.rows.find(
        (row) => Number(row.customer_id) === Number(otherCustomerId)
      );
      let accountGroupId = current.account_group_id ?? other.account_group_id;

      if (!accountGroupId) {
        const displayName = [current.name, other.name]
          .filter((name): name is string => typeof name === "string" && name.trim() !== "")
          .sort((left, right) => left.trim().length - right.trim().length)[0]
          ?.trim();
        const groupResult = await client.query(
          `INSERT INTO public.customer_account_groups (display_name, created_by_employee_id)
           VALUES ($1, $2)
           RETURNING account_group_id;`,
          [displayName || `Customer #${customerId}`, employee.employeeId]
        );
        accountGroupId = groupResult.rows[0].account_group_id;
      }

      // If both accounts already head different groups, combine the groups by
      // moving every member. No per-account records are merged or rewritten.
      const groupIds = [current.account_group_id, other.account_group_id].filter(
        (value, index, values) => value && values.indexOf(value) === index
      );
      if (groupIds.length > 1) {
        await client.query(
          `UPDATE public.customers
           SET account_group_id = $1
           WHERE account_group_id = ANY($2::BIGINT[]);`,
          [accountGroupId, groupIds]
        );
      }

      await client.query(
        `UPDATE public.customers
         SET account_group_id = $1
         WHERE customer_id = ANY($2::INTEGER[]);`,
        [accountGroupId, [Number(customerId), Number(otherCustomerId)]]
      );

      await client.query(
        `INSERT INTO public.audit_logs (
           employee_id, actor_name, action, entity_type, entity_id,
           field_name, old_value, new_value, reason, occurred_at
         )
         SELECT $1, $2, 'Linked customer service accounts', 'customer', account_id::TEXT,
           'account_group_id', NULL, $4, $5, CURRENT_TIMESTAMP
         FROM UNNEST($3::INTEGER[]) account_id;`,
        [
          employee.employeeId,
          `${employee.firstName} ${employee.lastName}`,
          [Number(customerId), Number(otherCustomerId)],
          String(accountGroupId),
          `Linked service accounts #${customerId} and #${otherCustomerId}`,
        ]
      );

      await client.query("COMMIT");
      res.json({ accountGroupId: Number(accountGroupId) });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Could not link customer accounts:", error);
      res.status(500).json({ error: "Could not link customer accounts." });
    } finally {
      client.release();
    }
  }
);

app.get("/api/customers/:customerId", requireAuth, async (req, res) => {
  try {
    // The profile query joins package fees so payment forms can prefill configured amounts.
    const { customerId } = req.params;

    if (
  typeof customerId !== "string" ||
  !/^\d+$/.test(customerId)
) {
  return res.status(400).json({
    error: "Invalid customer ID",
  });
}

    const result = await pool.query(
      `
      SELECT
        c.customer_id,
        c.name,
        c.address,
        c.occupation,
        c.telephone,
        c.email,
        c.id_type,
        c.id_number,

        c.package_id,
        c.monthly_fee,

        c.application_date,
        c.activation_date,
        c.deactivation_date,
        c.reactivation_date,
        GREATEST(
          c.deactivation_date,
          (
            SELECT MAX(history.effective_date)
            FROM public.account_status_history history
            WHERE history.customer_id = c.customer_id
              AND history.from_status = 'active'
              AND history.to_status = 'disconnected'
          )
        ) AS last_disconnected_on,
        COALESCE(
          (
            SELECT MAX(history.effective_date)
            FROM public.account_status_history history
            WHERE history.customer_id = c.customer_id
              AND history.from_status = 'pending_reconnection'
              AND history.to_status = 'active'
          ),
          -- Access filled re_activation_date with the original activation date
          -- on most accounts. Treat it as a legacy reconnection only when it
          -- actually follows a recorded disconnection.
          CASE
            WHEN c.reactivation_date > c.deactivation_date
            THEN c.reactivation_date
            ELSE NULL
          END
        ) AS last_reconnected_on,
        CASE
          -- Only active, billable accounts have an upcoming recurring charge.
          WHEN c.status = 'active'
            AND c.activation_date IS NOT NULL
            AND COALESCE(c.monthly_fee, 0) > 0
          THEN CASE
            -- A future activation is itself the first billing date.
            WHEN c.activation_date >
              (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE
            THEN c.activation_date
            -- If this month's anniversary is still ahead, use it; otherwise
            -- move to next month. The shared function safely clamps the 29th,
            -- 30th, and 31st in shorter months.
            WHEN public.spcl_anniversary_date(
              c.activation_date,
              (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE
            ) > (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE
            THEN public.spcl_anniversary_date(
              c.activation_date,
              (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE
            )
            ELSE public.spcl_anniversary_date(
              c.activation_date,
              (
                (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE
                + INTERVAL '1 month'
              )::DATE
            )
          END
          ELSE NULL
        END AS next_billing_date,

        c.status,
        c.adult_channel,

        c.pole_box_number,
        c.port_number,

        p.name AS package_name,
        p.service_type AS package_service_type,
        p.plan_tier AS package_plan_tier,
        p.speed_mbps AS package_speed_mbps,
        p.installation_fee,
        p.default_monthly_charge,
        p.reconnection_fee

      FROM public.customers c

      LEFT JOIN public.packages p
        ON c.package_id = p.package_id

      WHERE c.customer_id = $1;
      `,
      [Number(customerId)]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "Customer not found",
      });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Could not load customer:", error);

    res.status(500).json({
      error: "Could not load customer",
    });
  }
});

app.get(
  "/api/customers/:customerId/payments",  requireAuth,
  async (req, res) => {
    try {
      const { customerId } = req.params;

      if (
  typeof customerId !== "string" ||
  !/^\d+$/.test(customerId)
) {
  return res.status(400).json({
    error: "Invalid customer ID",
  });
}

      const page =
        typeof req.query.page === "string"
          ? Math.max(Number(req.query.page) || 1, 1)
          : 1;

      const search =
        typeof req.query.search === "string"
          ? req.query.search.trim()
          : "";

      const type =
        typeof req.query.type === "string"
          ? req.query.type.trim()
          : "";

      const from =
        typeof req.query.from === "string"
          ? req.query.from.trim()
          : "";

      const to =
        typeof req.query.to === "string"
          ? req.query.to.trim()
          : "";

      const limit = 5;
      const offset = (page - 1) * limit;

      const values = [
        Number(customerId),
        search,
        type,
        from,
        to,
      ];

      const whereClause = `
        WHERE customer_id = $1

        AND (
          $2 = ''
          OR legacy_payment_id::TEXT ILIKE '%' || $2 || '%'
          OR COALESCE(payment_type, legacy_payment_type, '')
             ILIKE '%' || $2 || '%'
          OR COALESCE(amount_paid::TEXT, '')
             ILIKE '%' || $2 || '%'
          OR COALESCE(location, '')
             ILIKE '%' || $2 || '%'
          OR COALESCE(cashier_name, '')
             ILIKE '%' || $2 || '%'
        )

        AND (
          $3 = ''
          OR COALESCE(payment_type, legacy_payment_type, '') = $3
        )

        AND (
          NULLIF($4, '')::DATE IS NULL
          OR payment_date >= NULLIF($4, '')::DATE
        )

        AND (
          NULLIF($5, '')::DATE IS NULL
          OR payment_date <= NULLIF($5, '')::DATE
        )
      `;

      const paymentsResult = await pool.query(
        `
        SELECT
          payment_id,
          legacy_payment_id,
          payment_type,
          legacy_payment_type,
          amount_paid,
          month_paid,
          payment_date,
          location,
          cashier_name,
          receipt_number,
          (voided_at IS NOT NULL) AS is_voided,
          voided_at,
          void_reason
        FROM public.payments

        ${whereClause}

        ORDER BY
          payment_date DESC NULLS LAST,
          payment_id DESC

        LIMIT $6
        OFFSET $7;
        `,
        [...values, limit, offset]
      );

      const countResult = await pool.query(
        `
        SELECT COUNT(*)::INTEGER AS total
        FROM public.payments

        ${whereClause};
        `,
        values
      );

      const total = countResult.rows[0].total;

      res.json({
        payments: paymentsResult.rows,

        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (error) {
      console.error("Could not load payments:", error);

      res.status(500).json({
        error: "Could not load payments",
      });
    }
  }
);


app.get("/api/audit-logs", requireAuth, async (req, res) => {
  try {
    const employeeSearch =
      typeof req.query.employee === "string"
        ? req.query.employee.trim().slice(0, 100)
        : "";
    const employeePattern = `%${employeeSearch}%`;

    // Bound the activity feed to protect the UI and database from unbounded history reads.
    const result = await pool.query(
      `
      SELECT
        audit.audit_log_id,
        audit.actor_name,
        audit.action,
        audit.entity_type,
        audit.entity_id,
        audit.field_name,
        audit.old_value,
        audit.new_value,
        audit.reason,
        audit.occurred_at,
        CASE
          WHEN audit.entity_type = 'customer' THEN audit.entity_id
          WHEN audit.entity_type = 'payment' THEN payment.customer_id::TEXT
          WHEN audit.entity_type = 'service_ticket' THEN ticket.customer_id::TEXT
          WHEN audit.entity_type = 'application' THEN application.customer_id::TEXT
          ELSE NULL
        END AS related_customer_id
      FROM public.audit_logs audit
      LEFT JOIN public.employees employee
        ON employee.employee_id = audit.employee_id
      LEFT JOIN public.payments payment
        ON payment.payment_id = CASE
          WHEN audit.entity_type = 'payment' AND audit.entity_id ~ '^[0-9]+$'
          THEN audit.entity_id::BIGINT
          ELSE NULL
        END
      LEFT JOIN public.service_tickets ticket
        ON ticket.service_ticket_id = CASE
          WHEN audit.entity_type = 'service_ticket' AND audit.entity_id ~ '^[0-9]+$'
          THEN audit.entity_id::BIGINT
          ELSE NULL
        END
      LEFT JOIN public.applications application
        ON application.application_id = CASE
          WHEN audit.entity_type = 'application' AND audit.entity_id ~ '^[0-9]+$'
          THEN audit.entity_id::BIGINT
          ELSE NULL
        END
      WHERE
        (audit.source_key IS NULL
          OR audit.source_key NOT LIKE 'email-disconnection-5-day:%')
        AND (
          $1 = ''
          OR audit.actor_name ILIKE $2
          OR employee.first_name ILIKE $2
          OR employee.last_name ILIKE $2
          OR CONCAT_WS(' ', employee.first_name, employee.last_name) ILIKE $2
          OR employee.username ILIKE $2
        )
      ORDER BY audit.occurred_at DESC, audit.audit_log_id DESC
      LIMIT 100;
      `,
      [employeeSearch, employeePattern]
    );

    res.json({
      auditLogs: result.rows,
      employeeSearch,
    });
  } catch (error) {
    console.error("Could not load audit logs:", error);

    res.status(500).json({
      error: "Could not load activity history.",
    });
  }
});

/**
 * One customer's history, merged from every table that records something
 * happening to their account.
 *
 * Payments are deliberately absent. They have their own tab with amounts,
 * receipt numbers and void state, and repeating them here would both double
 * the length of the timeline and give two places to read the same number
 * from. Audit entries about payments are filtered out for the same reason.
 *
 * The shape of each row is deliberately flat and pre-formatted — kind, title,
 * detail, reason, actor — so the client renders a timeline without needing to
 * know which source table a given line came from.
 *
 * Paged 25 at a time. Filtering happens HERE rather than in the client: if the
 * client filtered a page it had already been given, asking for "waivers" could
 * show an empty tab on an account that has twenty of them further down, and
 * "load more" would appear to do nothing. The filter has to reach the ORDER BY
 * for paging to mean anything.
 */
const ACTIVITY_PAGE_SIZE = 25;
const ACTIVITY_MAX_PAGE_SIZE = 100;

/**
 * Maps a filter name from the UI onto the event kinds it covers. "Tickets" is
 * one idea to the person reading the page even though it is two kinds in the
 * query, so the grouping lives here rather than making them choose.
 */
const ACTIVITY_FILTERS: Record<string, string[] | null> = {
  all: null,
  note: ["note"],
  status_change: ["status_change"],
  ticket: ["ticket_opened", "ticket_event"],
  rate_change: ["rate_change"],
  waiver: ["waiver"],
  reconnection: ["reconnection"],
  hold: ["hold"],
  staff_edit: ["staff_edit"],
};

app.get("/api/customers/:customerId/activity", requireAuth, async (req, res) => {
  try {
    const { customerId } = req.params;

    if (typeof customerId !== "string" || !/^\d+$/.test(customerId)) {
      return res.status(400).json({ error: "Invalid customer ID" });
    }

    const requestedFilter =
      typeof req.query.filter === "string" ? req.query.filter : "all";

    if (!(requestedFilter in ACTIVITY_FILTERS)) {
      return res.status(400).json({
        error: `Unknown filter. Expected one of: ${Object.keys(ACTIVITY_FILTERS).join(", ")}`,
      });
    }

    const kinds = ACTIVITY_FILTERS[requestedFilter];

    // Clamped rather than rejected: a nonsense limit in a URL should still
    // return a sane page, not a 400 the user cannot act on.
    const requestedLimit = Number.parseInt(String(req.query.limit ?? ""), 10);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), ACTIVITY_MAX_PAGE_SIZE)
      : ACTIVITY_PAGE_SIZE;

    const requestedOffset = Number.parseInt(String(req.query.offset ?? ""), 10);
    const offset = Number.isFinite(requestedOffset) ? Math.max(requestedOffset, 0) : 0;

    const result = await pool.query(
      `
      WITH activity AS (
          -- Account status changes: disconnections, reconnections, closures.
          SELECT
              COALESCE(h.changed_at, h.effective_date::TIMESTAMPTZ) AS occurred_at,
              'status_change'::TEXT AS kind,
              CASE
                  WHEN h.from_status IS NULL THEN 'Account set to ' || h.to_status
                  ELSE 'Status changed from ' || h.from_status || ' to ' || h.to_status
              END AS title,
              NULL::TEXT AS detail,
              h.reason AS reason,
              CONCAT_WS(' ', e.first_name, e.last_name) AS actor,
              h.account_status_history_id::TEXT AS reference_id
          FROM public.account_status_history h
          LEFT JOIN public.employees e ON e.employee_id = h.changed_by_employee_id
          WHERE h.customer_id = $1
            -- A routine OLT-vs-database reconciliation still needs its row in
            -- account_status_history (billing and Account Operations depend
            -- on it), but it is not a noteworthy event for this blended
            -- timeline the way a real deactivation or reconnection is.
            AND h.reason NOT LIKE 'OLT reconciliation:%'

          UNION ALL

          -- Monthly fee changes.
          SELECT
              COALESCE(r.created_at, r.effective_date::TIMESTAMPTZ),
              'rate_change',
              'Monthly fee set to J$' || TRIM(TO_CHAR(r.monthly_fee, 'FM999999990.00')),
              'Effective ' || TO_CHAR(r.effective_date, 'DD Mon YYYY')
                  || CASE WHEN r.is_legacy_estimate THEN ' (estimated from legacy data)' ELSE '' END,
              r.reason,
              CONCAT_WS(' ', e.first_name, e.last_name),
              r.customer_rate_history_id::TEXT
          FROM public.customer_rate_history r
          LEFT JOIN public.employees e ON e.employee_id = r.changed_by_employee_id
          WHERE r.customer_id = $1

          UNION ALL

          -- Service tickets, at the point they were raised.
          SELECT
              COALESCE(t.created_at, t.reported_date::TIMESTAMPTZ),
              'ticket_opened',
              'Service ticket raised: ' || t.issue_summary,
              NULLIF(CONCAT_WS(' · ',
                  NULLIF('Priority ' || t.priority, 'Priority '),
                  NULLIF('Assigned to ' || CONCAT_WS(' ', a.first_name, a.last_name), 'Assigned to '),
                  t.description
              ), ''),
              NULL,
              CONCAT_WS(' ', e.first_name, e.last_name),
              t.service_ticket_id::TEXT
          FROM public.service_tickets t
          LEFT JOIN public.employees e ON e.employee_id = t.created_by_employee_id
          LEFT JOIN public.employees a ON a.employee_id = t.assigned_employee_id
          WHERE t.customer_id = $1

          UNION ALL

          -- Everything that happened to those tickets afterwards.
          SELECT
              th.changed_at,
              'ticket_event',
              CASE
                  WHEN th.to_status IS NOT NULL AND th.from_status IS NOT NULL
                      THEN 'Ticket #' || th.service_ticket_id || ' moved from ' || th.from_status || ' to ' || th.to_status
                  WHEN th.to_status IS NOT NULL
                      THEN 'Ticket #' || th.service_ticket_id || ' set to ' || th.to_status
                  ELSE 'Ticket #' || th.service_ticket_id || ' ' || th.event_type
              END,
              th.note,
              NULL,
              CONCAT_WS(' ', e.first_name, e.last_name),
              th.service_ticket_id::TEXT
          FROM public.service_ticket_history th
          JOIN public.service_tickets t ON t.service_ticket_id = th.service_ticket_id
          LEFT JOIN public.employees e ON e.employee_id = th.changed_by_employee_id
          WHERE t.customer_id = $1

          UNION ALL

          -- Waivers: requested, reviewed, and possibly reversed. Each is its
          -- own line, because "requested" and "approved three days later by
          -- someone else" are two events, and collapsing them hides who
          -- approved it — which is the part anyone reading this wants.
          SELECT
              w.requested_at,
              'waiver',
              'Waiver requested: J$' || TRIM(TO_CHAR(w.amount, 'FM999999990.00')),
              NULL,
              w.reason,
              CONCAT_WS(' ', e.first_name, e.last_name),
              w.waiver_request_id::TEXT
          FROM public.waiver_requests w
          LEFT JOIN public.employees e ON e.employee_id = w.requested_by_employee_id
          WHERE w.customer_id = $1

          UNION ALL

          SELECT
              w.reviewed_at,
              'waiver',
              'Waiver ' || w.status || ': J$' || TRIM(TO_CHAR(w.amount, 'FM999999990.00')),
              NULL,
              w.review_note,
              CONCAT_WS(' ', e.first_name, e.last_name),
              w.waiver_request_id::TEXT
          FROM public.waiver_requests w
          LEFT JOIN public.employees e ON e.employee_id = w.reviewed_by_employee_id
          WHERE w.customer_id = $1 AND w.reviewed_at IS NOT NULL

          UNION ALL

          SELECT
              w.reversed_at,
              'waiver',
              'Waiver reversed: J$' || TRIM(TO_CHAR(w.amount, 'FM999999990.00')),
              NULL,
              w.reversal_note,
              CONCAT_WS(' ', e.first_name, e.last_name),
              w.waiver_request_id::TEXT
          FROM public.waiver_requests w
          LEFT JOIN public.employees e ON e.employee_id = w.reversed_by_employee_id
          WHERE w.customer_id = $1 AND w.reversed_at IS NOT NULL

          UNION ALL

          -- Reconnection requests and their decisions.
          SELECT
              n.requested_at,
              'reconnection',
              'Reconnection requested (balance J$' || TRIM(TO_CHAR(n.outstanding_balance_snapshot, 'FM999999990.00')) || ')',
              NULL,
              n.reason,
              CONCAT_WS(' ', e.first_name, e.last_name),
              n.reconnection_request_id::TEXT
          FROM public.reconnection_requests n
          LEFT JOIN public.employees e ON e.employee_id = n.requested_by_employee_id
          WHERE n.customer_id = $1

          UNION ALL

          SELECT
              n.reviewed_at,
              'reconnection',
              'Reconnection ' || n.status,
              NULL,
              n.review_note,
              CONCAT_WS(' ', e.first_name, e.last_name),
              n.reconnection_request_id::TEXT
          FROM public.reconnection_requests n
          LEFT JOIN public.employees e ON e.employee_id = n.reviewed_by_employee_id
          WHERE n.customer_id = $1 AND n.reviewed_at IS NOT NULL

          UNION ALL

          -- Disconnection holds, placed and released.
          SELECT
              d.created_at,
              'hold',
              'Disconnection hold placed until ' || TO_CHAR(d.expires_on, 'DD Mon YYYY'),
              NULL,
              d.reason,
              CONCAT_WS(' ', e.first_name, e.last_name),
              d.disconnection_hold_id::TEXT
          FROM public.disconnection_holds d
          LEFT JOIN public.employees e ON e.employee_id = d.approved_by_employee_id
          WHERE d.customer_id = $1

          UNION ALL

          SELECT
              d.released_at,
              'hold',
              'Disconnection hold released',
              NULL,
              NULL,
              CONCAT_WS(' ', e.first_name, e.last_name),
              d.disconnection_hold_id::TEXT
          FROM public.disconnection_holds d
          LEFT JOIN public.employees e ON e.employee_id = d.released_by_employee_id
          WHERE d.customer_id = $1 AND d.released_at IS NOT NULL

          UNION ALL

          -- Dated manual notes. Interpreting midnight in Jamaica keeps a
          -- date-only event on its selected day when the browser formats it.
          SELECT
              n.note_date::TIMESTAMP AT TIME ZONE 'America/Jamaica',
              'note',
              CASE WHEN n.updated_at IS NULL
                   THEN 'Customer note'
                   ELSE 'Customer note (edited)'
              END,
              n.note,
              CASE WHEN n.updated_at IS NULL THEN NULL
                   ELSE 'Last edited by '
                     || COALESCE(NULLIF(CONCAT_WS(' ', editor.first_name, editor.last_name), ''), 'former staff member')
                     || ' on '
                     || TO_CHAR(n.updated_at AT TIME ZONE 'America/Jamaica', 'DD Mon YYYY, HH12:MI AM')
              END,
              CONCAT_WS(' ', creator.first_name, creator.last_name),
              n.customer_note_id::TEXT
          FROM public.customer_notes n
          LEFT JOIN public.employees creator ON creator.employee_id = n.created_by_employee_id
          LEFT JOIN public.employees editor ON editor.employee_id = n.updated_by_employee_id
          WHERE n.customer_id = $1

          UNION ALL

          -- Staff edits from the audit trail. actor_name is a snapshot taken
          -- at write time, so an old entry still names the right person after
          -- they leave or change their name.
          SELECT
              al.occurred_at,
              'staff_edit',
              al.action,
              CASE
                -- Customer OLT audits store complete JSON snapshots for
                -- traceability. The profile timeline only needs a readable
                -- summary; exposing those snapshots here creates a huge block
                -- of technical text and can stretch the entire page.
                WHEN al.field_name = 'network_access' THEN
                  CASE
                    WHEN al.action = 'Verified customer OLT information'
                      THEN 'Saved OLT information matched the live ONT.'
                    WHEN al.action = 'OLT mapping mismatch'
                      THEN 'Saved OLT information did not match the live ONT.'
                    WHEN al.action = 'Added customer OLT information'
                      THEN 'OLT information was added to this customer.'
                    WHEN al.action = 'Changed customer OLT information'
                      THEN 'OLT information was updated for this customer.'
                    ELSE 'OLT information was checked or updated.'
                  END
                ELSE NULLIF(CONCAT_WS(' ',
                    NULLIF(al.field_name, ''),
                    CASE WHEN al.old_value IS NOT NULL OR al.new_value IS NOT NULL
                         THEN COALESCE(al.old_value, '(blank)') || ' → ' || COALESCE(al.new_value, '(blank)')
                    END
                ), '')
              END,
              al.reason,
              al.actor_name,
              al.entity_id
          FROM public.audit_logs al
          LEFT JOIN public.service_tickets at_t
            ON at_t.service_ticket_id = CASE
                 WHEN al.entity_type = 'service_ticket' AND al.entity_id ~ '^[0-9]+$'
                 THEN al.entity_id::BIGINT
               END
          LEFT JOIN public.applications at_a
            ON at_a.application_id = CASE
                 WHEN al.entity_type = 'application' AND al.entity_id ~ '^[0-9]+$'
                 THEN al.entity_id::BIGINT
               END
          -- Who did it, so administrative housekeeping can be told apart from
          -- a real change to this customer.
          LEFT JOIN public.employees at_e
            ON at_e.employee_id = al.employee_id
          WHERE al.entity_type <> 'payment'
            -- Automated email delivery remains permanently auditable in the
            -- database, but is operational noise in staff-facing timelines.
            AND (al.source_key IS NULL
              OR al.source_key NOT LIKE 'email-disconnection-5-day:%')
            -- Notes have their own richer timeline row above. The audit entry
            -- remains globally searchable without appearing twice here.
            AND al.action NOT IN ('Added customer note', 'Edited customer note')
            -- An admin editing this customer belongs on the timeline. An admin
            -- doing admin things that merely touch the customer does not.
            AND (
              al.entity_type = 'customer'
              OR COALESCE(at_e.role, '') <> 'admin'
            )
            AND COALESCE(
                  CASE WHEN al.entity_type = 'customer' AND al.entity_id ~ '^[0-9]+$'
                       THEN al.entity_id::INTEGER END,
                  at_t.customer_id,
                  at_a.customer_id
                ) = $1
      )
      SELECT
          occurred_at,
          kind,
          title,
          detail,
          reason,
          NULLIF(actor, '') AS actor,
          reference_id,
          -- Counted over the filtered set before LIMIT, in the same pass, so
          -- the client can say "25 of 143" without a second round trip.
          COUNT(*) OVER () AS total_count
      FROM activity
      -- A NULL timestamp means the event has not happened yet (an unreviewed
      -- waiver, an unreleased hold), so it has no place on a timeline.
      WHERE occurred_at IS NOT NULL
        AND ($2::TEXT[] IS NULL OR kind = ANY($2::TEXT[]))
      ORDER BY occurred_at DESC, kind, reference_id
      LIMIT $3 OFFSET $4;
      `,
      [customerId, kinds, limit, offset]
    );

    // total_count is identical on every row, so it is read off the first and
    // stripped from the payload rather than repeated 25 times.
    const total = result.rows.length > 0 ? Number(result.rows[0].total_count) : 0;
    const activity = result.rows.map(({ total_count, ...entry }) => entry);

    res.json({
      activity,
      total,
      limit,
      offset,
      filter: requestedFilter,
      hasMore: offset + activity.length < total,
    });
  } catch (error) {
    console.error("Could not load customer activity:", error);

    res.status(500).json({
      error: "Could not load activity for this customer.",
    });
  }
});


app.post("/api/auth/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    if (
      typeof username !== "string" ||
      typeof password !== "string" ||
      !username.trim() ||
      !password
    ) {
      return res.status(400).json({
        error: "Username and password are required.",
      });
    }

    // Brute-force check runs before the database lookup and before bcrypt, so
    // a locked account costs almost nothing to turn away. bcrypt is
    // deliberately slow, which makes it the thing an attacker would lean on
    // to load the server.
    const throttle = checkLoginAllowed(username, req.ip);

    if (!throttle.allowed) {
      console.warn(
        `Login blocked by throttle (${throttle.reason}) for "${username.trim()}" from ${req.ip ?? "unknown IP"}.`
      );

      // Retry-After is the standard companion to 429 and costs nothing to send.
      res.setHeader("Retry-After", String(throttle.retryAfterSeconds));

      return res.status(429).json({
        error: throttle.message,
        retryAfterSeconds: throttle.retryAfterSeconds,
      });
    }

    // Use a case-insensitive username lookup but never expose whether an account exists.
    const result = await pool.query(
      `
      SELECT
        e.employee_id,
        e.first_name,
        e.last_name,
        e.username,
        e.password_hash,
        e.role,
        e.location_id,
        e.is_active,

        l.name AS location_name

      FROM public.employees e

      LEFT JOIN public.locations l
        ON e.location_id = l.location_id

      WHERE LOWER(e.username) = LOWER($1)

        -- Technicians are people, not accounts: they have no username and no
        -- hash, so they can be assigned service tickets and nothing else.
        -- Excluding them here rather than after the lookup means a row with
        -- no credentials falls into the same "unknown username" path as any
        -- other miss - rate limited, and giving nothing away about who
        -- exists. It also keeps a NULL from ever reaching bcrypt.compare,
        -- which throws rather than returning false.
        AND e.password_hash IS NOT NULL

      LIMIT 1;
      `,
      [username.trim()]
    );

    const employee = result.rows[0];

    if (!employee) {
      // Counted like any other failure. If unknown usernames were free,
      // an attacker could enumerate valid accounts at full speed.
      recordFailedLogin(username, req.ip);
      await recordFailedAttempt(username, "unknown_username");

      return res.status(401).json({
        error: "Invalid username or password.",
      });
    }

    if (!employee.is_active) {
      await recordFailedAttempt(
        username,
        "inactive_account",
        employee.employee_id,
        `${employee.first_name} ${employee.last_name}`
      );

      return res.status(403).json({
        error: "This employee account is inactive.",
      });
    }

    // bcrypt performs the expensive password verification against the stored hash.
    const passwordMatches = await bcrypt.compare(
      password,
      employee.password_hash
    );

    if (!passwordMatches) {
      recordFailedLogin(username, req.ip);
      await recordFailedAttempt(
        username,
        "wrong_password",
        employee.employee_id,
        `${employee.first_name} ${employee.last_name}`
      );

      return res.status(401).json({
        error: "Invalid username or password.",
      });
    }

    // A correct password clears this username's counter so earlier typos do
    // not carry forward. The IP counter is left standing on purpose.
    clearFailedLogins(username);

    // Store only the safe identity fields required by authorization and page headers.
    req.session.employee = {
      employeeId: employee.employee_id,
      firstName: employee.first_name,
      lastName: employee.last_name,
      username: employee.username,
      role: employee.role,
      locationId: employee.location_id,
      locationName: employee.location_name,
    };

    await pool.query(
      `
      UPDATE public.employees
      SET last_login_at = CURRENT_TIMESTAMP
      WHERE employee_id = $1;
      `,
      [employee.employee_id]
    );

    // Held on the session so logout can close the right row, and so the
    // heartbeat above knows which one to touch.
    req.session.loginSessionId = await recordSuccessfulLogin(
      employee,
      req.sessionID
    );
    req.session.lastSeenWrittenAt = Date.now();

    res.json({
      employee: req.session.employee,
    });
  } catch (error) {
    console.error("Login failed:", error);

    res.status(500).json({
      error: "Could not log in.",
    });
  }
});

app.get("/api/auth/me", (req, res) => {
  if (!req.session.employee) {
    return res.status(401).json({
      error: "Not authenticated.",
    });
  }

  res.json({
    employee: req.session.employee,
  });
});

app.patch("/api/auth/password", requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (
    typeof currentPassword !== "string" ||
    typeof newPassword !== "string" ||
    !currentPassword ||
    !newPassword
  ) {
    return res.status(400).json({
      error: "Current and new passwords are required.",
    });
  }

  if (newPassword.length < 8) {
    return res.status(400).json({
      error: "The new password must be at least 8 characters.",
    });
  }

  if (newPassword.length > 128) {
    return res.status(400).json({
      error: "The new password must be 128 characters or fewer.",
    });
  }

  const employee = req.session.employee!;
  const client = await pool.connect();

  try {
    // Lock the employee row so concurrent password changes cannot overwrite one another.
    await client.query("BEGIN");

    const result = await client.query(
      `
      SELECT password_hash, is_active
      FROM public.employees
      WHERE employee_id = $1
      FOR UPDATE;
      `,
      [employee.employeeId]
    );

    const account = result.rows[0];

    if (!account || !account.is_active) {
      await client.query("ROLLBACK");
      return res.status(403).json({
        error: "This employee account is not available.",
      });
    }

    const passwordMatches = await bcrypt.compare(
      currentPassword,
      account.password_hash
    );

    if (!passwordMatches) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: "The current password is incorrect.",
      });
    }

    const passwordIsUnchanged = await bcrypt.compare(
      newPassword,
      account.password_hash
    );

    if (passwordIsUnchanged) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: "Choose a new password that is different from the current one.",
      });
    }

    // Twelve bcrypt rounds matches the development seed policy.
    const passwordHash = await bcrypt.hash(newPassword, 12);

    // Persist the new hash, then record the event in the same transaction.
    await client.query(
      `
      UPDATE public.employees
      SET password_hash = $1,
          updated_at = CURRENT_TIMESTAMP
      WHERE employee_id = $2;
      `,
      [passwordHash, employee.employeeId]
    );

    // Never place old or new password material in the audit log.
    await client.query(
      `
      INSERT INTO public.audit_logs (
        employee_id,
        actor_name,
        action,
        entity_type,
        entity_id,
        field_name,
        occurred_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP);
      `,
      [
        employee.employeeId,
        `${employee.firstName} ${employee.lastName}`,
        "Changed own password",
        "employee",
        String(employee.employeeId),
        "password",
      ]
    );

    await client.query("COMMIT");

    res.json({ message: "Password updated." });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Could not change password:", error);
    res.status(500).json({
      error: "Could not change password.",
    });
  } finally {
    client.release();
  }
});



app.get(
  "/api/admin/employees",
  requireAuth,
  requireRole("admin"),
  async (req, res) => {
    try {
      // Admins can inspect account access here; changes are intentionally handled elsewhere.
      const result = await pool.query(
        `
        SELECT
          e.employee_id,
          e.first_name,
          e.last_name,
          e.username,
          e.role,
          e.is_active,
          e.last_login_at,
          e.created_at,

          l.location_id,
          l.name AS location_name

        FROM public.employees e

        LEFT JOIN public.locations l
          ON e.location_id = l.location_id

        ORDER BY
          e.last_name,
          e.first_name;
        `
      );

      res.json({
        employees: result.rows,
      });
    } catch (error) {
      console.error(
        "Could not load employees:",
        error
      );

      res.status(500).json({
        error: "Could not load employees.",
      });
    }
  }
);

/** Active offices, for the Office dropdown on the admin screen. */
app.get("/api/locations", requireAuth, async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT location_id, name, code, is_head_office
       FROM public.locations
       WHERE is_active = TRUE
       ORDER BY is_head_office DESC, name;`
    );

    res.json({ locations: result.rows });
  } catch (error) {
    console.error("Could not load locations:", error);
    res.status(500).json({ error: "Could not load offices." });
  }
});

// Roles a person can hold and still log in. 'technician' is deliberately not
// here: migration 034 makes a technician someone with no username and no
// password hash at all, so moving in or out of that role means creating or
// destroying a login, not editing a field. That is a different action from
// "this cashier should be head office", and pretending otherwise in a dropdown
// would produce a constraint violation the admin cannot interpret.
const EDITABLE_ROLES = ["admin", "head_office", "branch"] as const;
type EditableRole = (typeof EDITABLE_ROLES)[number];

/**
 * Edits one employee's name, role, office, or active state.
 *
 * The guards exist because this screen is the one place an admin can lock
 * themselves — or everyone — out of the system, and the NAS is in Jamaica.
 */
app.patch(
  "/api/admin/employees/:employeeId",
  requireAuth,
  requireRole("admin"),
  async (req, res) => {
    const actor = req.session.employee!;
    const { employeeId } = req.params;

    // Express types a route param as string | string[], so the typeof guard is
    // what narrows it before the regex — the same shape the customer routes
    // above use. Without it this compiles locally under a transpiler that
    // strips types, and fails in the Docker build where tsc actually runs.
    if (typeof employeeId !== "string" || !/^\d+$/.test(employeeId)) {
      return res.status(400).json({ error: "Invalid employee ID." });
    }

    const targetId = Number(employeeId);
    const wantsFirstName = req.body.firstName !== undefined;
    const wantsLastName = req.body.lastName !== undefined;
    const wantsRole = req.body.role !== undefined;
    const wantsActive = req.body.isActive !== undefined;
    const wantsLocation = req.body.locationId !== undefined;

    if (
      !wantsFirstName &&
      !wantsLastName &&
      !wantsRole &&
      !wantsActive &&
      !wantsLocation
    ) {
      return res.status(400).json({ error: "Nothing to change." });
    }

    const normalizeName = (value: unknown) =>
      typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
    const firstName = wantsFirstName ? normalizeName(req.body.firstName) : null;
    const lastName = wantsLastName ? normalizeName(req.body.lastName) : null;

    if (wantsFirstName && (firstName!.length < 1 || firstName!.length > 100)) {
      return res.status(400).json({
        error: "First name must be between 1 and 100 characters.",
      });
    }
    if (wantsLastName && (lastName!.length < 1 || lastName!.length > 100)) {
      return res.status(400).json({
        error: "Last name must be between 1 and 100 characters.",
      });
    }
    if (
      (firstName !== null && /[\u0000-\u001F\u007F]/.test(firstName)) ||
      (lastName !== null && /[\u0000-\u001F\u007F]/.test(lastName))
    ) {
      return res.status(400).json({ error: "Employee names contain invalid characters." });
    }

    const role = wantsRole ? String(req.body.role) : null;
    if (wantsRole && !EDITABLE_ROLES.includes(role as EditableRole)) {
      return res.status(400).json({
        error: `Role must be one of: ${EDITABLE_ROLES.join(", ")}.`,
      });
    }

    if (wantsActive && typeof req.body.isActive !== "boolean") {
      return res.status(400).json({ error: "isActive must be true or false." });
    }

    const locationId =
      wantsLocation && req.body.locationId !== null
        ? Number(req.body.locationId)
        : null;

    if (wantsLocation && locationId !== null && !Number.isInteger(locationId)) {
      return res.status(400).json({ error: "Invalid office." });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      // Locked for the same reason the ticket update locks: two admins editing
      // the same person would otherwise each overwrite the other's change.
      const currentResult = await client.query(
        `SELECT employee_id, first_name, last_name, username, role, is_active, location_id
         FROM public.employees WHERE employee_id = $1 FOR UPDATE;`,
        [targetId]
      );

      const current = currentResult.rows[0];

      if (!current) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Employee not found." });
      }

      // Technicians have no login, so role and active state here would mean
      // something different from what the screen implies. Office is fine.
      if (wantsRole && current.role === "technician") {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error:
            "Technicians cannot be given a login role here. They have no username or password by design.",
        });
      }

      // Changing your own role is how an admin accidentally stops being one,
      // with no second admin around to undo it.
      if (targetId === actor.employeeId && wantsRole && role !== current.role) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: "You cannot change your own role. Ask another administrator.",
        });
      }

      if (targetId === actor.employeeId && wantsActive && req.body.isActive === false) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "You cannot deactivate yourself." });
      }

      // The last active administrator must stay an active administrator,
      // whether the change is a demotion or a deactivation.
      const losingAdmin =
        current.role === "admin" &&
        ((wantsRole && role !== "admin") ||
          (wantsActive && req.body.isActive === false));

      if (losingAdmin) {
        const remaining = await client.query(
          `SELECT count(*)::INT AS n FROM public.employees
           WHERE role = 'admin' AND is_active = TRUE AND employee_id <> $1;`,
          [targetId]
        );

        if (remaining.rows[0].n === 0) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error:
              "This is the last active administrator. Promote someone else first, or nobody can administer the system.",
          });
        }
      }

      if (wantsLocation && locationId !== null) {
        const office = await client.query(
          `SELECT 1 FROM public.locations WHERE location_id = $1 AND is_active = TRUE;`,
          [locationId]
        );

        if (office.rows.length === 0) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "That office does not exist." });
        }
      }

      const updated = await client.query(
        `
        UPDATE public.employees
        SET first_name  = CASE WHEN $2::BOOLEAN THEN $3::TEXT ELSE first_name END,
            last_name   = CASE WHEN $4::BOOLEAN THEN $5::TEXT ELSE last_name END,
            role        = COALESCE($6, role),
            is_active   = COALESCE($7, is_active),
            location_id = CASE WHEN $8::BOOLEAN THEN $9::SMALLINT ELSE location_id END,
            updated_at  = CURRENT_TIMESTAMP
        WHERE employee_id = $1
        RETURNING employee_id, first_name, last_name, username, role, is_active, location_id;
        `,
        [
          targetId,
          wantsFirstName,
          firstName,
          wantsLastName,
          lastName,
          wantsRole ? role : null,
          wantsActive ? req.body.isActive : null,
          wantsLocation,
          locationId,
        ]
      );

      // One audit row per field that actually moved, so the trail reads as
      // "what changed" rather than "someone opened the edit form".
      const changes: Array<[string, string | null, string | null]> = [];

      if (wantsFirstName && firstName !== current.first_name) {
        changes.push(["first_name", current.first_name, firstName]);
      }
      if (wantsLastName && lastName !== current.last_name) {
        changes.push(["last_name", current.last_name, lastName]);
      }
      if (wantsRole && role !== current.role) {
        changes.push(["role", current.role, role]);
      }
      if (wantsActive && req.body.isActive !== current.is_active) {
        changes.push([
          "is_active",
          String(current.is_active),
          String(req.body.isActive),
        ]);
      }
      if (wantsLocation && locationId !== current.location_id) {
        changes.push([
          "location_id",
          current.location_id === null ? null : String(current.location_id),
          locationId === null ? null : String(locationId),
        ]);
      }

      for (const [field, oldValue, newValue] of changes) {
        await client.query(
          `INSERT INTO public.audit_logs
             (employee_id, actor_name, action, entity_type, entity_id,
              field_name, old_value, new_value, reason)
           VALUES ($1, $2, $3, 'employee', $4, $5, $6, $7, $8);`,
          [
            actor.employeeId,
            `${actor.firstName} ${actor.lastName}`,
            `Updated ${current.first_name} ${current.last_name}`,
            String(targetId),
            field,
            oldValue,
            newValue,
            typeof req.body.reason === "string"
              ? req.body.reason.trim().slice(0, 500) || null
              : null,
          ]
        );
      }

      await client.query("COMMIT");

      // Keep this browser session's actor name accurate when an Admin corrects
      // their own spelling. Existing audit rows intentionally retain the name
      // captured at the time of each historical action.
      if (targetId === actor.employeeId) {
        actor.firstName = updated.rows[0].first_name;
        actor.lastName = updated.rows[0].last_name;
      }

      res.json({ employee: updated.rows[0], changed: changes.length });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      console.error("Could not update employee:", error);
      res.status(500).json({ error: "Could not update the employee." });
    } finally {
      client.release();
    }
  }
);

/**
 * One employee's login history: sessions and failed attempts, newest first.
 *
 * A session with no ended_at is not necessarily still open — most sessions
 * end because somebody shut a laptop, which fires nothing. So before reading,
 * any unended row whose session has gone from user_sessions is settled as
 * 'expired', dated at the last activity we saw. That runs here rather than on
 * a timer because an admin opening this panel is the only time the answer
 * matters, and it keeps the history from drifting forever.
 */
app.get(
  "/api/admin/employees/:employeeId/sessions",
  requireAuth,
  requireRole("admin"),
  async (req, res) => {
    const { employeeId } = req.params;

    if (typeof employeeId !== "string" || !/^\d+$/.test(employeeId)) {
      return res.status(400).json({ error: "Invalid employee ID." });
    }

    const requestedLimit = Number.parseInt(String(req.query.limit ?? ""), 10);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), 100)
      : 25;

    const requestedOffset = Number.parseInt(String(req.query.offset ?? ""), 10);
    const offset = Number.isFinite(requestedOffset) ? Math.max(requestedOffset, 0) : 0;

    try {
      // Settle anything that quietly lapsed. COALESCE keeps a row that somehow
      // never got a heartbeat from ending before it began.
      await pool.query(
        `
        UPDATE public.login_sessions ls
        SET ended_at   = COALESCE(ls.last_seen_at, ls.started_at),
            end_reason = 'expired'
        WHERE ls.employee_id = $1
          AND ls.outcome = 'success'
          AND ls.ended_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM public.user_sessions us
            WHERE us.sid = ls.session_sid
              AND us.expire > CURRENT_TIMESTAMP
          );
        `,
        [employeeId]
      );

      const result = await pool.query(
        `
        SELECT
            ls.login_session_id,
            ls.outcome,
            ls.failure_reason,
            ls.username_attempted,
            ls.location_name,
            ls.started_at,
            ls.last_seen_at,
            ls.ended_at,
            ls.end_reason,
            -- Anything still unended after the sweep above genuinely has a
            -- live session behind it.
            (ls.outcome = 'success' AND ls.ended_at IS NULL) AS is_active,
            COUNT(*) OVER () AS total_count
        FROM public.login_sessions ls
        WHERE ls.employee_id = $1
        ORDER BY ls.started_at DESC, ls.login_session_id DESC
        LIMIT $2 OFFSET $3;
        `,
        [employeeId, limit, offset]
      );

      const total = result.rows.length > 0 ? Number(result.rows[0].total_count) : 0;
      const sessions = result.rows.map(({ total_count, ...row }) => row);

      res.json({
        sessions,
        total,
        limit,
        offset,
        hasMore: offset + sessions.length < total,
      });
    } catch (error) {
      console.error("Could not load login history:", error);
      res.status(500).json({ error: "Could not load login history." });
    }
  }
);

/**
 * Issues a new password for someone who has lost theirs.
 *
 * The admin supplies the password rather than the server generating one, so
 * the person handing it over is the person who knows it, and it never has to
 * be read back out of a response or a log.
 */
app.post(
  "/api/admin/employees/:employeeId/reset-password",
  requireAuth,
  requireRole("admin"),
  async (req, res) => {
    const actor = req.session.employee!;
    const { employeeId } = req.params;

    // Express types a route param as string | string[], so the typeof guard is
    // what narrows it before the regex — the same shape the customer routes
    // above use. Without it this compiles locally under a transpiler that
    // strips types, and fails in the Docker build where tsc actually runs.
    if (typeof employeeId !== "string" || !/^\d+$/.test(employeeId)) {
      return res.status(400).json({ error: "Invalid employee ID." });
    }

    const newPassword = String(req.body.newPassword ?? "");

    // Matches the minimum createEmployees.ts enforces, so a password issued
    // here is no weaker than one issued at onboarding.
    if (newPassword.length < 12) {
      return res
        .status(400)
        .json({ error: "The new password must be at least 12 characters." });
    }

    // bcrypt silently truncates past 72 bytes, which would make two different
    // passwords equivalent.
    if (Buffer.byteLength(newPassword, "utf8") > 72) {
      return res
        .status(400)
        .json({ error: "The new password is too long. Use 72 bytes or fewer." });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const currentResult = await client.query(
        `SELECT employee_id, first_name, last_name, username, role
         FROM public.employees WHERE employee_id = $1 FOR UPDATE;`,
        [Number(employeeId)]
      );

      const target = currentResult.rows[0];

      if (!target) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Employee not found." });
      }

      if (target.username === null) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: `${target.first_name} ${target.last_name} has no login, so there is no password to reset.`,
        });
      }

      const passwordHash = await bcrypt.hash(newPassword, 12);

      await client.query(
        `UPDATE public.employees
         SET password_hash = $1, updated_at = CURRENT_TIMESTAMP
         WHERE employee_id = $2;`,
        [passwordHash, target.employee_id]
      );

      // Never record password material, old or new — only that it happened.
      await client.query(
        `INSERT INTO public.audit_logs
           (employee_id, actor_name, action, entity_type, entity_id, field_name, reason)
         VALUES ($1, $2, $3, 'employee', $4, 'password', $5);`,
        [
          actor.employeeId,
          `${actor.firstName} ${actor.lastName}`,
          `Reset password for ${target.first_name} ${target.last_name}`,
          String(target.employee_id),
          typeof req.body.reason === "string"
            ? req.body.reason.trim().slice(0, 500) || null
            : null,
        ]
      );

      await client.query("COMMIT");

      res.json({
        message: `Password reset for ${target.first_name} ${target.last_name}. Hand it to them directly and have them change it at first login.`,
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      console.error("Could not reset password:", error);
      res.status(500).json({ error: "Could not reset the password." });
    } finally {
      client.release();
    }
  }
);


/**
 * Technician phone access.
 *
 * A technician has no username and no password — migration 034 makes that a
 * database rule, not a convention — so the phone app is opened with a
 * credential of its own: a code made from their name to identify them
 * (migration 078) and a six-digit passcode to prove it is them.
 *
 * Only the passcode needs to be secret, and it is the one that is random.
 * It is generated here rather than typed by an administrator, because a PIN
 * somebody chooses on a technician's behalf is 1234 far more often than it is
 * anything else.
 *
 * The passcode is shown exactly once, in the response to this call. It is
 * hashed before it is stored and never appears in a log, an audit row, or any
 * later read. Losing it means issuing a new one, which is a five-second job.
 */

/**
 * The fallback alphabet, used only when a name cannot produce a code (see
 * deriveLoginCode below). Drops the letters that get read back as digits off
 * a printed card — I, O and S — along with the digits 0 and 1.
 */
const LOGIN_CODE_ALPHABET = "ABCDEFGHJKLMNPQRTUVWXYZ23456789";

function generateLoginCode() {
  let code = "";
  for (let index = 0; index < 6; index += 1) {
    code += LOGIN_CODE_ALPHABET[randomInt(LOGIN_CODE_ALPHABET.length)];
  }
  return code;
}

/**
 * The technician's code, made from their name: Andre Clarke becomes ACLARK.
 *
 * The code says who is signing in; the passcode is what proves it. So this
 * does not need to be unguessable, and paying for unguessability in
 * memorability was the wrong trade - a technician who mislays the card cannot
 * reconstruct ABC234, but can always reconstruct their own name.
 *
 * Accents and apostrophes are stripped rather than transliterated, so
 * O'Brien becomes AOBRIE rather than something with a character nobody can
 * type on a phone keyboard. A name that leaves fewer than two letters -
 * initials only, or a record with a blank surname - falls back to the random
 * generator above rather than producing a one-character code.
 */
function deriveLoginCode(firstName: string, lastName: string) {
  const letters = (value: string) =>
    value
      .normalize("NFD")
      .replace(/[^a-zA-Z]/g, "")
      .toUpperCase();

  const code = letters(firstName).slice(0, 1) + letters(lastName).slice(0, 5);

  return code.length >= 2 ? code : generateLoginCode();
}

/** Six digits, uniformly random, leading zeros kept. */
function generatePasscode() {
  return String(randomInt(1_000_000)).padStart(6, "0");
}

app.get(
  "/api/admin/technician-phone-access",
  requireAuth,
  requireRole("admin"),
  async (_req, res) => {
    try {
      const result = await pool.query(`
        SELECT
          e.employee_id,
          e.first_name,
          e.last_name,
          e.is_active,
          a.login_code,
          a.issued_at,
          a.last_used_at,
          a.locked_until,
          a.revoked_at
        FROM public.employees e
        LEFT JOIN public.technician_phone_access a
          ON a.employee_id = e.employee_id
        WHERE e.role = 'technician'
        ORDER BY e.last_name, e.first_name;
      `);

      res.json({ technicians: result.rows });
    } catch (error) {
      console.error("Could not load technician phone access:", error);
      res.status(500).json({ error: "Could not load technician phone access." });
    }
  }
);

app.post(
  "/api/admin/employees/:employeeId/phone-access",
  requireAuth,
  requireRole("admin"),
  async (req, res) => {
    const actor = req.session.employee!;
    const { employeeId } = req.params;

    if (typeof employeeId !== "string" || !/^\d+$/.test(employeeId)) {
      return res.status(400).json({ error: "Invalid employee ID." });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const targetResult = await client.query(
        `SELECT employee_id, first_name, last_name, role, is_active
         FROM public.employees WHERE employee_id = $1 FOR UPDATE;`,
        [Number(employeeId)]
      );
      const target = targetResult.rows[0];

      if (!target) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Employee not found." });
      }

      // The table's composite foreign key would refuse this anyway. Checking
      // here turns a constraint violation into a sentence.
      if (target.role !== "technician") {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error:
            `${target.first_name} ${target.last_name} is not a technician. ` +
            `The phone app is for field staff only.`,
        });
      }

      if (!target.is_active) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: `${target.first_name} ${target.last_name} is inactive.`,
        });
      }

      const passcode = generatePasscode();
      const passcodeHash = await bcrypt.hash(passcode, 12);

      // The code is re-derived on every issue, including a reissue, so a
      // technician carrying an old random code moves onto their name code the
      // next time the office hands them a passcode. That is safe precisely
      // BECAUSE it happens at issue time: a new passcode already invalidates
      // whatever is on their phone, so both halves are being replaced at the
      // same moment and go onto the same card. Changing the code at any other
      // point would break a credential that was still working.
      const base = deriveLoginCode(target.first_name, target.last_name);

      // Two Clarkes produce one code, so later ones take a digit. The check
      // ignores this technician's own row: somebody reissued twice should get
      // ACLARK again, not climb to ACLARK2 and then ACLARK3 for no reason.
      //
      // The unique index covers live credentials only, so a revoked ACLARK
      // does not stand in the way of the next person to need it.
      let loginCode = "";

      for (const suffix of ["", "2", "3", "4", "5", "6", "7", "8", "9"]) {
        const candidate = base + suffix;

        const taken = await client.query(
          `SELECT 1 FROM public.technician_phone_access
           WHERE login_code = $1 AND revoked_at IS NULL AND employee_id <> $2;`,
          [candidate, Number(employeeId)]
        );

        if (taken.rows.length === 0) {
          loginCode = candidate;
          break;
        }
      }

      // Nine people sharing an initial and the first five letters of a
      // surname. Vanishingly unlikely, but a random code is a better answer
      // than a failed request.
      if (!loginCode) {
        for (let attempt = 0; attempt < 10 && !loginCode; attempt += 1) {
          const candidate = generateLoginCode();
          const taken = await client.query(
            `SELECT 1 FROM public.technician_phone_access
             WHERE login_code = $1 AND revoked_at IS NULL;`,
            [candidate]
          );
          if (taken.rows.length === 0) loginCode = candidate;
        }
      }

      if (!loginCode) {
        await client.query("ROLLBACK");
        return res
          .status(500)
          .json({ error: "Could not allocate a technician code. Try again." });
      }

      await client.query(
        `
        INSERT INTO public.technician_phone_access
          (employee_id, login_code, passcode_hash, issued_by_employee_id)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (employee_id) DO UPDATE SET
          login_code = EXCLUDED.login_code,
          passcode_hash = EXCLUDED.passcode_hash,
          issued_by_employee_id = EXCLUDED.issued_by_employee_id,
          issued_at = CURRENT_TIMESTAMP,
          -- Reissuing is also the way an administrator releases a technician
          -- who has locked themselves out, so the counters reset here.
          failed_attempts = 0,
          locked_until = NULL,
          revoked_at = NULL,
          revoked_by_employee_id = NULL;
        `,
        [Number(employeeId), loginCode, passcodeHash, actor.employeeId]
      );

      // Records that it happened and to whom. Never the passcode.
      await client.query(
        `INSERT INTO public.audit_logs
           (employee_id, actor_name, action, entity_type, entity_id, field_name, new_value, reason)
         VALUES ($1, $2, $3, 'employee', $4, 'phone_access', $5, $6);`,
        [
          actor.employeeId,
          `${actor.firstName} ${actor.lastName}`,
          `Issued technician app access for ${target.first_name} ${target.last_name}`,
          String(target.employee_id),
          loginCode,
          typeof req.body.reason === "string"
            ? req.body.reason.trim().slice(0, 500) || null
            : null,
        ]
      );

      await client.query("COMMIT");

      res.json({
        loginCode,
        passcode,
        message:
          `Write these down and hand them to ${target.first_name} directly. ` +
          `The passcode is not shown again.`,
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      console.error("Could not issue technician phone access:", error);
      res.status(500).json({ error: "Could not issue phone access." });
    } finally {
      client.release();
    }
  }
);

app.delete(
  "/api/admin/employees/:employeeId/phone-access",
  requireAuth,
  requireRole("admin"),
  async (req, res) => {
    const actor = req.session.employee!;
    const { employeeId } = req.params;

    if (typeof employeeId !== "string" || !/^\d+$/.test(employeeId)) {
      return res.status(400).json({ error: "Invalid employee ID." });
    }

    try {
      const result = await pool.query(
        `
        UPDATE public.technician_phone_access
        SET revoked_at = CURRENT_TIMESTAMP, revoked_by_employee_id = $2
        WHERE employee_id = $1 AND revoked_at IS NULL
        RETURNING login_code;
        `,
        [Number(employeeId), actor.employeeId]
      );

      if (result.rows.length === 0) {
        return res
          .status(404)
          .json({ error: "That technician has no active phone access." });
      }

      // Live sessions are cut too. Revoking a lost phone that stays signed in
      // for another thirty days would not be revoking anything.
      await pool.query(
        `
        DELETE FROM public.user_sessions
        WHERE (sess -> 'technician' ->> 'employeeId') = $1;
        `,
        [String(Number(employeeId))]
      );

      await pool.query(
        `INSERT INTO public.audit_logs
           (employee_id, actor_name, action, entity_type, entity_id, field_name, old_value, reason)
         VALUES ($1, $2, 'Revoked technician app access', 'employee', $3, 'phone_access', $4, $5);`,
        [
          actor.employeeId,
          `${actor.firstName} ${actor.lastName}`,
          String(Number(employeeId)),
          result.rows[0].login_code,
          typeof req.body?.reason === "string"
            ? req.body.reason.trim().slice(0, 500) || null
            : null,
        ]
      );

      res.json({
        message: "Phone access revoked and any signed-in phone signed out.",
      });
    } catch (error) {
      console.error("Could not revoke technician phone access:", error);
      res.status(500).json({ error: "Could not revoke phone access." });
    }
  }
);


app.post("/api/auth/logout", async (req, res) => {
  // Close the history row before the session is destroyed, while the id is
  // still readable. Best-effort: failing to write history must not stop
  // somebody logging out.
  const loginSessionId = req.session?.loginSessionId;

  if (loginSessionId) {
    try {
      await pool.query(
        `UPDATE public.login_sessions
         SET ended_at = CURRENT_TIMESTAMP, end_reason = 'logout',
             last_seen_at = CURRENT_TIMESTAMP
         WHERE login_session_id = $1 AND ended_at IS NULL;`,
        [loginSessionId]
      );
    } catch (error) {
      console.error("Could not close login session:", error);
    }
  }

  // Destroy the server-side record before clearing the browser's session cookie.
  req.session.destroy((error) => {
    if (error) {
      console.error("Logout failed:", error);

      return res.status(500).json({
        error: "Could not log out.",
      });
    }

    // Must match the name the session is configured with above. This said
    // "connect.sid", express-session's default, so the real cookie was left
    // in the browser on logout — harmless, since the session id it holds is
    // already destroyed server-side, but it never actually cleared anything.
    res.clearCookie(process.env.SESSION_COOKIE_NAME || "spcl.sid");

    res.json({
      message: "Logged out.",
    });
  });
});


app.patch(
  "/api/customers/:customerId/profile",
  requireAuth,
  requireRole("admin", "head_office"),
  async (req, res) => {
    // Profile corrections are limited to Admin and Head Office. Package, rate, and status
    // changes remain in their dedicated workflows with their own safeguards.
    const { customerId } = req.params;
    if (typeof customerId !== "string" || !/^\d+$/.test(customerId)) {
      return res.status(400).json({ error: "Invalid customer ID" });
    }

    const requiredName = String(req.body.name ?? "").trim();
    const optionalText = (value: unknown) => {
      const cleaned = String(value ?? "").trim();
      return cleaned === "" ? null : cleaned;
    };
    const profile = {
      name: requiredName,
      address: optionalText(req.body.address),
      occupation: optionalText(req.body.occupation),
      telephone: optionalText(req.body.telephone),
      email: optionalText(req.body.email),
      id_type: optionalText(req.body.idType),
      id_number: optionalText(req.body.idNumber),
      pole_box_number: optionalText(req.body.poleBoxNumber),
      port_number: optionalText(req.body.portNumber),
      adult_channel: req.body.adultChannel,
    };
    const reason = String(req.body.reason ?? "").trim();

    if (profile.name.length < 2 || profile.name.length > 160) {
      return res.status(400).json({ error: "Customer name must be 2–160 characters." });
    }
    const lengthLimits: Array<[string, string | null, number]> = [
      ["Address", profile.address, 500],
      ["Occupation", profile.occupation, 160],
      ["Telephone", profile.telephone, 50],
      ["Email", profile.email, 254],
      ["ID type", profile.id_type, 80],
      ["ID number", profile.id_number, 100],
      ["Pole box", profile.pole_box_number, 80],
      ["Port", profile.port_number, 80],
    ];
    const invalidLength = lengthLimits.find(([, value, max]) => value !== null && value.length > max);
    if (invalidLength) {
      return res.status(400).json({ error: `${invalidLength[0]} is too long.` });
    }
    if (profile.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.email)) {
      return res.status(400).json({ error: "Enter a valid email address." });
    }
    if (typeof profile.adult_channel !== "boolean") {
      return res.status(400).json({ error: "Adult channel selection is required." });
    }
    if (reason.length < 3 || reason.length > 500) {
      return res.status(400).json({ error: "A reason between 3 and 500 characters is required." });
    }

    const employee = req.session.employee!;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const customerResult = await client.query(
        `SELECT name, address, occupation, telephone, email, id_type, id_number,
            pole_box_number, port_number, adult_channel
         FROM public.customers
         WHERE customer_id = $1
         FOR UPDATE;`,
        [Number(customerId)]
      );
      if (customerResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Customer not found." });
      }

      const current = customerResult.rows[0] as Record<string, string | boolean | null>;
      const changes = Object.entries(profile).filter(([field, value]) => current[field] !== value);
      if (changes.length === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "No profile changes were made." });
      }

      await client.query(
        `UPDATE public.customers SET
            name = $1, address = $2, occupation = $3, telephone = $4,
            email = $5, id_type = $6, id_number = $7,
            pole_box_number = $8, port_number = $9, adult_channel = $10
         WHERE customer_id = $11;`,
        [
          profile.name, profile.address, profile.occupation, profile.telephone,
          profile.email, profile.id_type, profile.id_number,
          profile.pole_box_number, profile.port_number, profile.adult_channel,
          Number(customerId),
        ]
      );

      // One row per changed field keeps the activity feed readable and makes
      // every correction independently traceable.
      for (const [field, value] of changes) {
        await client.query(
          `INSERT INTO public.audit_logs (
              employee_id, actor_name, action, entity_type, entity_id,
              field_name, old_value, new_value, reason, occurred_at
           ) VALUES ($1, $2, 'Edited customer profile', 'customer', $3,
              $4, $5, $6, $7, CURRENT_TIMESTAMP);`,
          [
            employee.employeeId,
            `${employee.firstName} ${employee.lastName}`,
            customerId,
            field,
            current[field] === null ? null : String(current[field]),
            value === null ? null : String(value),
            reason,
          ]
        );
      }

      await client.query("COMMIT");
      res.json({ customerId: Number(customerId), ...profile, changedFields: changes.map(([field]) => field) });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Could not update customer profile:", error);
      res.status(500).json({ error: "Could not update customer profile." });
    } finally {
      client.release();
    }
  }
);

app.patch(
  "/api/customers/:customerId/activation-date",
  requireAuth,
  requireRole("admin", "head_office"),
  async (req, res) => {
    // Activation date is the billing anchor - every monthly due date is derived
    // from it. Correcting it therefore means rebuilding the customer's charges,
    // which is only safe while nothing has been settled against them. A
    // customer who has been paying on a schedule keeps the date they have,
    // because moving it would rewrite bills they have already received.
    const { customerId } = req.params;
    if (typeof customerId !== "string" || !/^\d+$/.test(customerId)) {
      return res.status(400).json({ error: "Invalid customer ID" });
    }

    const activationDate = String(req.body.activationDate ?? "").trim();
    const reason = String(req.body.reason ?? "").trim();

    if (!/^\d{4}-\d{2}-\d{2}$/.test(activationDate)) {
      return res.status(400).json({ error: "Choose a valid activation date." });
    }
    if (reason.length < 3 || reason.length > 500) {
      return res.status(400).json({
        error: "A reason between 3 and 500 characters is required.",
      });
    }

    const employee = req.session.employee!;
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const customerResult = await client.query(
        `SELECT customer_id, name, activation_date, status
           FROM public.customers
          WHERE customer_id = $1
          FOR UPDATE;`,
        [Number(customerId)]
      );
      if (customerResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Customer not found." });
      }

      const customer = customerResult.rows[0];

      // Sanity bounds. A date before the company existed or years into the
      // future is a typo, and a typo here silently reschedules their billing.
      const boundsResult = await client.query(
        `SELECT
            $1::DATE < DATE '2000-01-01' AS too_early,
            $1::DATE > ((CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE + 90)
              AS too_late,
            $1::DATE = $2::DATE AS unchanged;`,
        [activationDate, customer.activation_date]
      );
      const bounds = boundsResult.rows[0];

      if (bounds.too_early || bounds.too_late) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error:
            "That activation date is outside the range this can be corrected to.",
        });
      }
      if (bounds.unchanged) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: "That is already the activation date.",
        });
      }

      // Eligibility. The window closes the moment they are first billed: up
      // to that point the assigned billing date is just a plan and moving it
      // costs nothing, but the first charge is a bill the customer has been
      // given, and changing the date it was derived from would contradict it.
      //
      // The installation fee collected on their application does not count.
      // Every newly activated customer carries one from the moment they are
      // created, so counting it would shut this window before anybody could
      // use it - and it says nothing about billing, which is what the rule is
      // actually protecting: it is one-off work, posts nothing to the ledger,
      // and is dated before the activation date rather than derived from it.
      const historyResult = await client.query(
        `SELECT
            (SELECT count(*) FROM public.payments
              WHERE customer_id = $1
                AND application_id IS NULL)::INTEGER AS payments,
            (SELECT count(*) FROM public.account_ledger_entries
              WHERE customer_id = $1
                AND entry_type = 'monthly_charge')::INTEGER AS charges,
            (SELECT count(*) FROM public.waiver_requests
              WHERE customer_id = $1)::INTEGER AS waivers,
            (SELECT count(*) FROM public.reconnection_requests
              WHERE customer_id = $1)::INTEGER AS reconnections;`,
        [Number(customerId)]
      );
      const history = historyResult.rows[0];

      if (
        history.charges > 0 ||
        history.payments > 0 ||
        history.waivers > 0 ||
        history.reconnections > 0
      ) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error:
            "This customer has already been billed on their current " +
            "activation date, so it can no longer be corrected here. Ask an " +
            "administrator to adjust it directly.",
        });
      }

      await client.query(
        `UPDATE public.customers
            SET activation_date = $1::DATE
          WHERE customer_id = $2;`,
        [activationDate, Number(customerId)]
      );

      // Rebuild rather than leave the old anniversary behind - see migration
      // 040 for why a stale charge set is the dangerous outcome here.
      const rebuiltResult = await client.query(
        `SELECT public.spcl_regenerate_customer_charges(
            $1,
            (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE
         ) AS rebuilt;`,
        [Number(customerId)]
      );

      await client.query(
        `INSERT INTO public.audit_logs (
            employee_id, actor_name, action, entity_type, entity_id,
            field_name, old_value, new_value, reason, occurred_at
         ) VALUES ($1, $2, 'Corrected activation date', 'customer', $3,
            'activation_date', $4, $5, $6, CURRENT_TIMESTAMP);`,
        [
          employee.employeeId,
          `${employee.firstName} ${employee.lastName}`,
          customerId,
          customer.activation_date === null
            ? null
            : String(customer.activation_date),
          activationDate,
          reason,
        ]
      );

      await client.query("COMMIT");

      res.json({
        customerId: Number(customerId),
        activationDate,
        chargesRebuilt: Number(rebuiltResult.rows[0].rebuilt),
      });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Could not correct the activation date:", error);
      res.status(500).json({ error: "Could not correct the activation date." });
    } finally {
      client.release();
    }
  }
);

app.patch(
  "/api/customers/:customerId/subscription",
  requireAuth,
  requireRole("admin", "head_office"),
  async (req, res) => {
    // A subscription change selects a catalog rate; it never edits past
    // ledger charges. The effective-dated row is used on future anniversaries.
    const { customerId } = req.params;
    const packageIdText = String(req.body.packageId ?? "").trim();
    const reason = String(req.body.reason ?? "").trim();

    if (typeof customerId !== "string" || !/^\d+$/.test(customerId)) {
      return res.status(400).json({ error: "Invalid customer ID" });
    }
    if (!/^\d+$/.test(packageIdText)) {
      return res.status(400).json({ error: "Select a valid package." });
    }
    if (reason.length < 3) {
      return res.status(400).json({ error: "A reason for the package change is required." });
    }

    const employee = req.session.employee!;
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const customerResult = await client.query(
        `SELECT c.customer_id, c.package_id, c.monthly_fee, c.status,
            old_package.name AS package_name
         FROM public.customers c
         LEFT JOIN public.packages old_package ON old_package.package_id = c.package_id
         WHERE c.customer_id = $1
         FOR UPDATE OF c;`,
        [Number(customerId)]
      );
      if (customerResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Customer not found." });
      }

      const packageResult = await client.query(
        `SELECT package_id, name, default_monthly_charge, service_type,
            plan_tier, speed_mbps
         FROM public.packages
         WHERE package_id = $1 AND is_active = TRUE;`,
        [Number(packageIdText)]
      );
      if (packageResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Selected package is not available." });
      }

      const customer = customerResult.rows[0];
      if (customer.status === "terminated") {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: "A terminated subscription cannot be changed.",
        });
      }
      const selectedPackage = packageResult.rows[0];
      const newFee = Number(selectedPackage.default_monthly_charge).toFixed(2);
      if (
        Number(customer.package_id) === Number(selectedPackage.package_id) &&
        Number(customer.monthly_fee) === Number(newFee)
      ) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "The customer already has this package and catalog rate." });
      }

      await client.query(
        `UPDATE public.customers
         SET package_id = $1, monthly_fee = $2
         WHERE customer_id = $3;`,
        [selectedPackage.package_id, newFee, Number(customerId)]
      );

      await client.query(
        `INSERT INTO public.customer_rate_history (
            customer_id, package_id, monthly_fee, effective_date, reason,
            changed_by_employee_id, is_legacy_estimate
         ) VALUES (
            $1, $2, $3,
            (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
            $4, $5, FALSE
         );`,
        [Number(customerId), selectedPackage.package_id, newFee, reason, employee.employeeId]
      );

      await client.query(
        `INSERT INTO public.audit_logs (
            employee_id, actor_name, action, entity_type, entity_id,
            field_name, old_value, new_value, reason, occurred_at
         ) VALUES ($1, $2, $3, 'customer', $4, 'subscription', $5, $6, $7, CURRENT_TIMESTAMP);`,
        [
          employee.employeeId,
          `${employee.firstName} ${employee.lastName}`,
          "Changed customer package",
          customerId,
          `${customer.package_name ?? "No package"} @ J$${Number(customer.monthly_fee ?? 0).toFixed(2)}`,
          `${selectedPackage.name} @ J$${newFee}`,
          reason,
        ]
      );

      await client.query("COMMIT");
      res.json({
        customerId: Number(customerId),
        packageId: selectedPackage.package_id,
        packageName: selectedPackage.name,
        serviceType: selectedPackage.service_type,
        planTier: selectedPackage.plan_tier,
        speedMbps: selectedPackage.speed_mbps,
        monthlyFee: newFee,
        effectiveDate: new Intl.DateTimeFormat("en-CA", {
          timeZone: "America/Jamaica",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date()),
      });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Could not update customer subscription:", error);
      res.status(500).json({ error: "Could not update customer subscription." });
    } finally {
      client.release();
    }
  }
);

/**
 * Serve the built React frontend from the same process as the API.
 *
 * One origin means no CORS, and session cookies behave the same way in the
 * browser, in the Electron client, and over Tailscale HTTPS. The static mount
 * is registered after every /api route so it can never shadow the API.
 */
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

const CLIENT_DIST_PATH = path.resolve(
  process.env.CLIENT_DIST_PATH ||
    path.join(currentDirectory, "..", "client-dist")
);

const clientBuildExists = existsSync(
  path.join(CLIENT_DIST_PATH, "index.html")
);

if (clientBuildExists) {
  // Hashed asset filenames can be cached hard; index.html must not be, or staff
  // keep running an old build after a deployment.
  app.use(
    express.static(CLIENT_DIST_PATH, {
      index: false,
      maxAge: "1y",

      setHeaders: (res, filePath) => {
        if (filePath.endsWith("index.html")) {
          res.setHeader("Cache-Control", "no-store");
        }
      },
    })
  );

  // Client-side routing: anything that is not an API call returns the shell.
  app.get(/^\/(?!api\/|health$).*/, (req, res) => {
    res.sendFile(path.join(CLIENT_DIST_PATH, "index.html"));
  });
} else if (IS_PRODUCTION) {
  console.warn(
    `No frontend build found at ${CLIENT_DIST_PATH}. Serving the API only.`
  );
}

const server = app.listen(PORT, HOST, () => {
  console.log(`SPCL API listening on ${HOST}:${PORT}`);
});

// The scheduler itself always starts, but its master switch defaults to off.
// This lets the API report the configured state consistently after restarts.
const stopDelinquentAutomation = startDelinquentAutomation();
const stopReconnectionAutomation = startReconnectionAutomation();
const stopDisconnectionEmailReminders = startDisconnectionEmailReminders();

/**
 * Containers are stopped with SIGTERM. Closing the HTTP server and the database
 * pool means in-flight requests finish instead of being cut off mid-transaction.
 */
function shutdown(signal: string) {
  console.log(`${signal} received, shutting down.`);
  stopDelinquentAutomation();
  stopReconnectionAutomation();
  stopDisconnectionEmailReminders();

  server.close(() => {
    pool.end().then(
      () => process.exit(0),
      () => process.exit(1)
    );
  });

  // Do not hang forever if a connection refuses to close.
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
