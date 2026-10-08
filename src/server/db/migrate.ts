/**
 * Applies pending SQL migrations from ./drizzle.
 * Run with: npm run db:migrate  (uses DATABASE_URL)
 *
 * Takes the shared migration lock (scripts/migrate-on-build.mjs takes the
 * same one), so two migration runs against one database never overlap.
 */
import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

/** Shared with scripts/migrate-on-build.mjs — one migration run per database at a time. */
const MIGRATION_LOCK = "gokesari-migrations";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");

  // Managed providers require TLS; read the flag from the URL rather than
  // assuming, so the same script works against localhost and against Neon.
  const sslmode = new URL(url).searchParams.get("sslmode");
  const ssl = !sslmode || sslmode === "disable" ? false : ("require" as const);

  const client = postgres(url, { max: 1, ssl });
  try {
    await client`select pg_advisory_lock(hashtext(${MIGRATION_LOCK}))`;
    await migrate(drizzle(client), { migrationsFolder: "./drizzle" });
    console.log("Migrations applied.");
  } finally {
    await client`select pg_advisory_unlock_all()`.catch(() => {});
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
