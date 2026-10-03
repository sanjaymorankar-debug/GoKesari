/**
 * Applies pending SQL migrations from ./drizzle.
 * Run with: npm run db:migrate  (uses DATABASE_URL)
 */
import "dotenv/config";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import { createConnection } from "mysql2/promise";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");

  // Managed providers require TLS; read the flag from the URL rather than
  // assuming, so the same script works against localhost and against RDS.
  const params = new URL(url).searchParams;
  const mode = (
    params.get("ssl-mode") ??
    params.get("sslmode") ??
    ""
  ).toLowerCase();
  const ssl =
    !mode || mode === "disabled" || mode === "disable"
      ? undefined
      : { minVersion: "TLSv1.2" as const };

  // Same UTC handling as the request-path pool (src/server/db/index.ts): a
  // migration that backfills a DATETIME must not shift it by the host offset.
  // multipleStatements is what lets one migration file carry several DDL
  // statements, which the Postgres driver allowed implicitly.
  const connection = await createConnection({
    uri: url,
    ssl,
    timezone: "Z",
    multipleStatements: true,
  });
  try {
    await migrate(drizzle(connection), { migrationsFolder: "./drizzle" });
    console.log("Migrations applied.");
  } finally {
    await connection.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
