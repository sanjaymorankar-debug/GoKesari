/**
 * Catalogue access rules as the test accounts meet them (signed-in tier: the
 * test site and the local server): a customer cannot upload product lists,
 * another shop cannot touch shop A's photos or MRP, an unpriced product can
 * be neither carted nor ordered, only moderators decide photos, and the
 * product-master APIs stay closed to customers.
 *
 * Nothing here changes data that matters: every write is one the server must
 * refuse. Pieces this site's test data lacks (shop B, an unpriced listing)
 * block the case instead of failing it.
 */
import { as } from "../lib/actors";
import { cartLines, emptyCart, shopOf } from "../lib/flows";
import { call, expectStatus, RUN, why } from "../lib/http";
import { blocked, expect, need, qa } from "../lib/record";
import { NO_SUCH_ID } from "../lib/routes";
import { IS_LOCAL } from "../lib/target";
import { world } from "../lib/world";
import { filePart, ownerListings, xlsx } from "../lib/sellers-helpers";

const signed = { tier: "signed" as const, timeout: 120_000 };

/** One of shop A's own listings, as its owner sees them. */
async function aListingOfA() {
  const shop = await shopOf("A");
  const listings = await ownerListings(await as("shop"), shop.id);
  const row = listings.find((l) => l.onlineSaleEnabled) ?? listings[0];
  return { shop, listing: need(row, `a listing of ${shop.name}`) };
}

qa("TC-CAT-016", "a customer cannot upload product lists: POST /api/excel-uploads → 403", async () => {
  const { shop } = await aListingOfA();
  const sheet = await xlsx([["Product ID", "Price"], ["P00001", 10]], `customer-upload-${RUN}.xlsx`);
  const res = await call(await as("customer"), "POST", "/api/excel-uploads", undefined, {
    multipart: { shopId: shop.id, file: filePart("prices.xlsx", sheet, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") },
  });
  expect(res.status, why(res)).toBe(403);
  const template = await call(await as("customer"), "GET", `/api/shops/${shop.id}/price-template`);
  expect(template.status, "nor download the shop's template").toBe(403);
  return `customer upload → 403 "${res.body?.error?.message}"; template → 403`;
}, signed);

qa("TC-CAT-024", "shop B's owner cannot add, reorder, replace or delete photos of shop A's listing (403/404)", async () => {
  need(world().shops.B, "a second shop (shop B) and its owner");
  const { shop, listing } = await aListingOfA();
  const b = await as("shopB");
  const base = `/api/shops/${shop.id}/listings/${listing.id}/media`;
  const tiny = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==", "base64");
  const answers: string[] = [];
  for (const [label, res] of [
    ["read media", await call(b, "GET", base)],
    ["add photo", await call(b, "POST", `${base}/photos`, undefined, { multipart: { file: filePart("x.jpg", tiny, "image/jpeg") } })],
    ["reorder", await call(b, "PUT", `${base}/photos/order`, { imageIds: [NO_SUCH_ID] })],
    ["delete", await call(b, "DELETE", `${base}/photos/${NO_SUCH_ID}`)],
    ["descriptions", await call(b, "PATCH", base, { shortDescription: "hijacked" })],
    ["product photo", await call(b, "POST", `/api/products/${listing.productId}/images`, { storedImageId: NO_SUCH_ID, shopProductId: listing.id })],
  ] as const) {
    expect([403, 404], `${label}: ${why(res)}`).toContain(res.status);
    answers.push(`${label} ${res.status}`);
  }
  return answers.join(", ");
}, signed);

qa("TC-CAT-030", "an unpriced listing cannot be added to a cart or ordered: both refused with a reason; no cart line, no order, no ₹0 debit", async () => {
  const unpriced = world().listings.unpricedLoose ?? (IS_LOCAL ? null : blocked("needs an unpriced listing (the local world's unpriced loose product)"));
  const listing = need(unpriced, "an unpriced loose listing");
  await emptyCart();
  const add = await call(await as("customer"), "POST", "/api/cart", { shopProductId: listing.shopProductId, quantity: 1 });
  expect(add.status, why(add)).toBeGreaterThanOrEqual(400);
  expect(add.status).toBeLessThan(500);
  expect(JSON.stringify(add.body)).toMatch(/not priced|only at the physical shop|not available|not offering/i);
  expect(await cartLines(), "no cart line").toEqual([]);
  const checkout = await call(await as("customer"), "POST", "/api/checkout", { requestId: `qa-${RUN}-unpriced`, paymentMethod: "WALLET", addressId: null, acknowledgeClosedShopIds: [] });
  expect(checkout.status, `checkout with nothing purchasable: ${why(checkout)}`).toBeGreaterThanOrEqual(400);
  expect(checkout.status).toBeLessThan(500);
  return `add to cart → ${add.status} "${add.body?.error?.message}"; checkout → ${checkout.status} "${checkout.body?.error?.message}"`;
}, signed);

qa("TC-CAT-061", "shop A's owner cannot change the MRP of shop B's listing or the master MRP: 403/404, nothing changes", async () => {
  need(world().shops.B, "shop B");
  const bListing = need(world().listings.sharedB, "a listing of shop B");
  const a = await as("shop");
  const cross = await call(a, "PATCH", `/api/shop-products/${bListing.shopProductId}`, { onlinePricePaise: 1 });
  expect([403, 404], `shop B's listing: ${why(cross)}`).toContain(cross.status);
  const master = await call(a, "POST", "/api/mrp", { productId: bListing.productId, mrpPaise: 1, source: "ADMIN" });
  expect(master.status, why(master)).toBe(403);
  const after = (await ownerListings(await as("shopB"), need(world().shops.B?.id, "shop B id"))).find((l) => l.id === bListing.shopProductId);
  expect(after?.onlinePricePaise, "shop B's price unchanged").toBe(bListing.pricePaise);
  return `PATCH shop B's listing → ${cross.status}; POST /api/mrp → 403; shop B still at ${after?.onlinePricePaise}`;
}, { ...signed, partial: "there is no shop-level MRP (docs/three-modules-2026-10/PLAN.md §1.2), so 'the MRP change for a Shop B listing' is its per-shop price" });

qa("TC-CAT-070", "only moderators decide photos: the owner and a customer get 403 on the approve action and on the queue", async () => {
  const answers: string[] = [];
  for (const role of ["shop", "customer"] as const) {
    const decide = await call(await as(role), "POST", `/api/admin/image-moderation/${NO_SUCH_ID}/decision`, { decision: "approve" });
    expect(decide.status, `${role} approve: ${why(decide)}`).toBe(403);
    const queue = await call(await as(role), "GET", "/api/admin/image-moderation");
    expect(queue.status, `${role} queue`).toBe(403);
    answers.push(`${role}: approve ${decide.status}, queue ${queue.status}`);
  }
  return answers.join("; ");
}, { ...signed, partial: "the owner's own image id is not used (a 403 is decided before the image is looked up); TC-CAT-068 shows a moderator deciding one" });

qa("TC-PMD-006", "product-master APIs are staff-only: a customer gets 403 on products, review and data-quality and no personal data", async () => {
  const answers: string[] = [];
  for (const path of ["/api/product-master/products", "/api/product-master/review", "/api/product-master/data-quality", "/api/product-master/products/search?q=milk"]) {
    const res = await call(await as("customer"), "GET", path);
    expect(res.status, `${path}: ${why(res)}`).toBe(403);
    expect(res.text).not.toMatch(/@|phone|mobile/i);
    answers.push(`${path} ${res.status}`);
  }
  const owner = await call(await as("shop"), "GET", "/api/product-master/data-quality");
  expect(owner.status, "a shop owner is not staff either").toBe(403);
  const ops = await call(await as("ops"), "GET", "/api/product-master/data-quality");
  expectStatus(ops, [200, 503], "staff can read it");
  return `${answers.join(", ")}; shop owner 403; operator ${ops.status}`;
}, { ...signed, partial: "the guest half is covered in tests/qa/guest/access.spec.ts" });
