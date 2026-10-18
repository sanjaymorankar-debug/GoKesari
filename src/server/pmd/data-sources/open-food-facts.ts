/**
 * Open Food Facts barcode look-up (batch-2026-10 WS-D, F9.1.2) — packaged food.
 *
 * Optional and OFF by default (rule pmdSources.openFoodFactsEnabled). One
 * product per request through OFF's product read API
 * (https://world.openfoodfacts.org/api/v2/product/<barcode>.json), with an
 * identifying User-Agent and a per-minute cap (rule offRequestsPerMinute); the
 * bulk path stays the official dump (sources/adapters/open-facts.ts). The
 * response is parsed by the SAME mapping as the dump (parseOpenFactsRow), and
 * contributor names are stripped before anything is stored.
 *
 * Licence: database ODbL 1.0, contents DbCL 1.0, images CC BY-SA — attribution
 * is required, so the attribution text (rule offAttribution) is stored with
 * every record (pmd_record_attributions) and shown in the product browser.
 * HTTP goes through an injectable fetch so tests never reach the network.
 */
import { enforceRateLimit } from "@/server/api/rate-limit";
import { getRule } from "@/server/services/settings";

import { analyzeGtin } from "../normalize/identifiers";
import { OPEN_FACTS_DUMPS, parseOpenFactsRow, stripContributors } from "../sources/adapters/open-facts";
import { ParseError } from "../sources/adapter";
import { createRowsAdapter } from "../sources/adapters/rows";
import { createCategoryMapper } from "../taxonomy/mapper";
import { OPEN_FACTS_RULES } from "../sources/mappings/open-facts";
import type { SourceDefinition, StagedProduct } from "../types";
import type { BarcodeLookupSource } from "./types";

export const OFF_LOOKUP_SOURCE_KEY = "open_food_facts_lookup";
export const OFF_LICENCE_URL = "https://opendatacommons.org/licenses/odbl/1-0/";
export const OFF_TERMS_URL = "https://world.openfoodfacts.org/terms-of-use";
const SITE = OPEN_FACTS_DUMPS.food.site;
const USER_AGENT = "GoKesari-ProductMaster/1.0 (https://gokesari.com; product look-up)";

const FIELDS = [
  "code", "product_name", "generic_name", "abbreviated_product_name", "brands", "brand_owner", "categories", "categories_tags",
  "quantity", "product_quantity", "ingredients_text", "allergens", "traces", "serving_size", "packaging", "labels", "labels_tags",
  "nutriscore_grade", "nova_group", "ingredients_analysis_tags", "origins", "manufacturing_places", "image_url",
  "image_ingredients_url", "image_nutrition_url", "completeness", "nutriments", "url",
].join(",");

export function offLookupDefinition(): SourceDefinition {
  return {
    key: OFF_LOOKUP_SOURCE_KEY,
    name: "Open Food Facts (barcode look-up)",
    kind: "OPEN_DATA",
    accessMethod: "OFFICIAL_API",
    status: "ACTIVE",
    reliability: 55,
    specPrecedence: 60,
    legalBasis:
      "Open Food Facts' product read API, one barcode at a time with an identifying User-Agent, within its rate limits. Database licence ODbL 1.0, contents DbCL 1.0, images CC BY-SA: attribution 'Open Food Facts contributors' is stored with each record and derived databases stay under the ODbL.",
    licenseName: "ODbL 1.0 (database) / DbCL 1.0 (contents); images CC BY-SA",
    termsUrl: OFF_TERMS_URL,
    apiEndpoint: `${SITE}/api/v2/product/{barcode}.json`,
    collectionFrequency: "on demand",
    rateLimitPerMin: 60,
    parserKey: "open_facts_api",
    notes: "batch-2026-10 F9.1.2, behind rule pmdSources.openFoodFactsEnabled (default off).",
  };
}

/** OFF API product JSON → the dump's row shape (arrays as comma lists, nutriments flattened), contributors removed. */
export function apiProductToRow(product: Record<string, unknown>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(product)) {
    if (k === "nutriments" && v && typeof v === "object") {
      for (const [nk, nv] of Object.entries(v as Record<string, unknown>)) if (nk.endsWith("_100g")) row[nk] = nv;
    } else if (Array.isArray(v)) {
      row[k] = v.join(",");
    } else {
      row[k] = v;
    }
  }
  return stripContributors(row);
}

export function offLookupSource(deps: { fetch?: typeof fetch } = {}): BarcodeLookupSource {
  const fetchFn = deps.fetch ?? fetch;
  const definition = offLookupDefinition();
  return {
    key: OFF_LOOKUP_SOURCE_KEY,
    label: definition.name,
    kind: "OPEN_DATA",
    definition: () => definition,
    mode: () => "REAL",
    isEnabled: async () => (await getRule("pmdSources")).openFoodFactsEnabled,
    licence: async () => ({ name: definition.licenseName!, url: OFF_LICENCE_URL, attribution: (await getRule("pmdSources")).offAttribution }),
    adapter: (rows) =>
      createRowsAdapter({
        definition,
        rows,
        collectionMethod: "OFFICIAL_API",
        categoryMapper: createCategoryMapper(OPEN_FACTS_RULES),
        imageLicenseNote: "Open Food Facts images: CC BY-SA (contributors); linked, not copied.",
      }),
    async lookup(gtins) {
      const rules = await getRule("pmdSources");
      const found: StagedProduct[] = [];
      const notFound: string[] = [];
      const codes = [...new Set(gtins.map((g) => analyzeGtin(g)).filter((g) => g?.checkDigitValid).map((g) => g!.gtin14))];
      for (const gtin14 of codes) {
        enforceRateLimit("pmd:off-lookup", { limit: rules.offRequestsPerMinute, windowMs: 60_000 });
        // OFF keys EAN-13 / UPC-A barcodes without GTIN-14 padding.
        const code = gtin14.replace(/^0(?=\d{13}$)/, "");
        const res = await fetchFn(`${SITE}/api/v2/product/${encodeURIComponent(code)}.json?fields=${FIELDS}`, {
          headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
          signal: AbortSignal.timeout(15_000),
        });
        if (res.status === 404) {
          notFound.push(gtin14);
          continue;
        }
        if (!res.ok) throw new Error(`Open Food Facts answered ${res.status}.`);
        const body = (await res.json()) as { status?: number; product?: Record<string, unknown> };
        if (body.status !== 1 || !body.product) {
          notFound.push(gtin14);
          continue;
        }
        const row = apiProductToRow({ ...body.product, code: body.product.code ?? code });
        try {
          found.push(parseOpenFactsRow({ sourceProductId: String(row.code), payload: row, url: `${SITE}/product/${code}` }, SITE));
        } catch (error) {
          if (error instanceof ParseError) notFound.push(gtin14);
          else throw error;
        }
      }
      return { found, notFound };
    },
  };
}
