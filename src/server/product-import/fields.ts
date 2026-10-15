/**
 * Column → GoKesari field mapping for the bulk product upload
 * (docs/product-import-2026-10 §2).
 *
 * Each rule names the canonical attribute keys (Amazon templates, any product
 * type) and the labels (GoKesari simple template, CSVs, older flat files) that
 * feed one field. A column is claimed by key first; only a column no key rule
 * claimed is tried against the labels. Nothing here is specific to one product
 * type: PUZZLES, TOYS and GROCERY templates share these attribute keys, and
 * any column no rule names is still kept, losslessly, in `attributes`.
 *
 * Every field is optional. A value that cannot be read is kept as written in
 * the row's raw cells and produces a warning — never an error.
 */
import type { ColumnDef } from "./columns";
import type { CellValue } from "./grid";
import * as N from "./normalise";

/** Fields that take several columns (#1…#5, Image URL 2…5) and become arrays. */
const REPEATED = new Set([
  "bullets", "otherImages", "browseNodes", "materials", "themes", "safetyWarnings", "extInfoEntity", "extInfoValue",
  "specialFeatures", "includedComponents", "educationalObjectives",
]);

type Rule = { field: string; keys?: RegExp[]; labels?: RegExp[] };

const ALL = "\\[audience=all\\]";

const RULES: Rule[] = [
  { field: "sku", keys: [/^contribution_sku\.value$/, /^item_sku$/, /^sku$/], labels: [/^(seller |item )?sku$/] },
  { field: "productCode", labels: [/^(gokesari )?product code$/, /^gokesari code$/] },
  { field: "productType", keys: [/^product_type\.value$/, /^feed_product_type$/], labels: [/^product type$/] },
  { field: "action", keys: [/^::record_action$/, /^update_delete$/], labels: [/^(listing )?action$/, /^update delete$/] },
  { field: "parentage", keys: [/^parentage_level\.value$/, /^parent_child$/], labels: [/^parentage( level)?$/] },
  { field: "parentSku", keys: [/^child_parent_sku_relationship\.parent_sku$/, /^parent_sku$/], labels: [/^parent sku$/] },
  { field: "variationTheme", keys: [/^variation_theme\.name$/, /^variation_theme$/], labels: [/^variation theme( name)?$/] },
  { field: "name", keys: [/^item_name\.value$/, /^item_name$/], labels: [/^(item|product) name$/, /^title$/, /^name$/] },
  { field: "highlight", keys: [/^title_differentiation\.value$/, /^item_highlight\.value$/], labels: [/^item highlights?$/] },
  { field: "brand", keys: [/^brand\.value$/, /^brand_name$/], labels: [/^brand( name)?$/] },
  { field: "subBrand", keys: [/^sub_brand\.value$/], labels: [/^sub[- ]?brand$/] },
  { field: "manufacturer", keys: [/^manufacturer\.value$/, /^manufacturer$/], labels: [/^manufacturer( name)?$/] },
  { field: "modelNumber", keys: [/^model_number\.value$/, /^model$/], labels: [/^model (number|no\.?)$/] },
  { field: "modelName", keys: [/^model_name\.value$/], labels: [/^model name$/] },
  { field: "partNumber", keys: [/^part_number\.value$/, /^part_number$/], labels: [/^(manufacturer )?part number$/] },
  {
    field: "barcodeType",
    keys: [/^externally_assigned_product_identifier\.type$/, /^external_product_id_type$/, /^product_identifier\.type$/],
    labels: [/^product id type$/, /^barcode type$/, /^external product id type$/],
  },
  {
    field: "barcode",
    keys: [/^externally_assigned_product_identifier\.value$/, /^external_product_id$/, /^product_identifier\.value$/],
    labels: [/^product id$/, /^barcode$/, /^external product id$/, /^(ean|upc|gtin)( code)?$/],
  },
  { field: "asin", keys: [/^merchant_suggested_asin\.value$/], labels: [/^(merchant suggested )?asin$/] },
  { field: "browseNodes", keys: [/^recommended_browse_nodes\.value$/, /^recommended_browse_nodes\d*$/], labels: [/^recommended browse nodes?( \d+)?$/] },
  { field: "category", labels: [/^(product )?category$/, /^category name$/] },
  { field: "description", keys: [/^product_description\.value$/, /^product_description$/], labels: [/^(product )?description$/] },
  { field: "bullets", keys: [/^bullet_point\.value$/, /^bullet_point\d*$/], labels: [/^bullet point( \d+)?$/, /^highlight \d+$/, /^key product features?( \d+)?$/] },
  { field: "keywords", keys: [/^generic_keyword\.value$/, /^generic_keywords\d*$/], labels: [/^generic keywords?$/, /^(search )?keywords$/] },
  { field: "mainImage", keys: [/^main_product_image_locator\.media_location$/, /^main_image_url$/], labels: [/^main image( url)?$/] },
  {
    field: "otherImages",
    keys: [/^other_product_image_locator_\d+\.media_location$/, /^other_image_url\d*$/],
    labels: [/^other image url( \d+)?$/, /^image url \d+$/],
  },
  { field: "swatchImage", keys: [/^swatch_product_image_locator\.media_location$/, /^swatch_image_url$/], labels: [/^swatch image( url)?$/] },
  { field: "color", keys: [/^color\.value$/, /^color_name$/], labels: [/^colou?r( name)?$/] },
  { field: "size", keys: [/^size\.value$/, /^size_name$/], labels: [/^size( name)?$/] },
  { field: "style", keys: [/^style\.value$/, /^style_name$/], labels: [/^style( name)?$/] },
  { field: "materials", keys: [/^material\.value$/, /^material_type\d*$/], labels: [/^material( type)?( \d+)?$/] },
  { field: "shape", keys: [/^item_shape\.value$/], labels: [/^item shape$/] },
  { field: "themes", keys: [/^theme\.value$/], labels: [/^theme( \d+)?$/] },
  { field: "specialFeatures", keys: [/^special_feature\.value$/], labels: [/^special features?( \d+)?$/] },
  { field: "includedComponents", keys: [/^included_components\.value$/], labels: [/^included components?( \d+)?$/] },
  { field: "educationalObjectives", keys: [/^educational_objective\.value$/], labels: [/^educational objectives?( \d+)?$/] },
  { field: "targetGender", keys: [/^target_gender\.value$/], labels: [/^target gender$/] },
  { field: "ageRange", keys: [/^age_range_description\.value$/], labels: [/^age range( description)?$/] },
  { field: "pieces", keys: [/^number_of_pieces\.value$/], labels: [/^number of pieces$/] },
  { field: "itemCount", keys: [/^number_of_items\.value$/], labels: [/^number of items$/] },
  { field: "unitCount", keys: [/^unit_count\.value$/], labels: [/^unit count$/] },
  { field: "unitCountType", keys: [/^unit_count\.type\.value$/, /^unit_count\.type$/], labels: [/^unit count type$/] },
  { field: "unit", labels: [/^unit$/, /^uom$/] },
  { field: "packSize", labels: [/^pack size$/] },
  { field: "itemWeight", keys: [/^item_weight\.value$/], labels: [/^item weight$/, /^weight$/] },
  { field: "itemWeightUnit", keys: [/^item_weight\.unit$/], labels: [/^item weight unit$/] },
  { field: "itemWeightG", labels: [/^weight \(g\)$/, /^weight in grams$/] },
  { field: "itemLength", keys: [/^item_length_width\.length\.value$/, /^item_length\.value$/, /^item_dimensions\.length\.value$/], labels: [/^item length$/] },
  { field: "itemLengthUnit", keys: [/^item_length_width\.length\.unit$/, /^item_length\.unit$/, /^item_dimensions\.length\.unit$/], labels: [/^item length unit$/] },
  { field: "itemWidth", keys: [/^item_length_width\.width\.value$/, /^item_width\.value$/, /^item_dimensions\.width\.value$/], labels: [/^item width$/] },
  { field: "itemWidthUnit", keys: [/^item_length_width\.width\.unit$/, /^item_width\.unit$/, /^item_dimensions\.width\.unit$/], labels: [/^item width unit$/] },
  { field: "itemHeight", keys: [/^item_height\.value$/, /^item_dimensions\.height\.value$/], labels: [/^item height$/] },
  { field: "itemHeightUnit", keys: [/^item_height\.unit$/, /^item_dimensions\.height\.unit$/], labels: [/^item height unit$/] },
  { field: "lengthCm", labels: [/^length \(cm\)$/] },
  { field: "widthCm", labels: [/^width \(cm\)$/] },
  { field: "heightCm", labels: [/^height \(cm\)$/] },
  { field: "pkgLength", keys: [/^item_package_dimensions\.length\.value$/], labels: [/^(item )?package length$/] },
  { field: "pkgLengthUnit", keys: [/^item_package_dimensions\.length\.unit$/], labels: [/^(item )?package length unit$/] },
  { field: "pkgWidth", keys: [/^item_package_dimensions\.width\.value$/], labels: [/^(item )?package width$/] },
  { field: "pkgWidthUnit", keys: [/^item_package_dimensions\.width\.unit$/], labels: [/^(item )?package width unit$/] },
  { field: "pkgHeight", keys: [/^item_package_dimensions\.height\.value$/], labels: [/^(item )?package height$/] },
  { field: "pkgHeightUnit", keys: [/^item_package_dimensions\.height\.unit$/], labels: [/^(item )?package height unit$/] },
  { field: "pkgWeight", keys: [/^item_package_weight\.value$/], labels: [/^(item )?package weight$/] },
  { field: "pkgWeightUnit", keys: [/^item_package_weight\.unit$/], labels: [/^(item )?package weight unit$/] },
  { field: "extInfoEntity", keys: [/^external_product_information\.entity$/], labels: [/^external product information( entity)?$/] },
  { field: "extInfoValue", keys: [/^external_product_information\.value$/], labels: [/^external product information value$/] },
  { field: "hsnCode", keys: [/^hsn_code\.value$/], labels: [/^hsn( code)?$/] },
  { field: "taxCode", keys: [/^product_tax_code\.value$/, /^product_tax_code$/], labels: [/^product tax code$/] },
  { field: "gstPercent", labels: [/^gst( ?%| rate| percent(age)?)?$/, /^tax rate$/] },
  {
    field: "mrp",
    keys: [
      new RegExp(`^purchasable_offer${ALL}\\.maximum_retail_price\\.schedule\\.value_with_tax$`),
      /^purchasable_offer\.maximum_retail_price\.schedule\.value_with_tax$/,
      /^maximum_retail_price(\.schedule)?\.value(_with_tax)?$/,
      /^maximum_retail_price$/,
    ],
    labels: [/^maximum retail price(?!.*b2b)/, /^mrp$/],
  },
  {
    field: "price",
    keys: [
      new RegExp(`^purchasable_offer${ALL}\\.our_price\\.schedule\\.value_with_tax$`),
      /^purchasable_offer\.our_price\.schedule\.value_with_tax$/,
      /^standard_price$/,
    ],
    labels: [/^your price(?!.*b2b)/, /^(selling )?price$/],
  },
  {
    field: "salePrice",
    keys: [new RegExp(`^purchasable_offer${ALL}\\.discounted_price\\.schedule\\.value_with_tax$`), /^purchasable_offer\.discounted_price\.schedule\.value_with_tax$/, /^sale_price$/],
    labels: [/^sale price(?!.*b2b)/],
  },
  {
    field: "saleStart",
    keys: [new RegExp(`^purchasable_offer${ALL}\\.discounted_price\\.schedule\\.start_at$`), /^purchasable_offer\.discounted_price\.schedule\.start_at$/, /^sale_from_date$/],
    labels: [/^sale start( date)?(?!.*b2b)/],
  },
  {
    field: "saleEnd",
    keys: [new RegExp(`^purchasable_offer${ALL}\\.discounted_price\\.schedule\\.end_at$`), /^purchasable_offer\.discounted_price\.schedule\.end_at$/, /^sale_end_date$/],
    labels: [/^sale end( date)?(?!.*b2b)/],
  },
  { field: "quantity", keys: [/^fulfillment_availability\.quantity$/, /^quantity$/], labels: [/^quantity( \(in\))?$/, /^qty$/, /^stock( qty| quantity)?$/] },
  { field: "fulfillmentChannel", keys: [/^fulfillment_availability\.fulfillment_channel_code$/], labels: [/^fulfillment channel code( \(in\))?$/] },
  { field: "handlingDays", keys: [/^fulfillment_availability\.lead_time_to_ship_max_days$/, /^fulfillment_latency$/], labels: [/^handling time( \(in\))?$/] },
  { field: "restockDate", keys: [/^fulfillment_availability\.restock_date$/, /^restock_date$/], labels: [/^restock date( \(in\))?$/] },
  { field: "alwaysAvailable", keys: [/^fulfillment_availability\.is_inventory_available$/], labels: [/^inventory always available( \(in\))?$/] },
  { field: "maxOrderQty", keys: [/^max_order_quantity\.value$/, /^max_order_quantity$/], labels: [/^max(imum)? order (qty|quantity)$/] },
  { field: "condition", keys: [/^condition_type\.value$/, /^condition_type$/], labels: [/^(item |offer )?condition$/] },
  { field: "conditionNote", keys: [/^condition_note\.value$/, /^condition_note$/], labels: [/^(offer )?condition note$/] },
  { field: "giftWrap", keys: [/^gift_options\.can_be_wrapped$/], labels: [/^is gift wrap available$/] },
  { field: "giftMessage", keys: [/^gift_options\.can_be_messaged$/], labels: [/^offering can be gift messaged$/] },
  { field: "countryOfOrigin", keys: [/^country_of_origin\.value$/, /^country_of_origin$/], labels: [/^country( ?\/ ?region)? of origin$/] },
  { field: "manufacturerContact", keys: [/^manufacturer_contact_information\.value$/], labels: [/^manufacturer contact( information)?$/] },
  { field: "packerContact", keys: [/^packer_contact_information\.value$/], labels: [/^packer contact( information)?$/] },
  { field: "importerContact", keys: [/^importer_contact_information\.value$/], labels: [/^importer contact( information)?$/] },
  { field: "safetyWarnings", keys: [/^safety_warning\.value$/], labels: [/^safety warning( \d+)?$/] },
  { field: "batteriesRequired", keys: [/^batteries_required\.value$/], labels: [/^(are )?batteries required\??$/] },
  { field: "batteriesIncluded", keys: [/^batteries_included\.value$/], labels: [/^(are )?batteries included\??$/] },
];

/** Columns that are compliance data, collected whole into `compliance` (on top of any field above). */
const COMPLIANCE_KEY = /^(hazmat|supplier_declared_dg_hz_regulation|safety_data_sheet_url|compliance_media|ghs|dangerous_goods|safety_warning|batteries_|battery|lithium_battery|is_chemical|pesticide|eu_toys_safety|cpsia)/;
const COMPLIANCE_GROUP = /safety|compliance/i;

export interface FieldMap {
  /** field → the columns that feed it, in sheet order. */
  byField: Map<string, ColumnDef[]>;
  /** Columns claimed by no field (still kept in attributes). */
  unmapped: ColumnDef[];
}

export function mapColumns(columns: ColumnDef[]): FieldMap {
  const byField = new Map<string, ColumnDef[]>();
  const claimed = new Set<number>();
  const add = (field: string, col: ColumnDef) => {
    const list = byField.get(field) ?? [];
    list.push(col);
    byField.set(field, list);
    claimed.add(col.index);
  };
  // Keys first…
  for (const col of columns) {
    if (!col.key) continue;
    const rule = RULES.find((r) => r.keys?.some((k) => k.test(col.canonical)));
    if (rule) add(rule.field, col);
  }
  // …then labels, for what no key claimed.
  for (const col of columns) {
    if (claimed.has(col.index)) continue;
    // B2B labels never feed the ALL-audience price fields.
    const label = col.label.replace(/\s+/g, " ").trim().toLowerCase();
    if (col.canonical.includes("[audience=b2b]")) continue;
    const rule = RULES.find((r) => r.labels?.some((l) => l.test(label)));
    if (rule) {
      // A single-value field takes its first column only; later ones stay attributes.
      if (!REPEATED.has(rule.field) && byField.has(rule.field)) continue;
      add(rule.field, col);
    }
  }
  return { byField, unmapped: columns.filter((c) => !claimed.has(c.index)) };
}

/* -------------------------------------------------------------- extraction */

export interface ImportFields {
  sku?: string;
  productCode?: string;
  productType?: string;
  action?: "UPSERT" | "EDIT" | "DELETE";
  parentage?: string;
  parentSku?: string;
  variationTheme?: string;
  name?: string;
  highlight?: string;
  brand?: string;
  subBrand?: string;
  manufacturer?: string;
  modelNumber?: string;
  modelName?: string;
  partNumber?: string;
  barcodeType?: N.BarcodeType;
  barcode?: string;
  /** Canonical GTIN-14 when the barcode is shaped like one. */
  gtin14?: string;
  asin?: string;
  browseNodes?: string[];
  /** Text after the last ">" of each browse node, then the Category column: candidates for a GoKesari category. */
  categoryHints?: string[];
  category?: string;
  description?: string;
  bullets?: string[];
  keywords?: string;
  mainImage?: string;
  otherImages?: string[];
  swatchImage?: string;
  color?: string;
  size?: string;
  style?: string;
  materials?: string[];
  shape?: string;
  themes?: string[];
  targetGender?: string;
  ageRange?: string;
  pieces?: number;
  itemCount?: number;
  unitCount?: number;
  unitCountType?: string;
  unit?: string;
  packSize?: string;
  itemWeightG?: number;
  itemLengthCm?: number;
  itemWidthCm?: number;
  itemHeightCm?: number;
  packageLengthCm?: number;
  packageWidthCm?: number;
  packageHeightCm?: number;
  packageWeightG?: number;
  hsnCode?: string;
  taxCode?: string;
  gstRateBp?: number;
  mrpPaise?: number;
  pricePaise?: number;
  salePricePaise?: number;
  saleStart?: string;
  saleEnd?: string;
  /** Present only when the cell is a usable whole number ≥ 0. */
  quantity?: number;
  /** The cell had something that is not a usable quantity (stock is then left alone). */
  quantityInvalid?: string;
  handlingDays?: number;
  restockDate?: string;
  alwaysAvailable?: boolean;
  maxOrderQty?: number;
  condition?: string;
  conditionNote?: string;
  giftWrap?: boolean;
  giftMessage?: boolean;
  countryOfOrigin?: string;
  manufacturerContact?: string;
  packerContact?: string;
  importerContact?: string;
  safetyWarnings?: string[];
  specialFeatures?: string[];
  includedComponents?: string[];
  educationalObjectives?: string[];
  compliance?: Record<string, unknown>;
  b2b?: Record<string, unknown>;
}

export interface ExtractedRow {
  fields: ImportFields;
  /** column id → value, for every non-empty cell. */
  raw: Record<string, CellValue>;
  /** section → label → value (repeated labels become arrays). */
  attributes: Record<string, Record<string, unknown>>;
  warnings: string[];
}

const ACTIONS: [RegExp, ImportFields["action"]][] = [
  [/^(create or replace|update|upsert|add|create|replace|full update)/i, "UPSERT"],
  [/^(edit|partial update|edit \(partial update\)|partial)/i, "EDIT"],
  [/^(delete|remove|deactivate|x)$/i, "DELETE"],
];

function cellOf(row: CellValue[], col: ColumnDef): CellValue {
  return row[col.index] ?? null;
}

/** Normalises one data row. Pure. */
export function extractRow(cells: CellValue[], map: FieldMap, columns: ColumnDef[]): ExtractedRow {
  const fields: ImportFields = {};
  const warnings: string[] = [];
  const raw: Record<string, CellValue> = {};
  const attributes: Record<string, Record<string, unknown>> = {};

  for (const col of columns) {
    const v = cellOf(cells, col);
    if (v == null || (typeof v === "string" && v.trim() === "")) continue;
    raw[col.id] = v;
    const group = col.group ?? "Attributes";
    const bag = (attributes[group] ??= {});
    const name = col.label;
    if (name in bag) {
      const prev = bag[name];
      bag[name] = Array.isArray(prev) ? [...prev, v] : [prev, v];
    } else bag[name] = v;
    if (col.key && (COMPLIANCE_KEY.test(col.canonical) || (col.group && COMPLIANCE_GROUP.test(col.group)))) {
      const c = (fields.compliance ??= {});
      const k = col.canonical.replace(/\.value$/, "");
      c[k] = k in c ? ([] as unknown[]).concat(c[k], v) : v;
    }
    if (col.canonical.includes("[audience=b2b]") || /\bb2b\b/i.test(col.label)) {
      const b = (fields.b2b ??= {});
      b[col.key ? col.canonical : col.label] = v;
    }
  }

  const values = (field: string): CellValue[] =>
    (map.byField.get(field) ?? []).map((c) => cellOf(cells, c)).filter((v) => v != null && String(v).trim() !== "");
  const first = (field: string): CellValue => values(field)[0] ?? null;
  const label = (field: string) => map.byField.get(field)?.[0]?.label ?? field;
  const warnBad = (field: string, rawValue: string, what: string) =>
    warnings.push(`${label(field)}: "${rawValue}" is not ${what}; kept as written.`);

  const str = (field: string, target: keyof ImportFields = field as keyof ImportFields) => {
    const t = N.text(first(field));
    if (t) (fields as Record<string, unknown>)[target] = t;
  };
  const list = (field: string) => {
    const items = values(field).map(N.text).filter((t): t is string => Boolean(t));
    if (items.length) (fields as Record<string, unknown>)[field] = items;
  };
  const parsed = <T>(field: string, fn: (v: unknown) => N.Parsed<T>, what: string, target: keyof ImportFields = field as keyof ImportFields) => {
    const v = first(field);
    const r = fn(v);
    if (!r) return;
    if (r.ok) (fields as Record<string, unknown>)[target] = r.value;
    else warnBad(field, r.raw, what);
  };

  for (const f of [
    "sku", "productCode", "productType", "parentage", "parentSku", "variationTheme", "name", "highlight", "brand", "subBrand",
    "manufacturer", "modelNumber", "modelName", "partNumber", "asin", "category", "description", "keywords", "mainImage",
    "swatchImage", "color", "size", "style", "shape", "targetGender", "ageRange", "unitCountType", "unit", "packSize",
    "taxCode", "condition", "conditionNote", "countryOfOrigin", "manufacturerContact", "packerContact", "importerContact",
    "fulfillmentChannel",
  ]) {
    str(f);
  }
  for (const f of ["bullets", "otherImages", "browseNodes", "materials", "themes", "safetyWarnings", "specialFeatures", "includedComponents", "educationalObjectives"]) {
    list(f);
  }
  delete (fields as Record<string, unknown>).fulfillmentChannel;

  // SKU from a number cell: 1001 not "1001.0".
  if (typeof first("sku") === "number") fields.sku = String(first("sku"));

  const actionText = N.text(first("action"));
  if (actionText) {
    const found = ACTIONS.find(([p]) => p.test(actionText));
    if (found) fields.action = found[1];
    else warnings.push(`${label("action")}: "${actionText}" is not a known action; treated as Create or Replace.`);
  }

  const barcodeType = N.barcodeType(first("barcodeType"));
  if (barcodeType) fields.barcodeType = barcodeType;
  const code = N.barcode(first("barcode"));
  if (code) {
    if (!map.byField.get("barcode")?.[0]?.key && /^P\d{5,}$/i.test(code.value)) {
      // A label-only "Product ID" column holding a GoKesari code (P00012), as the price sheet uses.
      fields.productCode ??= code.value.toUpperCase();
    } else if (barcodeType === "ASIN" || /^B0[A-Z0-9]{8}$/i.test(code.value)) {
      fields.asin ??= code.value.toUpperCase();
      fields.barcodeType ??= "ASIN";
    } else {
      fields.barcode = code.value;
      if (code.gtin14 && barcodeType !== "GTIN_EXEMPT") {
        if (code.checkDigitValid) fields.gtin14 = code.gtin14;
        else warnings.push(`${label("barcode")}: "${code.value}" has a wrong check digit; kept as a plain barcode.`);
      }
    }
  }

  parsed("pieces", N.wholeNumber, "a whole number");
  parsed("itemCount", N.wholeNumber, "a whole number");
  parsed("unitCount", (v) => N.number(v), "a number");
  parsed("handlingDays", N.wholeNumber, "a whole number of days");
  parsed("maxOrderQty", N.wholeNumber, "a whole number");
  parsed("restockDate", N.date, "a date", "restockDate");
  parsed("saleStart", N.date, "a date");
  parsed("saleEnd", N.date, "a date");
  parsed("alwaysAvailable", N.bool, "Yes or No");
  parsed("giftWrap", N.bool, "Yes or No");
  parsed("giftMessage", N.bool, "Yes or No");
  parsed("mrp", N.paise, "an amount", "mrpPaise");
  parsed("price", N.paise, "an amount", "pricePaise");
  parsed("salePrice", N.paise, "an amount", "salePricePaise");
  parsed("gstPercent", N.gstRateBp, "a GST rate", "gstRateBp");
  parsed("hsnCode", N.hsn, "an HSN code");
  if (fields.maxOrderQty === 0) {
    delete fields.maxOrderQty;
    warnings.push(`${label("maxOrderQty")}: 0 is not a usable order limit; ignored.`);
  }

  // Quantity: never guessed. A blank cell leaves stock alone; a bad one too, with a warning.
  const q = first("quantity");
  const qty = N.wholeNumber(q);
  if (qty?.ok) fields.quantity = qty.value;
  else if (qty) {
    fields.quantityInvalid = qty.raw;
    const n = N.number(q);
    warnings.push(
      n?.ok && n.value < 0
        ? `${label("quantity")}: ${qty.raw} is negative; stock left unchanged.`
        : `${label("quantity")}: "${qty.raw}" is not a whole number; stock left unchanged.`,
    );
  }

  // Dimensions, normalised to cm and g.
  const dim = (valueField: string, unitField: string, fn: typeof N.lengthCm, target: keyof ImportFields, what: string) => {
    const v = first(valueField);
    if (v == null) return;
    const r = fn(v, first(unitField));
    if (r?.ok) (fields as Record<string, unknown>)[target] = r.value;
    else if (r) warnBad(valueField, r.raw, what);
  };
  dim("itemWeight", "itemWeightUnit", N.weightG, "itemWeightG", "a weight");
  if (fields.itemWeightG == null) dim("itemWeightG", "__none", N.weightG, "itemWeightG", "a weight in grams");
  dim("itemLength", "itemLengthUnit", N.lengthCm, "itemLengthCm", "a length");
  dim("itemWidth", "itemWidthUnit", N.lengthCm, "itemWidthCm", "a length");
  dim("itemHeight", "itemHeightUnit", N.lengthCm, "itemHeightCm", "a length");
  if (fields.itemLengthCm == null) dim("lengthCm", "__none", N.lengthCm, "itemLengthCm", "a length in cm");
  if (fields.itemWidthCm == null) dim("widthCm", "__none", N.lengthCm, "itemWidthCm", "a length in cm");
  if (fields.itemHeightCm == null) dim("heightCm", "__none", N.lengthCm, "itemHeightCm", "a length in cm");
  dim("pkgLength", "pkgLengthUnit", N.lengthCm, "packageLengthCm", "a length");
  dim("pkgWidth", "pkgWidthUnit", N.lengthCm, "packageWidthCm", "a length");
  dim("pkgHeight", "pkgHeightUnit", N.lengthCm, "packageHeightCm", "a length");
  dim("pkgWeight", "pkgWeightUnit", N.weightG, "packageWeightG", "a weight");

  // External Product Information: the pair whose Entity is "HSN Code" gives the HSN.
  const entities = (map.byField.get("extInfoEntity") ?? []).map((c) => ({ col: c, v: N.text(cellOf(cells, c)) }));
  const infoValues = map.byField.get("extInfoValue") ?? [];
  for (const { col, v } of entities) {
    if (!v || !/hsn/i.test(v)) continue;
    const partner = infoValues.find((c) => c.occurrence === col.occurrence) ?? infoValues[entities.findIndex((e) => e.col === col)];
    const h = partner ? N.hsn(cellOf(cells, partner)) : null;
    if (h?.ok) fields.hsnCode ??= h.value;
    else if (h) warnings.push(`External Product Information: HSN "${h.raw}" is not a valid HSN code; kept as written.`);
  }

  // Category candidates: the last segment of each browse node path, then the Category column.
  const hints: string[] = [];
  for (const node of fields.browseNodes ?? []) {
    const last = node.split(">").pop()?.trim();
    if (last && !/^\d+$/.test(last)) hints.push(last);
  }
  if (fields.category) hints.push(...fields.category.split(">").map((s) => s.trim()).filter(Boolean).reverse());
  if (hints.length) fields.categoryHints = [...new Set(hints)];

  // Images: only http(s) addresses are kept as images.
  const urls = (u: string | undefined) => (u && /^https?:\/\//i.test(u) ? u : undefined);
  for (const f of ["mainImage", "swatchImage"] as const) {
    if (fields[f] && !urls(fields[f])) {
      warnings.push(`${label(f)}: "${fields[f]}" is not an http(s) address; image skipped.`);
      delete fields[f];
    }
  }
  if (fields.otherImages) {
    const good = fields.otherImages.filter((u) => urls(u));
    for (const badUrl of fields.otherImages.filter((u) => !urls(u))) {
      warnings.push(`${label("otherImages")}: "${badUrl}" is not an http(s) address; image skipped.`);
    }
    if (good.length) fields.otherImages = good;
    else delete fields.otherImages;
  }

  return { fields, raw, attributes, warnings };
}
