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

import { isSplitLayout, migrateSplit } from "../../../scripts/split-migrate.mjs";

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
    if (await isSplitLayout(client)) {
      // Seller / customer split (docs/db-split-2026-10/CODE_SPLIT_PLAN.md): each migration runs where its tables live.
      const sellerUrl = process.env.SELLER_DATABASE_URL;
      if (!sellerUrl) throw new Error("This database is split but SELLER_DATABASE_URL is not set.");
      const sellerMode = new URL(sellerUrl).searchParams.get("sslmode");
      const seller = postgres(sellerUrl, { max: 1, ssl: !sellerMode || sellerMode === "disable" ? false : ("require" as const) });
      try {
        const { applied, repaired } = await migrateSplit({ core: client, seller, coreUrl: url, log: (line: string) => console.log(line) });
        console.log(`Split layout: ${applied.length} migration(s) applied, ${repaired.length} repair(s).`);
      } finally {
        await seller.end();
      }
    } else {
      await migrate(drizzle(client), { migrationsFolder: "./drizzle" });
      console.log("Migrations applied.");
    }
  } finally {
    await client`select pg_advisory_unlock_all()`.catch(() => {});
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
