/**
 * Builds Amazon Seller Central inventory templates for the bulk-upload tests
 * (docs/product-import-2026-10).
 *
 * The real PUZZLES.xlsm the brief refers to was not available to this build,
 * so tests/fixtures/bulk_upload/PUZZLES.xlsm is a reconstruction made here, to
 * the layout the brief verified from that file: sheet "Template", 309 columns,
 * row 1 `settings=…`, row 2 blank, row 3 section headers, row 4 labels, row 5
 * attribute keys, row 6 Amazon's example (ABC123), row 7 the notice, data from
 * row 8; other sheets before and after it, and a VBA project (it is an .xlsm).
 * Replace the file with the real one: the tests assert the layout, not
 * anything only this reconstruction has.
 */
import ExcelJS from "exceljs";
import JSZip from "jszip";

const MP = "[marketplace_id=A21TJRUUN4KGV]";
const LT = "[language_tag=en_IN]";
const ALL = `purchasable_offer${MP}[audience=ALL]#1`;
const B2B = `purchasable_offer${MP}[audience=B2B]#1`;

export interface TemplateColumn {
  group: string;
  label: string;
  key: string;
}

function build(): TemplateColumn[] {
  const cols: TemplateColumn[] = [];
  let group = "";
  const g = (name: string) => {
    group = name;
  };
  const c = (label: string, key: string) => cols.push({ group, label, key });
  const rep = (n: number, label: string, key: (i: number) => string) => {
    for (let i = 1; i <= n; i += 1) c(label, key(i));
  };

  g("Listing Identity");
  c("SKU", "contribution_sku#1.value");
  c("Product Type", "product_type#1.value");
  c("Listing Action", "::record_action");

  g("Variations");
  c("Parentage Level", `parentage_level${MP}#1.value`);
  c("Parent SKU", `child_parent_sku_relationship${MP}#1.parent_sku`);
  c("Child Relationship Type", `child_parent_sku_relationship${MP}#1.child_relationship_type`);
  c("Variation Theme Name", "variation_theme#1.name");

  g("Product Identity");
  c("Item Name", `item_name${MP}${LT}#1.value`);
  c("Brand Name", `brand${MP}${LT}#1.value`);
  c("Product Id Type", "externally_assigned_product_identifier#1.type");
  c("Product Id", "externally_assigned_product_identifier#1.value");
  c("Merchant Suggested ASIN", `merchant_suggested_asin${MP}#1.value`);
  rep(5, "Recommended Browse Nodes", (i) => `recommended_browse_nodes${MP}#${i}.value`);
  c("Item Highlight", `title_differentiation${MP}${LT}#1.value`);
  c("Model Number", `model_number${MP}#1.value`);
  c("Model Name", `model_name${MP}${LT}#1.value`);
  c("Manufacturer", `manufacturer${MP}${LT}#1.value`);
  c("Part Number", `part_number${MP}#1.value`);
  c("Sub Brand", `sub_brand${MP}${LT}#1.value`);
  c("Edition", `edition${MP}${LT}#1.value`);
  c("Collection Name", `collection${MP}${LT}#1.value`);

  g("Images");
  c("Main Image URL", `main_product_image_locator${MP}#1.media_location`);
  for (let i = 1; i <= 8; i += 1) c("Other Image URL", `other_product_image_locator_${i}${MP}#1.media_location`);
  c("Swatch Image URL", `swatch_product_image_locator${MP}#1.media_location`);

  g("Product Details");
  c("Product Description", `product_description${MP}${LT}#1.value`);
  rep(5, "Bullet Point", (i) => `bullet_point${MP}${LT}#${i}.value`);
  c("Generic Keyword", `generic_keyword${MP}${LT}#1.value`);
  rep(5, "Special Features", (i) => `special_feature${MP}${LT}#${i}.value`);
  c("Style", `style${MP}${LT}#1.value`);
  rep(5, "Material", (i) => `material${MP}${LT}#${i}.value`);
  c("Color", `color${MP}${LT}#1.value`);
  c("Color Map", `color${MP}${LT}#1.standardized_values#1`);
  c("Size", `size${MP}${LT}#1.value`);
  c("Item Shape", `item_shape${MP}${LT}#1.value`);
  rep(5, "Theme", (i) => `theme${MP}${LT}#${i}.value`);
  c("Target Gender", `target_gender${MP}#1.value`);
  c("Age Range Description", `age_range_description${MP}${LT}#1.value`);
  c("Number of Pieces", `number_of_pieces${MP}#1.value`);
  c("Number of Items", `number_of_items${MP}#1.value`);
  c("Unit Count", `unit_count${MP}#1.value`);
  c("Unit Count Type", `unit_count${MP}#1.type.value`);
  rep(5, "Included Components", (i) => `included_components${MP}${LT}#${i}.value`);
  rep(5, "Educational Objective", (i) => `educational_objective${MP}${LT}#${i}.value`);
  c("Puzzle Type", `puzzle_type${MP}${LT}#1.value`);
  c("Skill Level", `skill_level${MP}${LT}#1.value`);
  c("Number of Players", `number_of_players${MP}#1.value`);
  c("Is Assembly Required", `is_assembly_required${MP}#1.value`);
  c("Minimum Age (Manufacturer)", `manufacturer_minimum_age${MP}#1.value`);
  c("Minimum Age Unit", `manufacturer_minimum_age${MP}#1.unit`);
  c("Maximum Age (Manufacturer)", `manufacturer_maximum_age${MP}#1.value`);
  c("Maximum Age Unit", `manufacturer_maximum_age${MP}#1.unit`);
  c("Item Weight", `item_weight${MP}#1.value`);
  c("Item Weight Unit", `item_weight${MP}#1.unit`);
  c("Item Length", `item_length_width${MP}#1.length.value`);
  c("Item Length Unit", `item_length_width${MP}#1.length.unit`);
  c("Item Width", `item_length_width${MP}#1.width.value`);
  c("Item Width Unit", `item_length_width${MP}#1.width.unit`);
  c("Item Thickness", `item_thickness${MP}#1.decimal_value`);
  c("Item Thickness Unit", `item_thickness${MP}#1.unit`);
  c("Care Instructions", `care_instructions${MP}${LT}#1.value`);
  c("Warranty Description", `warranty_description${MP}${LT}#1.value`);
  c("Is Fragile", `is_fragile${MP}#1.value`);
  c("Contains Liquid Contents", `contains_liquid_contents${MP}#1.value`);
  rep(3, "External Product Information", (i) => `external_product_information${MP}#${i}.entity`);
  rep(3, "External Product Information", (i) => `external_product_information${MP}#${i}.value`);
  c("Country of Origin", `country_of_origin${MP}#1.value`);
  c("Manufacturer Contact Information", `manufacturer_contact_information${MP}${LT}#1.value`);
  c("Packer Contact Information", `packer_contact_information${MP}${LT}#1.value`);
  c("Importer Contact Information", `importer_contact_information${MP}${LT}#1.value`);
  c("Item Type Name", `item_type_name${MP}${LT}#1.value`);
  c("Part Type", `part_type${MP}${LT}#1.value`);
  c("Language", `language${MP}#1.value`);
  c("Language Type", `language${MP}#1.type`);

  g("Offer");
  c("Item Condition", `condition_type${MP}#1.value`);
  c("Offer Condition Note", `condition_note${MP}${LT}#1.value`);
  c("Is Gift Wrap Available", `gift_options${MP}#1.can_be_wrapped`);
  c("Offering Can Be Gift Messaged", `gift_options${MP}#1.can_be_messaged`);
  c("Maximum Order Quantity", `max_order_quantity${MP}#1.value`);
  c("Product Tax Code", "product_tax_code#1.value");
  c("Offering Release Date", `merchant_release_date${MP}#1.value`);
  c("Merchant Shipping Group", `merchant_shipping_group${MP}#1.value`);
  c("List Price", `list_price${MP}#1.value`);
  c("List Price Currency", `list_price${MP}#1.currency`);

  g("Offer (IN) - Sell on Amazon");
  c("Your Price INR (Sell on Amazon, IN)", `${ALL}.our_price#1.schedule#1.value_with_tax`);
  c("Sale Price INR (Sell on Amazon, IN)", `${ALL}.discounted_price#1.schedule#1.value_with_tax`);
  c("Sale Start Date (Sell on Amazon, IN)", `${ALL}.discounted_price#1.schedule#1.start_at`);
  c("Sale End Date (Sell on Amazon, IN)", `${ALL}.discounted_price#1.schedule#1.end_at`);
  c("Maximum Retail Price (Sell on Amazon, IN)", `${ALL}.maximum_retail_price#1.schedule#1.value_with_tax`);
  c("Minimum Seller Allowed Price (Sell on Amazon, IN)", `${ALL}.minimum_seller_allowed_price#1.schedule#1.value_with_tax`);
  c("Maximum Seller Allowed Price (Sell on Amazon, IN)", `${ALL}.maximum_seller_allowed_price#1.schedule#1.value_with_tax`);
  c("Offering Start Date (Sell on Amazon, IN)", `${ALL}.start_at.value`);
  c("Offering End Date (Sell on Amazon, IN)", `${ALL}.end_at.value`);
  c("Quantity (IN)", "fulfillment_availability#1.quantity");
  c("Fulfillment Channel Code (IN)", "fulfillment_availability#1.fulfillment_channel_code");
  c("Handling Time (IN)", "fulfillment_availability#1.lead_time_to_ship_max_days");
  c("Restock Date (IN)", "fulfillment_availability#1.restock_date");
  c("Inventory Always Available (IN)", "fulfillment_availability#1.is_inventory_available");

  g("Offer (IN) - B2B");
  c("Business Price (Sell on Amazon, IN)", `${B2B}.our_price#1.schedule#1.value_with_tax`);
  c("B2B Maximum Retail Price (Sell on Amazon, IN)", `${B2B}.maximum_retail_price#1.schedule#1.value_with_tax`);
  c("Quantity Price Type (Sell on Amazon, IN)", `${B2B}.quantity_discount_plan#1.schedule#1.discount_type`);
  for (let i = 1; i <= 5; i += 1) {
    c(`Quantity Lower Bound ${i} (Sell on Amazon, IN)`, `${B2B}.quantity_discount_plan#1.schedule#1.levels#${i}.lower_bound`);
    c(`Quantity Price ${i} (Sell on Amazon, IN)`, `${B2B}.quantity_discount_plan#1.schedule#1.levels#${i}.value`);
  }
  c("Progressive Discount Type (Sell on Amazon, IN)", `${B2B}.progressive_discount_type`);
  c("National Stock Number (Sell on Amazon, IN)", `${B2B}.national_stock_number`);
  c("United Nations Standard Products and Services Code", `${B2B}.unspsc_code`);
  c("Pricing Action", `${B2B}.pricing_action`);

  g("Shipping");
  c("Item Package Length", `item_package_dimensions${MP}#1.length.value`);
  c("Item Package Length Unit", `item_package_dimensions${MP}#1.length.unit`);
  c("Item Package Width", `item_package_dimensions${MP}#1.width.value`);
  c("Item Package Width Unit", `item_package_dimensions${MP}#1.width.unit`);
  c("Item Package Height", `item_package_dimensions${MP}#1.height.value`);
  c("Item Package Height Unit", `item_package_dimensions${MP}#1.height.unit`);
  c("Package Weight", `item_package_weight${MP}#1.value`);
  c("Package Weight Unit", `item_package_weight${MP}#1.unit`);
  c("Number of Boxes", `number_of_boxes${MP}#1.value`);
  c("Item Package Quantity", `item_package_quantity${MP}#1.value`);

  g("Safety & Compliance");
  rep(5, "Safety Warning", (i) => `safety_warning${MP}${LT}#${i}.value`);
  c("Are batteries required?", `batteries_required${MP}#1.value`);
  c("Batteries Included", `batteries_included${MP}#1.value`);
  c("Battery Cell Composition", `battery${MP}#1.cell_composition#1.value`);
  c("Battery Weight", `battery${MP}#1.weight#1.value`);
  c("Battery Weight Unit", `battery${MP}#1.weight#1.unit`);
  rep(5, "Dangerous Goods Regulations", (i) => `supplier_declared_dg_hz_regulation${MP}#${i}.value`);
  c("Hazmat", `hazmat${MP}#1.aspect`);
  c("Hazmat Value", `hazmat${MP}#1.value`);
  c("Safety Data Sheet (SDS or MSDS) URL", `safety_data_sheet_url${MP}#1.value`);
  rep(3, "Compliance Media Content Type", (i) => `compliance_media${MP}#${i}.content_type`);
  rep(3, "Compliance Media Content Language", (i) => `compliance_media${MP}#${i}.content_language`);
  rep(3, "Compliance Media Source Location", (i) => `compliance_media${MP}#${i}.source_location`);
  c("GHS Class", `ghs${MP}#1.classification#1.class`);
  c("Is Chemical", `is_chemical${MP}#1.value`);
  c("EU Toys Safety Directive Age Warning", `eu_toys_safety_directive_age_warning${MP}#1.value`);
  rep(3, "EU Toys Safety Directive Warning", (i) => `eu_toys_safety_directive_warning${MP}#${i}.value`);
  rep(3, "EU Toys Safety Directive Language", (i) => `eu_toys_safety_directive_language${MP}#${i}.value`);
  rep(3, "CPSIA Warning", (i) => `cpsia_cautionary_statement${MP}#${i}.value`);

  // Further PUZZLES attributes Amazon publishes for the product type, in the
  // template's last "Product Details" block, to the brief's 309 columns.
  g("Product Details (more)");
  const more: [string, string][] = [
    ["Product Subcategory", "product_subcategory"], ["Department", "department"], ["Sub Department", "sub_department"],
    ["Genre", "genre"], ["Character", "subject_character"], ["Pattern", "pattern"], ["Finish Type", "finish_type"],
    ["Frame Material", "frame_material"], ["Paper Finish", "paper_finish"], ["Lifestyle", "lifestyle"],
    ["Occasion", "occasion_type"], ["Seasons", "seasons"], ["Artist", "artist"], ["Series", "series"],
    ["Release Date", "release_date"], ["Toy Award", "toy_award_name"], ["Box Contents", "box_contents"],
    ["Display Height", "display_height"], ["Display Width", "display_width"], ["Assembled Length", "assembled_length"],
    ["Assembled Width", "assembled_width"], ["Assembled Height", "assembled_height"], ["Is Glow In The Dark", "is_glow_in_the_dark"],
    ["Is Customizable", "is_customizable"], ["Customization Template", "customization_template"], ["Product Site Launch Date", "product_site_launch_date"],
    ["Is Discontinued By Manufacturer", "is_discontinued_by_manufacturer"], ["Item Volume", "item_volume"], ["Item Volume Unit", "item_volume.unit"],
    ["Recycled Content Percentage", "recycled_content_percentage"], ["Number of Puzzle Pieces Per Bag", "pieces_per_bag"],
    ["Puzzle Difficulty", "puzzle_difficulty"], ["Solved Image Included", "solved_image_included"], ["Glue Included", "glue_included"],
    ["Poster Included", "poster_included"], ["Board Included", "board_included"], ["Storage Bag Included", "storage_bag_included"],
    ["Mounting Type", "mounting_type"], ["Orientation", "orientation"], ["Print Technique", "print_technique"],
    ["Cut Style", "cut_style"], ["Piece Thickness", "piece_thickness"], ["Piece Shape", "piece_shape"],
    ["Image Theme", "image_theme"], ["Image Source", "image_source"], ["License", "license_name"], ["Licensor", "licensor"],
    ["Number of Sides", "number_of_sides"], ["Is Double Sided", "is_double_sided"], ["Has Unique Pieces", "has_unique_pieces"],
    ["Is Eco Friendly", "is_eco_friendly"], ["Is Handmade", "is_handmade"], ["Is Wooden", "is_wooden"],
  ];
  for (const [label, key] of more) c(label, `${key}${MP}#1.value`);

  // Pad to exactly 309 (the brief's count) with further numbered "Other Attributes" columns.
  let n = 1;
  while (cols.length < 309) {
    c(`Other Attributes ${n}`, `other_attributes${MP}${LT}#${n}.value`);
    n += 1;
  }
  return cols.slice(0, 309);
}

export const PUZZLES_COLUMNS: readonly TemplateColumn[] = build();

/** Builds a product row from label → value (a repeated label takes an array). */
export function amazonRow(values: Record<string, unknown>): unknown[] {
  const seen = new Map<string, number>();
  return PUZZLES_COLUMNS.map((col) => {
    const n = seen.get(col.label) ?? 0;
    seen.set(col.label, n + 1);
    const v = values[col.label];
    if (Array.isArray(v)) return v[n] ?? null;
    return n === 0 ? (v ?? null) : null;
  });
}

/** By attribute key fragment, for columns whose label repeats with different keys (External Product Information). */
export function setByKey(row: unknown[], keyFragment: string, value: unknown): unknown[] {
  const i = PUZZLES_COLUMNS.findIndex((c) => c.key.includes(keyFragment));
  if (i < 0) throw new Error(`No column with key ${keyFragment}`);
  row[i] = value;
  return row;
}

export const AMAZON_EXAMPLE_ROW = amazonRow({
  SKU: "ABC123",
  "Product Type": "PUZZLES",
  "Item Name": "Adidas Blue Sneakers",
  "Brand Name": "Adidas",
  "Product Id Type": "EAN",
  "Product Id": "8901234567890",
  "Quantity (IN)": 10,
  "Your Price INR (Sell on Amazon, IN)": 999,
});

export const AMAZON_NOTICE =
  "We've prefilled attributes for you based on your product type. Please do not delete these rows; enter your product data from row 8.";

/** A valid EAN-13 for `body` (12 digits). */
export function ean13(body: string): string {
  const digits = body.split("").map(Number);
  const sum = digits.reduce((s, d, i) => s + d * (i % 2 === 0 ? 1 : 3), 0);
  return body + String((10 - (sum % 10)) % 10);
}

const VBA_STUB = Buffer.from(
  "\u00d0\u00cf\u0011\u00e0 fake VBA project for tests\r\nAttribute VB_Name = \"Module1\"\r\nSub Auto_Open()\r\n  Shell \"cmd /c echo pwned > C:\\\\pwned.txt\"\r\nEnd Sub\r\n",
  "latin1",
);

/** Turns an .xlsx buffer into an .xlsm (macro-enabled) one with a VBA project part. */
export async function addVbaProject(xlsx: Buffer): Promise<Buffer> {
  const zip = await JSZip.loadAsync(xlsx);
  zip.file("xl/vbaProject.bin", VBA_STUB);
  const types = await zip.file("[Content_Types].xml")!.async("string");
  zip.file(
    "[Content_Types].xml",
    types
      .replace(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
        "application/vnd.ms-excel.sheet.macroEnabled.main+xml",
      )
      .replace("<Default ", '<Default Extension="bin" ContentType="application/vnd.ms-office.vbaProject"/><Default '),
  );
  const relsPath = "xl/_rels/workbook.xml.rels";
  const rels = await zip.file(relsPath)!.async("string");
  zip.file(
    relsPath,
    rels.replace(
      "</Relationships>",
      '<Relationship Id="rIdVba1" Type="http://schemas.microsoft.com/office/2006/relationships/vbaProject" Target="vbaProject.bin"/></Relationships>',
    ),
  );
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

/**
 * The whole workbook: Instructions, Data Definitions (which also says "SKU"),
 * Template, Valid Values. `rows` are data rows from row 8 on.
 */
export async function buildAmazonWorkbook(rows: unknown[][], options: { macros?: boolean; productType?: string } = {}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const instructions = wb.addWorksheet("Instructions");
  instructions.addRow(["Use this template to add or update listings. Enter data in the Template tab from row 8."]);
  const defs = wb.addWorksheet("Data Definitions");
  defs.addRow(["Group Name", "Field Name", "Local Label Name", "Definition and Use", "Accepted Values", "Example", "Required?"]);
  for (const col of PUZZLES_COLUMNS.slice(0, 40)) defs.addRow([col.group, col.key, col.label, "", "", "", "Optional"]);

  const ws = wb.addWorksheet("Template");
  const type = options.productType ?? "PUZZLES";
  ws.addRow([
    `settings=contentLanguageTag=en_IN&feedType=113&headerLanguageTag=en_IN&isEdit=false&marketplaceId=A21TJRUUN4KGV&primaryMarketplaceId=amzn1.mp.o.A21TJRUUN4KGV&productTypes=${type}&templateIdentifier=0f1e2d3c&timestamp=2026-10-01T10:00:00.000Z`,
    "TemplateType=fptcustom",
    "Version=2026.1001",
  ]);
  ws.addRow([]);
  const groupRow: (string | null)[] = [];
  let last = "";
  for (const col of PUZZLES_COLUMNS) {
    groupRow.push(col.group !== last ? col.group : null);
    last = col.group;
  }
  ws.addRow(groupRow);
  ws.addRow(PUZZLES_COLUMNS.map((c) => c.label));
  ws.addRow(PUZZLES_COLUMNS.map((c) => c.key));
  ws.addRow(AMAZON_EXAMPLE_ROW);
  ws.addRow([AMAZON_NOTICE]);
  for (const r of rows) ws.addRow(r);

  const valid = wb.addWorksheet("Valid Values");
  valid.addRow(["Product Id Type", "EAN", "UPC", "GTIN", "ASIN", "GTIN Exempt"]);
  valid.addRow(["Item Condition", "New", "Used - Like New", "Refurbished"]);

  const xlsx = Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
  return options.macros === false ? xlsx : addVbaProject(xlsx);
}

/** The five data rows of the PUZZLES fixture (rows 8–12). */
export function puzzlesFixtureRows(): unknown[][] {
  const r1 = amazonRow({
    SKU: "PZ-1000-WORLDMAP",
    "Product Type": "PUZZLES",
    "Item Name": "Generic 1000 Piece Jigsaw Puzzle - World Map",
    "Brand Name": "Generic",
    "Product Id Type": "EAN",
    "Product Id": ean13("890612345001"),
    "Recommended Browse Nodes": ["Toys & Games > Puzzles > Jigsaw Puzzles"],
    "Model Number": "WM-1000",
    Manufacturer: "Generic Toys Pvt Ltd",
    "Main Image URL": "https://images.example-cdn.com/puzzles/wm-1000-main.jpg",
    "Other Image URL": ["https://images.example-cdn.com/puzzles/wm-1000-2.jpg", "https://images.example-cdn.com/puzzles/wm-1000-3.jpg"],
    "Product Description": "A 1000 piece world map jigsaw puzzle for the whole family.",
    "Bullet Point": ["1000 thick cardboard pieces", "Finished size 70 x 50 cm", "Poster included", "Ages 12 and up", "Made in India"],
    "Generic Keyword": "jigsaw puzzle world map 1000 pieces",
    Material: ["Cardboard", "Paper"],
    Theme: ["Maps", "Geography"],
    Color: "Multicolour",
    "Age Range Description": "Adult",
    "Number of Pieces": 1000,
    "Number of Items": 1,
    "Unit Count": 1,
    "Unit Count Type": "Count",
    "Item Weight": 650,
    "Item Weight Unit": "Grams",
    "Item Length": 70,
    "Item Length Unit": "Centimetres",
    "Item Width": 50,
    "Item Width Unit": "Centimetres",
    "Country of Origin": "India",
    "Manufacturer Contact Information": "Generic Toys Pvt Ltd, Pune 411001",
    "Item Condition": "New",
    "Is Gift Wrap Available": "Yes",
    "Offering Can Be Gift Messaged": "No",
    "Maximum Order Quantity": 5,
    "Product Tax Code": "A_GEN_STANDARD",
    "Your Price INR (Sell on Amazon, IN)": "649.00",
    "Maximum Retail Price (Sell on Amazon, IN)": "₹999",
    "Quantity (IN)": 25,
    "Handling Time (IN)": 2,
    "Item Package Length": 35,
    "Item Package Length Unit": "Centimetres",
    "Item Package Width": 25,
    "Item Package Width Unit": "Centimetres",
    "Item Package Height": 6,
    "Item Package Height Unit": "Centimetres",
    "Package Weight": 0.75,
    "Package Weight Unit": "Kilograms",
    "Safety Warning": ["Not suitable for children under 3 years: small parts."],
    "Are batteries required?": "No",
    "Business Price (Sell on Amazon, IN)": 600,
  });
  setByKey(r1, "external_product_information[marketplace_id=A21TJRUUN4KGV]#1.entity", "HSN Code");
  setByKey(r1, "external_product_information[marketplace_id=A21TJRUUN4KGV]#1.value", "95032000");

  const r2 = amazonRow({
    SKU: "PZ-3D-TAJ",
    "Product Type": "PUZZLES",
    "Listing Action": "Create or Replace (Full Update)",
    "Item Name": "Generic 3D Taj Mahal Puzzle 216 Pieces",
    "Brand Name": "Generic",
    "Product Id Type": "EAN",
    "Product Id": ean13("890612345002"),
    "Recommended Browse Nodes": ["Toys & Games > Puzzles > 3-D Puzzles"],
    "Number of Pieces": 216,
    "Your Price INR (Sell on Amazon, IN)": "1,299.00",
    "Maximum Retail Price (Sell on Amazon, IN)": "1,599",
    "Sale Price INR (Sell on Amazon, IN)": "1,199",
    "Sale Start Date (Sell on Amazon, IN)": "01/11/2026",
    "Sale End Date (Sell on Amazon, IN)": "2026-11-30",
    "Quantity (IN)": "1,200",
    "Item Condition": "New",
    "Country of Origin": "India",
  });
  setByKey(r2, "external_product_information[marketplace_id=A21TJRUUN4KGV]#1.entity", "HSN Code");
  setByKey(r2, "external_product_information[marketplace_id=A21TJRUUN4KGV]#1.value", "95032000");

  const r3 = amazonRow({
    SKU: "PZ-KIDS-ANIMALS",
    "Product Type": "PUZZLES",
    "Item Name": "Generic Floor Puzzle Animals 48 Pieces",
    "Brand Name": "Generic",
    "Product Id Type": "GTIN Exempt",
    "Recommended Browse Nodes": ["Toys & Games > Puzzles > Floor Puzzles"],
    "Your Price INR (Sell on Amazon, IN)": 349,
    "Maximum Retail Price (Sell on Amazon, IN)": 499,
    "Quantity (IN)": 0,
    "Restock Date (IN)": 46300,
    "Inventory Always Available (IN)": "N",
  });
  setByKey(r3, "external_product_information[marketplace_id=A21TJRUUN4KGV]#1.entity", "HSN Code");
  setByKey(r3, "external_product_information[marketplace_id=A21TJRUUN4KGV]#1.value", "95032000");

  const r4 = amazonRow({
    SKU: "PZ-MINI-500",
    "Product Type": "PUZZLES",
    "Item Name": "Generic 500 Piece Puzzle - Kerala Backwaters",
    "Brand Name": "Generic",
    "Your Price INR (Sell on Amazon, IN)": 449,
    "Maximum Retail Price (Sell on Amazon, IN)": 599,
    "Quantity (IN)": "ten",
  });
  setByKey(r4, "external_product_information[marketplace_id=A21TJRUUN4KGV]#1.entity", "HSN Code");
  setByKey(r4, "external_product_information[marketplace_id=A21TJRUUN4KGV]#1.value", "95032000");

  const r5 = amazonRow({ SKU: "PZ-1000-WORLDMAP-B", "Quantity (IN)": 7 });
  return [r1, r2, r3, r4, r5];
}
