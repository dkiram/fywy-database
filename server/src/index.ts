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
import applicationsRouter from "./routes/applications.js";
import paymentsRouter from "./routes/payments.js";
import accountsRouter from "./routes/accounts.js";
import serviceTicketsRouter from "./routes/serviceTickets.js";
import poleBoxesRouter from "./routes/poleBoxes.js";
import reportsRouter from "./routes/reports.js";
import dashboardRouter from "./routes/dashboard.js";

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

    // Do not advertise the framework in the cookie name.
    name: process.env.SESSION_COOKIE_NAME || "spcl.sid",

    cookie: {
      httpOnly: true,

      // Only send the cookie over HTTPS in production. Set
      // SESSION_COOKIE_SECURE=false if the deployment is temporarily on plain
      // HTTP over the LAN, otherwise nobody will be able to log in.
      secure: process.env.SESSION_COOKIE_SECURE
        ? process.env.SESSION_COOKIE_SECURE === "true"
        : IS_PRODUCTION,

      sameSite: "lax",

      // 8 hours
      maxAge: 1000 * 60 * 60 * 8,
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

      WHERE
        $1 = ''
        OR c.customer_id::TEXT ILIKE $2
        OR c.name ILIKE $2
        OR c.telephone ILIKE $2

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
        $1 = ''
        OR audit.actor_name ILIKE $2
        OR employee.first_name ILIKE $2
        OR employee.last_name ILIKE $2
        OR CONCAT_WS(' ', employee.first_name, employee.last_name) ILIKE $2
        OR employee.username ILIKE $2
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

      LIMIT 1;
      `,
      [username.trim()]
    );

    const employee = result.rows[0];

    if (!employee) {
      return res.status(401).json({
        error: "Invalid username or password.",
      });
    }

    if (!employee.is_active) {
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
      return res.status(401).json({
        error: "Invalid username or password.",
      });
    }

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


app.post("/api/auth/logout", (req, res) => {
  // Destroy the server-side record before clearing the browser's session cookie.
  req.session.destroy((error) => {
    if (error) {
      console.error("Logout failed:", error);

      return res.status(500).json({
        error: "Could not log out.",
      });
    }

    res.clearCookie("connect.sid");

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
        `SELECT c.customer_id, c.package_id, c.monthly_fee,
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

/**
 * Containers are stopped with SIGTERM. Closing the HTTP server and the database
 * pool means in-flight requests finish instead of being cut off mid-transaction.
 */
function shutdown(signal: string) {
  console.log(`${signal} received, shutting down.`);

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
