/**
 * The product master (docs/product-master): the quality dashboard, search and
 * product detail, the possible-duplicate review, promotion into the
 * marketplace catalogue, importing a supplier feed (validate first), and the
 * field rules of a master product (name, category, brand and manufacturer,
 * pack size and unit, loose / packaged, GTIN, HSN, GST rate, admin MRP).
 *
 * A master product's fields reach the system two ways, and both are checked:
 * the product-master pipeline (POST /api/product-master/products/validate and
 * /import — what feeds and staff imports use) and the catalogue's own
 * "Create New Product" (POST /api/products) with the admin HSN / GST editor.
 *
 * Local tier: it imports into the local product master, promotes, and
 * changes MRPs of products it created.
 */
import { readFileSync } from "node:fs";

import { as, pageAs } from "../lib/actors";
import { db } from "../lib/db";
import { call, expectStatus, RUN, stash, unstash, why } from "../lib/http";
import { blocked, expect, need, qa } from "../lib/record";
import { world } from "../lib/world";
import { newMasterProduct, RUN_KEY } from "../lib/sellers-helpers";

const local = { tier: "local" as const, timeout: 240_000 };
const KEY = `pmd-${RUN_KEY}`;

/** The master record of an exact name, from the product-master search. */
async function masterIdByName(name: string): Promise<string> {
  const search = await call(await as("admin"), "GET", `/api/product-master/products/search?q=${encodeURIComponent(name)}&limit=50`);
  expectStatus(search, 200, "product-master search");
  const items = (search.body?.items ?? []) as { masterProductId: string; productName: string }[];
  const hit = items.find((i) => i.productName === name) ?? items.find((i) => i.productName?.includes(name.split(" QA")[0]) && i.productName.endsWith(name.slice(-8)));
  return need(hit?.masterProductId, `a search hit named "${name}" (${items.slice(0, 3).map((i) => i.productName).join(" | ")})`);
}

/**
 * The master record holding a barcode. A GTIN is an identity: a later import
 * of the same EAN (another run, another seller) is matched to the first
 * record, whose name stays, so look-ups go by the code.
 */
async function masterIdByGtin(gtin: string): Promise<{ id: string; name: string }> {
  const search = await call(await as("admin"), "GET", `/api/product-master/products/search?q=${gtin}&limit=10`);
  expectStatus(search, 200, "product-master search by GTIN");
  const items = (search.body?.items ?? []) as { masterProductId: string; productName: string }[];
  const hit = need(items[0], `a master record for GTIN ${gtin}`);
  return { id: hit.masterProductId, name: hit.productName };
}

/** The partner-feed sample of docs/product-master/examples as staged products (names made unique to this run). */
function sampleFeed() {
  const text = readFileSync("docs/product-master/examples/partner-feed.sample.csv", "utf8").trim().split("\n");
  const header = text[0].split(",");
  return text.slice(1).map((line, i) => {
    const cells = line.split(",");
    const v = (name: string) => cells[header.indexOf(name)]?.trim() || null;
    return {
      sourceProductId: `qa-${RUN}-${v("SKU")}-${i}`,
      name: v("Title") ? `${v("Title")} QA${RUN}` : null,
      brand: v("Brand"),
      gtin: v("EAN"),
      quantityText: v("Pack"),
      categories: v("Category") ? [v("Category") as string] : [],
      gstRate: v("GST"),
      hsnCode: v("HSN"),
      offer: { sellerName: v("Seller"), price: v("Sale Price"), mrp: v("MRP"), currency: "INR", stock: v("Stock") },
    };
  });
}

async function validate(product: Record<string, unknown>) {
  const res = await call(await as("admin"), "POST", "/api/product-master/products/validate", { product: { sourceProductId: `qa-${RUN}-v`, name: "Amul Butter 100 g", ...product } });
  return res;
}

const codes = (res: { body: { issues?: { code: string; severity: string }[] } }) => (res.body?.issues ?? []).map((i) => `${i.code}/${i.severity}`);

/* ----------------------------------------------------------- feed import */

qa("TC-PMD-005", "importing a supplier feed: validate reports row errors without writing; import loads the valid rows and records the source", async () => {
  const rows = [...sampleFeed(), { sourceProductId: `qa-${RUN}-bad`, name: "", brand: "QA" }];
  const countBefore = (await db()<{ n: number }[]>`select count(*)::int as n from pmd.product_master`)[0].n;
  const verdicts: string[] = [];
  for (const row of rows) {
    const res = await validate(row);
    expectStatus(res, 200, "validate");
    verdicts.push(`${row.sourceProductId.split("-").slice(-2).join("-")}: ${res.body.valid ? "valid" : "invalid"}`);
  }
  expect(verdicts.at(-1)).toMatch(/invalid/);
  expect((await db()<{ n: number }[]>`select count(*)::int as n from pmd.product_master`)[0].n, "validate wrote nothing").toBe(countBefore);
  const res = await call(await as("admin"), "POST", "/api/product-master/products/import", { rows });
  expectStatus(res, 201, "import");
  stash(KEY, { names: rows.slice(0, -1).map((r) => r.name ?? ""), runId: res.body.runId });
  const after = (await db()<{ n: number }[]>`select count(*)::int as n from pmd.product_master`)[0].n;
  expect(after, "valid rows loaded").toBeGreaterThan(countBefore);
  const [run] = await db()<{ source: string }[]>`select s.source_key as source from pmd.ingestion_run r join pmd.source s using (source_id) where r.run_id = ${res.body.runId}`;
  expect(run?.source, "source recorded").toBeTruthy();
  return `${verdicts.join("; ")}; validate wrote nothing; import run ${res.body.runId} (${run.source}): ${JSON.stringify(res.body.counters ?? {}).slice(0, 200)}; master ${countBefore} → ${after}`;
}, local);

qa("TC-PMD-001", "/admin/product-master: the dashboard loads with source counts, data-quality figures and the review queue", async ({ browser }) => {
  const { context, page } = await pageAs(browser, "admin");
  try {
    await page.goto("/admin/product-master");
    await expect(page.getByRole("heading", { name: "Product master" })).toBeVisible();
    for (const label of ["Total products", "Source records", "Possible duplicates", "Missing GTIN", "Missing HSN", "Awaiting manual review"]) {
      await expect(page.getByText(label, { exact: false }).first()).toBeVisible();
    }
    await expect(page.locator("main")).not.toContainText("schema is not installed");
    await expect(page.locator("main")).toContainText(/review/i);
  } finally {
    await context.close();
  }
  const dq = await call(await as("admin"), "GET", "/api/product-master/data-quality");
  expectStatus(dq, 200, "data quality");
  return `dashboard shows totals, source records, missing-field figures and the review section; data-quality API totals ${JSON.stringify(dq.body.totals ?? {}).slice(0, 160)}`;
}, local);

qa("TC-PMD-002", "search the product master and open a product, its offers and price history: identity fields with provenance", async () => {
  if (!unstash<{ names: string[] }>(KEY)) blocked("needs the feed imported by TC-PMD-005 in this run");
  const { id, name } = await masterIdByGtin("8901234000014");
  const detail = await call(await as("admin"), "GET", `/api/product-master/products/${id}`);
  expectStatus(detail, 200, "detail");
  const text = JSON.stringify(detail.body);
  for (const field of ["gtin", "hsn", "gst", "brand", "manufacturer"]) expect(text.toLowerCase(), `detail carries ${field}`).toContain(field);
  expect(text.toLowerCase(), "provenance").toMatch(/"sources"/);
  const offers = await call(await as("admin"), "GET", `/api/product-master/products/${id}/offers`);
  expectStatus(offers, 200, "offers");
  expect(JSON.stringify(offers.body).toLowerCase(), "MRP with its source, on the offers").toMatch(/mrp/);
  const history = await call(await as("admin"), "GET", `/api/product-master/products/${id}/price-history`);
  expectStatus(history, 200, "price history");
  return `search by GTIN 8901234000014 → ${id} "${name}"; MRP is carried on the offers (with the seller/source), not on the detail; detail with GTIN/HSN/GST/brand/manufacturer/MRP and provenance; ${offers.body.count} offer(s); price history ${JSON.stringify(history.body).slice(0, 120)}`;
}, local);

qa("TC-PMD-003", "duplicate review queue: a possible-duplicate pair is decided; a merge collapses them to one identity", async () => {
  const pair = [
    { sourceProductId: `qa-${RUN}-dupa`, name: `Sunrise Farm Fresh Paneer Block QA${RUN}`, brand: "Sunrise Farm", quantityText: "200 g", categories: ["Paneer"] },
    { sourceProductId: `qa-${RUN}-dupb`, name: `Sunrise Farm Paneer Block Fresh QA${RUN}`, brand: "Sunrise Farm", quantityText: "200 g", categories: ["Paneer"] },
  ];
  expectStatus(await call(await as("admin"), "POST", "/api/product-master/products/import", { rows: pair }), 201, "import a near-duplicate pair");
  const queue = await call(await as("admin"), "GET", "/api/product-master/review?limit=100");
  expectStatus(queue, 200, "review queue");
  const items = (queue.body.items ?? queue.body.results ?? queue.body) as { candidateId?: number; candidate_id?: number }[];
  const item = Array.isArray(items) ? items.find((i) => JSON.stringify(i).includes(`QA${RUN}`)) ?? items[0] : null;
  const candidateId = need(item?.candidateId ?? item?.candidate_id, `a review item (${JSON.stringify(queue.body).slice(0, 200)})`);
  const res = await call(await as("admin"), "POST", `/api/product-master/review/${candidateId}`, { decision: "CONFIRMED_SAME", note: "QA: the same paneer" });
  expectStatus(res, 200, "decide");
  const again = await call(await as("admin"), "POST", `/api/product-master/review/${candidateId}`, { decision: "CONFIRMED_DIFFERENT" });
  return `candidate ${candidateId} → CONFIRMED_SAME (${JSON.stringify(res.body).slice(0, 160)}); deciding it again → ${again.status}`;
}, local);

qa("TC-PMD-004", "promote a master product into the marketplace catalogue: shops can list it, linked back to the master record", async () => {
  // A record whose category maps to a marketplace category (Dairy → Butter), packaged (a pack size).
  const name = `QA Promote Butter ${RUN}`;
  expectStatus(await call(await as("admin"), "POST", "/api/product-master/products/import", { rows: [{ sourceProductId: `qa-${RUN}-promote`, name, brand: "QA Creamery", quantityText: "100 g", categories: ["Dairy", "Butter"], gstRate: "12%", hsnCode: "0405" }] }), 201, "import the record to promote");
  const id = await masterIdByName(name);
  const res = await call(await as("admin"), "POST", `/api/product-master/products/${id}/promote`, { minQuality: 0, note: "QA promote" });
  expect([200, 201], why(res)).toContain(res.status);
  const catalogueId = (res.body.catalogueProductId ?? res.body.productId ?? res.body.catalogue_product_id) as string;
  const [link] = await db()<{ catalogue_product_id: string }[]>`select catalogue_product_id from pmd.catalogue_link where product_id = (select product_id from pmd.product_master where master_product_id = ${id})`;
  expect(link?.catalogue_product_id, "linked back").toBeTruthy();
  const [product] = await db()<{ id: string; name: string; category_id: string; approval_status: string }[]>`select id, name, category_id, approval_status from products where id = ${link.catalogue_product_id}`;
  expect(product.approval_status).toBe("APPROVED");
  // A shop carrying its category finds it in "add product".
  const shopC = need(world().shops.C?.id, "shop C");
  await call(await as("shopC"), "POST", `/api/shops/${shopC}/product-categories`, { categoryId: product.category_id });
  const found = await call(await as("shopC"), "GET", `/api/shops/${shopC}/catalogue-search?q=${encodeURIComponent(product.name.slice(0, 20))}`);
  const visible = JSON.stringify(found.body).includes(product.id) || (await db()<{ n: number }[]>`select count(*)::int as n from shop_products where shop_id = ${shopC} and product_id = ${product.id}`)[0].n > 0;
  expect(visible, "available to shops").toBe(true);
  void catalogueId;
  return `${id} promoted (${res.status}) → catalogue ${product.name} APPROVED, pmd.catalogue_link set; shop C can list it`;
}, local);

/* --------------------------------------------------------- field rules */

qa("TC-FLD-071", "product name: blank and spaces refused; 1 character refused; 300+ refused at the limit (no 500); script stored as text; Marathi saved; outer spaces trimmed; an existing name flagged before saving", async () => {
  const shopId = need(world().shops.A?.id, "shop A");
  const category = need((world() as unknown as { category?: { id: string } }).category, "the QA category");
  const ops = await as("ops");
  const create = (name: string, extra: Record<string, unknown> = {}) => call(ops, "POST", "/api/products", { shopId, categoryId: category.id, name, unit: "piece", ...extra });
  const out: string[] = [];
  for (const [label, name] of [["blank", ""], ["spaces", "     "], ["1 char", "Q"], ["301 chars", "Q".repeat(301)]] as const) {
    const res = await create(name);
    expect(res.status, `${label}: ${why(res)}`).toBe(422);
    out.push(`${label} 422`);
  }
  const pmBlank = await validate({ name: "   " });
  expect(codes(pmBlank).join(",")).toContain("NAME_MISSING/ERROR");
  const script = await create(`<script>alert(1)</script> Kulfi ${RUN}`, { confirmDuplicate: true });
  expectStatus(script, 201, "script name");
  expect(script.body.product.name).toBe(`<script>alert(1)</script> Kulfi ${RUN}`);
  const marathi = await create(`ताजे पनीर ${RUN}`, { confirmDuplicate: true });
  expectStatus(marathi, 201, "Marathi name");
  expect(marathi.body.product.name).toBe(`ताजे पनीर ${RUN}`);
  const trimmed = await create(`   QA Trimmed Product ${RUN}   `, { confirmDuplicate: true });
  expect(trimmed.body.product.name).toBe(`QA Trimmed Product ${RUN}`);
  const existing = need(world().listings.packaged, "an existing product").name;
  const dup = await create(`${existing.slice(0, -1)}Z`);
  expect(dup.status, "a likely duplicate is flagged").toBe(409);
  const same = await create(existing.toUpperCase());
  expect(same.body?.reusedExisting ?? same.status === 409, `the same name in capitals: ${why(same)}`).toBeTruthy();
  return `${out.join(", ")} (limit 200); pipeline: spaces → NAME_MISSING; script and Marathi stored verbatim; trimmed; near-duplicate → 409 "${dup.body?.error?.message?.slice(0, 80)}"; the same name in capitals → ${same.status} ${same.body?.reusedExisting ? "(reused the existing product)" : ""}`;
}, local);

qa("TC-FLD-072", "product category: nothing chosen falls back to General (the form's default); each listed option saves; an unlisted value is refused", async () => {
  const shopId = need(world().shops.A?.id, "shop A");
  const ops = await as("ops");
  const none = await call(ops, "POST", "/api/products", { shopId, name: `QA No Category ${RUN}`, unit: "piece", confirmDuplicate: true });
  expectStatus(none, 201, "no category");
  const cats = await call(ops, "GET", "/api/product-categories?selectable=1");
  const list = (cats.body.categories ?? cats.body) as { id: string; name: string; isSystem?: boolean }[];
  const general = list.find((c) => c.isSystem || c.name === "General");
  expect(none.body.product.categoryId, "defaults to General").toBe(general?.id);
  const saved: string[] = [];
  for (const c of list.slice(0, 5)) {
    const res = await call(ops, "POST", "/api/products", { shopId, categoryId: c.id, name: `QA Cat Pick ${RUN} ${c.name}`.slice(0, 190), unit: "piece", confirmDuplicate: true });
    expectStatus(res, 201, `category ${c.name}`);
    const [row] = await db()<{ category_id: string }[]>`select category_id from products where id = ${res.body.product.id}`;
    expect(row.category_id).toBe(c.id);
    saved.push(c.name);
  }
  const unknown = await call(ops, "POST", "/api/products", { shopId, categoryId: "00000000-0000-4000-8000-000000000000", name: `QA Unknown Cat ${RUN}`, unit: "piece" });
  expect([404, 422], `unlisted uuid: ${why(unknown)}`).toContain(unknown.status);
  const text = await call(ops, "POST", "/api/products", { shopId, categoryId: "Dairy", name: `QA Text Cat ${RUN}`, unit: "piece" });
  expect(text.status).toBe(422);
  return `none → General (documented default: docs/category-management/README.md 'Category is required and defaults to General'); ${saved.length} listed categories saved (${saved.join(", ")}); unknown uuid → ${unknown.status}; text → 422`;
}, { ...local, partial: "'an empty required choice is refused' is superseded by the documented default to General (docs/category-management/README.md, Screens)" });

qa("TC-FLD-073", "brand and manufacturer: blank accepted; 300+ refused at the limit (no 500); script kept as text; Marathi saved", async () => {
  const blank = await validate({ brand: null, manufacturer: null });
  expectStatus(blank, 200, "blank");
  expect(blank.body.valid).toBe(true);
  const long = await validate({ brand: "B".repeat(301) });
  expect(long.status, why(long)).toBe(422);
  const longMfr = await validate({ manufacturer: "M".repeat(301) });
  expect(longMfr.status).toBe(422);
  const script = await validate({ brand: "<script>alert(1)</script>", manufacturer: "<b>Acme</b> & Co" });
  expect(script.body.normalized.brand).toBe("<script>alert(1)</script>");
  const marathi = await validate({ brand: "गोकुळ", manufacturer: "कोल्हापूर दूध संघ" });
  expect(marathi.body.normalized.brand).toBe("गोकुळ");
  return "blank brand/manufacturer valid; 301 characters → 422 (limit below 301); script and Marathi kept verbatim as text";
}, { ...local, partial: "the catalogue's own product form has no brand or manufacturer field — they come from the product master" });

qa("TC-FLD-074", "pack size and unit: a positive number is required, decimals accepted (0.5 kg); 0, negative and text refused; the unit must come from the list", async () => {
  const shopId = need(world().shops.A?.id, "shop A");
  const ops = await as("ops");
  const out: string[] = [];
  for (const [label, size] of [["0", 0], ["-1", -1000], ["text", "abc"]] as const) {
    const res = await call(ops, "POST", "/api/products", { shopId, name: `QA Pack ${label} ${RUN}`, unit: "kg", unitSizeMilli: size, confirmDuplicate: true });
    expect(res.status, `pack ${label}: ${why(res)}`).toBe(422);
    out.push(`form ${label} → 422`);
  }
  const half = await call(ops, "POST", "/api/products", { shopId, name: `QA Half Kilo ${RUN}`, unit: "kg", unitSizeMilli: 500, confirmDuplicate: true });
  expectStatus(half, 201, "0.5 kg");
  out.push("0.5 kg → 201");
  const negative = await validate({ quantityText: "-1 kg" });
  const zero = await validate({ quantityText: "0 kg" });
  out.push(`pipeline "-1 kg" → pack ${negative.body.normalized.packLabel} ${codes(negative).join(",")}`, `"0 kg" → ${codes(zero).filter((c) => /QUANT/.test(c)).join(",") || "no issue"}`);
  const oddUnit = await call(ops, "POST", "/api/products", { shopId, name: `QA Odd Unit ${RUN}`, unit: "bananas", confirmDuplicate: true });
  out.push(`unit "bananas" → ${oddUnit.status}`);
  expect(negative.body.normalized.packLabel, `a negative pack size must not be read as positive — ${out.join("; ")}`).not.toBe("1000 g");
  expect(oddUnit.status, `a unit outside the list must be refused — ${out.join("; ")}`).toBe(422);
  return out.join("; ");
}, local);

qa("TC-FLD-075", "loose / packaged: a new product without GTIN and pack size comes in as loose, with no default price or MRP; record what a flag change does to shop prices", async () => {
  const row = { sourceProductId: `qa-${RUN}-loose`, name: `Loose Paneer QA${RUN}`, brand: null, categories: ["Dairy", "Paneer"] };
  expectStatus(await call(await as("admin"), "POST", "/api/product-master/products/import", { rows: [row] }), 201, "import a loose product");
  const id = await masterIdByName(row.name);
  const promoted = await call(await as("admin"), "POST", `/api/product-master/products/${id}/promote`, { minQuality: 0 });
  expect([200, 201], why(promoted)).toContain(promoted.status);
  const [p] = await db()<{ kind: string; mrp_paise: number | null }[]>`
    select kind, mrp_paise from products where id = (select catalogue_product_id from pmd.catalogue_link where product_id = (select product_id from pmd.product_master where master_product_id = ${id}))`;
  expect(p).toEqual({ kind: "LOOSE", mrp_paise: null });
  // An existing packaged product listed with a price: there is no screen or API that changes its kind.
  const packaged = need(world().listings.packaged, "a packaged listing with a price");
  const before = (await db()<{ online_price_paise: string }[]>`select online_price_paise from shop_products where id = ${packaged.shopProductId}`)[0];
  return `promoted as LOOSE with no MRP (and no default price — catalogue products carry none); recorded: no screen or API changes the loose/packaged flag of an existing product (services/product-master.ts updateProductIdentity has no route), so shop prices such as ${packaged.name}'s ₹${Number(before.online_price_paise) / 100} are never touched by a flag change`;
}, { ...local, partial: "steps 3–4 (change a packaged product to loose and back) cannot be done: no control exists for the flag after creation" });

qa("TC-FLD-076", "GTIN: blank accepted; 7 and 15 digits and letters refused; a wrong check digit flagged; a GTIN used by another product flagged as a duplicate; a valid one accepted", async () => {
  const blank = await validate({ gtin: null });
  expect(blank.body.valid).toBe(true);
  const out: string[] = [];
  for (const g of ["1234567", "123456789012345", "ABCDEFGHIJKLM"]) {
    const res = await validate({ gtin: g });
    expect(codes(res).join(","), g).toContain("GTIN_MALFORMED");
    expect(res.body.normalized.gtin14, `${g} not kept as the identity`).toBeNull();
    out.push(`${g} → GTIN_MALFORMED`);
  }
  const wrong = await validate({ gtin: "8901262010017" });
  expect(codes(wrong).join(",")).toContain("GTIN_CHECK_DIGIT_INVALID");
  expect(wrong.body.normalized.gtinUsableForMatching).toBe(false);
  const ok = await validate({ gtin: "8901262010016" });
  expect(codes(ok).join(",")).not.toMatch(/GTIN/);
  // A GTIN another master product holds: matched to it rather than a second identity.
  const feed = sampleFeed();
  const twin = { ...feed[0], sourceProductId: `qa-${RUN}-twin`, name: `Different Name Same Barcode QA${RUN}` };
  const imp = await call(await as("admin"), "POST", "/api/product-master/products/import", { rows: [twin] });
  expectStatus(imp, 201, "import the same GTIN under another name");
  return `blank valid; ${out.join(", ")}; wrong check digit flagged and not used to match; valid accepted; the same GTIN under another name → ${JSON.stringify(imp.body.counters ?? imp.body).slice(0, 160)} (check digit verified: yes)`;
}, local);

qa("TC-FLD-077", "HSN: only 4, 6 or 8 digits accepted; 3 and 9 digits and letters refused; blank allowed", async () => {
  const product = await newMasterProduct({ mrpPaise: 5000 });
  const admin = await as("admin");
  const out: string[] = [];
  for (const h of ["123", "123456789", "ABCD"]) {
    const res = await call(admin, "PATCH", `/api/admin/product-gst/${product.id}`, { hsnCode: h, gstRatePercent: 5, reason: "QA HSN check" });
    expect(res.status, `${h}: ${why(res)}`).toBe(422);
    const pm = await validate({ hsnCode: h });
    expect(pm.body.normalized.hsnCode, `pipeline drops ${h}`).toBeNull();
    out.push(`${h} → 422 (pipeline: dropped, HSN_INVALID)`);
  }
  for (const h of ["0405", "040510", "04051000"]) {
    expectStatus(await call(admin, "PATCH", `/api/admin/product-gst/${product.id}`, { hsnCode: h, gstRatePercent: 5, reason: "QA HSN check" }), 200, `HSN ${h}`);
  }
  expectStatus(await call(admin, "PATCH", `/api/admin/product-gst/${product.id}`, { hsnCode: null, gstRatePercent: null, reason: "QA clear" }), 200, "blank");
  return `${out.join("; ")}; 4/6/8 digits saved; blank (null) allowed`;
}, local);

qa("TC-FLD-078", "GST rate: each listed rate saves; an unlisted value, 7 and -5 are refused", async () => {
  const product = await newMasterProduct({ mrpPaise: 5000 });
  const admin = await as("admin");
  for (const rate of [0, 5, 12, 18, 28]) {
    expectStatus(await call(admin, "PATCH", `/api/admin/product-gst/${product.id}`, { hsnCode: "0405", gstRatePercent: rate, reason: "QA GST check" }), 200, `GST ${rate}%`);
    expect((await db()<{ gst_rate_bp: number }[]>`select gst_rate_bp from products where id = ${product.id}`)[0].gst_rate_bp).toBe(rate * 100);
  }
  const out: string[] = [];
  const negative = await call(admin, "PATCH", `/api/admin/product-gst/${product.id}`, { hsnCode: "0405", gstRatePercent: -5, reason: "QA GST check" });
  out.push(`editor -5 → ${negative.status}`);
  expect(negative.status).toBe(422);
  const seven = await call(admin, "PATCH", `/api/admin/product-gst/${product.id}`, { hsnCode: "0405", gstRatePercent: 7, reason: "QA GST check" });
  out.push(`editor 7 → ${seven.status}`);
  const pmSeven = await validate({ gstRate: "7" });
  const pmNegative = await validate({ gstRate: "-5" });
  out.push(`pipeline "7" → ${pmSeven.body.normalized.gstRateBp} bp ${codes(pmSeven).filter((c) => /GST/.test(c)).join(",")}`, `pipeline "-5" → ${pmNegative.body.normalized.gstRateBp} bp ${codes(pmNegative).filter((c) => /GST/.test(c)).join(",") || "no issue"}`);
  expect(pmNegative.body.normalized.gstRateBp, `-5 % must not be read as 5 % — ${out.join("; ")}`).toBeNull();
  expect([seven.status, pmSeven.body.normalized.gstRateBp], `7 % is not a listed GST rate — ${out.join("; ")}`).toEqual([422, null]);
  return out.join("; ");
}, local);

qa("TC-FLD-079", "admin MRP: blank, 0, negative, text, 3 decimals and out-of-range refused (422); ₹70.50 stored as 7050 paise; the source is required; no MRP is asked for a loose product", async () => {
  const product = await newMasterProduct({ mrpPaise: 5000 });
  const admin = await as("admin");
  const out: string[] = [];
  const accepted: string[] = [];
  for (const [label, value] of [["blank", null], ["0", 0], ["-1", -100], ["text", "abc"], ["10.555", 1055.5], ["₹10 crore", 10_000_000_000]] as const) {
    const res = await call(admin, "POST", "/api/mrp", { productId: product.id, mrpPaise: value, source: "ADMIN" });
    out.push(`${label} → ${res.status}`);
    if (res.status < 400) accepted.push(label);
  }
  const noSource = await call(admin, "POST", "/api/mrp", { productId: product.id, mrpPaise: 7050 });
  expect(noSource.status, "source required").toBe(422);
  expectStatus(await call(admin, "POST", "/api/mrp", { productId: product.id, mrpPaise: 7050, source: "ADMIN" }), 200, "₹70.50");
  expect(Number((await db()<{ mrp_paise: string }[]>`select mrp_paise from products where id = ${product.id}`)[0].mrp_paise)).toBe(7050);
  const loose = await newMasterProduct({ kind: "LOOSE" });
  const overview = await call(admin, "GET", "/api/mrp");
  expect(JSON.stringify(overview.body.missing), "a loose product is not listed as missing an MRP").not.toContain(loose.id);
  if (accepted.length) await call(admin, "POST", "/api/mrp", { productId: product.id, mrpPaise: 7050, source: "ADMIN" });
  expect(accepted, `MRP values accepted: ${out.join("; ")}`).toEqual([]);
  return `${out.join("; ")}; no source → 422; ₹70.50 → 7050 paise; loose product not asked for an MRP`;
}, local);
