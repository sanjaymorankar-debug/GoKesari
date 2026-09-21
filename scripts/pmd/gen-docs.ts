/**
 * Regenerates the reference documents that are derived from code:
 *
 *   docs/product-master/DATA_DICTIONARY.md   from the workbook model
 *   docs/product-master/SOURCE_REGISTER.md   from the source registry
 *
 *   npm run pmd:docs            write them
 *   npm run pmd:docs -- --check exit 1 if a file on disk is out of date
 *
 * Needs no database.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { renderDataDictionary, renderSourceRegister } from "@/server/pmd/docs/render";
import { flag } from "./lib";

const DOCS = join(process.cwd(), "docs", "product-master");
const FILES: Array<[string, () => string]> = [
  ["DATA_DICTIONARY.md", renderDataDictionary],
  ["SOURCE_REGISTER.md", renderSourceRegister],
];

let stale = 0;
for (const [name, render] of FILES) {
  const path = join(DOCS, name);
  const next = render();
  let current: string | null = null;
  try {
    current = readFileSync(path, "utf8");
  } catch {
    /* not generated yet */
  }
  if (flag("check")) {
    if (current !== next) {
      stale++;
      console.error(`stale: ${name} - run "npm run pmd:docs"`);
    }
    continue;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, next, "utf8");
  console.log(`${current === next ? "unchanged" : "wrote    "} ${name}  (${next.split("\n").length} lines)`);
}
if (stale) process.exit(1);
