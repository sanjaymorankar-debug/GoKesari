/**
 * Turns a shops export (copy-shops.ts MODE=export) into two SQL files the
 * owner runs in the Neon console against the production database, for when
 * the workflow cannot reach production itself (docs/copy-shops-2026-10/README.md):
 *
 *   copy-shops-1-PREVIEW.sql  does the whole copy and undoes it, then lists
 *                             what would happen — changes nothing
 *   copy-shops-2-APPLY.sql    the same, saved
 *
 * Same rules as copy-shops.ts, carried out inside the database
 * (copy-shops.sql.tpl). Reads only the export; never connects anywhere.
 *
 *   BUNDLE_FILE=shops.json OUT_DIR=out npx tsx scripts/copy-shops/to-sql.ts
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function fail(message: string): never {
  console.error(`::error::${message}`);
  process.exit(1);
}

const bundleFile = process.env.BUNDLE_FILE || fail("BUNDLE_FILE is not set.");
const outDir = process.env.OUT_DIR || fail("OUT_DIR is not set.");
const json = readFileSync(bundleFile, "utf8");
const bundle = JSON.parse(json) as { exportedAt: string; shops: string[] };
const template = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "copy-shops.sql.tpl"), "utf8");

// The export goes in as a dollar-quoted literal: its tag must not occur inside it.
let tag = randomBytes(6).toString("hex");
while (json.includes(`$cs_json_${tag}$`)) tag = randomBytes(6).toString("hex");

const files = [
  {
    name: "copy-shops-1-PREVIEW.sql",
    apply: false,
    title: "PREVIEW: changes nothing. Run this first.",
    note: "This PREVIEW does the whole copy and then undoes it: production is NOT changed. Read the result; if it is right, run copy-shops-2-APPLY.sql.",
  },
  {
    name: "copy-shops-2-APPLY.sql",
    apply: true,
    title: "APPLY: saves the shops to production.",
    note: "This APPLY file SAVES to production. Run copy-shops-1-PREVIEW.sql first. Before running, note the time: Neon can restore the database to it (Restore → point in time).",
  },
];

mkdirSync(outDir, { recursive: true });
for (const f of files) {
  // Placeholders are replaced in a fixed order; the export goes last so nothing inside it is touched.
  const sql = template
    .replaceAll("__TITLE__", f.title)
    .replaceAll("__MODE_NOTE__", f.note)
    .replaceAll("__SHOPS__", bundle.shops.join(", "))
    .replaceAll("__EXPORTED__", bundle.exportedAt)
    .replaceAll("__APPLY__", String(f.apply))
    .replaceAll("__TAG__", `_${tag}`)
    .replace("__BUNDLE__", () => json);
  writeFileSync(join(outDir, f.name), sql);
  console.log(`${f.name}: ${Math.round(sql.length / 1024)} KB`);
}
