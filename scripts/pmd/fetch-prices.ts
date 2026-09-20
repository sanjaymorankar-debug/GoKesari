/**
 * Pilot data acquisition: Open Prices observations in one currency.
 *
 *   npx tsx scripts/pmd/fetch-prices.ts --currency INR
 *
 * Pages through the public API politely (robots checked, rate limited, retried) and
 * writes a local JSONL, oldest observation first so price history replays in order.
 * Contributor usernames and proof references are stripped before anything is written.
 */
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { fetchOpenPricesPage, stripPersonalData } from "@/server/pmd/sources/adapters/open-prices";
import { PoliteHttpClient } from "@/server/pmd/sources/http";
import { arg, defaultSampleDir, httpUserAgent } from "./lib";

async function main() {
  const currency = arg("currency", "INR")!;
  const size = Number(arg("size", "100"));
  const maxPages = Number(arg("max-pages", "50"));
  const outDir = arg("out", defaultSampleDir())!;
  mkdirSync(outDir, { recursive: true });

  const http = new PoliteHttpClient({ userAgent: httpUserAgent(), minIntervalMs: 1500 });
  const items: Record<string, unknown>[] = [];
  let total = 0;
  for (let page = 1; page <= maxPages; page++) {
    const res = await fetchOpenPricesPage(http, { currency, page, size });
    total = res.total;
    items.push(...res.items);
    console.log(`page ${page}/${res.pages}: ${res.items.length} observations (total ${res.total})`);
    if (page >= res.pages || res.items.length === 0) break;
  }

  const clean = items
    .map(stripPersonalData)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)) || Number(a.id) - Number(b.id));
  const file = join(outDir, `open_prices.${currency.toLowerCase()}.jsonl`);
  const out = createWriteStream(file, { encoding: "utf8" });
  for (const it of clean) out.write(JSON.stringify(it) + "\n");
  await new Promise<void>((res) => out.end(res));

  writeFileSync(
    file.replace(/\.jsonl$/, ".meta.json"),
    JSON.stringify(
      {
        source: "open_prices",
        endpoint: "https://prices.openfoodfacts.org/api/v1/prices",
        retrievedAt: new Date().toISOString(),
        currency,
        reportedTotal: total,
        observationsWritten: clean.length,
        licence: "ODbL 1.0 - attribute Open Food Facts / Open Prices contributors",
        personalDataStripped: ["owner", "proof", "proof_id", "product.creator"],
      },
      null,
      2,
    ),
  );
  console.log(`wrote ${clean.length} observations -> ${file}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? `${e.name}: ${e.message}` : e);
  process.exit(1);
});
