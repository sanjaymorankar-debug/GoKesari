/**
 * Runs first in `npm run build`, before `next build`. With MIGRATE_ON_BUILD=true
 * it applies pending migrations from ./drizzle, so a deploy migrates the
 * database before the new code is built — migrate first, deploy second
 * (docs/gokesari-audit/DEPLOY_RUNBOOK.md §0). If the migration fails the script
 * exits non-zero and `next build` never runs.
 *
 * Off unless the variable is set: an environment without it builds exactly as
 * before and is migrated by hand (npm run db:migrate). Set it per environment
 * in the host's environment variables — test.gokesari.com first. DEPLOYMENT.md §4.
 *
 * Plain Node, dependencies only (no tsx): the host may build without
 * devDependencies.
 *
 * Holds the shared migration lock (a Postgres advisory lock, the same one
 * src/server/db/migrate.ts takes) while it migrates, so this and the
 * test-db workflow (.github/workflows/test-db.yml) can start at the same
 * moment: one applies the migrations, the other waits and finds nothing to do.
 */
import nextEnv from "@next/env";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const TAG = "[migrate-on-build]";
/** Shared with src/server/db/migrate.ts — one migration run per database at a time. */
const MIGRATION_LOCK = "gokesari-migrations";

// The same .env files and precedence `next build` uses, so this sees exactly
// the variables the build sees, however the host provides them.
nextEnv.loadEnvConfig(process.cwd());

if (!/^(1|true)$/i.test(process.env.MIGRATE_ON_BUILD ?? "")) {
  console.log(
    `${TAG} skipped: MIGRATE_ON_BUILD is not "true". Migrations are applied by hand (npm run db:migrate).`,
  );
  process.exit(0);
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error(`${TAG} FAILED: MIGRATE_ON_BUILD is on but DATABASE_URL is not set. Build stopped.`);
  process.exit(1);
}

// Same TLS rule as src/server/db/migrate.ts.
const sslmode = new URL(url).searchParams.get("sslmode");
const ssl = !sslmode || sslmode === "disable" ? false : "require";

/** Rows in drizzle's migration journal; 0 on a database never migrated. */
async function recorded(sql) {
  const [{ table }] = await sql`select to_regclass('drizzle.__drizzle_migrations') as table`;
  if (!table) return { count: 0, newest: "none" };
  const [row] = await sql`
    select count(*)::int as count, max(created_at)::text as newest
    from drizzle.__drizzle_migrations`;
  return { count: row.count, newest: row.newest ?? "none" };
}

const client = postgres(url, { max: 1, ssl, onnotice: () => {} });
try {
  const [{ db }] = await client`select current_database() as db`;
  const [{ got }] = await client`select pg_try_advisory_lock(hashtext(${MIGRATION_LOCK})) as got`;
  if (!got) {
    console.log(`${TAG} another migration is running on "${db}" — waiting for it to finish.`);
    await client`select pg_advisory_lock(hashtext(${MIGRATION_LOCK}))`;
  }
  // Counted under the lock, so a run that waited reports what it applied itself (nothing).
  const before = await recorded(client);
  // Host and database name only — never the connection string (it holds the password).
  console.log(
    `${TAG} database "${db}" on ${new URL(url).hostname}: ${before.count} migrations recorded, newest ${before.newest}.`,
  );
  await migrate(drizzle(client), { migrationsFolder: "./drizzle" });
  const after = await recorded(client);
  console.log(
    `${TAG} applied ${after.count - before.count} new migration(s); ${after.count} recorded, newest ${after.newest}.`,
  );
} catch (err) {
  console.error(
    `${TAG} FAILED: ${err instanceof Error ? err.message : String(err)}. Build stopped before any new code was built.`,
  );
  process.exitCode = 1;
} finally {
  // Closing the session releases the lock too; unlocking first keeps it short.
  await client`select pg_advisory_unlock_all()`.catch(() => {});
  await client.end();
}
