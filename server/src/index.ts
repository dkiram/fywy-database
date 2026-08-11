import express from "express";
import { pool } from "./db.js";
import cors from "cors";

const app = express();

app.use(
  cors({
    origin: "http://localhost:5173",
  })
);


const PORT = 3000;

app.use(express.json());

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

app.get("/api/customers", async (req, res) => {
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

app.get("/api/customers/:customerId", async (req, res) => {
  try {
    const { customerId } = req.params;

    if (!/^\d+$/.test(customerId)) {
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

app.listen(PORT, () => {
  console.log(`SPCL API running on http://localhost:${PORT}`);
});