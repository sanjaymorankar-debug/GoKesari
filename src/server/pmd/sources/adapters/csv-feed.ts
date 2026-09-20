/**
 * Mapped CSV feed adapter - the entry point for LICENSED / PARTNER feeds
 * (affiliate product feeds, distributor price lists, manufacturer catalogues).
 *
 * A feed is described by data, not code: which column holds which platform field.
 * That is how a new partner is onboarded without touching the engine:
 *
 *   {
 *     "sourceProductId": "SKU",  "name": "Title",  "brand": "Brand",  "gtin": "EAN",
 *     "quantityText": "Pack Size", "categories": "Category",
 *     "offer.price": "Sale Price", "offer.mrp": "MRP", "offer.sellerName": "Seller",
 *     "offer.stock": "Availability", "images": "Image URL"
 *   }
 *
 * Anything not mapped is ignored. Category-specific facts map through
 * `attribute.<key>` (e.g. "attribute.ram_gb": "RAM (GB)"). The delimiter is configurable.
 * This adapter reads a FILE the operator obtained lawfully; it never fetches anything.
 */
import { createReadStream } from "node:fs";

import { createCategoryMapper, type CategoryMapper } from "../../taxonomy/mapper";
import type { RawRecord, SourceDefinition, StagedAttribute, StagedProduct } from "../../types";
import { ParseError, type SourceAdapter } from "../adapter";
import { parseDelimitedWithHeader } from "../delimited";

export type FeedMapping = Record<string, string>;

export interface CsvFeedOptions {
  definition: SourceDefinition;
  /** Path to the feed file, or an async iterable of rows already keyed by header (tests). */
  input: { path: string } | { rows: Record<string, string>[] };
  mapping: FeedMapping;
  delimiter?: string;
  fullSnapshot?: boolean;
  categoryMapper?: CategoryMapper;
  /** Splits a multi-valued cell (categories, images). Default "|". */
  listSeparator?: string;
}

const SCALAR_FIELDS = [
  "sourceProductId", "sourceUrl", "name", "brand", "manufacturer", "description", "shortDescription", "gtin", "isbn", "mpn",
  "model", "sku", "productCode", "quantityText", "netWeightText", "grossWeightText", "dimensionsText", "color", "size",
  "material", "shape", "variant", "gstRate", "hsnCode", "cess", "countryOfOrigin", "availability",
] as const;

const OFFER_FIELDS = [
  "sellerId", "sellerName", "sellerLocation", "sellerRating", "price", "mrp", "currency", "stock", "deliveryInformation", "url", "collectedAt",
] as const;

export function mapFeedRow(row: Record<string, string>, mapping: FeedMapping, listSeparator = "|"): StagedProduct {
  const cell = (col: string | undefined): string | null => {
    if (!col) return null;
    const v = row[col];
    return v == null || v.trim() === "" ? null : v.trim();
  };
  const list = (col: string | undefined): string[] =>
    (cell(col) ?? "").split(listSeparator).map((s) => s.trim()).filter(Boolean);

  const idCol = mapping.sourceProductId;
  const id = cell(idCol);
  if (!id) throw new ParseError("NO_SOURCE_ID", `Row has no value in the source-id column "${idCol}".`);

  const staged: Record<string, unknown> = { sourceProductId: id };
  for (const f of SCALAR_FIELDS) if (f !== "sourceProductId" && mapping[f]) staged[f] = cell(mapping[f]);
  if (mapping.categories) staged.categories = list(mapping.categories);
  if (mapping.images) staged.images = list(mapping.images);
  if (mapping.keywords) staged.keywords = list(mapping.keywords);

  const offer: Record<string, unknown> = {};
  for (const f of OFFER_FIELDS) if (mapping[`offer.${f}`]) offer[f] = cell(mapping[`offer.${f}`]);
  if (Object.values(offer).some((v) => v != null)) staged.offer = offer;

  const attributes: StagedAttribute[] = [];
  for (const [k, col] of Object.entries(mapping)) {
    if (!k.startsWith("attribute.")) continue;
    const v = cell(col);
    if (v != null) attributes.push({ key: k.slice("attribute.".length), value: v });
  }
  if (attributes.length) staged.attributes = attributes;
  return staged as unknown as StagedProduct;
}

/** Marks a row the CSV parser could not read (wrong number of cells). parse() rejects it, so it is logged, not lost. */
const MALFORMED = "__malformed";

interface MalformedRow {
  rowNumber: number;
  width: number;
  expected: number;
}

/**
 * Every row of the feed becomes a record - including the ones that cannot be used (no id, wrong
 * width). parse() rejects those, so each one ends up in IMPORT_ERRORS instead of vanishing.
 * Row numbers are file rows: the header is row 1, the first data row is row 2.
 */
async function* feedRecords(opts: CsvFeedOptions): AsyncGenerator<RawRecord> {
  const idCol = opts.mapping.sourceProductId;
  const record = (row: Record<string, string>, rowNumber: number): RawRecord => ({
    sourceProductId: row[idCol]?.trim() || `row-${rowNumber}`,
    payload: row,
  });

  if ("rows" in opts.input) {
    let rowNumber = 1;
    for (const row of opts.input.rows) yield record(row, ++rowNumber);
    return;
  }

  const malformed: RawRecord[] = [];
  let nextRow = 2;
  for await (const row of parseDelimitedWithHeader(createReadStream(opts.input.path), {
    delimiter: opts.delimiter ?? ",",
    onBadRow: (rowNumber, width, expected) => {
      nextRow = rowNumber + 1;
      const detail: MalformedRow = { rowNumber, width, expected };
      malformed.push({ sourceProductId: `row-${rowNumber}`, payload: { [MALFORMED]: detail } });
    },
  })) {
    yield* malformed.splice(0);
    yield record(row, nextRow++);
  }
  yield* malformed.splice(0);
}

export function createCsvFeedAdapter(opts: CsvFeedOptions): SourceAdapter {
  if (!opts.mapping.sourceProductId) throw new Error("feed mapping must name the sourceProductId column");
  return {
    definition: opts.definition,
    collectionMethod: "LICENSED_FEED_CSV",
    createsProducts: true,
    supportsFullSnapshot: opts.fullSnapshot ?? false,
    categoryMapper: opts.categoryMapper ?? createCategoryMapper({ tags: {}, keywords: [] }),

    async *extract(ctx): AsyncGenerator<RawRecord> {
      let n = 0;
      for await (const rec of feedRecords(opts)) {
        yield rec;
        n++;
        if (ctx.limit && n >= ctx.limit) return;
      }
    },

    parse: (raw) => {
      const bad = raw.payload[MALFORMED] as MalformedRow | undefined;
      if (bad) {
        throw new ParseError("ROW_WIDTH", `Row ${bad.rowNumber} has ${bad.width} column(s) but the header has ${bad.expected}; the row was not loaded.`);
      }
      return mapFeedRow(raw.payload as Record<string, string>, opts.mapping, opts.listSeparator);
    },
  };
}
