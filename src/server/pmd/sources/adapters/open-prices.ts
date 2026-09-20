/**
 * Open Prices adapter - crowdsourced shelf-price observations from the Open Food
 * Facts project (prices.openfoodfacts.org).
 *
 * Access method: the project's public REST API. Its robots.txt is empty (no
 * restrictions) and the API is provided for programmatic use; the polite client
 * still identifies us, rate-limits, and retries with backoff.
 *
 * Each observation is one offer: WHO (a store, from OpenStreetMap), WHAT (a
 * barcode), HOW MUCH (price, currency) and WHEN (date). Observations for the same
 * barcode from different stores are different sellers; later observations from the
 * same store are price history - never duplicate products.
 *
 * What is deliberately NOT done:
 *   - contributor usernames and proof images are never stored (people, not products);
 *   - prices quoted per kilogram are skipped: they are not the price of a pack;
 *   - a price observation does not prove stock, so stock stays UNKNOWN.
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

import { createCategoryMapper } from "../../taxonomy/mapper";
import type { RawRecord, SourceDefinition, StagedProduct } from "../../types";
import { type ExtractContext, ParseError, type SourceAdapter } from "../adapter";
import type { PoliteHttpClient } from "../http";
import { OPEN_FACTS_RULES } from "../mappings/open-facts";

export const OPEN_PRICES_API = "https://prices.openfoodfacts.org/api/v1/prices";

export const OPEN_PRICES_DEFINITION: SourceDefinition = {
  key: "open_prices",
  name: "Open Prices (Open Food Facts)",
  kind: "OPEN_DATA",
  accessMethod: "OFFICIAL_API",
  status: "ACTIVE",
  reliability: 50,
  specPrecedence: 65,
  legalBasis:
    "Public REST API of an open-data project, provided for programmatic reuse; robots.txt is empty (no restrictions). " +
    "Open database licence (ODbL) - attribute the contributors and keep derived data under the same terms.",
  licenseName: "ODbL 1.0 (verify on prices.openfoodfacts.org/about before redistribution)",
  termsUrl: "https://prices.openfoodfacts.org/about",
  robotsPolicy: "robots.txt on prices.openfoodfacts.org is empty (checked 2026-09-19).",
  apiEndpoint: OPEN_PRICES_API,
  collectionFrequency: "daily",
  rateLimitPerMin: 30,
  parserKey: "open_prices_json",
  retryMax: 3,
  notes: "Shelf-price observations submitted by volunteers. Not a marketplace feed: no stock, no MRP, sparse for India.",
};

/* --------------------------------------------------------------- fetching */

export interface OpenPricesPage {
  items: Record<string, unknown>[];
  total: number;
  page: number;
  pages: number;
  size: number;
}

export async function fetchOpenPricesPage(
  http: PoliteHttpClient,
  params: { currency: string; page: number; size: number },
): Promise<OpenPricesPage> {
  const q = new URLSearchParams({
    currency: params.currency,
    page: String(params.page),
    size: String(params.size),
    order_by: "date",
  });
  return http.getJson<OpenPricesPage>(`${OPEN_PRICES_API}?${q}`);
}

/** Removes contributor identities and proof references from an observation. */
export function stripPersonalData(item: Record<string, unknown>): Record<string, unknown> {
  const { owner: _owner, proof: _proof, proof_id: _proofId, ...rest } = item;
  void _owner;
  void _proof;
  void _proofId;
  const product = rest.product as Record<string, unknown> | null | undefined;
  if (product && typeof product === "object") {
    const { creator: _creator, ...p } = product;
    void _creator;
    rest.product = p;
  }
  return rest;
}

/* ---------------------------------------------------------------- adapter */

export type OpenPricesInput = { mode: "file"; path: string } | { mode: "rows"; rows: Record<string, unknown>[] };

export function createOpenPricesAdapter(input: OpenPricesInput): SourceAdapter {
  return {
    definition: OPEN_PRICES_DEFINITION,
    collectionMethod: "OFFICIAL_API_JSON",
    createsProducts: true,
    supportsFullSnapshot: false,
    categoryMapper: createCategoryMapper(OPEN_FACTS_RULES),
    imageLicenseNote: "Open Food Facts images: CC BY-SA (contributors); linked, not copied.",

    async *extract(ctx: ExtractContext): AsyncGenerator<RawRecord> {
      let n = 0;
      const emit = (item: Record<string, unknown>): RawRecord | null => {
        const code = String(item.product_code ?? (item.product as Record<string, unknown> | null)?.code ?? "").trim();
        if (!code) return null;
        return { sourceProductId: code, payload: item, url: `https://prices.openfoodfacts.org/prices/${item.id}` };
      };
      if (input.mode === "rows") {
        for (const item of input.rows) {
          const rec = emit(item);
          if (rec) {
            yield rec;
            if (ctx.limit && ++n >= ctx.limit) return;
          }
        }
        return;
      }
      const rl = createInterface({ input: createReadStream(input.path, { encoding: "utf8" }), crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line.trim()) continue;
        const rec = emit(JSON.parse(line) as Record<string, unknown>);
        if (rec) {
          yield rec;
          if (ctx.limit && ++n >= ctx.limit) return;
        }
      }
    },

    sanitize: stripPersonalData,
    parse: parseOpenPricesItem,
  };
}

const str = (v: unknown): string | null => {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
};

export function parseOpenPricesItem(raw: RawRecord): StagedProduct {
  const item = raw.payload;
  if (item.type && item.type !== "PRODUCT") throw new ParseError("NOT_A_PRODUCT_PRICE", "Observation is for a category, not a product.", "WARNING");
  const product = (item.product ?? {}) as Record<string, unknown>;
  const code = str(item.product_code) ?? str(product.code);
  if (!code) throw new ParseError("NO_CODE", "Observation has no barcode.");

  const per = str(item.price_per);
  if (per && per.toUpperCase() !== "UNIT") {
    throw new ParseError("PRICE_PER_MEASURE", `Price is quoted per ${per}, not per pack; skipped.`, "WARNING");
  }
  const price = item.price;
  if (price == null || Number.isNaN(Number(price))) throw new ParseError("NO_PRICE", "Observation has no usable price.");

  const location = (item.location ?? {}) as Record<string, unknown>;
  const city = str(location.osm_address_city);
  const country = str(location.osm_address_country);
  const sellerName = str(location.osm_name) ?? str(location.osm_display_name);
  const osmId = str(location.osm_id);
  const date = str(item.date);
  if (!date || Number.isNaN(Date.parse(date))) throw new ParseError("NO_DATE", "Observation has no valid date.");

  return {
    sourceProductId: code,
    sourceUrl: raw.url ?? null,
    name: str(product.product_name),
    brand: str(product.brands),
    gtin: code,
    quantityText: str(product.quantity),
    categories: Array.isArray(product.categories_tags) ? (product.categories_tags as unknown[]).map(String) : [],
    images: [str(product.image_url)].filter((u): u is string => !!u),
    offer: {
      sellerId: osmId ? `osm:${str(location.osm_type) ?? "node"}:${osmId}` : null,
      sellerName,
      sellerLocation: [city, country].filter(Boolean).join(", ") || null,
      price: Number(price),
      currency: str(item.currency),
      // A price seen on a shelf does not prove the item is in stock.
      stock: null,
      // Date-only observation: midnight UTC, so the same day is always the same instant.
      collectedAt: new Date(`${date.slice(0, 10)}T00:00:00Z`),
      url: raw.url ?? null,
    },
  };
}
