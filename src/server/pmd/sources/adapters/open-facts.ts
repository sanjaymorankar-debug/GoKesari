/**
 * Open Food Facts family adapter - Open Food Facts, Open Beauty Facts, Open
 * Products Facts and Open Pet Food Facts share one schema and one licence, so one
 * adapter serves all four.
 *
 * Access method: the projects' OFFICIAL BULK DATA DUMPS on static.*.org/data/.
 * These are the sanctioned way to consume the data at volume, and their robots.txt
 * does not disallow /data/. The live product API (/api) IS disallowed for generic
 * crawlers by robots.txt, so this adapter never uses it - the http client would
 * refuse the request anyway.
 *
 * Licence: the database is ODbL 1.0 and its contents DbCL 1.0 (attribution and
 * share-alike apply to the data); product images are CC BY-SA and are only linked,
 * never copied.
 *
 * Two input modes:
 *   file  a JSONL sample previously written by `pmd:fetch-sample` - deterministic and offline;
 *   url   stream the .csv.gz from the dump, filter to a country, stop after `limit` rows.
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";

import { createCategoryMapper } from "../../taxonomy/mapper";
import type { RawRecord, SourceDefinition, StagedAttribute, StagedProduct } from "../../types";
import { type ExtractContext, ParseError, type SourceAdapter } from "../adapter";
import { parseDelimitedWithHeader } from "../delimited";
import type { PoliteHttpClient } from "../http";
import { OPEN_FACTS_RULES } from "../mappings/open-facts";

export type OpenFactsVariant = "food" | "beauty" | "products" | "petfood";

export const OPEN_FACTS_DUMPS: Record<OpenFactsVariant, { key: string; name: string; url: string; site: string; maxMb: number }> = {
  food: {
    key: "open_food_facts",
    name: "Open Food Facts",
    url: "https://static.openfoodfacts.org/data/en.openfoodfacts.org.products.csv.gz",
    site: "https://world.openfoodfacts.org",
    maxMb: 250,
  },
  beauty: {
    key: "open_beauty_facts",
    name: "Open Beauty Facts",
    url: "https://static.openbeautyfacts.org/data/en.openbeautyfacts.org.products.csv.gz",
    site: "https://world.openbeautyfacts.org",
    maxMb: 40,
  },
  products: {
    key: "open_products_facts",
    name: "Open Products Facts",
    url: "https://static.openproductsfacts.org/data/en.openproductsfacts.org.products.csv.gz",
    site: "https://world.openproductsfacts.org",
    maxMb: 20,
  },
  petfood: {
    key: "open_pet_food_facts",
    name: "Open Pet Food Facts",
    url: "https://static.openpetfoodfacts.org/data/en.openpetfoodfacts.org.products.csv.gz",
    site: "https://world.openpetfoodfacts.org",
    maxMb: 20,
  },
};

export function openFactsDefinition(variant: OpenFactsVariant): SourceDefinition {
  const d = OPEN_FACTS_DUMPS[variant];
  return {
    key: d.key,
    name: d.name,
    kind: "OPEN_DATA",
    accessMethod: "OPEN_DATASET",
    status: "ACTIVE",
    reliability: 55,
    specPrecedence: 60,
    legalBasis:
      "Open database published by the project for reuse. Consumed through the official bulk dump (static host /data/), " +
      "which robots.txt does not disallow; the live API is disallowed for generic crawlers and is not used. " +
      "Database licence ODbL 1.0, contents DbCL 1.0: attribute 'Open Food Facts contributors' and keep derived datasets under the same terms.",
    licenseName: "ODbL 1.0 (database) / DbCL 1.0 (contents); images CC BY-SA",
    termsUrl: "https://world.openfoodfacts.org/terms-of-use",
    robotsPolicy: "static host robots.txt disallows /api, /cgi, /facets only; /data/ dumps are allowed (checked 2026-09-19).",
    apiEndpoint: d.url,
    collectionFrequency: "weekly (dump is regenerated daily)",
    rateLimitPerMin: 30,
    parserKey: "open_facts_csv",
    retryMax: 3,
    notes: "Crowdsourced: coverage and accuracy vary. Treated as lower-reliability than manufacturer or licensed data; GTINs are validated before use.",
  };
}

/* ------------------------------------------------------------ live streaming */

export interface OpenFactsStreamOptions {
  url: string;
  /** OFF country tag to keep, e.g. "en:india". */
  countryTag: string;
  limit: number;
  /** Hard cap on bytes pulled from the dump; the transfer is aborted beyond it. */
  maxBytes: number;
  log: (m: string) => void;
  onBadRow?: (rowNumber: number) => void;
}

export interface OpenFactsStreamStats {
  bytesRead: number;
  rowsScanned: number;
  rowsKept: number;
  stoppedBecause: "LIMIT_REACHED" | "BYTE_CAP" | "END_OF_FILE";
  columns: string[];
}

/** Streams the gzip CSV, filters to a country, and stops as soon as `limit` rows are kept. */
export async function* streamOpenFactsRows(
  http: PoliteHttpClient,
  opts: OpenFactsStreamOptions,
  stats: OpenFactsStreamStats,
): AsyncGenerator<Record<string, string>> {
  const res = await http.get(opts.url, { stream: true });
  let capped = false;
  const compressed = http.streamBody(res, {
    maxBytes: opts.maxBytes,
    onLimit: (n) => {
      capped = true;
      stats.bytesRead = n;
    },
  });
  const counted = (async function* () {
    for await (const chunk of compressed) {
      stats.bytesRead += chunk.length;
      yield chunk;
    }
  })();

  const gunzip = createGunzip();
  const source = Readable.from(counted);
  source.on("error", (e) => gunzip.destroy(e));
  const decoded = source.pipe(gunzip);

  try {
    for await (const row of parseDelimitedWithHeader(decoded, {
      delimiter: "\t",
      onBadRow: (n) => opts.onBadRow?.(n),
    })) {
      if (stats.columns.length === 0) stats.columns = Object.keys(row);
      stats.rowsScanned++;
      if (!row.code || !row.countries_tags) continue;
      if (!row.countries_tags.split(",").includes(opts.countryTag)) continue;
      stats.rowsKept++;
      yield row;
      if (stats.rowsKept >= opts.limit) {
        stats.stoppedBecause = "LIMIT_REACHED";
        return;
      }
    }
    stats.stoppedBecause = capped ? "BYTE_CAP" : "END_OF_FILE";
  } catch (e) {
    // Cutting a gzip stream at the byte cap surfaces as "unexpected end of file" - that is our own doing.
    if (capped && /unexpected end of file/i.test((e as Error).message)) {
      stats.stoppedBecause = "BYTE_CAP";
      return;
    }
    throw e;
  } finally {
    gunzip.destroy();
    source.destroy();
  }
}

/** Columns that name the people who edited a product. The platform collects product facts, not people. */
const CONTRIBUTOR_COLUMNS = /^(creator|last_modified_by|last_updated_by|owner|owners?_tags|contributors?|editors?|checkers?|photographers?|informers?|correctors?|created_by|last_editor)/;

export function stripContributors(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) if (!CONTRIBUTOR_COLUMNS.test(k)) out[k] = v;
  return out;
}

/* ------------------------------------------------------------------- adapter */

export type OpenFactsInput =
  | { mode: "file"; path: string }
  | { mode: "rows"; rows: Record<string, unknown>[] };

export function createOpenFactsAdapter(variant: OpenFactsVariant, input: OpenFactsInput): SourceAdapter {
  const dump = OPEN_FACTS_DUMPS[variant];
  return {
    definition: openFactsDefinition(variant),
    collectionMethod: "OPEN_DATASET_CSV",
    createsProducts: true,
    supportsFullSnapshot: false, // we read a filtered slice, so absence says nothing
    categoryMapper: createCategoryMapper(OPEN_FACTS_RULES),
    imageLicenseNote: `${dump.name} images: CC BY-SA (contributors); linked, not copied.`,

    async *extract(ctx: ExtractContext): AsyncGenerator<RawRecord> {
      let n = 0;
      const emit = (row: Record<string, unknown>): RawRecord | null => {
        const code = String(row.code ?? "").trim();
        if (!code) return null;
        return { sourceProductId: code, payload: row, url: `${dump.site}/product/${encodeURIComponent(code)}` };
      };

      if (input.mode === "rows") {
        for (const row of input.rows) {
          const rec = emit(row);
          if (!rec) continue;
          yield rec;
          if (ctx.limit && ++n >= ctx.limit) return;
        }
        return;
      }

      const rl = createInterface({ input: createReadStream(input.path, { encoding: "utf8" }), crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line.trim()) continue;
        let row: Record<string, unknown>;
        try {
          row = JSON.parse(line) as Record<string, unknown>;
        } catch {
          ctx.log(`skipping unreadable JSONL line in ${input.path}`);
          continue;
        }
        const rec = emit(row);
        if (!rec) continue;
        yield rec;
        if (ctx.limit && ++n >= ctx.limit) return;
      }
    },

    sanitize: stripContributors,
    parse: (raw) => parseOpenFactsRow(raw, dump.site),
  };
}

/* ---------------------------------------------------------------- parsing */

function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function num(v: unknown): number | null {
  const s = str(v);
  if (s == null) return null;
  const n = Number(s.replace(/,/g, "."));
  return Number.isFinite(n) ? n : null;
}

const tags = (v: unknown): string[] => (str(v) ?? "").split(",").map((t) => t.trim()).filter(Boolean);

/** OFF nutrition columns (per 100 g) -> registry attribute keys. Sodium is grams in OFF; the registry wants mg. */
const NUTRITION: Array<{ col: string; key: string; unit: string; scale?: number }> = [
  { col: "energy-kcal_100g", key: "energy_kcal_per_100g", unit: "kcal" },
  { col: "proteins_100g", key: "protein_g_per_100g", unit: "g" },
  { col: "carbohydrates_100g", key: "carbohydrates_g_per_100g", unit: "g" },
  { col: "fat_100g", key: "total_fat_g_per_100g", unit: "g" },
  { col: "saturated-fat_100g", key: "saturated_fat_g_per_100g", unit: "g" },
  { col: "trans-fat_100g", key: "trans_fat_g_per_100g", unit: "g" },
  { col: "sugars_100g", key: "sugar_g_per_100g", unit: "g" },
  { col: "fiber_100g", key: "dietary_fiber_g_per_100g", unit: "g" },
  { col: "salt_100g", key: "salt_g_per_100g", unit: "g" },
  { col: "sodium_100g", key: "sodium_mg_per_100g", unit: "mg", scale: 1000 },
];

export function parseOpenFactsRow(raw: RawRecord, site: string): StagedProduct {
  const r = raw.payload;
  const code = str(r.code);
  if (!code) throw new ParseError("NO_CODE", "Row has no barcode.");

  const name = str(r.product_name) ?? str(r.generic_name) ?? str(r.abbreviated_product_name);
  if (!name) throw new ParseError("NO_NAME", `Product ${code} has no name.`);

  const attributes: StagedAttribute[] = [];
  const put = (key: string, value: string | number | boolean | null, unit?: string, original?: string) => {
    if (value != null && value !== "") attributes.push({ key, value, unit, original });
  };

  put("ingredients", str(r.ingredients_text));
  put("allergen_information", str(r.allergens)?.replace(/\ben:/g, "").replace(/,/g, ", ") ?? null);
  put("traces", str(r.traces)?.replace(/\ben:/g, "").replace(/,/g, ", ") ?? null);
  put("serving_size", str(r.serving_size));
  put("packaging", str(r.packaging));
  put("labels", str(r.labels));
  for (const n of NUTRITION) {
    const v = num(r[n.col]);
    if (v != null) put(n.key, n.scale ? v * n.scale : v, n.unit, `${str(r[n.col])} (${n.col})`);
  }
  const grade = str(r.nutriscore_grade);
  if (grade && /^[a-e]$/i.test(grade)) put("nutriscore_grade", grade.toUpperCase());
  const nova = num(r.nova_group);
  if (nova != null && nova >= 1 && nova <= 4) put("nova_group", nova);

  // Only definite dietary statements; "maybe-vegan" / "vegan-status-unknown" stay unknown, never true.
  const analysis = tags(r.ingredients_analysis_tags);
  if (analysis.includes("en:vegan")) put("vegan", true);
  else if (analysis.includes("en:non-vegan")) put("vegan", false);
  if (analysis.includes("en:vegetarian")) put("vegetarian_nonveg", "VEGETARIAN");
  else if (analysis.includes("en:non-vegetarian")) put("vegetarian_nonveg", "NON_VEGETARIAN");
  if (tags(r.labels_tags).includes("en:organic")) put("organic", true);

  // Where it is MADE comes from origins / manufacturing places, not from `countries` (where it is SOLD).
  const origin = str(r.origins) ?? str(r.manufacturing_places);

  const images = [r.image_url, r.image_ingredients_url, r.image_nutrition_url]
    .map(str)
    .filter((u): u is string => !!u);

  const completeness = num(r.completeness);

  return {
    sourceProductId: code,
    sourceUrl: str(r.url) ?? raw.url ?? `${site}/product/${code}`,
    name,
    brand: str(r.brands),
    manufacturer: str(r.brand_owner),
    // Tags are best; when a row has none, the free-text `categories` field still maps through the same rules.
    categories: tags(r.categories_tags).length ? tags(r.categories_tags) : (str(r.categories) ?? "").split(",").map((c) => c.trim()).filter(Boolean),
    shortDescription: str(r.generic_name) && str(r.generic_name) !== name ? str(r.generic_name) : null,
    gtin: code,
    quantityText: str(r.quantity) ?? (num(r.product_quantity) != null ? `${num(r.product_quantity)} g` : null),
    countryOfOrigin: origin,
    attributes,
    images,
    sourceConfidence: completeness != null ? Math.max(0, Math.min(100, Math.round(completeness * 100))) : null,
  };
}
