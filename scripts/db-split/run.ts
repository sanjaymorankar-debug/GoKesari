/**
 * Seller / customer database split — run the migration (Task 1).
 * Read docs/db-split-2026-10/README.md first.
 *
 *   SOURCE_DATABASE_URL     today's single database (only ever READ)
 *   SELLER_DATABASE_URL     the new gokesari_seller database
 *   CUSTOMER_DATABASE_URL   the new gokesari_customer database
 *
 *   npx tsx scripts/db-split/run.ts plan                 read-only: ownership, cross-database links, row counts
 *   npx tsx scripts/db-split/run.ts migrate              dry run: says what it would do, changes nothing
 *   npx tsx scripts/db-split/run.ts migrate --apply      builds both schemas, copies the data, verifies
 *   npx tsx scripts/db-split/run.ts verify               row counts + checksums + cross-database links
 *   npx tsx scripts/db-split/run.ts fdw --apply          postgres_fdw: seller tables readable in the customer DB and back
 *
 * Options: --replace (overwrite a target that already has data),
 *          --report <file.md> (also write the verification report there),
 *          --allow-remote (required for any host but localhost).
 *
 * The source is never written to. Nothing reads the app's .env: name every
 * database yourself, so a run can't land on the wrong one.
 */
import { writeFileSync } from "node:fs";

import { CUSTOMER_READS_FROM_SELLER, SELLER_READS_FROM_CORE } from "../../src/server/db/split/ownership";
import {
  checkCrossReferences,
  connect,
  copyTables,
  crossDbReferences,
  describeUrl,
  listForeignKeys,
  prepareTarget,
  publicTables,
  sameDatabaseClash,
  setupForeignTables,
  splitTables,
  verifyCopy,
} from "../../src/server/db/split/tools";
import { renderReport } from "../../src/server/db/split/report";

const args = process.argv.slice(2);
const action = args[0];
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set.`);
  if (/<|PLACEHOLDER|CHANGE_ME/i.test(value)) throw new Error(`${name} is still a placeholder — set the real connection string.`);
  const host = new URL(value).hostname;
  if (!["localhost", "127.0.0.1", "::1"].includes(host) && !flag("allow-remote")) {
    throw new Error(`${name} points at ${host}; add --allow-remote to run against a remote server.`);
  }
  return value;
}

async function main() {
  if (!["plan", "migrate", "verify", "fdw"].includes(action)) {
    console.log("Usage: npx tsx scripts/db-split/run.ts plan|migrate|verify|fdw [--apply] [--replace] [--report file.md] [--allow-remote]");
    process.exit(2);
  }
  const sourceUrl = need("SOURCE_DATABASE_URL");
  const source = connect(sourceUrl, 4);
  try {
    const fks = await listForeignKeys(source);
    const sourceTables = await publicTables(source);
    const { seller, customer, unowned } = splitTables(sourceTables);
    if (unowned.length) throw new Error(`Tables with no owner in src/server/db/split/ownership.ts: ${unowned.join(", ")}`);

    if (action === "plan") {
      const cross = crossDbReferences(fks);
      console.log(`Source: ${describeUrl(sourceUrl)} — ${sourceTables.length} tables`);
      console.log(`Seller database: ${seller.length} tables. Customer (core) database: ${customer.length} tables.`);
      console.log(`Foreign keys: ${fks.length}; ${cross.length} cross the two databases and become service-layer checks:`);
      for (const fk of cross) console.log(`  ${fk.table}.${fk.columns.join(",")} → ${fk.refTable} (${fk.from} → ${fk.to})`);
      return;
    }

    const sellerUrl = need("SELLER_DATABASE_URL");
    const customerUrl = need("CUSTOMER_DATABASE_URL");
    const clash = sameDatabaseClash({ SOURCE: sourceUrl, SELLER: sellerUrl, CUSTOMER: customerUrl });
    if (clash) throw new Error(`SOURCE, SELLER and CUSTOMER must be three different databases. ${clash}`);
    const sellerSql = connect(sellerUrl, 4);
    const customerSql = connect(customerUrl, 4);
    try {
      if (action === "fdw") {
        if (!flag("apply")) {
          console.log(`Dry run. --apply would make ${CUSTOMER_READS_FROM_SELLER.join(", ")} readable in ${describeUrl(customerUrl)} (schema seller_remote) and ${SELLER_READS_FROM_CORE.join(", ")} in ${describeUrl(sellerUrl)} (schema core_remote).`);
          return;
        }
        await setupForeignTables(customerSql, { serverName: "gokesari_seller", remoteUrl: sellerUrl, schema: "seller_remote", tables: CUSTOMER_READS_FROM_SELLER });
        await setupForeignTables(sellerSql, { serverName: "gokesari_core", remoteUrl: customerUrl, schema: "core_remote", tables: SELLER_READS_FROM_CORE });
        console.log("postgres_fdw set up both ways.");
        return;
      }

      if (action === "migrate") {
        console.log(`Source ${describeUrl(sourceUrl)} → seller ${describeUrl(sellerUrl)} (${seller.length} tables), customer ${describeUrl(customerUrl)} (${customer.length} tables).`);
        if (!flag("apply")) {
          console.log("Dry run — nothing changed. Re-run with --apply (after a backup of the source) to build and fill both databases.");
          return;
        }
        for (const [side, sql, tables] of [["seller", sellerSql, seller], ["customer", customerSql, customer]] as const) {
          const prepared = await prepareTarget(sql, side, { replace: flag("replace") });
          console.log(`${side}: schema ready (${prepared.keptTables.length} tables kept, ${prepared.droppedTables.length} owned by the other database dropped).`);
          await copyTables(source, sql, tables, (line) => console.log(`  ${side}: ${line}`), {
            openReader: () => connect(sourceUrl, 1),
            tableTimeoutMs: 10 * 60_000,
          });
        }
      }

      // migrate --apply and verify both end with the report.
      const verify = [...(await verifyCopy(source, sellerSql, "seller", seller)), ...(await verifyCopy(source, customerSql, "customer", customer))];
      const orphans = await checkCrossReferences(sellerSql, customerSql, fks);
      const report = renderReport({ verify, orphans, source: describeUrl(sourceUrl), seller: describeUrl(sellerUrl), customer: describeUrl(customerUrl), at: new Date().toISOString() });
      console.log(report);
      const file = option("report");
      if (file) writeFileSync(file, report);
      const failed = verify.some((v) => !v.ok) || orphans.some((o) => o.orphans > 0);
      if (failed) process.exitCode = 1;
    } finally {
      await sellerSql.end({ timeout: 5 });
      await customerSql.end({ timeout: 5 });
    }
  } finally {
    await source.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
