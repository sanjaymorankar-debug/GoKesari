/**
 * Mapped tabular feed adapter (CSV and Excel) - the entry point for LICENSED / PARTNER /
 * MANUFACTURER / GS1 feeds: product files a supplier delivered under an agreement.
 *
 * A feed is described by data, not code: which column holds which platform field.
 * That is how a new supplier is onboarded without touching the engine:
 *
 *   {
 *     "sourceProductId": "SKU",  "name": "Title",  "brand": "Brand",  "gtin": "EAN",
 *     "quantityText": "{Net Content} {UoM|unece}", "categories": "Category",
 *     "manufacturer": "=Acme Foods Ltd",
 *     "offer.price": "Sale Price", "offer.mrp": "MRP", "offer.sellerName": "Seller",
 *     "attribute.ram_gb": "RAM (GB)"
 *   }
 *
 * A mapping value is one of
 *   Column Name          the cell in that column
 *   =Some constant       the same text for every row (a brand the file never repeats)
 *   {A} x {B|unece}     a template: cells joined into text; `|unece` turns a UN/ECE unit code
 *                        (GRM, KGM, MLT, LTR, H87 ...) into g, kg, ml, l, pcs ...
 * Anything not mapped is ignored; a mapping key the platform does not know is an ERROR (a typo
 * must not silently import nothing). The delimiter is configurable; .xlsx is read by streaming.
 * This adapter reads a FILE the operator obtained lawfully; it never fetches anything.
 */
import { createReadStream } from "node:fs";

import { analyzeGtin } from "../../normalize/identifiers";
import { createCategoryMapper, type CategoryMapper } from "../../taxonomy/mapper";
import type { RawRecord, SourceDefinition, StagedAttribute, StagedProduct } from "../../types";
import { ParseError, type SourceAdapter } from "../adapter";
import { parseDelimitedWithHeader } from "../delimited";
import { parseXlsxWithHeader, type TabularRow } from "../xlsx";

export type FeedMapping = Record<string, string>;
export type FeedFormat = "csv" | "xlsx";

export interface CsvFeedOptions {
  definition: SourceDefinition;
  /** A file (format inferred from its extension unless given), or rows already keyed by header (tests). */
  input: { path: string; format?: FeedFormat } | { rows: Record<string, string>[] };
  mapping: FeedMapping;
  delimiter?: string;
  fullSnapshot?: boolean;
  categoryMapper?: CategoryMapper;
  /** Splits a multi-valued cell (categories, images). Default "|". */
  listSeparator?: string;
  /** xlsx: sheet name or 1-based position (default: first visible sheet) and the heading row (default 1). */
  sheet?: string | number;
  headerRow?: number;
  /** Restore leading zeros Excel strips from UPC-A codes (10-11 digit values with a valid check digit). Default true. */
  restoreGtinZeros?: boolean;
}

const SCALAR_FIELDS = [
  "sourceProductId", "sourceUrl", "name", "brand", "manufacturer", "description", "shortDescription", "gtin", "isbn", "mpn",
  "model", "sku", "productCode", "quantityText", "netWeightText", "grossWeightText", "dimensionsText", "color", "size",
  "material", "shape", "variant", "gstRate", "hsnCode", "cess", "countryOfOrigin", "availability",
] as const;

const LIST_FIELDS = ["categories", "images", "keywords"] as const;

const OFFER_FIELDS = [
  "sellerId", "sellerName", "sellerLocation", "sellerRating", "price", "mrp", "currency", "stock", "deliveryInformation", "url", "collectedAt",
] as const;

const KNOWN_KEYS = new Set<string>([...SCALAR_FIELDS, ...LIST_FIELDS, ...OFFER_FIELDS.map((f) => `offer.${f}`)]);

/** UN/ECE Recommendation 20 unit codes as GS1 data uses them -> the symbol the pack-size parser reads. */
const UNECE: Record<string, string> = {
  GRM: "g", KGM: "kg", MGM: "mg", MLT: "ml", LTR: "l", CLT: "cl", DLT: "dl", H87: "pcs", C62: "pcs",
  CMT: "cm", MMT: "mm", MTR: "m", INH: "in", FOT: "ft", ONZ: "oz", LBR: "lb",
};

function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/** Mapping keys the platform does not know, each with the closest valid key when there is one. */
export function validateFeedMapping(mapping: FeedMapping): { key: string; suggestion: string | null }[] {
  const out: { key: string; suggestion: string | null }[] = [];
  for (const key of Object.keys(mapping)) {
    if (KNOWN_KEYS.has(key) || (key.startsWith("attribute.") && key.length > "attribute.".length)) continue;
    const best = [...KNOWN_KEYS].map((k) => ({ k, d: distance(key.toLowerCase(), k.toLowerCase()) })).sort((x, y) => x.d - y.d)[0];
    out.push({ key, suggestion: best && best.d <= 3 ? best.k : null });
  }
  return out;
}

/**
 * Excel drops leading zeros from numeric cells, so a UPC-A like 012345678905 arrives as 12345678905.
 * Only the unambiguous case is repaired: 10-11 digits that become a valid 12-digit GTIN when padded.
 * (Shorter codes could be a truncated GTIN-8 or just an internal number - guessing there would
 * risk a false identity, so they are left alone.)
 */
export function restoreGtin(value: string): string {
  const digits = value.replace(/[\s-]/g, "");
  if (!/^\d{10,11}$/.test(digits)) return value;
  const padded = digits.padStart(12, "0");
  return analyzeGtin(padded)?.checkDigitValid ? padded : value;
}

export interface MapOptions {
  restoreGtinZeros?: boolean;
}

export function mapFeedRow(row: Record<string, string>, mapping: FeedMapping, listSeparator = "|", opts: MapOptions = {}): StagedProduct {
  const column = (col: string): string | null => {
    const v = row[col];
    return v == null || v.trim() === "" ? null : v.trim();
  };
  /** Column name, =constant, or {template}; null when nothing usable. */
  const cell = (spec: string | undefined): string | null => {
    if (!spec) return null;
    if (spec.startsWith("=")) return spec.slice(1).trim() || null;
    if (!spec.includes("{")) return column(spec);
    let any = false;
    const text = spec.replace(/\{([^{}|]+)(?:\|([a-z]+))?\}/g, (_m, col: string, filter?: string) => {
      const v = column(col.trim());
      if (v == null) return "";
      any = true;
      return filter === "unece" ? (UNECE[v.toUpperCase()] ?? v) : v;
    });
    return any ? text.replace(/\s+/g, " ").trim() || null : null;
  };
  const list = (spec: string | undefined): string[] =>
    (cell(spec) ?? "").split(listSeparator).map((s) => s.trim()).filter(Boolean);

  const idSpec = mapping.sourceProductId;
  const id = cell(idSpec);
  if (!id) throw new ParseError("NO_SOURCE_ID", `Row has no value in the source-id column "${idSpec}".`);

  const staged: Record<string, unknown> = { sourceProductId: id };
  for (const f of SCALAR_FIELDS) if (f !== "sourceProductId" && mapping[f]) staged[f] = cell(mapping[f]);
  if (opts.restoreGtinZeros && typeof staged.gtin === "string") staged.gtin = restoreGtin(staged.gtin);
  if (mapping.categories) staged.categories = list(mapping.categories);
  if (mapping.images) staged.images = list(mapping.images);
  if (mapping.keywords) staged.keywords = list(mapping.keywords);

  const offer: Record<string, unknown> = {};
  for (const f of OFFER_FIELDS) if (mapping[`offer.${f}`]) offer[f] = cell(mapping[`offer.${f}`]);
  if (Object.values(offer).some((v) => v != null)) staged.offer = offer;

  const attributes: StagedAttribute[] = [];
  for (const [k, spec] of Object.entries(mapping)) {
    if (!k.startsWith("attribute.")) continue;
    const v = cell(spec);
    if (v != null) attributes.push({ key: k.slice("attribute.".length), value: v });
  }
  if (attributes.length) staged.attributes = attributes;
  return staged as unknown as StagedProduct;
}

/** Marks a row the parser could not read (wrong number of cells). parse() rejects it, so it is logged, not lost. */
const MALFORMED = "__malformed";

interface MalformedRow {
  rowNumber: number;
  width: number;
  expected: number;
}

const formatOf = (path: string): FeedFormat => (/\.xlsx$/i.test(path) ? "xlsx" : "csv");

/**
 * Every row of the feed becomes a record - including the ones that cannot be used (no id, wrong
 * width). parse() rejects those, so each one ends up in IMPORT_ERRORS instead of vanishing.
 * Row numbers are file rows: the header is row 1 (or `headerRow`), the first data row follows.
 */
async function* feedRecords(opts: CsvFeedOptions): AsyncGenerator<RawRecord> {
  const idSpec = opts.mapping.sourceProductId;
  const idColumn = idSpec.startsWith("=") || idSpec.includes("{") ? null : idSpec;
  const record = ({ row, rowNumber }: TabularRow): RawRecord => ({
    sourceProductId: (idColumn ? row[idColumn]?.trim() : "") || `row-${rowNumber}`,
    payload: row,
  });

  if ("rows" in opts.input) {
    let rowNumber = 1;
    for (const row of opts.input.rows) yield record({ row, rowNumber: ++rowNumber });
    return;
  }

  if ((opts.input.format ?? formatOf(opts.input.path)) === "xlsx") {
    for await (const r of parseXlsxWithHeader(opts.input.path, { sheet: opts.sheet, headerRow: opts.headerRow })) yield record(r);
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
    yield record({ row, rowNumber: nextRow++ });
  }
  yield* malformed.splice(0);
}

/** Technical format recorded on every source row, prefixed by how the data was obtained. */
function collectionMethodFor(def: SourceDefinition, format: FeedFormat): string {
  const prefix = ({ MANUFACTURER_FEED: "MANUFACTURER_FEED", LICENSED_FEED: "LICENSED_FEED", MANUAL_UPLOAD: "MANUAL_UPLOAD" } as Record<string, string>)[def.accessMethod] ?? "FILE_FEED";
  return `${prefix}_${format.toUpperCase()}`;
}

export function createTabularFeedAdapter(opts: CsvFeedOptions): SourceAdapter {
  if (!opts.mapping.sourceProductId) throw new Error("feed mapping must name the sourceProductId column");
  const unknown = validateFeedMapping(opts.mapping);
  if (unknown.length) {
    throw new Error(
      `feed mapping has key(s) the platform does not know: ` +
        unknown.map((u) => (u.suggestion ? `"${u.key}" (did you mean "${u.suggestion}"?)` : `"${u.key}"`)).join(", "),
    );
  }
  const format: FeedFormat = "rows" in opts.input ? "csv" : (opts.input.format ?? formatOf(opts.input.path));
  return {
    definition: opts.definition,
    collectionMethod: collectionMethodFor(opts.definition, format),
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
      return mapFeedRow(raw.payload as Record<string, string>, opts.mapping, opts.listSeparator, { restoreGtinZeros: opts.restoreGtinZeros ?? true });
    },
  };
}

/** The original name, kept so existing callers and documents keep working. */
export const createCsvFeedAdapter = createTabularFeedAdapter;
