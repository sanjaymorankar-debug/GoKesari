/**
 * Pilot data acquisition: streams an official bulk dump, keeps only one country's
 * rows, and writes a local JSONL sample.
 *
 *   npx tsx scripts/pmd/fetch-sample.ts --variant food --limit 1000
 *   npx tsx scripts/pmd/fetch-sample.ts --variant beauty --limit 1000
 *
 * The transfer is bounded twice: it stops as soon as `--limit` matching rows have
 * been kept, and it never reads more than `--max-mb` of the compressed dump - a
 * 1.2 GB file is never downloaded whole to extract a thousand rows. Only the
 * filtered rows are written to disk. robots.txt is checked (and obeyed) first.
 *
 * Output lives outside the repository (%LOCALAPPDATA%\GokesariPmd\samples) by default.
 */
import { mkdirSync, writeFileSync, createWriteStream } from "node:fs";
import { join } from "node:path";

import { OPEN_FACTS_DUMPS, streamOpenFactsRows, type OpenFactsStreamStats, type OpenFactsVariant } from "@/server/pmd/sources/adapters/open-facts";
import { PoliteHttpClient } from "@/server/pmd/sources/http";
import { defaultSampleDir, httpUserAgent } from "./lib";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function main() {
  const variant = (arg("variant", "food") as OpenFactsVariant);
  const dump = OPEN_FACTS_DUMPS[variant];
  if (!dump) throw new Error(`unknown --variant ${variant}; expected ${Object.keys(OPEN_FACTS_DUMPS).join(", ")}`);
  const limit = Number(arg("limit", "1000"));
  const maxMb = Number(arg("max-mb", String(dump.maxMb)));
  const country = arg("country", "en:india")!;
  const outDir = arg("out", defaultSampleDir())!;
  mkdirSync(outDir, { recursive: true });

  const http = new PoliteHttpClient({ userAgent: httpUserAgent(), minIntervalMs: 2000 });
  const stats: OpenFactsStreamStats = { bytesRead: 0, rowsScanned: 0, rowsKept: 0, stoppedBecause: "END_OF_FILE", columns: [] };
  const file = join(outDir, `${dump.key}.${country.replace(/^en:/, "")}.jsonl`);
  const out = createWriteStream(file, { encoding: "utf8" });

  console.log(`source   ${dump.name}\nurl      ${dump.url}\nfilter   countries_tags contains ${country}\nbudget   ${limit} rows / ${maxMb} MB compressed\nwriting  ${file}`);
  const started = Date.now();
  let bad = 0;
  for await (const row of streamOpenFactsRows(
    http,
    { url: dump.url, countryTag: country, limit, maxBytes: maxMb * 1024 * 1024, log: console.log, onBadRow: () => bad++ },
    stats,
  )) {
    // Drop empty columns: the export has ~200 mostly-empty columns per row.
    const slim: Record<string, string> = {};
    for (const [k, v] of Object.entries(row)) if (v !== "") slim[k] = v;
    out.write(JSON.stringify(slim) + "\n");
  }
  await new Promise<void>((res) => out.end(res));

  const meta = {
    source: dump.key,
    url: dump.url,
    retrievedAt: new Date().toISOString(),
    countryFilter: country,
    licence: "ODbL 1.0 (database) / DbCL 1.0 (contents); images CC BY-SA - attribute Open Food Facts contributors",
    compressedBytesRead: stats.bytesRead,
    rowsScanned: stats.rowsScanned,
    rowsKept: stats.rowsKept,
    malformedRowsSkipped: bad,
    stoppedBecause: stats.stoppedBecause,
    seconds: Math.round((Date.now() - started) / 1000),
    columns: stats.columns,
  };
  writeFileSync(file.replace(/\.jsonl$/, ".meta.json"), JSON.stringify(meta, null, 2));
  console.log(
    `done     kept ${stats.rowsKept} of ${stats.rowsScanned} scanned rows; read ${(stats.bytesRead / 1048576).toFixed(1)} MB compressed; stopped: ${stats.stoppedBecause}; ${meta.seconds}s`,
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? `${e.name}: ${e.message}` : e);
  process.exit(1);
});
