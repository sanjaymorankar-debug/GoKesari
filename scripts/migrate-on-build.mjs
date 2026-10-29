/**
 * The migrator of the "Test database" and "Production database" workflows
 * (.github/workflows/test-db.yml, prod-db.yml). It applies pending migrations
 * from ./drizzle only when MIGRATE_ON_BUILD=true AND it runs inside GitHub
 * Actions (GITHUB_ACTIONS=true). If the migration fails it exits non-zero.
 *
 * It is also the first step of `npm run build`, where it now always skips
 * (exit 0, the build goes on). Hostinger builds a preview of every pull request
 * with the site's own environment variables, so with MIGRATE_ON_BUILD set in
 * hPanel an unmerged PR's preview migrated test.gokesari.com's — and, for PRs
 * into main, gokesari.com's — databases before the PR was merged (Blocker #71;
 * 0089–0094 reached production that way, 0114/0115 the test databases on
 * 29 Oct 2026). Migrations therefore run only through the workflows.
 * DEPLOYMENT.md §4.
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

import { cleanDatabaseUrl, isSplitLayout, migrateSplit } from "./split-migrate.mjs";

const TAG = "[migrate-on-build]";
/** Shared with src/server/db/migrate.ts — one migration run per database at a time. */
const MIGRATION_LOCK = "gokesari-migrations";

// The same .env files and precedence `next build` uses, so this sees exactly
// the variables the build sees, however the host provides them.
nextEnv.loadEnvConfig(process.cwd());

if (!/^(1|true)$/i.test(process.env.MIGRATE_ON_BUILD ?? "")) {
  console.log(
    `${TAG} skipped: MIGRATE_ON_BUILD is not "true". Migrations run only through the "Test database" and "Production database" workflows (DEPLOYMENT.md §4).`,
  );
  process.exit(0);
}

// Blocker #71: never from a host's build (a Hostinger deploy or PR preview), only from the workflows.
if (process.env.GITHUB_ACTIONS !== "true") {
  console.log(
    `${TAG} skipped: not running in GitHub Actions. Migrations run only through the "Test database" and "Production database" workflows (DEPLOYMENT.md §4).`,
  );
  process.exit(0);
}

const url = process.env.DATABASE_URL ? cleanDatabaseUrl(process.env.DATABASE_URL) : "";
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
  if (await isSplitLayout(client)) {
    // Seller / customer split: each migration runs in the database its tables live in.
    const sellerUrl = process.env.SELLER_DATABASE_URL ? cleanDatabaseUrl(process.env.SELLER_DATABASE_URL) : "";
    if (!sellerUrl) throw new Error("this database is split (seller tables are in the seller database) but SELLER_DATABASE_URL is not set");
    const sellerSsl = (() => {
      const mode = new URL(sellerUrl).searchParams.get("sslmode");
      return !mode || mode === "disable" ? false : "require";
    })();
    const seller = postgres(sellerUrl, { max: 1, ssl: sellerSsl, onnotice: () => {} });
    try {
      const { applied, repaired } = await migrateSplit({ core: client, seller, coreUrl: url, log: (line) => console.log(`${TAG} ${line}`) });
      console.log(`${TAG} split layout: ${applied.length} migration(s) applied, ${repaired.length} repair(s).`);
    } finally {
      await seller.end();
    }
  } else {
    await migrate(drizzle(client), { migrationsFolder: "./drizzle" });
  }
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
