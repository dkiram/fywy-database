/**
 * Creates real staff records from a list supplied on stdin.
 *
 *   ssh -p 9222 SPCNAS@100.98.108.77 \
 *     'docker exec -i spcl-api node dist/scripts/createEmployees.js --dry-run' < staff.json
 *
 *   ...then the same without --dry-run once the summary looks right.
 *
 * The people are NOT in this file, and must never be. Temp passwords in a
 * committed file would be temp passwords in git history forever, and every
 * new hire would otherwise mean another migration. The code is committed; the
 * list is not. Piping over stdin means the passwords never touch the NAS's
 * disk either - they exist in the local file, in memory for the length of the
 * run, and after that only as bcrypt hashes.
 *
 * Input is a JSON array. Two shapes, and the database enforces the
 * difference:
 *
 *   system user - someone who logs in
 *     { "firstName": "Kimone", "lastName": "Dunn", "role": "head_office",
 *       "locationCode": "HO", "username": "kdunn", "password": "..." }
 *
 *   technician  - someone who gets assigned work but never logs in
 *     { "firstName": "Suwayne", "lastName": "Frith", "role": "technician",
 *       "locationCode": "HO" }
 *
 * Re-running is safe. Anyone already present is reported as skipped rather
 * than duplicated, so a partial run can simply be repeated.
 */
import bcrypt from "bcrypt";
import { pool } from "../db.js";

type Role = "admin" | "head_office" | "branch" | "technician";

type Person = {
  firstName: string;
  lastName: string;
  role: Role;
  locationCode: string;
  username?: string;
  password?: string;
};

const ROLES: Role[] = ["admin", "head_office", "branch", "technician"];

// bcrypt's own limit is 72 bytes; anything longer is silently truncated,
// which would make two different passwords equivalent.
const MAX_PASSWORD_BYTES = 72;
const MIN_PASSWORD_LENGTH = 12;

const DRY_RUN = process.argv.includes("--dry-run");

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

/**
 * Rejects the whole file rather than importing the good half. A partial
 * staff list is harder to reason about than none at all, and re-running
 * after a fix is free.
 */
function validate(people: unknown): Person[] {
  if (!Array.isArray(people)) {
    throw new Error("Expected a JSON array of people.");
  }

  if (people.length === 0) {
    throw new Error("The list is empty.");
  }

  const problems: string[] = [];
  const seenUsernames = new Set<string>();

  const validated = people.map((entry, index) => {
    const where = `entry ${index + 1}`;
    const person = entry as Person;

    const firstName = String(person.firstName ?? "").trim();
    const lastName = String(person.lastName ?? "").trim();
    const role = String(person.role ?? "").trim() as Role;
    const locationCode = String(person.locationCode ?? "").trim();
    const username = person.username?.trim();
    const password = person.password;

    if (!firstName) problems.push(`${where}: firstName is required`);
    if (!lastName) problems.push(`${where}: lastName is required`);
    if (!locationCode) problems.push(`${where}: locationCode is required`);

    if (!ROLES.includes(role)) {
      problems.push(
        `${where}: role must be one of ${ROLES.join(", ")} (got "${person.role}")`
      );
    }

    if (role === "technician") {
      // Not a style preference - the database rejects it too. Catching it
      // here gives a readable message instead of a constraint violation.
      if (username || password) {
        problems.push(
          `${where}: technicians never log in, so remove username and password`
        );
      }
    } else {
      if (!username) problems.push(`${where}: username is required for ${role}`);
      if (!password) problems.push(`${where}: password is required for ${role}`);

      if (password && password.length < MIN_PASSWORD_LENGTH) {
        problems.push(
          `${where}: password must be at least ${MIN_PASSWORD_LENGTH} characters`
        );
      }

      if (password && Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) {
        problems.push(
          `${where}: password is over ${MAX_PASSWORD_BYTES} bytes, which bcrypt truncates`
        );
      }

      if (username) {
        const key = username.toLowerCase();

        if (seenUsernames.has(key)) {
          problems.push(`${where}: username "${username}" appears twice in this file`);
        }

        seenUsernames.add(key);
      }
    }

    return { firstName, lastName, role, locationCode, username, password };
  });

  if (problems.length > 0) {
    throw new Error(`Nothing was created:\n  ${problems.join("\n  ")}`);
  }

  return validated;
}

async function createEmployees() {
  const client = await pool.connect();

  const created: string[] = [];
  const skipped: string[] = [];

  try {
    const people = validate(JSON.parse(await readStdin()));

    // One transaction for the whole file. Either the list goes in or it
    // does not; half a staff list is a confusing thing to debug later.
    await client.query("BEGIN");

    for (const person of people) {
      const label = `${person.firstName} ${person.lastName} (${person.role})`;

      const location = await client.query(
        `SELECT location_id FROM public.locations WHERE UPPER(code) = UPPER($1) LIMIT 1;`,
        [person.locationCode]
      );

      if (location.rows.length === 0) {
        const available = await client.query(
          `SELECT code, name FROM public.locations WHERE is_active = TRUE ORDER BY code;`
        );

        throw new Error(
          `${label}: no location with code "${person.locationCode}". ` +
            `Available: ${available.rows.map((r) => `${r.code} (${r.name})`).join(", ")}`
        );
      }

      const locationId = location.rows[0].location_id;

      // Technicians have no username to match on, so identity falls back to
      // the name. Two genuinely different technicians with the same name
      // would need distinguishing by hand - rare enough to be worth the
      // simpler rule, and far better than silently creating duplicates
      // every time this is re-run.
      const existing = person.username
        ? await client.query(
            `SELECT employee_id FROM public.employees WHERE LOWER(username) = LOWER($1);`,
            [person.username]
          )
        : await client.query(
            `SELECT employee_id FROM public.employees
             WHERE LOWER(first_name) = LOWER($1)
               AND LOWER(last_name) = LOWER($2)
               AND role = 'technician';`,
            [person.firstName, person.lastName]
          );

      if (existing.rows.length > 0) {
        skipped.push(`${label} - already exists`);
        continue;
      }

      if (DRY_RUN) {
        created.push(`${label} at ${person.locationCode}`);
        continue;
      }

      const passwordHash = person.password
        ? await bcrypt.hash(person.password, 12)
        : null;

      await client.query(
        `
        INSERT INTO public.employees (
          first_name, last_name, username, password_hash, role, location_id
        )
        VALUES ($1, $2, $3, $4, $5, $6);
        `,
        [
          person.firstName,
          person.lastName,
          person.username ?? null,
          passwordHash,
          person.role,
          locationId,
        ]
      );

      created.push(`${label} at ${person.locationCode}`);
    }

    if (DRY_RUN) {
      await client.query("ROLLBACK");
    } else {
      await client.query("COMMIT");
    }

    console.log(DRY_RUN ? "Dry run - nothing was written.\n" : "Done.\n");

    console.log(`${DRY_RUN ? "Would create" : "Created"}: ${created.length}`);
    for (const line of created) console.log(`  + ${line}`);

    if (skipped.length > 0) {
      console.log(`\nSkipped: ${skipped.length}`);
      for (const line of skipped) console.log(`  - ${line}`);
    }

    if (!DRY_RUN && created.length > 0) {
      console.log(
        "\nHand each person their temp password directly, not over a group chat,"
      );
      console.log("and have them change it at first login.");
    }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);

    console.error(
      "\nNo employees were created:\n",
      error instanceof Error ? error.message : error
    );

    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

createEmployees();
