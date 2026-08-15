import express from "express";
import { pool } from "./db.js";
import cors from "cors";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import bcrypt from "bcrypt";

import type {
  Request,
  Response,
  NextFunction,
} from "express";

const app = express();

const PgSession = connectPgSimple(session);


app.use(
  cors({
    origin: "http://localhost:5173",
    credentials: true,
  })
);


const PORT = 3000;

app.use(express.json());

app.use(
  session({
    store: new PgSession({
      pool,
      tableName: "user_sessions",
      schemaName: "public",
    }),

    secret: process.env.SESSION_SECRET!,

    resave: false,
    saveUninitialized: false,

    cookie: {
      httpOnly: true,
      secure: false,
      sameSite: "lax",

      // 8 hours
      maxAge: 1000 * 60 * 60 * 8,
    },
  })
);


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


app.get("/", (req, res) => {
  res.send("SPCL API is running");
});

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
        c.telephone,
        c.email,

        c.package_id,
        c.monthly_fee,

        c.application_date,
        c.activation_date,
        c.deactivation_date,
        c.reactivation_date,

        c.status,
        c.adult_channel,

        c.pole_box_number,
        c.port_number,

        p.name AS package_name,
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
          cashier_name
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


app.get("/api/audit-logs", requireAuth, async (_req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        audit_log_id,
        actor_name,
        action,
        entity_type,
        entity_id,
        field_name,
        old_value,
        new_value,
        reason,
        occurred_at
      FROM public.audit_logs
      ORDER BY occurred_at DESC, audit_log_id DESC
      LIMIT 100;
      `
    );

    res.json({
      auditLogs: result.rows,
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

    const passwordMatches = await bcrypt.compare(
      password,
      employee.password_hash
    );

    if (!passwordMatches) {
      return res.status(401).json({
        error: "Invalid username or password.",
      });
    }

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



app.get(
  "/api/admin/employees",
  requireAuth,
  requireRole("admin"),
  async (req, res) => {
    try {
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
  "/api/customers/:customerId/monthly-fee",
  requireAuth,
  requireRole("admin", "head_office"),
  async (req, res) => {
    const { monthlyFee, reason } = req.body;

    const { customerId } = req.params;

if (
  typeof customerId !== "string" ||
  !/^\d+$/.test(customerId)
) {
  return res.status(400).json({
    error: "Invalid customer ID",
  });
}

    const feeText = String(monthlyFee ?? "").trim();

    if (!/^\d+(\.\d{1,2})?$/.test(feeText)) {
      return res.status(400).json({
        error: "Enter a valid monthly fee.",
      });
    }

    if (
      typeof reason !== "string" ||
      reason.trim().length < 3
    ) {
      return res.status(400).json({
        error: "A reason for the rate change is required.",
      });
    }

    const employee = req.session.employee!;

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const customerResult = await client.query(
        `
        SELECT
          customer_id,
          monthly_fee
        FROM public.customers
        WHERE customer_id = $1
        FOR UPDATE;
        `,
        [Number(customerId)]
      );

      if (customerResult.rows.length === 0) {
        await client.query("ROLLBACK");

        return res.status(404).json({
          error: "Customer not found.",
        });
      }

      const customer = customerResult.rows[0];

      const oldFee =
        customer.monthly_fee === null
          ? null
          : String(customer.monthly_fee);

      const newFee = Number(feeText).toFixed(2);

      if (oldFee !== null && Number(oldFee) === Number(newFee)) {
        await client.query("ROLLBACK");

        return res.status(400).json({
          error: "The monthly fee has not changed.",
        });
      }

      await client.query(
        `
        UPDATE public.customers
        SET monthly_fee = $1
        WHERE customer_id = $2;
        `,
        [newFee, Number(customerId)]
      );

      await client.query(
        `
        INSERT INTO public.audit_logs (
          actor_name,
          action,
          entity_type,
          entity_id,
          field_name,
          old_value,
          new_value,
          reason,
          occurred_at
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          CURRENT_TIMESTAMP
        );
        `,
        [
          `${employee.firstName} ${employee.lastName}`,
          "Changed customer monthly rate",
          "customer",
          customerId,
          "monthly_fee",
          oldFee,
          newFee,
          reason.trim(),
        ]
      );

      await client.query("COMMIT");

      res.json({
        customerId: Number(customerId),
        monthlyFee: newFee,
      });
    } catch (error) {
      await client.query("ROLLBACK");

      console.error(
        "Could not update monthly fee:",
        error
      );

      res.status(500).json({
        error: "Could not update monthly fee.",
      });
    } finally {
      client.release();
    }
  }
);

app.listen(PORT, () => {
  console.log(`SPCL API running on http://localhost:${PORT}`);
});
