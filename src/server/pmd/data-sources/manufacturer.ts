/**
 * Manufacturer self-upload (batch-2026-10 WS-D, F9.1.2) — the primary source.
 *
 * A manufacturer (brand owner) downloads the template, fills one row per
 * product (GTIN/EAN, MRP, HSN, image URLs, descriptions, brand, pack size…)
 * and uploads it at /manufacturer, or POSTs the same rows with its API key.
 * Rows are validated here — GTIN check digit (normalize/identifiers.ts), MRP,
 * HSN, GST, image addresses — and duplicates inside one file are flagged by
 * GTIN-14 before anything is staged. Its records are BRAND_MANUFACTURER data
 * (highest precedence for specifications, tax and MRP), filed under the
 * account's own source `mfr_<slug>`.
 */
import ExcelJS from "exceljs";

import { analyzeGtin } from "../normalize/identifiers";
import { createRowsAdapter } from "../sources/adapters/rows";
import { checkImageUrl } from "@/server/product-import/image-fetch";
import { getRule } from "@/server/services/settings";
import { standardCodeMapper } from "../services/ingest-api";
import type { SourceDefinition, StagedAttribute, StagedProduct } from "../types";
import type { ProductDataSource } from "./types";

/** Template columns, in order. `aliases` are other headings accepted for the same column. */
export const MANUFACTURER_TEMPLATE_COLUMNS = [
  { key: "gtin", header: "GTIN", required: true, aliases: ["EAN", "Barcode", "Barcode (EAN)", "GTIN/EAN", "EAN/GTIN"], example: "8901058000009", help: "8, 12, 13 or 14 digits with a valid check digit" },
  { key: "itemCode", header: "Item Code", required: false, aliases: ["SKU", "Product Code"], example: "AB-1001", help: "Your own code (optional)" },
  { key: "name", header: "Product Name", required: true, aliases: ["Name", "Title"], example: "Amul Butter Pasteurised 100 g", help: "As printed on the pack" },
  { key: "brand", header: "Brand", required: true, aliases: [], example: "Amul", help: "Brand on the pack" },
  { key: "manufacturer", header: "Manufacturer", required: false, aliases: ["Marketed By", "Brand Owner"], example: "Gujarat Co-operative Milk Marketing Federation", help: "Legal name" },
  { key: "category", header: "Category", required: false, aliases: ["Category Path"], example: "dairy/butter", help: "GoKesari category path or your category" },
  { key: "packSize", header: "Pack Size", required: false, aliases: ["Net Quantity", "Net Content", "Quantity"], example: "100 g", help: "e.g. 100 g, 1 L, 6 x 200 ml" },
  { key: "mrp", header: "MRP", required: false, aliases: ["MRP (Rs)", "MRP (₹)", "MRP (INR)"], example: "62.00", help: "In rupees, as printed" },
  { key: "gstRate", header: "GST %", required: false, aliases: ["GST", "GST Rate"], example: "12", help: "0, 0.25, 3, 5, 12, 18, 28 or 40" },
  { key: "hsn", header: "HSN", required: false, aliases: ["HSN Code"], example: "04051000", help: "4, 6 or 8 digits" },
  { key: "shortDescription", header: "Short Description", required: false, aliases: [], example: "Pasteurised table butter", help: "One line" },
  { key: "description", header: "Description", required: false, aliases: ["Long Description"], example: "Made from fresh cream…", help: "Full description" },
  { key: "images", header: "Image URLs", required: false, aliases: ["Image URL", "Images"], example: "https://example.com/butter-front.jpg|https://example.com/butter-back.jpg", help: "https addresses, separated by |" },
  { key: "countryOfOrigin", header: "Country of Origin", required: false, aliases: ["Origin"], example: "India", help: "" },
  { key: "ingredients", header: "Ingredients", required: false, aliases: [], example: "Milk fat, common salt", help: "Food only" },
  { key: "shelfLife", header: "Shelf Life", required: false, aliases: [], example: "12 months", help: "Food only" },
] as const;

export type TemplateKey = (typeof MANUFACTURER_TEMPLATE_COLUMNS)[number]["key"];
export type TemplateRow = Partial<Record<TemplateKey, string>>;

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9%₹]/g, "");
const HEADER_INDEX = new Map<string, TemplateKey>(
  MANUFACTURER_TEMPLATE_COLUMNS.flatMap((c) => [c.header, ...c.aliases].map((h) => [norm(h), c.key] as const)),
);

/** Maps a file row keyed by its own headings to the template's keys (unknown columns are ignored). */
export function toTemplateRow(row: Record<string, unknown>): TemplateRow {
  const out: TemplateRow = {};
  for (const [heading, value] of Object.entries(row)) {
    const key = HEADER_INDEX.get(norm(heading));
    if (!key) continue;
    const text = value == null ? "" : String(value).trim();
    if (text) out[key] = text;
  }
  return out;
}

/** Headings that are required but absent from a file — reported once, before any row. */
export function missingRequiredHeadings(headings: string[]): string[] {
  const present = new Set(headings.map((h) => HEADER_INDEX.get(norm(h))).filter(Boolean));
  return MANUFACTURER_TEMPLATE_COLUMNS.filter((c) => c.required && !present.has(c.key)).map((c) => c.header);
}

export interface RowOutcome {
  ok: boolean;
  gtin14: string | null;
  sourceProductId: string | null;
  staged: StagedProduct | null;
  errorCode: string | null;
  errorMessage: string | null;
}

const GST_RATES = new Set([0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28, 40]);

/** Validates one template row and turns it into the pipeline's staged vocabulary. */
export function validateTemplateRow(row: TemplateRow, defaults: { brand?: string | null; manufacturer?: string | null } = {}): RowOutcome {
  const fail = (code: string, message: string, gtin14: string | null = null): RowOutcome => ({
    ok: false,
    gtin14,
    sourceProductId: null,
    staged: null,
    errorCode: code,
    errorMessage: message,
  });
  if (!row.gtin) return fail("GTIN_MISSING", "GTIN / EAN is required.");
  const g = analyzeGtin(row.gtin);
  if (!g) return fail("GTIN_INVALID", `"${row.gtin}" is not a GTIN (8, 12, 13 or 14 digits).`);
  if (!g.checkDigitValid) return fail("GTIN_CHECK_DIGIT", `GTIN ${row.gtin} has a wrong check digit.`, g.gtin14);
  if (!g.usableForMatching) return fail("GTIN_RESTRICTED", `GTIN ${row.gtin} is an in-store / restricted code and cannot identify a product.`, g.gtin14);
  const name = row.name?.trim();
  if (!name) return fail("NAME_MISSING", "Product Name is required.", g.gtin14);
  const brand = row.brand?.trim() || defaults.brand?.trim();
  if (!brand) return fail("BRAND_MISSING", "Brand is required.", g.gtin14);

  let mrp: number | null = null;
  if (row.mrp) {
    mrp = Number(row.mrp.replace(/[₹,\s]|rs\.?/gi, ""));
    if (!Number.isFinite(mrp) || mrp <= 0 || mrp > 10_000_000) return fail("MRP_INVALID", `MRP "${row.mrp}" is not a price in rupees.`, g.gtin14);
  }
  let gstRate: number | null = null;
  if (row.gstRate) {
    gstRate = Number(row.gstRate.replace(/%/g, "").trim());
    if (!Number.isFinite(gstRate) || !GST_RATES.has(gstRate)) return fail("GST_INVALID", `GST % "${row.gstRate}" is not a GST rate.`, g.gtin14);
  }
  const hsn = row.hsn?.replace(/\s/g, "") ?? null;
  if (hsn && !/^\d{4}(\d{2}){0,2}$/.test(hsn)) return fail("HSN_INVALID", `HSN "${row.hsn}" must be 4, 6 or 8 digits.`, g.gtin14);

  const images = (row.images ?? "").split(/[|\n]+|\s*,\s*(?=https?:)/).map((u) => u.trim()).filter(Boolean);
  for (const url of images) {
    try {
      checkImageUrl(url);
    } catch (error) {
      return fail("IMAGE_URL_INVALID", `Image URL "${url.slice(0, 120)}": ${(error as Error).message}.`, g.gtin14);
    }
  }

  const attributes: StagedAttribute[] = [];
  if (row.ingredients) attributes.push({ key: "ingredients", value: row.ingredients });
  if (row.shelfLife) attributes.push({ key: "shelf_life", value: row.shelfLife });

  const sourceProductId = g.gtin14;
  return {
    ok: true,
    gtin14: g.gtin14,
    sourceProductId,
    errorCode: null,
    errorMessage: null,
    staged: {
      sourceProductId,
      name,
      brand,
      manufacturer: row.manufacturer?.trim() || defaults.manufacturer?.trim() || null,
      categories: row.category ? [row.category] : [],
      description: row.description ?? null,
      shortDescription: row.shortDescription ?? null,
      gtin: g.gtin14,
      productCode: row.itemCode ?? null,
      quantityText: row.packSize ?? null,
      gstRate,
      hsnCode: hsn,
      countryOfOrigin: row.countryOfOrigin ?? null,
      attributes,
      images,
      offer: mrp != null ? { mrp, sellerName: brand, currency: "INR" } : null,
    },
  };
}

/** The pmd.source row of one manufacturer account. ACTIVE: the account exists because an admin onboarded it. */
export function manufacturerSourceDefinition(account: { sourceKey: string; name: string }): SourceDefinition {
  return {
    key: account.sourceKey,
    name: `Manufacturer: ${account.name}`,
    kind: "BRAND_MANUFACTURER",
    accessMethod: "MANUFACTURER_FEED",
    status: "ACTIVE",
    reliability: 95,
    specPrecedence: 10,
    legalBasis:
      "Catalogue data uploaded by the brand owner itself through the GoKesari manufacturer portal or its API key, under the portal's terms (the uploader confirms it may supply the data).",
    collectionFrequency: "on upload",
    parserKey: "manufacturer_template",
    notes: "batch-2026-10 F9.1.2 manufacturer self-upload portal.",
  };
}

export function manufacturerDataSource(account: { sourceKey: string; name: string }): ProductDataSource {
  const definition = manufacturerSourceDefinition(account);
  return {
    key: account.sourceKey,
    label: definition.name,
    kind: "MANUFACTURER",
    definition: () => definition,
    isEnabled: async () => (await getRule("pmdSources")).manufacturerPortalEnabled,
    licence: async () => null,
    adapter: (rows) =>
      createRowsAdapter({ definition, rows, collectionMethod: "MANUFACTURER_UPLOAD", categoryMapper: standardCodeMapper(), createsProducts: true }),
  };
}

/* ---------------------------------------------------------------- template */

export function templateCsv(): Buffer {
  const quote = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const header = MANUFACTURER_TEMPLATE_COLUMNS.map((c) => quote(c.header)).join(",");
  const example = MANUFACTURER_TEMPLATE_COLUMNS.map((c) => quote(c.example)).join(",");
  return Buffer.from(`﻿${header}\r\n${example}\r\n`, "utf8");
}

export async function templateXlsx(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "GoKesari";
  const ws = wb.addWorksheet("Products");
  ws.columns = MANUFACTURER_TEMPLATE_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: Math.max(14, c.header.length + 4) }));
  ws.getRow(1).font = { bold: true };
  // GTINs are text: Excel would otherwise drop leading zeros and turn 13 digits into 8.9E+12.
  ws.getColumn("gtin").numFmt = "@";
  ws.addRow(Object.fromEntries(MANUFACTURER_TEMPLATE_COLUMNS.map((c) => [c.key, c.example])));
  const help = wb.addWorksheet("How to fill");
  help.columns = [
    { header: "Column", key: "h", width: 22 },
    { header: "Required", key: "r", width: 10 },
    { header: "What to enter", key: "w", width: 70 },
  ];
  help.getRow(1).font = { bold: true };
  for (const c of MANUFACTURER_TEMPLATE_COLUMNS) help.addRow({ h: c.header, r: c.required ? "yes" : "", w: c.help });
  return Buffer.from(await wb.xlsx.writeBuffer());
}
