/**
 * Applies the PMD schema migrations in ./drizzle-pmd.
 * Run with: npm run pmd:migrate
 *
 * Separate from `npm run db:migrate` because PMD lives in its own MySQL
 * database, `pmd`, on the same server as the application. PostgreSQL had it as
 * a schema inside the application's database; MySQL has no schema-within-a-
 * database, but `database.table` is the same two-part name, so a database
 * called `pmd` leaves every `pmd.<table>` reference in the application working
 * unchanged.
 *
 * Why the same server rather than its own: pmd.catalogue_link has foreign keys
 * into the application's `products` and `users`, which MySQL permits across
 * databases but not across servers. The migration substitutes `@APP_DB@` with
 * the application database named in the connection URL.
 */
import "dotenv/config";
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";

import { createConnection, type Connection } from "mysql2/promise";

const MIGRATIONS_DIR = "./drizzle-pmd";
const PMD_DATABASE = "pmd";

/** The database a MySQL URL points at — the application's own. */
function appDatabase(url: string): string {
  const name = new URL(url).pathname.replace(/^\//, "");
  if (!name) throw new Error(`no database in the connection URL: ${url.replace(/:[^:@/]*@/, ":***@")}`);
  return name;
}

function sslFor(url: string) {
  const params = new URL(url).searchParams;
  const mode = (params.get("ssl-mode") ?? params.get("sslmode") ?? "").toLowerCase();
  return !mode || mode === "disabled" || mode === "disable" ? undefined : { minVersion: "TLSv1.2" as const };
}

async function applied(connection: Connection): Promise<Set<string>> {
  await connection.query(
    `CREATE TABLE IF NOT EXISTS \`${PMD_DATABASE}\`.__migrations (
       name       varchar(191) NOT NULL PRIMARY KEY,
       applied_at datetime(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
     )`,
  );
  const [rows] = await connection.query(`SELECT name FROM \`${PMD_DATABASE}\`.__migrations`);
  return new Set((rows as { name: string }[]).map((r) => r.name));
}

async function main() {
  // PMD_DATABASE_URL is honoured for the case where PMD is pointed at a
  // different server on purpose, but it must name a MySQL server now.
  const url = process.env.PMD_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("neither PMD_DATABASE_URL nor DATABASE_URL is set");
  if (/^postgres(ql)?:/i.test(url)) {
    throw new Error(
      "the PMD connection URL is PostgreSQL. PMD has been ported to MySQL; " +
        "point it at the MySQL server that holds the application database.",
    );
  }

  const appDb = appDatabase(url);
  const connection = await createConnection({
    uri: url,
    ssl: sslFor(url),
    timezone: "Z",
    // one file is sent as one statement batch rather than being split on ';',
    // which a view body or a CHECK expression could otherwise break
    multipleStatements: true,
  });

  try {
    await connection.query(
      `CREATE DATABASE IF NOT EXISTS \`${PMD_DATABASE}\`
         CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
    const done = await applied(connection);

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    let ran = 0;
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = (await readFile(path.join(MIGRATIONS_DIR, file), "utf8")).replaceAll("@APP_DB@", appDb);
      console.log(`applying ${file}`);
      await connection.query(sql);
      await connection.query(`INSERT INTO \`${PMD_DATABASE}\`.__migrations (name) VALUES (?)`, [file]);
      ran += 1;
    }
    console.log(
      ran === 0
        ? `PMD migrations already up to date (${files.length} applied).`
        : `PMD migrations applied: ${ran} of ${files.length}.`,
    );
  } finally {
    await connection.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
