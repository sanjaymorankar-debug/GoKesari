/**
 * Attribute registry: the category-specific facts stored in
 * pmd.product_specification (one row per product x attribute x source).
 *
 * This is how "food has nutrition, electronics has RAM, apparel has fabric"
 * works without a hundred sparse columns on PRODUCT_MASTER. Unknown keys arriving
 * from a source are auto-registered as free-text OTHER attributes, so a new source
 * never needs a schema change.
 *
 * `masterColumn` marks attributes whose winning value is also projected onto a
 * product_master column (for filtering and export).
 */

export type AttributeGroup =
  | "GENERAL"
  | "FOOD"
  | "ELECTRONICS"
  | "APPAREL"
  | "HOME"
  | "BEAUTY"
  | "COMPLIANCE"
  | "OTHER";

export interface AttributeDefinition {
  key: string;
  label: string;
  group: AttributeGroup;
  dataType: "TEXT" | "NUMBER" | "BOOLEAN";
  unit?: string;
  /** SPEC: manufacturer/brand data wins. MARKETPLACE: availability/price-style facts. */
  authority?: "SPEC" | "MARKETPLACE";
  trackConflicts?: boolean;
  masterColumn?: string;
  description?: string;
}

const A = (
  key: string,
  label: string,
  group: AttributeGroup,
  dataType: AttributeDefinition["dataType"],
  extra: Partial<AttributeDefinition> = {},
): AttributeDefinition => ({ key, label, group, dataType, ...extra });

export const ATTRIBUTE_DEFINITIONS: readonly AttributeDefinition[] = [
  /* ------------------------------------------------------------- general */
  A("country_of_origin", "Country of origin", "GENERAL", "TEXT"),
  A("brand_other", "Other brands / related names", "GENERAL", "TEXT", { trackConflicts: false }),
  A("color", "Colour", "GENERAL", "TEXT", { masterColumn: "color" }),
  A("size", "Size", "GENERAL", "TEXT", { masterColumn: "size" }),
  A("material", "Material", "GENERAL", "TEXT", { masterColumn: "material" }),
  A("shape", "Shape", "GENERAL", "TEXT", { masterColumn: "shape" }),
  A("model_number", "Model number", "GENERAL", "TEXT", { masterColumn: "model_number" }),
  A("net_weight_g", "Net weight", "GENERAL", "NUMBER", { unit: "g", masterColumn: "net_weight_g" }),
  A("gross_weight_g", "Gross weight", "GENERAL", "NUMBER", { unit: "g", masterColumn: "gross_weight_g" }),
  A("length_mm", "Length", "GENERAL", "NUMBER", { unit: "mm", masterColumn: "length_mm" }),
  A("width_mm", "Width", "GENERAL", "NUMBER", { unit: "mm", masterColumn: "width_mm" }),
  A("height_mm", "Height", "GENERAL", "NUMBER", { unit: "mm", masterColumn: "height_mm" }),
  A("volume_ml", "Volume", "GENERAL", "NUMBER", { unit: "ml", masterColumn: "volume_ml" }),
  A("gst_rate_bp", "GST rate", "COMPLIANCE", "NUMBER", { unit: "bp", masterColumn: "gst_rate_bp" }),
  A("hsn_code", "HSN code", "COMPLIANCE", "TEXT", { masterColumn: "hsn_code" }),
  A("cess_bp", "Cess", "COMPLIANCE", "NUMBER", { unit: "bp", masterColumn: "cess_bp" }),
  A("manufacturer_address", "Manufacturer address", "COMPLIANCE", "TEXT"),
  A("bis_certification", "BIS certification", "COMPLIANCE", "TEXT"),
  A("packaging", "Packaging", "GENERAL", "TEXT"),
  A("labels", "Labels / certifications", "GENERAL", "TEXT"),

  /* ---------------------------------------------------------------- food */
  A("fssai_number", "FSSAI licence number", "FOOD", "TEXT", { description: "14-digit FSSAI licence / registration number" }),
  A("food_category", "Food category", "FOOD", "TEXT"),
  A("ingredients", "Ingredients", "FOOD", "TEXT"),
  A("allergen_information", "Allergen information", "FOOD", "TEXT"),
  A("traces", "May contain traces of", "FOOD", "TEXT"),
  A("nutritional_information", "Nutritional information (text)", "FOOD", "TEXT"),
  A("serving_size", "Serving size", "FOOD", "TEXT"),
  A("energy_kcal_per_100g", "Energy (kcal / 100 g)", "FOOD", "NUMBER", { unit: "kcal" }),
  A("protein_g_per_100g", "Protein (g / 100 g)", "FOOD", "NUMBER", { unit: "g" }),
  A("carbohydrates_g_per_100g", "Carbohydrates (g / 100 g)", "FOOD", "NUMBER", { unit: "g" }),
  A("total_fat_g_per_100g", "Total fat (g / 100 g)", "FOOD", "NUMBER", { unit: "g" }),
  A("saturated_fat_g_per_100g", "Saturated fat (g / 100 g)", "FOOD", "NUMBER", { unit: "g" }),
  A("trans_fat_g_per_100g", "Trans fat (g / 100 g)", "FOOD", "NUMBER", { unit: "g" }),
  A("sugar_g_per_100g", "Sugars (g / 100 g)", "FOOD", "NUMBER", { unit: "g" }),
  A("sodium_mg_per_100g", "Sodium (mg / 100 g)", "FOOD", "NUMBER", { unit: "mg" }),
  A("salt_g_per_100g", "Salt (g / 100 g)", "FOOD", "NUMBER", { unit: "g" }),
  A("dietary_fiber_g_per_100g", "Dietary fibre (g / 100 g)", "FOOD", "NUMBER", { unit: "g" }),
  A("vegetarian_nonveg", "Vegetarian / non-vegetarian", "FOOD", "TEXT"),
  A("organic", "Organic", "FOOD", "BOOLEAN"),
  A("vegan", "Vegan", "FOOD", "BOOLEAN"),
  A("manufacturing_date", "Manufacturing date", "FOOD", "TEXT", { trackConflicts: false }),
  A("best_before", "Best before", "FOOD", "TEXT", { trackConflicts: false }),
  A("shelf_life", "Shelf life", "FOOD", "TEXT"),
  A("storage_instructions", "Storage instructions", "FOOD", "TEXT"),
  A("preparation_instructions", "Preparation instructions", "FOOD", "TEXT"),
  A("nutriscore_grade", "Nutri-Score grade", "FOOD", "TEXT"),
  A("nova_group", "NOVA processing group", "FOOD", "NUMBER"),

  /* --------------------------------------------------------- electronics */
  A("processor", "Processor", "ELECTRONICS", "TEXT"),
  A("ram_gb", "RAM", "ELECTRONICS", "NUMBER", { unit: "GB" }),
  A("storage_gb", "Storage", "ELECTRONICS", "NUMBER", { unit: "GB" }),
  A("display_size_in", "Display size", "ELECTRONICS", "NUMBER", { unit: "in" }),
  A("display_type", "Display type", "ELECTRONICS", "TEXT"),
  A("resolution", "Resolution", "ELECTRONICS", "TEXT"),
  A("refresh_rate_hz", "Refresh rate", "ELECTRONICS", "NUMBER", { unit: "Hz" }),
  A("operating_system", "Operating system", "ELECTRONICS", "TEXT"),
  A("battery_capacity_mah", "Battery capacity", "ELECTRONICS", "NUMBER", { unit: "mAh" }),
  A("camera", "Camera", "ELECTRONICS", "TEXT"),
  A("connectivity", "Connectivity", "ELECTRONICS", "TEXT"),
  A("wifi", "Wi-Fi", "ELECTRONICS", "TEXT"),
  A("bluetooth", "Bluetooth", "ELECTRONICS", "TEXT"),
  A("ports", "Ports", "ELECTRONICS", "TEXT"),
  A("power_w", "Power", "ELECTRONICS", "NUMBER", { unit: "W" }),
  A("voltage_v", "Voltage", "ELECTRONICS", "NUMBER", { unit: "V" }),
  A("warranty_period_months", "Warranty period", "ELECTRONICS", "NUMBER", { unit: "months" }),
  A("warranty", "Warranty details", "ELECTRONICS", "TEXT"),

  /* ------------------------------------------------------------- apparel */
  A("gender", "Gender", "APPAREL", "TEXT"),
  A("age_group", "Age group", "APPAREL", "TEXT"),
  A("clothing_type", "Clothing type", "APPAREL", "TEXT"),
  A("fabric", "Fabric", "APPAREL", "TEXT"),
  A("pattern", "Pattern", "APPAREL", "TEXT"),
  A("fit", "Fit", "APPAREL", "TEXT"),
  A("sleeve_type", "Sleeve type", "APPAREL", "TEXT"),
  A("neck_type", "Neck type", "APPAREL", "TEXT"),
  A("occasion", "Occasion", "APPAREL", "TEXT"),
  A("season", "Season", "APPAREL", "TEXT"),
  A("wash_care", "Wash care", "APPAREL", "TEXT"),

  /* ------------------------------------------------- home / beauty / other */
  A("capacity_ml", "Capacity", "HOME", "NUMBER", { unit: "ml" }),
  A("pack_contents", "Pack contents", "HOME", "TEXT"),
  A("skin_type", "Skin type", "BEAUTY", "TEXT"),
  A("hair_type", "Hair type", "BEAUTY", "TEXT"),
  A("spf", "SPF", "BEAUTY", "NUMBER"),
];

const BY_KEY = new Map(ATTRIBUTE_DEFINITIONS.map((d) => [d.key, d]));

export function getAttributeDefinition(key: string): AttributeDefinition | undefined {
  return BY_KEY.get(key);
}

/** snake_case, ascii, max 60 chars - the only shape an attribute key may take. */
export function toAttributeKey(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
}
