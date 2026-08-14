import bcrypt from "bcrypt";
import { pool } from "../db.js";

async function seedDevEmployee() {
  try {
    const username = "admin";
    const password = "devpassword123";

    const passwordHash = await bcrypt.hash(password, 12);

    const locationResult = await pool.query(
      `
      SELECT location_id
      FROM public.locations
      WHERE code = 'HO'
      LIMIT 1;
      `
    );

    if (locationResult.rows.length === 0) {
      throw new Error("Head Office location does not exist.");
    }

    const locationId = locationResult.rows[0].location_id;

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
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6
      )
      ON CONFLICT DO NOTHING;
      `,
      [
        "Dev",
        "Admin",
        username,
        passwordHash,
        "admin",
        locationId,
      ]
    );

    console.log("Development employee ready.");
    console.log("Username: admin");
    console.log("Password: devpassword123");
  } catch (error) {
    console.error("Could not seed employee:", error);
  } finally {
    await pool.end();
  }
}

seedDevEmployee();