/** Creates the shared PostgreSQL connection pool used by every API route and script. */
import { Pool } from "pg";
import "dotenv/config";

export const pool = new Pool({
  host: process.env.POSTGRES_HOST,
  port: Number(process.env.POSTGRES_PORT),
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB,
});
