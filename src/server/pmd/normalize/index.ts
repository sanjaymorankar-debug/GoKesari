/**
 * StagedProduct -> NormalizedProduct.
 *
 * Pure: no I/O, no clock reads except through `ctx.now`, so it is deterministic and
 * cheap to test. Everything that can go wrong with a value becomes an
 * issue on the result rather than a thrown error - one bad field must not lose a
 * whole record, and the issues end up in IMPORT_ERRORS for a steward to see.
 *
 * Original values are never destroyed: the staged record is kept in raw_record and
 * `original` is carried on quantities, identifiers and attributes.
 */
import { getAttributeDefinition, toAttributeKey } from "../taxonomy/attributes";
import { UNCATEGORISED_CODE } from "../taxonomy/categories";
import type { CategoryMapper } from "../taxonomy/mapper";
import type {
  GtinInfo,
  NormalizationIssue,
  NormalizedAttribute,
  NormalizedOffer,
  NormalizedProduct,
  StagedAttribute,
  StagedOffer,
  StagedProduct,
} from "../types";
import {
  normalizeColor,
  normalizeCountry,
  normalizeSize,
  parseBoolean,
  parseStockStatus,
  toMinorUnits,
} from "./attributes";
import { entityKey, looksLikeCompany, normalizeEntity, splitBrandList } from "./brand";
import { analyzeGtin, normalizeAlnumKey } from "./identifiers";
import { gstSlabStatus, normalizeFssai, normalizeHsn, parseGstRate } from "./tax";
import { cleanDisplay, isNullLike, normalizeText, presentString } from "./text";
import { parseDimensions, parseMeasure, parseQuantity, stripQuantityFromText } from "./units";

export interface NormalizeContext {
  categoryMapper: CategoryMapper;
  now?: Date;
}

/** Words that never distinguish one product from another. */
const NAME_NOISE = new Set([
  "the", "and", "of", "with", "for", "a", "an", "by", "from", "in", "on",
  "new", "original", "genuine", "authentic", "official", "pack", "packs", "combo",
]);

const PLACEHOLDER_NAME = /^(loading|unknown|untitled|no name|noname|name|test|testing|sample|product|item|none|xx+|foo|bar|baz|asdf|qwerty|na|n a)$/;

/** True for names that carry no product information: placeholders, bare numbers, single characters. */
export function isPlaceholderName(name: string): boolean {
  const n = normalizeText(name);
  if (n.length < 2) return true;
  if (/^[\d.% ]+$/.test(n) && n.replace(/\D/g, "").length <= 4) return true;
  return PLACEHOLDER_NAME.test(n);
}

/** Removes the brand (however it is spaced) and pack/quantity words, leaving the product's own name. */
export function buildCoreName(name: string, brandKey: string | null): string {
  let tokens = normalizeText(stripQuantityFromText(name, { fromTitle: true })).split(" ").filter(Boolean);

  if (brandKey) {
    outer: for (let i = 0; i < tokens.length; i++) {
      let joined = "";
      for (let j = i; j < Math.min(tokens.length, i + 4); j++) {
        joined += tokens[j];
        if (joined === brandKey) {
          tokens = [...tokens.slice(0, i), ...tokens.slice(j + 1)];
          break outer;
        }
        if (joined.length > brandKey.length) break;
      }
    }
  }
  tokens = tokens.filter((t) => !NAME_NOISE.has(t));
  return tokens.join(" ");
}

function issue(
  list: NormalizationIssue[],
  field: string,
  code: string,
  severity: NormalizationIssue["severity"],
  message: string,
  original?: string | null,
): void {
  list.push({ field, code, severity, message, ...(original != null ? { original } : {}) });
}

function normalizeOffer(
  staged: StagedOffer,
  now: Date,
  issues: NormalizationIssue[],
): NormalizedOffer | null {
  const priceMinor = toMinorUnits(staged.price ?? null);
  const mrpMinor = toMinorUnits(staged.mrp ?? null);
  if (staged.price != null && priceMinor == null) {
    issue(issues, "offer.price", "PRICE_UNPARSEABLE", "WARNING", "Price could not be read as an amount.", String(staged.price));
  }
  if (staged.mrp != null && mrpMinor == null) {
    issue(issues, "offer.mrp", "MRP_UNPARSEABLE", "WARNING", "MRP could not be read as an amount.", String(staged.mrp));
  }
  if (priceMinor != null && mrpMinor != null && priceMinor > mrpMinor) {
    // Selling above the printed MRP is unlawful under Legal Metrology rules - keep the data, flag it.
    issue(issues, "offer.price", "PRICE_ABOVE_MRP", "WARNING", "Selling price is above the MRP.", `${priceMinor} > ${mrpMinor}`);
  }

  const sellerName = presentString(staged.sellerName);
  const sellerId = presentString(staged.sellerId);
  const hasAnything = priceMinor != null || mrpMinor != null || sellerName || sellerId || staged.stock != null;
  if (!hasAnything) return null;

  let collectedAt = now;
  if (staged.collectedAt) {
    const d = staged.collectedAt instanceof Date ? staged.collectedAt : new Date(staged.collectedAt);
    if (!Number.isNaN(d.getTime())) collectedAt = d;
    else issue(issues, "offer.collectedAt", "DATE_UNPARSEABLE", "WARNING", "Observation date could not be read; using collection time.", String(staged.collectedAt));
  }

  const rating = staged.sellerRating == null ? null : Number(staged.sellerRating);
  return {
    sellerId,
    sellerName,
    sellerLocation: presentString(staged.sellerLocation),
    sellerRating: rating != null && Number.isFinite(rating) && rating >= 0 && rating <= 5 ? rating : null,
    priceMinor,
    mrpMinor,
    currency: (presentString(staged.currency) ?? "INR").toUpperCase().slice(0, 3),
    stockStatus: parseStockStatus(staged.stock),
    deliveryInformation: presentString(staged.deliveryInformation),
    url: presentString(staged.url),
    collectedAt,
    taxInclusive: staged.taxInclusive ?? null,
    sellerKey: (sellerId ?? sellerName ?? "").toLowerCase(),
  };
}

function normalizeAttributes(list: StagedAttribute[], issues: NormalizationIssue[]): NormalizedAttribute[] {
  const out = new Map<string, NormalizedAttribute>();
  for (const a of list) {
    const key = toAttributeKey(a.key);
    if (!key || a.value == null || isNullLike(a.value)) continue;
    const def = getAttributeDefinition(key);
    const original = a.original ?? (typeof a.value === "string" ? a.value : String(a.value));
    const unit = a.unit ?? def?.unit;
    let attr: NormalizedAttribute | null = null;

    if (def?.dataType === "NUMBER") {
      const n = typeof a.value === "number" ? a.value : parseFloat(String(a.value).replace(/,/g, ""));
      if (Number.isFinite(n)) attr = { key, valueNum: n, ...(unit ? { unit } : {}), original };
      else issue(issues, key, "ATTRIBUTE_NOT_NUMERIC", "WARNING", `Expected a number for ${key}.`, original);
    } else if (def?.dataType === "BOOLEAN") {
      const b = parseBoolean(a.value);
      if (b != null) attr = { key, valueBool: b, original };
      else issue(issues, key, "ATTRIBUTE_NOT_BOOLEAN", "WARNING", `Expected yes/no for ${key}.`, original);
    } else if (typeof a.value === "number") {
      attr = { key, valueNum: a.value, ...(unit ? { unit } : {}), original };
    } else if (typeof a.value === "boolean") {
      attr = { key, valueBool: a.value, original };
    } else {
      const text = cleanDisplay(a.value);
      if (text) attr = { key, valueText: text, original };
    }

    if (key === "fssai_number" && attr?.valueText) {
      const f = normalizeFssai(attr.valueText);
      if (!f) {
        issue(issues, key, "FSSAI_INVALID", "WARNING", "FSSAI number must be 14 digits starting with 1 or 2.", attr.valueText);
        attr = null;
      } else attr = { ...attr, valueText: f };
    }
    if (attr) out.set(key, attr);
  }
  return [...out.values()];
}

export function normalizeStaged(staged: StagedProduct, ctx: NormalizeContext): NormalizedProduct {
  const now = ctx.now ?? new Date();
  const issues: NormalizationIssue[] = [];

  /* ------------------------------------------------------------- names */
  let name = presentString(staged.name);
  if (name && isPlaceholderName(name)) {
    // "Loading…", "1", "xx": crowdsourced junk. Treated as no name at all - never as a product called "1".
    issue(issues, "name", "NAME_PLACEHOLDER", "WARNING", "Name is a placeholder, not a product name.", name);
    name = null;
  }
  if (!name) issue(issues, "name", "NAME_MISSING", "ERROR", "Product has no name.");

  /* ------------------------------------------------------------- brand */
  const brandList = splitBrandList(staged.brand);
  const brand = normalizeEntity(brandList[0] ?? null);
  const otherBrands = brandList.slice(1);
  if (!brand) issue(issues, "brand", "BRAND_MISSING", "INFO", "No brand supplied.");

  let manufacturer = normalizeEntity(staged.manufacturer ?? null);
  // A company-looking secondary "brand" (Open Food Facts style) is the manufacturer when none was given.
  if (!manufacturer) {
    const company = otherBrands.find(looksLikeCompany);
    if (company) manufacturer = normalizeEntity(company);
  }

  /* ------------------------------------------------------- identifiers */
  let gtin: GtinInfo | null = null;
  let isbn13: string | null = null;
  const gtinRaw = presentString(staged.gtin);
  if (gtinRaw) {
    gtin = analyzeGtin(gtinRaw);
    if (!gtin) {
      issue(issues, "gtin", "GTIN_MALFORMED", "WARNING", "Barcode is not shaped like a GTIN (8/12/13/14 digits).", gtinRaw);
    } else {
      if (!gtin.checkDigitValid) issue(issues, "gtin", "GTIN_CHECK_DIGIT_INVALID", "WARNING", "GTIN check digit is wrong; not used for matching.", gtinRaw);
      else if (gtin.restricted) issue(issues, "gtin", "GTIN_RESTRICTED", "INFO", `GTIN is in a ${gtin.restricted} range; not used for matching.`, gtinRaw);
      isbn13 = gtin.isbn13 ?? null;
    }
  }
  const isbnRaw = presentString(staged.isbn);
  if (isbnRaw && !isbn13) {
    const g = analyzeGtin(isbnRaw);
    if (g?.isbn13) {
      isbn13 = g.isbn13;
      gtin ??= g;
    } else issue(issues, "isbn", "ISBN_INVALID", "WARNING", "ISBN failed validation.", isbnRaw);
  }

  const mpn = normalizeAlnumKey(staged.mpn);
  const model = normalizeAlnumKey(staged.model);
  const sku = presentString(staged.sku);
  const productCode = presentString(staged.productCode);

  /* ---------------------------------------- pack size, weights, sizes  */
  const quantityText = presentString(staged.quantityText);
  let quantity = parseQuantity(quantityText);
  if (quantityText && !quantity) {
    issue(issues, "quantity", "QUANTITY_UNPARSEABLE", "INFO", "Pack size text was not understood.", quantityText);
  }
  // No explicit quantity field: many listings only put the size in the title.
  if (!quantity && name) quantity = parseQuantity(name, { fromTitle: true });

  const netWeightG = parseMeasure(staged.netWeightText, "g") ?? (quantity?.unit === "g" ? quantity.total : null);
  const grossWeightG = parseMeasure(staged.grossWeightText, "g");
  const volumeMl = quantity?.unit === "ml" ? quantity.total : null;
  const dims = parseDimensions(staged.dimensionsText);
  const color = normalizeColor(staged.color);
  const size = normalizeSize(staged.size);

  /* ------------------------------------------------------------ names */
  const brandKey = brand?.key ?? null;
  const displayName = name ?? "";
  // May legitimately be empty (a product named only by its brand, e.g. "Coca-Cola 500 ml").
  // The matcher understands an empty core; falling back to the full name would put pack tokens back in.
  const coreName = buildCoreName(displayName, brandKey);
  const variant = presentString(staged.variant);
  const searchText = normalizeText(
    [brand?.display, displayName, variant, model?.original, mpn?.original, color?.display].filter(Boolean).join(" "),
  );

  /* ---------------------------------------------------------- category */
  const categories = (staged.categories ?? []).map((c) => c.trim()).filter(Boolean);
  const catMatch = ctx.categoryMapper.map(categories, displayName);
  if (!catMatch) issue(issues, "category", "CATEGORY_UNMAPPED", "INFO", "No standard category matched; filed as Uncategorised.", categories.join(" | ") || null);

  /* --------------------------------------------------------------- tax */
  let gstRateBp: number | null = null;
  const gstRaw = staged.gstRate;
  if (gstRaw != null && !isNullLike(gstRaw)) {
    gstRateBp = parseGstRate(gstRaw);
    if (gstRateBp == null) issue(issues, "gst", "GST_RATE_INVALID", "WARNING", "GST rate could not be read.", String(gstRaw));
    else {
      const status = gstSlabStatus(gstRateBp);
      if (status === "LEGACY") issue(issues, "gst", "GST_RATE_LEGACY", "INFO", "GST slab is no longer current.", String(gstRaw));
      if (status === "UNUSUAL") issue(issues, "gst", "GST_RATE_UNUSUAL", "WARNING", "GST rate is not a known slab.", String(gstRaw));
    }
  }
  let hsnCode: string | null = null;
  if (staged.hsnCode != null && !isNullLike(staged.hsnCode)) {
    hsnCode = normalizeHsn(staged.hsnCode);
    if (!hsnCode) issue(issues, "hsn", "HSN_INVALID", "WARNING", "HSN must be 4, 6 or 8 digits in a goods chapter.", String(staged.hsnCode));
  }
  let cessBp: number | null = null;
  if (staged.cess != null && !isNullLike(staged.cess)) {
    cessBp = parseGstRate(staged.cess);
    if (cessBp == null) issue(issues, "cess", "CESS_INVALID", "WARNING", "Cess could not be read.", String(staged.cess));
  }

  /* ---------------------------------------------------------- country */
  let countryOfOrigin: string | null = null;
  if (staged.countryOfOrigin && !isNullLike(staged.countryOfOrigin)) {
    const c = normalizeCountry(staged.countryOfOrigin);
    if (c) {
      countryOfOrigin = c.name;
      if (!c.recognised) issue(issues, "countryOfOrigin", "COUNTRY_UNRECOGNISED", "INFO", "Country not in the reference list.", staged.countryOfOrigin);
    }
  }

  /* -------------------------------------------------------- attributes */
  const stagedAttrs: StagedAttribute[] = [...(staged.attributes ?? [])];
  const push = (key: string, value: string | number | boolean | null | undefined, unit?: string, original?: string) => {
    if (value != null && value !== "") stagedAttrs.push({ key, value, unit, original });
  };
  push("country_of_origin", countryOfOrigin, undefined, staged.countryOfOrigin ?? undefined);
  push("brand_other", otherBrands.length ? otherBrands.join(", ") : null);
  push("color", color?.display, undefined, staged.color ?? undefined);
  push("size", size?.display, undefined, staged.size ?? undefined);
  push("material", presentString(staged.material));
  push("shape", presentString(staged.shape));
  push("model_number", model?.original);
  push("net_weight_g", netWeightG, "g", staged.netWeightText ?? staged.quantityText ?? undefined);
  push("gross_weight_g", grossWeightG, "g", staged.grossWeightText ?? undefined);
  push("length_mm", dims?.length, "mm", staged.dimensionsText ?? undefined);
  push("width_mm", dims?.width, "mm", staged.dimensionsText ?? undefined);
  push("height_mm", dims?.height, "mm", staged.dimensionsText ?? undefined);
  push("volume_ml", volumeMl, "ml", staged.quantityText ?? undefined);
  push("gst_rate_bp", gstRateBp, "bp", gstRaw != null ? String(gstRaw) : undefined);
  push("hsn_code", hsnCode, undefined, staged.hsnCode != null ? String(staged.hsnCode) : undefined);
  push("cess_bp", cessBp, "bp", staged.cess != null ? String(staged.cess) : undefined);
  const attributes = normalizeAttributes(stagedAttrs, issues);

  /* ------------------------------------------------------------ offer */
  const offer = staged.offer ? normalizeOffer(staged.offer, now, issues) : null;

  const images = [...new Set((staged.images ?? []).map((u) => u?.trim()).filter((u): u is string => !!u && /^https?:\/\//i.test(u)))].slice(0, 6);

  const rating = staged.rating != null && Number.isFinite(staged.rating) && staged.rating >= 0 && staged.rating <= 5 ? staged.rating : null;

  return {
    sourceProductId: staged.sourceProductId,
    sourceUrl: presentString(staged.sourceUrl),
    name: displayName,
    coreName,
    searchText,
    familyKey: coreName,
    brand,
    otherBrands,
    manufacturer,
    gtin,
    isbn13,
    mpn,
    model,
    sku,
    productCode,
    quantity,
    netWeightG,
    grossWeightG,
    volumeMl,
    dimensionsMm: dims,
    color,
    size,
    material: presentString(staged.material),
    shape: presentString(staged.shape),
    variant,
    categoryRaw: categories,
    categoryCode: catMatch?.code ?? UNCATEGORISED_CODE,
    categoryConfidence: catMatch?.confidence ?? null,
    gstRateBp,
    hsnCode,
    cessBp,
    countryOfOrigin,
    description: presentString(staged.description),
    shortDescription: presentString(staged.shortDescription),
    attributes,
    images,
    rating,
    reviewCount: staged.reviewCount != null && Number.isInteger(staged.reviewCount) && staged.reviewCount >= 0 ? staged.reviewCount : null,
    availability: presentString(staged.availability),
    offer,
    keywords: (staged.keywords ?? []).map((k) => k.trim()).filter(Boolean).slice(0, 30),
    issues,
  };
}

export { entityKey };
