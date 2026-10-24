/**
 * The catalogue as shops and operations work it: master products and the
 * approval of shop-created ones, listing a product, prices and their rules
 * (channel prices, the owner's immediate change, the operator's proposal,
 * the MRP cap), the master MRP and its corrections, reference prices, the
 * Excel price list and its bad variants, stock and its alerts, photos and
 * their moderation, loose goods without a price, and the per-shop MRP cases
 * (NEW-010) as the build decided them.
 *
 * Local tier: it arranges master products in the database, reads price
 * history and audit rows, changes rules (restored) and the master MRP of
 * products it created. Owner-side work happens in a fresh owner's shop that
 * sells the world's QA catalogue (lib/sellers-helpers sellingShop), so the
 * world's shops keep their prices and stock.
 */
import type { APIRequestContext, Page } from "@playwright/test";

import { as, pageAs } from "../lib/actors";
import { db } from "../lib/db";
import { addToCart, cartLines, deliver, emptyCart, onlyRiderOnline, packOrder, placeOrder } from "../lib/flows";
import { anonymous, call, expectStatus, RUN, stash, unstash, why } from "../lib/http";
import { blocked, expect, need, qa } from "../lib/record";
import { world } from "../lib/world";
import {
  auditRows,
  ctxFor,
  DISGUISED,
  download,
  filePart,
  image,
  inventory,
  listingRow,
  newMasterProduct,
  noisePng,
  notificationsOf,
  ownerListings,
  pageFor,
  priceHistory,
  readXlsx,
  sellingShop,
  storefront,
  withRule,
  xlsx,
  type Account,
  RUN_KEY,
} from "../lib/sellers-helpers";

const local = { tier: "local" as const, timeout: 240_000 };
const KEY = `catalogue-${RUN_KEY}`;

interface Shop {
  shopId: string;
  shopName: string;
  slug: string;
  owner: Account;
}

/** One fresh selling shop for the whole file, made on first use and handed on through the stash. */
async function shop(): Promise<Shop & { ctx: APIRequestContext }> {
  const kept = unstash<Shop>(KEY);
  if (kept) return { ...kept, ctx: await ctxFor(kept.owner) };
  const made = await sellingShop("catalogue");
  const [row] = await db()<{ slug: string }[]>`select slug from shops where id = ${made.shop.id}`;
  const value = { shopId: made.shop.id, shopName: made.shop.name, slug: row.slug, owner: made.owner };
  stash(KEY, value);
  return { ...value, ctx: made.ctx };
}

/** A new master product listed by the shop at `pricePaise` (stock 20). */
async function listed(s: Shop & { ctx: APIRequestContext }, opts: { kind?: "PACKAGED" | "LOOSE"; mrpPaise?: number | null; pricePaise?: number | null; stock?: number } = {}) {
  const product = await newMasterProduct({ kind: opts.kind, mrpPaise: opts.mrpPaise });
  const price = opts.pricePaise === undefined ? 4500 : opts.pricePaise;
  const res = await call(s.ctx, "POST", `/api/shops/${s.shopId}/products`, {
    productId: product.id,
    onlineSaleEnabled: price != null,
    onlinePricePaise: price,
    offlineSaleEnabled: price != null,
    offlinePricePaise: price,
    trackInventory: true,
    onlineStock: opts.stock ?? 20,
  });
  expectStatus(res, 201, "list the product");
  return { product, listingId: res.body.id as string };
}

const num = (v: unknown) => (v == null ? null : Number(v));

async function ownerPricesOnPage(page: Page, productName: string, rupees: string) {
  await page.goto("/shop/inventory");
  await page.getByLabel(`Price of ${productName}`).fill(rupees);
  await page.getByRole("button", { name: "Save prices" }).click();
}

/* ------------------------------------------------------ master products */

qa("TC-CAT-001", "an operator creates a master product (name, category, pack size) and edits its HSN and GST rate: saved with a system product code, found in catalogue search", async () => {
  const s = await shop();
  const category = need((world() as unknown as { category?: { id: string } }).category, "the QA category");
  const name = `QA Operator Product ${RUN}`;
  const created = await call(await as("ops"), "POST", "/api/products", { shopId: s.shopId, categoryId: category.id, name, unit: "g", unitSizeMilli: 500_000, confirmDuplicate: true });
  expectStatus(created, 201, "operator creates a product");
  const product = created.body.product as { id: string; code: string; approvalStatus: string };
  expect(product.code, "system product code").toMatch(/^P\d{5,}$/);
  expect(product.approvalStatus, "staff-created products are published").toBe("APPROVED");
  const gst = await call(await as("admin"), "PATCH", `/api/admin/product-gst/${product.id}`, { hsnCode: "0405", gstRatePercent: 12, reason: "QA: HSN for butter" });
  expectStatus(gst, 200, "edit HSN and GST");
  const [row] = await db()<{ hsn_code: string; gst_rate_bp: number; unit_size_milli: number }[]>`select hsn_code, gst_rate_bp, unit_size_milli from products where id = ${product.id}`;
  expect(row).toMatchObject({ hsn_code: "0405", gst_rate_bp: 1200, unit_size_milli: 500_000 });
  const search = await call(await as("ops"), "GET", `/api/product-categories/products?q=${encodeURIComponent(name)}`);
  expectStatus(search, 200, "catalogue search");
  expect(JSON.stringify(search.body)).toContain(product.code);
  return `${product.code} "${name}" APPROVED, 500 g; HSN 0405 / GST 12% saved; found by catalogue search`;
}, { ...local, partial: "brand and GTIN are not fields of the catalogue product form — they arrive through the product master (TC-PMD-002/005, TC-FLD-073/076)" });

qa("TC-CAT-002", "a shop-created product: a duplicate suggestion is offered; until approved only the creating shop sees it; operations approve one and reject another", async () => {
  const s = await shop();
  const category = need((world() as unknown as { category?: { id: string } }).category, "the QA category");
  const butter = need(world().listings.packaged, "the world's butter").name;
  const similar = await call(s.ctx, "POST", "/api/products", { shopId: s.shopId, categoryId: category.id, name: `${butter.slice(0, -1)}X`, unit: "piece" });
  expect(similar.status, `a near-duplicate name: ${why(similar)}`).toBe(409);
  expect(similar.body?.error?.message).toMatch(/looks similar to an existing product/);
  const mine = await call(s.ctx, "POST", "/api/products", { shopId: s.shopId, categoryId: category.id, name: `QA Owner Made ${RUN}`, unit: "piece", onlineSaleEnabled: true, onlinePricePaise: 3000, confirmDuplicate: true });
  expectStatus(mine, 201, "create a new product");
  expect(mine.body.product.approvalStatus).toBe("PENDING_APPROVAL");
  const other = world().shops.B?.id ?? blocked("needs shop B");
  const seenByB = async () => JSON.stringify((await call(await as("shopB"), "GET", `/api/shops/${other}/catalogue-search?q=${encodeURIComponent(`QA Owner Made ${RUN}`)}`)).body);
  expect(await seenByB(), "another shop cannot see it while pending").not.toContain(mine.body.product.id);
  const queue = await call(await as("admin"), "GET", "/api/products/pending-approval");
  expect(JSON.stringify(queue.body)).toContain(mine.body.product.id);
  expectStatus(await call(await as("admin"), "POST", `/api/products/${mine.body.product.id}/approval`, { decision: "APPROVED" }), 200, "approve");
  expect(await seenByB(), "visible to other shops once approved").toContain(mine.body.product.id);
  const second = await call(s.ctx, "POST", "/api/products", { shopId: s.shopId, categoryId: category.id, name: `QA Owner Rejected ${RUN}`, unit: "piece", confirmDuplicate: true });
  expectStatus(second, 201, "a second product");
  const noReason = await call(await as("admin"), "POST", `/api/products/${second.body.product.id}/approval`, { decision: "REJECTED" });
  expect(noReason.status, "rejecting needs a reason").toBe(422);
  expectStatus(await call(await as("admin"), "POST", `/api/products/${second.body.product.id}/approval`, { decision: "REJECTED", reason: "QA: duplicate of an existing product" }), 200, "reject");
  const [rej] = await db()<{ approval_status: string; rejection_reason: string }[]>`select approval_status, rejection_reason from products where id = ${second.body.product.id}`;
  expect(rej.approval_status).toBe("REJECTED");
  return `near-duplicate → 409 suggestion; own product PENDING_APPROVAL, hidden from shop B until approved, then visible; another rejected with a reason (none → 422)`;
}, local);

qa("TC-CAT-003", "the owner adds a master product from the catalogue on /shop/manage/products with a price: the listing is created and shows on the shop page", async ({ browser }) => {
  const s = await shop();
  const product = await newMasterProduct({ mrpPaise: 9000 });
  const { context, page } = await pageFor(browser, s.owner);
  try {
    await page.goto("/shop/manage/products");
    const tab = page.getByRole("tab", { name: /add/i });
    if (await tab.count()) await tab.first().click();
    const price = page.getByLabel(`Price for ${product.name}`);
    await expect(price).toBeVisible();
    await price.fill("85");
    await price.locator("xpath=ancestor::div[contains(@class,'p-3')][1]").getByRole("button", { name: "Add" }).click();
    await expect.poll(async () => (await ownerListings(s.ctx, s.shopId)).some((l) => l.productId === product.id), { timeout: 20_000 }).toBe(true);
  } finally {
    await context.close();
  }
  const row = (await ownerListings(s.ctx, s.shopId)).find((l) => l.productId === product.id)!;
  expect(row.onlinePricePaise).toBe(8500);
  expect(row.offlinePricePaise, "the in-shop price is set too").toBe(8500);
  expect(row.onlineStock, "stock entered with the add").toBe(100);
  const guest = await anonymous();
  const front = await storefront(guest, s.shopId);
  await guest.dispose();
  expect(front.rows.some((r) => r.productId === product.id && r.onlinePricePaise === 8500), "on the shop's storefront").toBe(true);
  return `${product.code} added at ₹85 online and in shop, stock 100; on the shop's storefront`;
}, { ...local, partial: "the add row takes one price for both channels and a fixed opening stock of 100 — separate offline price and stock are edited afterwards (TC-CAT-017)" });

/* --------------------------------------------------------------- prices */

qa("TC-CAT-004", "a channel needs its price: online on without a price, negative and zero prices are refused; an empty price is accepted only while online sale is off, and switching it on then asks for a price", async () => {
  const s = await shop();
  const { listingId } = await listed(s, { kind: "LOOSE", pricePaise: null });
  const patch = (body: Record<string, unknown>) => call(s.ctx, "PATCH", `/api/shop-products/${listingId}`, body);
  const results: string[] = [];
  const noPrice = await patch({ onlineSaleEnabled: true });
  expect(noPrice.status, why(noPrice)).toBe(422);
  results.push(`online on, no price → ${noPrice.status}`);
  const negative = await patch({ onlineSaleEnabled: true, onlinePricePaise: -500 });
  expect(negative.status).toBe(422);
  results.push(`-₹5 → ${negative.status}`);
  const empty = await patch({ onlineSaleEnabled: false, onlinePricePaise: null, description: "QA empty price" });
  expect(empty.status, why(empty)).toBe(200);
  results.push(`empty with online off → ${empty.status}`);
  const zero = await patch({ onlineSaleEnabled: true, onlinePricePaise: 0 });
  results.push(`₹0 → ${zero.status}`);
  const row = await listingRow(listingId);
  if (zero.status === 200) await patch({ onlineSaleEnabled: false, onlinePricePaise: null });
  expect(zero.status, `a zero price must be refused — ${results.join("; ")}; stored ${row.online_price_paise}, on sale ${row.online_sale_enabled}`).toBe(422);
  return results.join("; ");
}, { ...local, partial: "the owner's forms check the same rules (Save is refused below ₹0.01 on /shop/inventory — TC-CAT-032)" });

qa("TC-CAT-005", "the owner's price change on /shop/inventory is live at once, with a price-history row and an audit entry", async ({ browser }) => {
  const s = await shop();
  const { product, listingId } = await listed(s, { mrpPaise: 9000, pricePaise: 6000 });
  const { context, page } = await pageFor(browser, s.owner);
  try {
    await ownerPricesOnPage(page, product.name, "72.50");
    await expect(page.getByText("Saved 1 price.")).toBeVisible();
  } finally {
    await context.close();
  }
  const live = (await storefront(await as("customer"), s.shopId)).rows.find((r) => r.shopProductId === listingId);
  expect(live?.onlinePricePaise, "live price").toBe(7250);
  const history = await priceHistory(listingId);
  expect(history.some((h) => h.price_type === "ONLINE" && num(h.previous_price_paise) === 6000 && num(h.new_price_paise) === 7250 && h.changed_by === s.owner.id)).toBe(true);
  const audits = await auditRows(listingId, "%price%");
  expect(audits.length, "audit entry").toBeGreaterThan(0);
  return `₹60 → ₹72.50: "Saved 1 price."; storefront shows 7250 paise; history ONLINE 6000→7250 by the owner; audit "${audits[0].action}"`;
}, local);

qa("TC-CAT-006", "an operator's price change returns 202 pending and the live price stays until the owner approves; a rejected one leaves it; an admin override applies; all audited", async () => {
  const s = await shop();
  const { listingId } = await listed(s, { mrpPaise: 9000, pricePaise: 5000 });
  const live = async () => num((await listingRow(listingId)).online_price_paise);
  const propose = async (paise: number) => {
    const res = await call(await as("ops"), "PATCH", `/api/shop-products/${listingId}`, { onlinePricePaise: paise });
    expect(res.status, why(res)).toBe(202);
    expect(res.body.pendingApproval).toBe(true);
    return res.body.requestIds[0] as string;
  };
  const r1 = await propose(5500);
  expect(await live(), "unchanged while pending").toBe(5000);
  expectStatus(await call(s.ctx, "POST", "/api/price-requests/decide", { requestIds: [r1], decision: "APPROVED" }), 200, "owner approves");
  expect(await live()).toBe(5500);
  const r2 = await propose(6000);
  expectStatus(await call(s.ctx, "POST", "/api/price-requests/decide", { requestIds: [r2], decision: "REJECTED", rejectionReason: "QA too high" }), 200, "owner rejects");
  expect(await live(), "rejected: unchanged").toBe(5500);
  const r3 = await propose(5900);
  const opsOverride = await call(await as("ops"), "POST", `/api/price-requests/${r3}/override`, { reason: "QA" });
  expect(opsOverride.status, "an operator cannot override").toBe(403);
  expectStatus(await call(await as("admin"), "POST", `/api/price-requests/${r3}/override`, { reason: "QA admin override" }), 200, "admin override");
  expect(await live()).toBe(5900);
  const audits = await db()<{ action: string }[]>`select action from audit_logs where entity_id in (${listingId}, ${r1}, ${r2}, ${r3}) or new_value::text like ${`%${r3}%`}`;
  const actions = [...new Set(audits.map((a) => a.action))];
  expect(actions.length, `audited: ${actions.join(", ")}`).toBeGreaterThanOrEqual(2);
  return `operator ₹55 → 202, live ₹50 until the owner approved; ₹60 rejected → stays ₹55; ₹59 admin override → live (operator override 403); audit actions ${actions.join(", ")}`;
}, local);

qa(["TC-CAT-007", "TC-CAT-063"], "a selling price above a verified MRP (₹50) is refused on the form, the API and Excel; ₹50 and ₹49 are accepted; a loose product has no MRP check", async ({ browser }) => {
  const s = await shop();
  const { product, listingId } = await listed(s, { mrpPaise: 5000, pricePaise: 4500 });
  const api1 = await call(s.ctx, "PATCH", `/api/shops/${s.shopId}/prices`, { prices: [{ shopProductId: listingId, pricePaise: 5100 }] });
  expect(api1.status, why(api1)).toBe(422);
  expect(api1.body?.error?.message).toMatch(/above the MRP/);
  const api2 = await call(s.ctx, "PATCH", `/api/shop-products/${listingId}`, { onlinePricePaise: 5100 });
  expect(api2.status).toBe(422);
  const { context, page } = await pageFor(browser, s.owner);
  try {
    await ownerPricesOnPage(page, product.name, "51");
    await expect(page.getByText(/above the MRP/)).toBeVisible();
  } finally {
    await context.close();
  }
  const sheet = await xlsx([["Product ID", "Price"], [product.code, 51]], `mrp-over-${RUN}.xlsx`);
  const upload = await call(s.ctx, "POST", "/api/excel-uploads", undefined, { multipart: { shopId: s.shopId, file: filePart("over-mrp.xlsx", sheet, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") } });
  expectStatus(upload, 201, "upload");
  const apply = await call(s.ctx, "POST", `/api/excel-uploads/${upload.body.uploadId}/apply`);
  const excelRefused = apply.status >= 400 || (await listingRow(listingId)).online_price_paise !== "5100";
  expect(excelRefused, `Excel ₹51: apply ${apply.status} ${why(apply)}`).toBe(true);
  expect(num((await listingRow(listingId)).online_price_paise)).toBe(4500);
  for (const ok of [5000, 4900]) {
    expectStatus(await call(s.ctx, "PATCH", `/api/shops/${s.shopId}/prices`, { prices: [{ shopProductId: listingId, pricePaise: ok }] }), 200, `price ${ok}`);
  }
  const loose = await listed(s, { kind: "LOOSE", pricePaise: 4000 });
  expectStatus(await call(s.ctx, "PATCH", `/api/shops/${s.shopId}/prices`, { prices: [{ shopProductId: loose.listingId, pricePaise: 999_900 }] }), 200, "a loose price has no MRP cap");
  return `₹51 → refused on /shop/inventory ("above the MRP"), PATCH prices 422, PATCH listing 422, Excel apply ${apply.status}; ₹50 and ₹49 saved; loose ₹9,999 accepted`;
}, { ...local, partial: "TC-CAT-063 (check against the shop's own MRP) is superseded: no shop-level MRP exists — docs/three-modules-2026-10/PLAN.md §1.2 'MRP is master-only'; the check uses the master MRP as asserted here" });

qa("TC-CAT-008", "the product card shows the MRP struck through, the price and the discount (MRP 60, price 58 → 3%); none when price = MRP; never negative", async ({ page }) => {
  const listing = need(world().listings.packaged, "the packaged listing (MRP ₹60, price ₹58)");
  const shopA = need(world().shops.A, "shop A");
  await page.goto(`/shops/${shopA.slug}`);
  const card = page.locator(`[data-product-name="${listing.name}"]`).first();
  await expect(card).toBeVisible();
  const text = (await card.innerText()).replace(/\s+/g, " ");
  const struck = await card.locator(".line-through").allInnerTexts();
  expect(text).toContain("58");
  expect({ struck, discount: /\d+\s*%\s*off/i.test(text) }, `card text: "${text.slice(0, 200)}"`).toEqual({ struck: [expect.stringContaining("60")], discount: true });
  return `card: ${text.slice(0, 120)}`;
}, { tier: "local", partial: "MRP of the shop being viewed (NEW-010) is superseded: one master MRP (docs/three-modules-2026-10/PLAN.md §1.2)" });

/* ------------------------------------------------------------------ MRP */

qa("TC-CAT-009", "an admin sets an MRP with its source on /admin/mrp: saved with verification, history and audit; a shop owner gets 403 from the master MRP API", async () => {
  const product = await newMasterProduct({ mrpPaise: null });
  const res = await call(await as("admin"), "POST", "/api/mrp", { productId: product.code, mrpPaise: 6500, source: "BRAND", reason: "QA: printed on pack" });
  expectStatus(res, 200, "set MRP");
  expect(res.body).toMatchObject({ mrpPaise: 6500 });
  const [row] = await db()<{ mrp_paise: number; mrp_source: string; mrp_verification_status: string }[]>`select mrp_paise, mrp_source, mrp_verification_status from products where id = ${product.id}`;
  expect(row.mrp_source).toBe("BRAND");
  const owner = await call(await as("shop"), "POST", "/api/mrp", { productId: product.code, mrpPaise: 1, source: "ADMIN" });
  expect(owner.status, why(owner)).toBe(403);
  const ownerRead = await call(await as("shop"), "GET", "/api/mrp");
  expect(ownerRead.status).toBe(403);
  const audits = await auditRows(product.id, "%mrp%");
  const history = await db()<{ n: number }[]>`select count(*)::int as n from product_mrp_history where product_id = ${product.id}`.catch(() => [{ n: -1 }]);
  expect(audits.length, "audited").toBeGreaterThan(0);
  return `MRP ₹65 source BRAND, verification ${row.mrp_verification_status}; audit "${audits[0].action}"; history rows ${history[0].n}; owner POST/GET → 403`;
}, { ...local, partial: "the /admin/mrp form itself is not driven; the owner changes a price for the own shop on the shop screens (TC-CAT-057)" });

qa("TC-CAT-010", "lowering the master MRP below a shop's price: the shop is notified, its price is unchanged, and it is listed under 'Shop prices above the MRP'", async () => {
  const s = await shop();
  const since = new Date();
  const { product, listingId } = await listed(s, { mrpPaise: 6000, pricePaise: 5800 });
  const res = await call(await as("admin"), "POST", "/api/mrp", { productId: product.id, mrpPaise: 5000, source: "ADMIN", reason: "QA lower" });
  expectStatus(res, 200, "lower MRP");
  expect(res.body.conflicts).toBe(1);
  expect(num((await listingRow(listingId)).online_price_paise), "price unchanged").toBe(5800);
  const notes = await notificationsOf(s.owner.id, since);
  expect(notes.some((n) => /above the new MRP/.test(n.title)), JSON.stringify(notes)).toBe(true);
  const overview = await call(await as("admin"), "GET", "/api/mrp");
  expect(JSON.stringify(overview.body.violations)).toContain(listingId);
  return `MRP ₹60 → ₹50 under a ₹58 price: 1 conflict, price kept, owner told "${notes[0]?.title}", listed in violations`;
}, { ...local, partial: "'a shop-specific MRP is not overwritten' (TC-CAT-060) is superseded: no shop-level MRP exists (docs/three-modules-2026-10/PLAN.md §1.2)" });

qa("TC-CAT-011", "an MRP correction claim by a shop: the MRP is unchanged until decided; accept updates it, reject leaves it", async () => {
  const s = await shop();
  const a = await listed(s, { mrpPaise: 5000, pricePaise: 4500 });
  const b = await listed(s, { mrpPaise: 5000, pricePaise: 4500 });
  const claim = async (productId: string, paise: number) => {
    const res = await call(s.ctx, "POST", "/api/mrp/corrections", { productId, shopId: s.shopId, claimedMrpPaise: paise, note: "QA: pack says otherwise" });
    expectStatus(res, 201, "raise a claim");
    return res.body.id as string;
  };
  const mrp = async (id: string) => {
    const [row] = await db()<{ mrp_paise: string; mrp_verification_status: string }[]>`select mrp_paise, mrp_verification_status from products where id = ${id}`;
    return { mrp_paise: Number(row.mrp_paise), mrp_verification_status: row.mrp_verification_status };
  };
  const c1 = await claim(a.product.id, 5500);
  const c2 = await claim(b.product.id, 5600);
  expect((await mrp(a.product.id)).mrp_paise, "unchanged until decided").toBe(5000);
  const statusWhilePending = (await mrp(b.product.id)).mrp_verification_status;
  expectStatus(await call(await as("ops"), "PATCH", `/api/mrp/corrections/${c1}`, { decision: "ACCEPT", note: "QA checked the pack" }), 200, "accept");
  expect((await mrp(a.product.id)).mrp_paise).toBe(5500);
  expectStatus(await call(await as("ops"), "PATCH", `/api/mrp/corrections/${c2}`, { decision: "REJECT", note: "QA pack shows 50" }), 200, "reject");
  const after = await mrp(b.product.id);
  expect(after.mrp_paise).toBe(5000);
  expect(after.mrp_verification_status, "status restored").toBe("VERIFIED");
  return `claims raised; MRP unchanged (B status while pending ${statusWhilePending}); accept → ₹55; reject → ₹50 and ${after.mrp_verification_status}`;
}, local);

qa(["TC-CAT-012", "TC-FLD-081"], "external reference prices: record (code, price, source, URL, location, date), verify, reject with a note, reopen — with history and no change to any shop price or MRP; each bad field refused", async () => {
  const listing = need(world().listings.packaged, "the packaged listing");
  const ops = await as("ops");
  const before = { mrp: (await db()<{ mrp_paise: number }[]>`select mrp_paise from products where id = ${listing.productId}`)[0].mrp_paise, price: num((await listingRow(listing.shopProductId)).online_price_paise) };
  const [code] = await db()<{ code: string }[]>`select code from products where id = ${listing.productId}`;
  const base = { productId: code.code, pricePaise: 5500, sourceType: "MARKET_SURVEY", sourceName: "QA Mandi survey", referenceUrl: "https://example.com/qa", marketLocation: "Kothrud market", pincode: "411038", referencedAt: new Date(Date.now() - 86_400_000).toISOString() };
  const bad: [string, Record<string, unknown>][] = [
    ["no product", { productId: "" }],
    ["no price", { pricePaise: undefined }],
    ["no source", { sourceName: "" }],
    ["no date", { referencedAt: undefined }],
    ["unknown code", { productId: "P99999999" }],
    ["price 0", { pricePaise: 0 }],
    ["negative", { pricePaise: -100 }],
    ["text price", { pricePaise: "abc" }],
    ["URL without scheme", { referenceUrl: "example.com/page" }],
    ["javascript: URL", { referenceUrl: "javascript:alert(1)" }],
    ["future date", { referencedAt: new Date(Date.now() + 7 * 86_400_000).toISOString() }],
  ];
  const outcomes: string[] = [];
  const accepted: string[] = [];
  for (const [label, patch] of bad) {
    const res = await call(ops, "POST", "/api/admin/price-references", { ...base, ...patch });
    outcomes.push(`${label} → ${res.status}`);
    if (res.status < 400) accepted.push(label);
    if (res.status === 422 && ["no product", "no price", "no source", "no date"].includes(label)) {
      expect(JSON.stringify(res.body?.error ?? {}), `${label}: the message names the field`).toMatch(/product|price|source|date|referenced/i);
    }
  }
  const created = await call(ops, "POST", "/api/admin/price-references", base);
  expectStatus(created, 201, "record a reference");
  const id = created.body.id as string;
  expectStatus(await call(ops, "PATCH", `/api/admin/price-references/${id}`, { action: "verify" }), 200, "verify");
  const second = await call(ops, "POST", "/api/admin/price-references", { ...base, pricePaise: 5600 });
  const noNote = await call(ops, "PATCH", `/api/admin/price-references/${second.body.id}`, { action: "reject" });
  expect(noNote.status, "reject needs a note").toBe(422);
  expectStatus(await call(ops, "PATCH", `/api/admin/price-references/${second.body.id}`, { action: "reject", note: "QA: wrong pack" }), 200, "reject");
  expectStatus(await call(ops, "PATCH", `/api/admin/price-references/${second.body.id}`, { action: "reopen" }), 200, "reopen");
  const history = await call(ops, "GET", `/api/admin/price-references/${second.body.id}`);
  expect((history.body.history as unknown[]).length, "history kept").toBeGreaterThanOrEqual(3);
  const after = { mrp: (await db()<{ mrp_paise: number }[]>`select mrp_paise from products where id = ${listing.productId}`)[0].mrp_paise, price: num((await listingRow(listing.shopProductId)).online_price_paise) };
  expect(after, "no MRP or price changed").toEqual(before);
  expect(accepted, `bad reference fields accepted: ${outcomes.join("; ")}`).toEqual([]);
  return `${outcomes.join("; ")}; recorded → verified; another rejected (note required) → reopened, ${(history.body.history as unknown[]).length} history rows; MRP and price unchanged`;
}, local);

/* -------------------------------------------------------------- Excel */

qa("TC-CAT-013", "Excel price list by the owner: download the template, edit, upload, the preview shows old vs new with counts, apply updates prices together with history and audit", async ({ browser }) => {
  const s = await shop();
  const a = await listed(s, { mrpPaise: 9000, pricePaise: 5000 });
  const b = await listed(s, { mrpPaise: 9000, pricePaise: 6000 });
  const template = await download(s.ctx, `/api/shops/${s.shopId}/price-template`);
  expect(template.status).toBe(200);
  expect(template.type).toMatch(/spreadsheetml/);
  const rows = await readXlsx(template.body);
  expect(rows[0]).toEqual(["Product ID", "Product Name", "Unit", "Price"]);
  const edited = rows.map((r, i) => (i === 0 ? r : r[0] === a.product.code ? [r[0], r[1], r[2], 55] : r[0] === b.product.code ? [r[0], r[1], r[2], 65.5] : [r[0], r[1], r[2], r[3] === "" ? null : Number(r[3])]));
  const file = await xlsx(edited as (string | number | null)[][], `prices-edited-${RUN}.xlsx`);
  const { context, page } = await pageFor(browser, s.owner);
  try {
    await page.goto("/shop/prices");
    const section = page.locator("section.space-y-3", { has: page.getByRole("heading", { name: "Upload price list (Excel)" }) });
    await section.locator('input[type="file"]').setInputFiles({ name: "prices.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: file });
    await expect(section.getByText("2 to update")).toBeVisible({ timeout: 30_000 });
    await expect(section).toContainText(a.product.name);
    await expect(section).toContainText("55");
    await section.getByRole("button", { name: /Apply 2 change/ }).click();
    await expect(page.getByText(/Done/).first()).toBeVisible({ timeout: 30_000 });
  } finally {
    await context.close();
  }
  expect(num((await listingRow(a.listingId)).online_price_paise)).toBe(5500);
  expect(num((await listingRow(b.listingId)).online_price_paise)).toBe(6550);
  expect((await priceHistory(a.listingId)).some((h) => num(h.new_price_paise) === 5500)).toBe(true);
  const audits = await db()<{ action: string }[]>`select action from audit_logs where entity_type = 'excel_upload' and actor_id = ${s.owner.id} order by created_at desc limit 5`;
  expect(audits.map((x) => x.action).join(",")).toMatch(/excel/i);
  const looseRows = rows.filter((r) => /Loose/i.test(r[1] ?? ""));
  expect(looseRows.every((r) => r[3] === ""), `loose rows blank in the template: ${JSON.stringify(looseRows)}`).toBe(true);
  return `template ${rows.length - 1} rows (loose rows blank); preview "2 to update" with old/new; Apply → ₹55 and ₹65.50 live, price history + "${audits.map((x) => x.action)[0]}"`;
}, local);

qa("TC-CAT-014", "Excel validation: a non-Excel file, an oversized file and missing columns are refused; negative and text prices, duplicate rows and an unknown code are reported row by row; formula-like cells are neutralised; nothing is applied", async () => {
  const s = await shop();
  const a = await listed(s, { mrpPaise: 9000, pricePaise: 5000 });
  const b = await listed(s, { mrpPaise: 9000, pricePaise: 5000 });
  const c = await listed(s, { mrpPaise: 9000, pricePaise: 5000 });
  const up = (data: Buffer, name: string) => call(s.ctx, "POST", "/api/excel-uploads", undefined, { multipart: { shopId: s.shopId, file: filePart(name, data, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") } });
  const fake = await up(DISGUISED.html(), "fake.xlsx");
  expect(fake.status, why(fake)).toBe(422);
  const big = await up(Buffer.concat([await xlsx([["Product ID", "Price"]]), Buffer.alloc(2_200_000, 0x41)]), "big.xlsx");
  expect(big.status, why(big)).toBe(422);
  const noPrice = await up(await xlsx([["Product ID", "Name"], [a.product.code, "x"]], "no-price-col.xlsx"), "missing.xlsx");
  expect(noPrice.status).toBe(422);
  const sheet = await xlsx(
    [
      ["Product ID", "Product Name", "Price"],
      [a.product.code, "negative", -5],
      [b.product.code, "text", "abc"],
      [c.product.code, "=HYPERLINK(\"http://evil\")", 52],
      [c.product.code, "dup", 53],
      ["P99999999", "unknown", 50],
      ["+cmd|' /C calc'!A0", "plus", 50],
    ],
    `bad-rows-${RUN}.xlsx`,
  );
  const res = await up(sheet, "bad.xlsx");
  expectStatus(res, 201, "validate");
  const status = (res.body.rows as { rowNumber: number; status: string; productName: string; raw: Record<string, string> }[]).map((r) => ({ row: r.rowNumber, status: r.status, name: r.productName, raw: r.raw }));
  const by = (n: number) => status.find((r) => r.row === n);
  expect(by(2)?.status, "negative").toBe("INVALID_PRICE");
  expect(by(3)?.status, "text").toBe("INVALID_PRICE");
  expect(by(5)?.status, "duplicate").toBe("DUPLICATE");
  expect(by(6)?.status, "unknown code").toBe("NOT_FOUND");
  expect(by(4)?.name.startsWith("'="), `formula neutralised: ${by(4)?.name}`).toBe(true);
  expect(by(7)?.raw.productCode?.startsWith("'+"), "a + cell is neutralised").toBe(true);
  // Apply only what is valid — nothing of the bad rows.
  const apply = await call(s.ctx, "DELETE", `/api/excel-uploads/${res.body.uploadId}/apply`);
  expectStatus(apply, 200, "discard");
  for (const l of [a, b]) expect(num((await listingRow(l.listingId)).online_price_paise)).toBe(5000);
  return `fake .xlsx → 422 "${fake.body?.error?.message}"; 2.2 MB → 422; no Price column → 422; rows: ${status.map((r) => `${r.row}:${r.status}`).join(", ")}; '=' and '+' cells stored with a leading quote; discarded, nothing applied`;
}, local);

qa("TC-CAT-015", "an operator's Excel upload for a shop queues the changes for the owner's approval instead of applying them", async () => {
  const s = await shop();
  const a = await listed(s, { mrpPaise: 9000, pricePaise: 5000 });
  const sheet = await xlsx([["Product ID", "Price"], [a.product.code, 61]], `ops-prices-${RUN}.xlsx`);
  const res = await call(await as("ops"), "POST", "/api/excel-uploads", undefined, { multipart: { shopId: s.shopId, file: filePart("ops.xlsx", sheet, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") } });
  expectStatus(res, 201, "operator uploads");
  const apply = await call(await as("ops"), "POST", `/api/excel-uploads/${res.body.uploadId}/apply`);
  expectStatus(apply, 200, "apply");
  expect(apply.body).toMatchObject({ applied: 0, pending: 1, wentLive: false });
  expect(num((await listingRow(a.listingId)).online_price_paise), "live price unchanged").toBe(5000);
  const pending = await call(s.ctx, "GET", `/api/price-requests?shopId=${s.shopId}`);
  expect(JSON.stringify(pending.body)).toContain(a.listingId);
  return `operator sheet ₹61 → pending 1 for the owner, live price ₹50 unchanged`;
}, local);

/* ---------------------------------------------------------------- stock */

qa("TC-CAT-017", "updating stock on the owner's product screen saves, writes an inventory movement, and the storefront follows (0 → not available)", async ({ browser }) => {
  const s = await shop();
  const { product, listingId } = await listed(s, { mrpPaise: 9000, pricePaise: 5000, stock: 20 });
  const { context, page } = await pageFor(browser, s.owner);
  try {
    await page.goto("/shop/manage/products");
    await page.getByLabel("Find a product").fill(product.name);
    const card = page.locator("div.p-4").filter({ hasText: product.name }).filter({ has: page.getByRole("button", { name: /^(Edit|Close)$/ }) }).first();
    await card.getByRole("button", { name: "Edit" }).click();
    await card.getByLabel("Online stock").fill("0");
    await card.getByRole("button", { name: "Save changes" }).click();
    await expect.poll(async () => (await listingRow(listingId)).online_stock, { timeout: 20_000 }).toBe(0);
  } finally {
    await context.close();
  }
  const moves = await db()<{ delta_units: number; reason: string }[]>`select delta_units, reason from inventory_movements where shop_product_id = ${listingId} order by created_at desc limit 1`;
  expect(moves[0]).toMatchObject({ delta_units: -20 });
  const add = await addToCart("customer", listingId, 1);
  expect(add.status, `out of stock: ${why(add)}`).toBeGreaterThanOrEqual(400);
  return `stock 20 → 0 on the screen; movement ${moves[0].delta_units} "${moves[0].reason}"; add to cart → ${add.status}`;
}, { ...local, partial: "listings created at stock 100 by a category add are corrected the same way in TC-CAT-052" });

qa("TC-CAT-018", "an order of 2 units from stock 5 leaves 3 available; on-hand = available + reserved; stock never goes negative", async () => {
  const s = await shop();
  const { listingId, product } = await listed(s, { mrpPaise: 9000, pricePaise: 3000, stock: 5 });
  const order = await placeOrder({ method: "WALLET", quantity: 2, listing: { shopProductId: listingId, productId: product.id, name: product.name, pricePaise: 3000, shopId: s.shopId, shopName: s.shopName } });
  const row = (await inventory(s.ctx, s.shopId)).rows.find((r) => r.shopProductId === listingId)!;
  expect(row.available).toBe(3);
  expect(row.onHand).toBe(row.available + row.reserved);
  expect(row.reserved, "the 2 units are committed to the open order").toBe(2);
  await emptyCart();
  const tooMany = await addToCart("customer", listingId, 4);
  expect(tooMany.status, "cannot buy more than is left").toBeGreaterThanOrEqual(400);
  return `${order.orderNumber}: available 3, reserved ${row.reserved}, on hand ${row.onHand}; 4 more refused (${tooMany.status})`;
}, local);

qa("TC-CAT-019", "low-stock threshold: shop default 10, product default (API) and listing 3 — the effective threshold follows listing → product → shop and the table shows its source", async () => {
  const s = await shop();
  const p1 = await listed(s, { pricePaise: 3000, stock: 50 });
  const p2 = await listed(s, { pricePaise: 3000, stock: 50 });
  const p3 = await listed(s, { pricePaise: 3000, stock: 50 });
  expectStatus(await call(s.ctx, "PATCH", `/api/shops/${s.shopId}/inventory`, { lowStockThreshold: 10 }), 200, "shop default 10");
  expectStatus(await call(await as("ops"), "PATCH", `/api/admin/products/${p2.product.id}/stock-defaults`, { lowStockThreshold: 6 }), 200, "product default 6");
  expectStatus(await call(await as("ops"), "PATCH", `/api/admin/products/${p3.product.id}/stock-defaults`, { lowStockThreshold: 6 }), 200, "product default 6");
  expectStatus(await call(s.ctx, "PATCH", `/api/shop-products/${p3.listingId}/stock-settings`, { lowStockThreshold: 3 }), 200, "listing 3");
  const rows = (await inventory(s.ctx, s.shopId)).rows;
  const t = (id: string) => rows.find((r) => r.shopProductId === id)!.thresholds;
  expect([t(p1.listingId).lowStock, t(p1.listingId).source.lowStock]).toEqual([10, "SHOP"]);
  expect([t(p2.listingId).lowStock, t(p2.listingId).source.lowStock]).toEqual([6, "PRODUCT"]);
  expect([t(p3.listingId).lowStock, t(p3.listingId).source.lowStock]).toEqual([3, "LISTING"]);
  expectStatus(await call(s.ctx, "PATCH", `/api/shops/${s.shopId}/inventory`, { lowStockThreshold: 0 }), 200, "restore the shop default");
  return "shop 10 / product 6 / listing 3 → 10 (SHOP), 6 (PRODUCT), 3 (LISTING)";
}, { ...local, partial: "the source column on /shop/inventory renders the same values (SOURCE_LABEL); the page is not opened here" });

qa("TC-CAT-020", "a low-stock alert fires once per crossing, with one notification; none while it stays low; it resolves on restock", async () => {
  const s = await shop();
  const since = new Date();
  const { listingId, product } = await listed(s, { mrpPaise: 9000, pricePaise: 2000, stock: 6 });
  expectStatus(await call(s.ctx, "PATCH", `/api/shop-products/${listingId}/stock-settings`, { lowStockThreshold: 3 }), 200, "threshold 3");
  const l = { shopProductId: listingId, productId: product.id, name: product.name, pricePaise: 2000, shopId: s.shopId, shopName: s.shopName };
  await placeOrder({ method: "WALLET", quantity: 3, listing: l });
  const alerts = async () => db()<{ id: string; status: string; alert_type: string }[]>`select id, status, alert_type from stock_alerts where shop_product_id = ${listingId}`;
  const first = await alerts();
  expect(first.filter((a) => a.status !== "RESOLVED").length, `one alert at 3 left: ${JSON.stringify(first)}`).toBe(1);
  await placeOrder({ method: "WALLET", quantity: 1, listing: l });
  expect((await alerts()).length, "no second alert while still low").toBe(first.length);
  const notes = (await notificationsOf(s.owner.id, since)).filter((n) => /stock/i.test(`${n.type} ${n.title}`));
  expect(notes.length, `one notification: ${JSON.stringify(notes)}`).toBe(1);
  expectStatus(await call(s.ctx, "PATCH", `/api/shop-products/${listingId}`, { onlineStock: 30 }), 200, "restock");
  const after = await alerts();
  expect(after.every((a) => a.status === "RESOLVED"), JSON.stringify(after)).toBe(true);
  return `6 → 3 (threshold 3): one ${first[0].alert_type} alert and one notification; → 2: no new alert; restock to 30: resolved`;
}, local);

qa("TC-CAT-021", "reorder level and quantity on a listing are saved and shown with the low-stock list on the dashboard", async () => {
  const s = await shop();
  const { listingId } = await listed(s, { pricePaise: 3000, stock: 4 });
  expectStatus(await call(s.ctx, "PATCH", `/api/shop-products/${listingId}/stock-settings`, { reorderLevel: 5, reorderQuantity: 24 }), 200, "reorder settings");
  const inv = await inventory(s.ctx, s.shopId);
  const row = inv.rows.find((r) => r.shopProductId === listingId)!;
  expect(row.thresholds).toMatchObject({ reorderLevel: 5, reorderQuantity: 24 });
  expect((row as unknown as { reorderNeeded: boolean }).reorderNeeded).toBe(true);
  expect(inv.dashboard.reorderRequired).toBeGreaterThanOrEqual(1);
  return `reorder at 5, order 24: row flagged reorder; dashboard reorderRequired ${inv.dashboard.reorderRequired}`;
}, local);

/* --------------------------------------------------------------- photos */

async function photos(ctx: APIRequestContext, shopId: string, listingId: string) {
  const res = await call(ctx, "GET", `/api/shops/${shopId}/listings/${listingId}/media`);
  expectStatus(res, 200, "listing media");
  return res.body.photos as { id: string; isPrimary: boolean; sortOrder: number; url: string; moderationStatus: string }[];
}

async function uploadPhoto(ctx: APIRequestContext, shopId: string, listingId: string, data: Buffer, name: string, mime: string, replaceImageId?: string) {
  return call(ctx, "POST", `/api/shops/${shopId}/listings/${listingId}/media/photos`, undefined, {
    multipart: { file: filePart(name, data, mime), ...(replaceImageId ? { replaceImageId } : {}) },
  });
}

qa("TC-CAT-022", "listing photos: add several, the first is the main one, move one earlier, replace one, delete the main one — order and main persist and the next becomes main; the customer card shows the main photo", async ({ browser }) => {
  const s = await shop();
  const { listingId, product } = await listed(s, { pricePaise: 3000 });
  const { context, page } = await pageFor(browser, s.owner);
  try {
    await page.goto(`/shop/products/${listingId}/media`);
    for (const [i, colour] of [{ r: 200, g: 30, b: 30 }, { r: 30, g: 200, b: 30 }, { r: 30, g: 30, b: 200 }].entries()) {
      await page.getByTestId("gallery-input").setInputFiles({ name: `p${i}.jpg`, mimeType: "image/jpeg", buffer: await image(800, 600, "jpeg", colour) });
      await expect(page.getByTestId("photo-grid").getByRole("listitem")).toHaveCount(i + 1, { timeout: 30_000 });
    }
    await page.getByTestId("photo-grid").getByRole("listitem").nth(2).getByRole("button", { name: "Move earlier" }).click();
    await expect.poll(async () => (await photos(s.ctx, s.shopId, listingId)).length).toBe(3);
  } finally {
    await context.close();
  }
  let list = await photos(s.ctx, s.shopId, listingId);
  const [first, second, third] = list;
  expect(first.isPrimary, "first is main").toBe(true);
  // Replace the middle one; delete the main one.
  const replaced = await uploadPhoto(s.ctx, s.shopId, listingId, await image(700, 700, "png", { r: 250, g: 250, b: 0 }), "new.png", "image/png", second.id);
  expectStatus(replaced, 201, "replace");
  list = await photos(s.ctx, s.shopId, listingId);
  expect(list.map((p) => p.id)).toEqual([first.id, replaced.body.id, third.id]);
  const del = await call(s.ctx, "DELETE", `/api/shops/${s.shopId}/listings/${listingId}/media/photos/${first.id}`);
  expect(del.status).toBe(204);
  list = await photos(s.ctx, s.shopId, listingId);
  expect(list[0].id, "the next photo became main").toBe(replaced.body.id);
  expect(list[0].isPrimary).toBe(true);
  const row = (await storefront(await as("customer"), s.shopId)).rows.find((r) => r.shopProductId === listingId) as { imageUrl?: string | null } | undefined;
  expect(row?.imageUrl, "a photo is shown to customers").toBeTruthy();
  return `${product.name}: 3 added on the page, the third moved earlier, the middle one replaced in place, the main deleted → the next is main; storefront imageUrl ${row?.imageUrl}`;
}, local);

qa("TC-CAT-023", "photo validation by content: 6 MB, a PDF / SVG / HTML named .jpg and a 20×20 image are refused with clear messages; a 4000 px phone photo is accepted after the browser shrinks it", async ({ browser }) => {
  const s = await shop();
  const { listingId } = await listed(s, { pricePaise: 3000 });
  const cases: [string, Buffer, string, string, RegExp][] = [
    ["6 MB", await noisePng(1500, 1400), "big.jpg", "image/jpeg", /at most 5 MB/],
    ["PDF named .jpg", DISGUISED.pdfAsJpg(), "doc.jpg", "image/jpeg", /JPG, PNG or WebP/],
    ["SVG named .jpg", DISGUISED.svg(), "vector.jpg", "image/jpeg", /JPG, PNG or WebP/],
    ["HTML named .jpg", DISGUISED.html(), "page.jpg", "image/jpeg", /JPG, PNG or WebP/],
    ["20×20", await image(20, 20, "png"), "tiny.png", "image/png", /too small/],
  ];
  const seen: string[] = [];
  for (const [label, data, name, mime, message] of cases) {
    const res = await uploadPhoto(s.ctx, s.shopId, listingId, data, name, mime);
    expect(res.status, `${label}: ${why(res)}`).toBe(422);
    expect(res.body?.error?.message, label).toMatch(message);
    seen.push(`${label} (${(data.length / 1e6).toFixed(1)} MB) → 422`);
  }
  // The phone photo, through the page: the browser shrinks it before upload.
  const phone = await sharpLarge();
  const { context, page } = await pageFor(browser, s.owner);
  let sent = 0;
  try {
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url().includes("/media/photos")) sent = (r.postDataBuffer() ?? Buffer.alloc(0)).length;
    });
    await page.goto(`/shop/products/${listingId}/media`);
    await page.getByTestId("gallery-input").setInputFiles({ name: "phone.jpg", mimeType: "image/jpeg", buffer: phone });
    await expect(page.getByTestId("photo-grid").getByRole("listitem")).toHaveCount(1, { timeout: 60_000 });
  } finally {
    await context.close();
  }
  expect(sent, "the upload is smaller than the original").toBeLessThan(phone.length);
  return `${seen.join(", ")}; a 4000×3000 phone photo of ${(phone.length / 1e6).toFixed(1)} MB went up as ${(sent / 1e6).toFixed(2)} MB and was accepted`;
}, local);

/** A 4000×3000 photo-like JPEG (noise, so it is several MB like a phone photo). */
async function sharpLarge(): Promise<Buffer> {
  const { default: sharp } = await import("sharp");
  const width = 4000;
  const height = 3000;
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 7 + ((i / 3000) | 0)) & 0xff;
  return sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
}

qa("TC-CAT-025", "photo upload rate limit: a burst gets 429 after the limit", async () => {
  const made = await sellingShop("cat025");
  const listingId = made.listing.shopProductId;
  const tiny = await image(200, 200, "jpeg");
  let first429 = 0;
  for (let i = 1; i <= 65 && !first429; i++) {
    const res = await uploadPhoto(made.ctx, made.shop.id, listingId, tiny, `burst-${i}.jpg`, "image/jpeg");
    if (res.status === 429) first429 = i;
  }
  expect(first429, "429 within 65 uploads").toBeGreaterThan(0);
  return `429 at upload #${first429} (limit 60 per 10 minutes; uploads past the 5-photo cap answered 422 until then)`;
}, local);

qa("TC-CAT-026", "specifications text with HTML is never rendered as HTML", async ({ browser }) => {
  const s = await shop();
  const category = need((world() as unknown as { category?: { id: string } }).category, "the QA category");
  const specs = `<img src=x onerror=alert(1)><b>Bold ${RUN}</b>`;
  const created = await call(await as("ops"), "POST", "/api/products", { shopId: s.shopId, categoryId: category.id, name: `QA Specs Product ${RUN}`, unit: "piece", specifications: specs, description: `<script>alert(2)</script> about ${RUN}`, onlineSaleEnabled: true, onlinePricePaise: 2500, confirmDuplicate: true });
  expectStatus(created, 201, "product with specifications");
  const { context, page } = await pageAs(browser, "customer");
  let dialogs = 0;
  page.on("dialog", async (d) => {
    dialogs += 1;
    await d.dismiss();
  });
  try {
    await page.goto(`/products/${created.body.product.id}`);
    await expect(page.locator("main")).toBeVisible();
    expect(await page.locator("main b", { hasText: `Bold ${RUN}` }).count(), "no <b> rendered from the text").toBe(0);
    expect(await page.locator('main img[src="x"]').count(), "no injected <img>").toBe(0);
  } finally {
    await context.close();
  }
  expect(dialogs, "no script ran").toBe(0);
  const guest = await anonymous();
  const shown = await (await guest.get(`/products/${created.body.product.id}`)).text();
  await guest.dispose();
  return `product page: no injected element, no dialog; specifications ${shown.includes(`Bold ${RUN}`) ? "shown as text" : "not displayed on the product page"}`;
}, { ...local, partial: "specifications are stored but not displayed on the product page on this build, so 'shown escaped' is proven only for the description" });

/* ---------------------------------------------------------- loose goods */

qa("TC-CAT-027", "a loose product holds no default price or MRP in the master catalogue (empty, not 0)", async () => {
  const loose = need(world().listings.loose, "the loose listing");
  const [row] = await db()<{ kind: string; mrp_paise: number | null }[]>`select kind, mrp_paise from products where id = ${loose.productId}`;
  expect(row).toEqual({ kind: "LOOSE", mrp_paise: null });
  const pm = await call(await as("ops"), "GET", `/api/product-categories/products?q=${encodeURIComponent(loose.name)}`);
  const text = JSON.stringify(pm.body);
  expect(text).not.toMatch(/"mrpPaise":0\b/);
  const page = await call(await as("ops"), "GET", `/products/${loose.productId}`, undefined, { maxRedirects: 3 });
  expect(page.text, "no MRP line for a loose product").not.toContain('data-testid="product-mrp"');
  return `${loose.name}: kind LOOSE, MRP null (not 0); no MRP shown on its page`;
}, local);

qa("TC-CAT-028", "a loose product added to a shop starts with an empty price: the inventory price field is empty and the stored value is null, not 0", async ({ browser }) => {
  const made = await sellingShop("cat028");
  const sugar = (await ownerListings(made.ctx, made.shop.id)).find((l) => l.product.kind === "LOOSE")!;
  const row = await listingRow(sugar.id);
  expect([row.online_price_paise, row.offline_price_paise, row.online_sale_enabled]).toEqual([null, null, false]);
  const { context, page } = await pageFor(browser, made.owner);
  try {
    await page.goto("/shop/inventory");
    const input = page.getByLabel(`Price of ${sugar.product.name}`);
    await expect(input).toHaveValue("");
    await expect(input).toHaveAttribute("placeholder", "Enter price");
  } finally {
    await context.close();
  }
  return `${sugar.product.name}: price null/null, off sale; /shop/inventory shows an empty "Enter price" box`;
}, { ...local, partial: "added through the category add (the path that lists without a price); the single-product Add row asks for a price first" });

qa("TC-CAT-029", "a customer never sees ₹0 for an unpriced loose product: shop page, product page and search show no amount and no Add button", async ({ page }) => {
  const unpriced = need(world().listings.unpricedLoose, "the unpriced loose listing");
  const shopA = need(world().shops.A, "shop A");
  const seen: string[] = [];
  for (const path of [`/shops/${shopA.slug}`, `/products/${unpriced.productId}`, `/search?q=${encodeURIComponent(unpriced.name)}`]) {
    const res = await page.goto(path);
    const status = res?.status() ?? 0;
    const cards = page.locator("[data-product-name]");
    for (const t of await cards.allInnerTexts()) expect(t.replace(/\s+/g, " "), `${path}: a product card shows ₹0`).not.toMatch(/₹\s?0(\.00)?\b/);
    const text = status < 400 ? (await page.locator("main").innerText()).replace(/\s+/g, " ") : "";
    const card = page.locator(`[data-product-name="${unpriced.name}"]`);
    if (await card.count()) {
      await expect(card.first().getByRole("button", { name: /^Add\b/ })).toHaveCount(0);
      await expect(card.first()).toContainText(/Price on request|not set|unavailable|in shop/i);
    }
    if (path.startsWith("/products/")) {
      const row = page.getByTestId("price-comparison").locator(":scope > div").filter({ hasText: world().shops.A!.name });
      if (await row.count()) await expect(row.first()).not.toContainText(/₹\s?0(\.00)?\b/);
    }
    seen.push(`${path}: ${status} ${(await card.count()) ? "card without Add" : text.includes(unpriced.name) ? "named, no amount" : "not listed"}`);
  }
  return seen.join("; ");
}, { tier: "local", partial: "the unpriced listing is off sale online, so the shop page leaves it out rather than labelling it" });

qa("TC-CAT-031", "the owner sets ₹60 per kg on an unpriced loose listing: saved with history and audit; it becomes buyable at ₹60 per kg", async ({ browser }) => {
  const made = await sellingShop("cat031");
  const sugar = (await ownerListings(made.ctx, made.shop.id)).find((l) => l.product.kind === "LOOSE")!;
  const { context, page } = await pageFor(browser, made.owner);
  try {
    await ownerPricesOnPage(page, sugar.product.name, "60");
    await expect(page.getByText("Saved 1 price.")).toBeVisible();
  } finally {
    await context.close();
  }
  const row = await listingRow(sugar.id);
  expect([num(row.online_price_paise), row.online_sale_enabled]).toEqual([6000, true]);
  expect((await priceHistory(sugar.id)).some((h) => h.previous_price_paise === null && num(h.new_price_paise) === 6000)).toBe(true);
  expect((await auditRows(sugar.id, "%price%")).length).toBeGreaterThan(0);
  await emptyCart();
  expectStatus(await addToCart("customer", sugar.id, 1), [200, 201], "buyable now");
  const line = (await cartLines()).find((l) => l.shopProductId === sugar.id);
  await emptyCart();
  const guest = await anonymous();
  const html = await (await guest.get(`/products/${sugar.productId}`)).text();
  await guest.dispose();
  expect(html).toMatch(/₹(<!-- -->)?60(\.00)?/);
  expect(html).toMatch(/per kg|\/kg|\/ kg/i);
  return `₹60/kg saved (history null → 6000, audited), on sale; cart line at ${line?.unitPricePaise ?? "?"} paise; product page shows ₹60 per kg`;
}, local);

qa("TC-CAT-032", "loose price field: empty is accepted (stays unpriced); 0, -5, abc and 10.555 are refused", async ({ browser }) => {
  const made = await sellingShop("cat032");
  const sugar = (await ownerListings(made.ctx, made.shop.id)).find((l) => l.product.kind === "LOOSE")!;
  const results: string[] = [];
  const { context, page } = await pageFor(browser, made.owner);
  let decimalSaved: string | null = null;
  try {
    for (const value of ["0", "-5", "abc"]) {
      await ownerPricesOnPage(page, sugar.product.name, value);
      await expect(page.getByText("Enter a price greater than 0.")).toBeVisible();
      results.push(`"${value}" refused`);
    }
    await ownerPricesOnPage(page, sugar.product.name, "");
    await expect(page.getByText("No prices were changed.")).toBeVisible();
    expect((await listingRow(sugar.id)).online_price_paise, "empty leaves it unpriced").toBeNull();
    results.push("empty → unpriced");
    await ownerPricesOnPage(page, sugar.product.name, "10.555");
    await page.waitForTimeout(1500);
    decimalSaved = (await listingRow(sugar.id)).online_price_paise;
  } finally {
    await context.close();
  }
  for (const value of [0, -500, 1055.5]) {
    const res = await call(made.ctx, "PATCH", `/api/shops/${made.shop.id}/prices`, { prices: [{ shopProductId: sugar.id, pricePaise: value }] });
    results.push(`API ${value} → ${res.status}`);
  }
  expect(decimalSaved, `10.555 must be refused — ${results.join("; ")}; the form saved ${decimalSaved} paise`).toBeNull();
  return results.join("; ");
}, local);

qa("TC-CAT-033", "Excel and loose prices: loose rows are blank in the template; a blank loose cell is accepted as unpriced; a 0 in a loose cell is reported as an error and nothing becomes 0", async () => {
  const made = await sellingShop("cat033");
  const listings = await ownerListings(made.ctx, made.shop.id);
  const loose = listings.filter((l) => l.product.kind === "LOOSE");
  const template = await readXlsx((await download(made.ctx, `/api/shops/${made.shop.id}/price-template`)).body);
  for (const l of loose) expect(template.find((r) => r[0] === l.product.code)?.[3], `${l.product.name} blank`).toBe("");
  const blank = await call(made.ctx, "POST", "/api/excel-uploads", undefined, { multipart: { shopId: made.shop.id, file: filePart("blank.xlsx", await xlsx(template as (string | number | null)[][], `cat033-template-${RUN}.xlsx`), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") } });
  expectStatus(blank, 201, "upload the template back");
  const blankRows = (blank.body.rows as { productCode: string; status: string; errorMessage: string | null }[]).filter((r) => loose.some((l) => l.product.code === r.productCode));
  await call(made.ctx, "DELETE", `/api/excel-uploads/${blank.body.uploadId}/apply`);
  const zeroSheet = await xlsx([["Product ID", "Price"], [loose[0].product.code, 0]], `cat033-zero-${RUN}.xlsx`);
  const zero = await call(made.ctx, "POST", "/api/excel-uploads", undefined, { multipart: { shopId: made.shop.id, file: filePart("zero.xlsx", zeroSheet, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") } });
  expectStatus(zero, 201, "upload a 0");
  const zeroRow = (zero.body.rows as { status: string; errorMessage: string | null }[])[0];
  if (zeroRow.status === "VALID") await call(made.ctx, "DELETE", `/api/excel-uploads/${zero.body.uploadId}/apply`);
  const detail = `blank loose rows → ${blankRows.map((r) => `${r.status}${r.errorMessage ? ` "${r.errorMessage}"` : ""}`).join(", ")}; a 0 → ${zeroRow.status}`;
  for (const l of loose) expect((await listingRow(l.id)).online_price_paise, `${l.product.name} not set to 0`).toBeNull();
  expect(zeroRow.status, `a 0 for a loose product must be reported as an error — ${detail}`).not.toBe("VALID");
  expect(blankRows.every((r) => r.status !== "INVALID_PRICE"), `a blank loose price is reported as an error rather than accepted as unpriced — ${detail}`).toBe(true);
  return detail;
}, local);

qa("TC-CAT-034", "search and Compare prices with shop A unpriced and shop B priced for the same loose product: B is buyable and can be 'Lowest price'; A is marked not buyable and sorted after", async ({ page }) => {
  const shopA = need(world().shops.A, "shop A");
  const shopB = need(world().shops.B, "shop B");
  const product = await newMasterProduct({ kind: "LOOSE", name: `QA Loose Jaggery ${RUN}` });
  const la = await call(await as("shop"), "POST", `/api/shops/${shopA.id}/products`, { productId: product.id, onlineSaleEnabled: false, offlineSaleEnabled: false, trackInventory: true, onlineStock: 50 });
  const lb = await call(await as("shopB"), "POST", `/api/shops/${shopB.id}/products`, { productId: product.id, onlineSaleEnabled: true, onlinePricePaise: 4500, offlineSaleEnabled: false, trackInventory: true, onlineStock: 50 });
  expectStatus(la, 201, "shop A lists it unpriced");
  expectStatus(lb, 201, "shop B lists it at ₹45/kg");
  try {
    await page.goto(`/search?q=${encodeURIComponent(product.name)}`);
    await expect(page.locator(`[data-product-name="${product.name}"]`).first()).toBeVisible();
    for (const t of await page.locator(`[data-product-name="${product.name}"]`).allInnerTexts()) expect(t).not.toMatch(/₹\s?0(\.00)?\b/);
    await page.goto(`/products/${product.id}`);
    const rows = page.getByTestId("price-comparison").locator(":scope > div");
    await expect(rows.first()).toContainText(shopB.name);
    await expect(rows.first()).toContainText("Lowest price");
    const aRow = rows.filter({ hasText: shopA.name });
    await expect(aRow).toContainText(/Not available online/);
    await expect(aRow).not.toContainText(/₹\s?0\b/);
    const order = await rows.allInnerTexts();
    expect(order.findIndex((t) => t.includes(shopA.name))).toBeGreaterThan(order.findIndex((t) => t.includes(shopB.name)));
    return `search shows ${product.name} with no ₹0; compare: B ₹45/kg first with "Lowest price"; A "Not available online", after B, no ₹0`;
  } finally {
    await call(await as("shop"), "DELETE", `/api/shop-products/${la.body.id}`);
    await call(await as("shopB"), "DELETE", `/api/shop-products/${lb.body.id}`);
  }
}, local);

qa("TC-CAT-035", "the owner clears the price of a loose product in a customer's cart: the cart flags the line as not purchasable and paying is disabled until it is removed", async ({ browser }) => {
  const made = await sellingShop("cat035");
  const paneer = (await ownerListings(made.ctx, made.shop.id)).find((l) => l.product.kind === "LOOSE")!;
  expectStatus(await call(made.ctx, "PATCH", `/api/shops/${made.shop.id}/prices`, { prices: [{ shopProductId: paneer.id, pricePaise: 30000 }] }), 200, "price it");
  await emptyCart();
  expectStatus(await addToCart("customer", paneer.id, 1), [200, 201], "in the cart");
  expectStatus(await call(made.ctx, "PATCH", `/api/shop-products/${paneer.id}`, { onlineSaleEnabled: false, offlineSaleEnabled: false, onlinePricePaise: null, offlinePricePaise: null }), 200, "clear the price");
  const { context, page } = await pageAs(browser, "customer");
  try {
    await page.goto("/cart");
    const line = page.getByRole("listitem").filter({ hasText: paneer.product.name }).first();
    await expect(line).toBeVisible();
    await expect(line.locator("span", { hasText: /not|unavailable|only at the/i }).first()).toBeVisible();
    const pay = page.getByRole("button", { name: /Pay from wallet|Place order/ });
    if (await pay.count()) await expect(pay).toBeDisabled();
  } finally {
    await context.close();
  }
  const checkout = await call(await as("customer"), "POST", "/api/checkout", { requestId: `qa-${RUN}-cleared`, paymentMethod: "WALLET", addressId: null, acknowledgeClosedShopIds: [made.shop.id] });
  expect(checkout.status, why(checkout)).toBeGreaterThanOrEqual(400);
  await emptyCart();
  return `line flagged with a reason; Pay disabled; checkout → ${checkout.status}`;
}, local);

qa("TC-CAT-036", "loose listings that already had a shop price keep it; only those without one are empty", async () => {
  const loose = need(world().listings.loose, "the priced loose listing");
  const unpriced = need(world().listings.unpricedLoose, "the unpriced loose listing");
  const a = await listingRow(loose.shopProductId);
  const b = await listingRow(unpriced.shopProductId);
  expect(num(a.online_price_paise)).toBe(loose.pricePaise);
  expect(b.online_price_paise).toBeNull();
  return `${loose.name} keeps ₹${(loose.pricePaise ?? 0) / 100}; ${unpriced.name} stays empty`;
}, local);

/* ------------------------------------------------- per-shop MRP (NEW-010) */

const SUPERSEDED = "expected result superseded by docs/three-modules-2026-10/PLAN.md §1.2 (approved 8 Oct): 'No shop-level MRP exists. MRP is master-only and the shop's own selling price is per shop'";

qa(["TC-CAT-057", "TC-CAT-058", "TC-CAT-066"], "the owner changes the price for the own shop (the per-shop figure the build keeps); shop B and the master catalogue keep theirs; with no shop MRP there is nothing to reset", async ({ browser }) => {
  const a = need(world().listings.sharedA, "shop A's bread");
  const b = need(world().listings.sharedB, "shop B's bread");
  const masterBefore = (await db()<{ mrp_paise: number }[]>`select mrp_paise from products where id = ${a.productId}`)[0].mrp_paise;
  const { context, page } = await pageAs(browser, "shop");
  try {
    await page.goto("/shop/inventory");
    await expect(page.getByLabel(/MRP/i)).toHaveCount(0);
    await ownerPricesOnPage(page, a.name, "41");
    await expect(page.getByText("Saved 1 price.")).toBeVisible();
  } finally {
    await context.close();
  }
  try {
    expect(num((await listingRow(a.shopProductId)).online_price_paise)).toBe(4100);
    expect(num((await listingRow(b.shopProductId)).online_price_paise), "shop B unchanged").toBe(b.pricePaise);
    expect((await db()<{ mrp_paise: number }[]>`select mrp_paise from products where id = ${a.productId}`)[0].mrp_paise, "master MRP unchanged").toBe(masterBefore);
  } finally {
    await call(await as("shop"), "PATCH", `/api/shops/${world().shops.A!.id}/prices`, { prices: [{ shopProductId: a.shopProductId, pricePaise: a.pricePaise }] });
  }
  return `no MRP field on the owner's screens; shop A's bread ₹40 → ₹41 saved ("Saved 1 price.") for shop A only; shop B ₹${(b.pricePaise ?? 0) / 100} and master MRP ₹${masterBefore / 100} unchanged; restored`;
}, { ...local, partial: SUPERSEDED });

qa(["TC-CAT-059", "TC-CAT-060"], "customers see one MRP (the master) and each shop's own price; a later master MRP change applies to every shop", async ({ page }) => {
  const product = await newMasterProduct({ mrpPaise: 5000 });
  const shopA = need(world().shops.A?.id, "shop A");
  const shopB = need(world().shops.B?.id, "shop B");
  const la = await call(await as("shop"), "POST", `/api/shops/${shopA}/products`, { productId: product.id, onlineSaleEnabled: true, onlinePricePaise: 4800, trackInventory: true, onlineStock: 10 });
  const lb = await call(await as("shopB"), "POST", `/api/shops/${shopB}/products`, { productId: product.id, onlineSaleEnabled: true, onlinePricePaise: 4600, trackInventory: true, onlineStock: 10 });
  expectStatus(la, 201, "A lists it");
  expectStatus(lb, 201, "B lists it");
  try {
    await page.goto(`/products/${product.id}`);
    await expect(page.getByTestId("product-mrp")).toContainText("50");
    await expect(page.getByTestId("price-comparison")).toContainText("48");
    await expect(page.getByTestId("price-comparison")).toContainText("46");
    expectStatus(await call(await as("admin"), "POST", "/api/mrp", { productId: product.id, mrpPaise: 6000, source: "ADMIN", reason: "QA master change" }), 200, "master MRP ₹60");
    await page.reload();
    await expect(page.getByTestId("product-mrp")).toContainText("60");
    return "product page: one MRP ₹50 with A ₹48 and B ₹46 compared; master → ₹60 shown for every shop";
  } finally {
    await call(await as("shop"), "DELETE", `/api/shop-products/${la.body.id}`);
    await call(await as("shopB"), "DELETE", `/api/shop-products/${lb.body.id}`);
  }
}, { ...local, partial: `per-shop MRP display and 'Shop A keeps ₹55' — ${SUPERSEDED}` });

qa(["TC-CAT-062"], "MRP figures an owner can enter (the 'MRP looks wrong?' claim) are validated: empty, 0, -1, abc, 10.555 and ₹10 crore refused; the master MRP is unchanged", async () => {
  const listing = need(world().listings.packaged, "the packaged listing");
  const shopA = need(world().shops.A?.id, "shop A");
  const before = (await db()<{ mrp_paise: number }[]>`select mrp_paise from products where id = ${listing.productId}`)[0].mrp_paise;
  const out: string[] = [];
  const accepted: string[] = [];
  for (const [label, value] of [["empty", null], ["0", 0], ["-1", -100], ["abc", "abc"], ["10.555", 1055.5], ["₹10 crore", 10_000_000_000]] as const) {
    const res = await call(await as("shop"), "POST", "/api/mrp/corrections", { productId: listing.productId, shopId: shopA, claimedMrpPaise: value, note: "QA validation" });
    out.push(`${label} → ${res.status}`);
    if (res.status < 400) accepted.push(label);
  }
  expect((await db()<{ mrp_paise: number }[]>`select mrp_paise from products where id = ${listing.productId}`)[0].mrp_paise).toBe(before);
  expect(accepted, `claims accepted: ${out.join("; ")}`).toEqual([]);
  return out.join("; ");
}, { ...local, partial: `the owner has no own-shop MRP field — ${SUPERSEDED}; the claim form is the owner's only MRP input` });

qa("TC-CAT-064", "MRP history: each master MRP change is kept with old value, new value, who and when", async () => {
  const product = await newMasterProduct({ mrpPaise: 5000 });
  for (const paise of [5200, 5400]) expectStatus(await call(await as("admin"), "POST", "/api/mrp", { productId: product.id, mrpPaise: paise, source: "ADMIN", reason: `QA ${paise}` }), 200, `MRP ${paise}`);
  const audits = (await auditRows(product.id)).filter((r) => /mrp/i.test(r.action));
  const values = audits.map((r) => JSON.stringify([r.previous_value, r.new_value]));
  expect(audits.length, values.join(" | ")).toBeGreaterThanOrEqual(2);
  expect(values.join(" ")).toContain("5400");
  expect(audits.every((r) => r.actor_id === world().users.admin!.id)).toBe(true);
  return `${audits.length} MRP audit rows with old/new, actor and time: ${values.slice(0, 2).join(" ; ")}`;
}, { ...local, partial: `history per shop — ${SUPERSEDED}` });

qa("TC-CAT-065", "MRP changed through the Excel price list applies to the uploading shop only", async () => {
  const template = await readXlsx((await download(await as("shop"), `/api/shops/${need(world().shops.A?.id, "shop A")}/price-template`)).body);
  const header = template[0];
  if (!header.some((h) => /mrp/i.test(h))) blocked(`the price template has no MRP column (columns: ${header.join(", ")}) — the case's precondition says to mark it Blocked`);
  return "MRP column present";
}, local);

qa("TC-CAT-067", "past orders keep the price and MRP of the time: after the owner and admin change them, the delivered order's lines, totals and settlement are unchanged", async () => {
  const listing = need(world().listings.packaged, "the packaged listing");
  const shopA = need(world().shops.A?.id, "shop A");
  await onlyRiderOnline("rider");
  const order = await placeOrder({ method: "WALLET", listing: { ...listing, shopId: shopA, shopName: world().shops.A!.name } });
  await packOrder(order.id);
  await deliver(order.id);
  const snap = async () => db()<{ unit_price_paise: string; line_total_paise: string; total: string }[]>`
    select oi.unit_price_paise, oi.line_total_paise, o.total_paise as total from order_items oi join orders o on o.id = oi.order_id where o.id = ${order.id}`;
  const before = await snap();
  const mrpBefore = (await db()<{ mrp_paise: number }[]>`select mrp_paise from products where id = ${listing.productId}`)[0].mrp_paise;
  try {
    expectStatus(await call(await as("shop"), "PATCH", `/api/shops/${shopA}/prices`, { prices: [{ shopProductId: listing.shopProductId, pricePaise: 5900 }] }), 200, "owner changes the price");
    expectStatus(await call(await as("admin"), "POST", "/api/mrp", { productId: listing.productId, mrpPaise: 6500, source: "ADMIN", reason: "QA past orders" }), 200, "admin changes the MRP");
    expect(await snap(), "order lines and total unchanged").toEqual(before);
    const view = await call(await as("customer"), "GET", "/api/orders");
    const listed = ((Array.isArray(view.body) ? view.body : view.body.orders) as { id: string; totalPaise: number }[]).find((o) => o.id === order.id);
    expect(listed?.totalPaise).toBe(order.totalPaise);
  } finally {
    await call(await as("shop"), "PATCH", `/api/shops/${shopA}/prices`, { prices: [{ shopProductId: listing.shopProductId, pricePaise: listing.pricePaise }] });
    // mrp_paise is a bigint: postgres.js reads it as a string, which the API refuses.
    const restore = await call(await as("admin"), "POST", "/api/mrp", { productId: listing.productId, mrpPaise: mrpBefore == null ? null : Number(mrpBefore), source: "ADMIN", reason: "QA restore" });
    expectStatus(restore, [200, 201], "restore the MRP");
  }
  return `${order.orderNumber} delivered at ₹${(listing.pricePaise ?? 0) / 100}; price → ₹59 and MRP → ₹65: lines ${JSON.stringify(before)} unchanged; restored`;
}, { ...local, partial: "the shop settlement row is created by the payout cycle, not checked here" });

/* ----------------------------------------------------- photo moderation */

qa(["TC-CAT-068", "TC-CAT-069"], "with photo moderation on, a shop's new photo is pending and hidden from customers until approved; a rejected one shows the reason to the owner, customers keep the previous photo or the placeholder, and the owner can replace it", async () => {
  const made = await sellingShop("cat068");
  const listingId = made.listing.shopProductId;
  return withRule("imageModeration", { enabled: true }, async () => {
    const custView = async () => ((await storefront(await as("customer"), made.shop.id)).rows.find((r) => r.shopProductId === listingId) as { imageUrl?: string | null } | undefined)?.imageUrl ?? null;
    const before = await custView();
    const up = await uploadPhoto(made.ctx, made.shop.id, listingId, await image(600, 600, "jpeg", { r: 10, g: 120, b: 10 }), "mod.jpg", "image/jpeg");
    expectStatus(up, 201, "upload");
    expect(up.body.moderationStatus).toBe("PENDING");
    expect(await custView(), "hidden from customers while pending").toBe(before);
    const queue = await call(await as("ops"), "GET", "/api/admin/image-moderation");
    expect(JSON.stringify(queue.body)).toContain(up.body.id);
    expectStatus(await call(await as("ops"), "POST", `/api/admin/image-moderation/${up.body.id}/decision`, { decision: "approve" }), 200, "approve");
    const approvedUrl = await custView();
    expect(approvedUrl, "visible once approved").not.toBe(before);
    const second = await uploadPhoto(made.ctx, made.shop.id, listingId, await image(600, 600, "jpeg", { r: 120, g: 10, b: 10 }), "mod2.jpg", "image/jpeg");
    const reorder = await call(made.ctx, "PUT", `/api/shops/${made.shop.id}/listings/${listingId}/media/photos/order`, { imageIds: [second.body.id, up.body.id] });
    expect(reorder.status).toBe(204);
    expectStatus(await call(await as("ops"), "POST", `/api/admin/image-moderation/${second.body.id}/decision`, { decision: "reject", reason: "QA: shows a person" }), 200, "reject");
    expect(await custView(), "customers keep the approved photo").toBe(approvedUrl);
    const media = await call(made.ctx, "GET", `/api/shops/${made.shop.id}/listings/${listingId}/media`);
    const rejected = (media.body.photos as { id: string; moderationStatus: string; rejectionReason: string | null }[]).find((p) => p.id === second.body.id);
    expect(rejected).toMatchObject({ moderationStatus: "REJECTED", rejectionReason: "QA: shows a person" });
    const replace = await uploadPhoto(made.ctx, made.shop.id, listingId, await image(600, 600, "png"), "fix.png", "image/png", second.body.id);
    expectStatus(replace, 201, "the owner replaces it");
    return `upload PENDING, customers keep ${before ?? "the placeholder"}; in the queue; approve → shown; a second rejected "QA: shows a person" → owner sees the reason, customers keep the approved one; replaced (${replace.body.moderationStatus})`;
  });
}, local);
