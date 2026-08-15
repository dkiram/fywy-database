import bcrypt from "bcrypt";
import { pool } from "../db.js";

type DevEmployee = {
  firstName: string;
  lastName: string;
  username: string;
  password: string;
  role: "admin" | "head_office" | "branch";
  locationCode: string;
};

const employees: DevEmployee[] = [
  {
    firstName: "Dev",
    lastName: "Admin",
    username: "admin",
    password: "devpassword123",
    role: "admin",
    locationCode: "HO",
  },
  {
    firstName: "Dev",
    lastName: "Head Office",
    username: "headoffice",
    password: "devpassword123",
    role: "head_office",
    locationCode: "HO",
  },
  {
    firstName: "Dev",
    lastName: "Branch",
    username: "branch",
    password: "devpassword123",
    role: "branch",
    locationCode: "DEV",
  },
];

async function seedDevEmployees() {
  try {
    for (const employee of employees) {
      const passwordHash = await bcrypt.hash(
        employee.password,
        12
      );

      const locationResult = await pool.query(
        `
        SELECT location_id
        FROM public.locations
        WHERE code = $1
        LIMIT 1;
        `,
        [employee.locationCode]
      );

      if (locationResult.rows.length === 0) {
        throw new Error(
          `Location ${employee.locationCode} does not exist.`
        );
      }

      const locationId =
        locationResult.rows[0].location_id;

      await pool.query(
        `
        INSERT INTO public.employees (
          first_name,
          last_name,
          username,
          password_hash,
          role,
          location_id
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT DO NOTHING;
        `,
        [
          employee.firstName,
          employee.lastName,
          employee.username,
          passwordHash,
          employee.role,
          locationId,
        ]
      );
    }

    console.log("Development employees ready.");
    console.log("");
    console.log("admin / devpassword123");
    console.log("headoffice / devpassword123");
    console.log("branch / devpassword123");
  } catch (error) {
    console.error(
      "Could not seed development employees:",
      error
    );
  } finally {
    await pool.end();
  }
}

seedDevEmployees();