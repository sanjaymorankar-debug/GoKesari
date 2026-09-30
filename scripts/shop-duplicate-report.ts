/**
 * Duplicate shop report — READ ONLY. Runs scripts/shop-duplicate-report.sql
 * inside a read-only transaction and prints each group of shops that look
 * like the same shop registered more than once. Nothing is updated or
 * deleted: pick the record to keep in each group yourself.
 *
 *   DATABASE_URL=<target> npx tsx scripts/shop-duplicate-report.ts [--csv]
 *
 * The app's .env is deliberately NOT loaded (in a developer's checkout it
 * points at a hosted database), so the target must be named explicitly. A
 * hosted database is allowed: the transaction is READ ONLY, so Postgres
 * itself refuses any write. Works before migration 0024 as well (only the
 * same-name-and-PIN grouping then applies).
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import postgres from "postgres";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const columns = Object.keys(rows[0]);
  const cell = (value: unknown) => {
    const text = value instanceof Date ? value.toISOString() : String(value ?? "");
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [columns.join(","), ...rows.map((row) => columns.map((c) => cell(row[c])).join(","))].join("\n");
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) fail("DATABASE_URL is not set. Name the target database explicitly — this tool never loads .env.");

  const target = new URL(url);
  const sslmode = target.searchParams.get("sslmode");
  const sql = postgres(url, {
    max: 1,
    ssl: sslmode && sslmode !== "disable" ? "require" : false,
  });

  const query = readFileSync(path.join(__dirname, "shop-duplicate-report.sql"), "utf8");
  try {
    const rows = await sql.begin("read only", (tx) => tx.unsafe(query));
    if (process.argv.includes("--csv")) {
      console.log(toCsv(rows as unknown as Record<string, unknown>[]));
      return;
    }
    console.log(`target   ${target.protocol}//${target.host}${target.pathname}`);
    if (rows.length === 0) {
      console.log("No duplicate groups found.");
      return;
    }
    const groups = new Set(rows.map((row) => row.group_no)).size;
    console.log(`${groups} group(s), ${rows.length} row(s). Nothing was changed.`);
    console.table(rows);
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
