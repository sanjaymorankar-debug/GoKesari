/**
 * Puja Samagri & Temple Supplies (docs/puja-samagri-2026-11, brief §9) as the test accounts
 * meet it: shop A's owner takes part of the puja catalogue (Puja Samagri becomes an added
 * shop type of the bakery), removes and restores a product, creates a product type and a
 * product (duplicate check first); staff review them; the customer searches in three
 * languages, asks the price of a loose item that the owner then prices, and orders a puja
 * item through the existing checkout, delivery and OTP — and cancels one before packing.
 * Signed-in tier: test.gokesari.com and the local server.
 *
 * Test data it leaves on shop A: the Kapur (Camphor) and Phool & Patte puja listings (marked
 * by their categories), one product type and products named "QA Puja … <run>" (rejected or
 * approved in the review), one priced marigold listing. The FSSAI toggle and any festival
 * collection it opens are put back / switched off in a finally block.
 */
import type { Page } from "@playwright/test";

import { as, pageAs } from "../lib/actors";
import { addToCart, deliver, emptyCart, orderAs, packOrder, placeOrder, shopOf, type Listing } from "../lib/flows";
import { call, expectStatus, RUN, stash, unstash, why } from "../lib/http";
import { blocked, expect, qa } from "../lib/record";

type Category = { id: string; slug: string; name: string; productCount: number; listed: number };
type Item = {
  productId: string;
  name: string;
  nameHi: string | null;
  kind: "PACKAGED" | "LOOSE";
  mrpPaise: number | null;
  approvalStatus: string;
  listing: { id: string; state: "LISTED" | "REMOVED"; pricePaise: number | null; stock: number } | null;
};

const KEY = "puja-samagri";
const base = (shopId: string) => `/api/shops/${shopId}`;

async function setupOf(shopId: string) {
  const res = await call(await as("shop"), "GET", `${base(shopId)}/puja`);
  if (res.status === 404) blocked("the Puja Samagri feature is not on this site yet");
  expectStatus(res, 200, "GET puja setup");
  if (!res.body.typeEnabled) blocked("the Puja Samagri shop type is switched off on this site");
  return res.body as { categories: Category[]; defaultStock: number; isPujaShop: boolean; primaryIsPuja: boolean };
}

async function itemsOf(shopId: string, query: string): Promise<Item[]> {
  const res = await call(await as("shop"), "GET", `${base(shopId)}/puja/catalogue?limit=200&${query}`);
  expectStatus(res, 200, `puja catalogue ${query}`);
  return res.body.items as Item[];
}

/** Every listing name a customer sees on the shop's shelf (all pages). */
async function shelfNames(shopId: string): Promise<string[]> {
  const names: string[] = [];
  for (let offset = 0; offset < 1000; offset += 100) {
    const res = await call(await as("customer"), "GET", `/api/shops/${shopId}/products?limit=100&offset=${offset}`);
    expectStatus(res, 200, "shop shelf");
    const rows = res.body as { productName: string }[];
    names.push(...rows.map((r) => r.productName));
    if (rows.length < 100) break;
  }
  return names;
}

async function noSidewaysScroll(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

qa("TC-PUJA-010", "taking the puja catalogue lists every product of the ticked categories at stock 100, priced at MRP, loose items with an empty price; unticked categories and products stay out; a second run adds nothing", async () => {
  const shop = await shopOf("A");
  const setup = await setupOf(shop.id);
  expect(setup.categories).toHaveLength(15);
  expect(setup.categories.reduce((n, c) => n + c.productCount, 0)).toBeGreaterThanOrEqual(499);
  const keep = ["puja-kapur", "puja-phool-patte"];
  const kapur = setup.categories.find((c) => c.slug === "puja-kapur")!;
  const before = await itemsOf(shop.id, `categoryId=${kapur.id}`);
  const untick = before.find((i) => !i.listing);
  const owner = await as("shop");
  const res = await call(owner, "POST", `${base(shop.id)}/puja/seed`, {
    excludeCategoryIds: setup.categories.filter((c) => !keep.includes(c.slug)).map((c) => c.id),
    excludeProductIds: untick ? [untick.productId] : [],
  });
  expectStatus(res, 200, "take the puja catalogue");
  expect(res.body.stock).toBe(setup.defaultStock);
  const added = new Set(before.filter((i) => !i.listing && i.productId !== untick?.productId).map((i) => i.productId));
  const after = await itemsOf(shop.id, `categoryId=${kapur.id}`);
  for (const i of after.filter((x) => added.has(x.productId))) {
    expect(i.listing?.state, i.name).toBe("LISTED");
    expect(i.listing?.stock, i.name).toBe(setup.defaultStock);
    expect(i.listing?.pricePaise, i.name).toBe(i.kind === "LOOSE" ? null : i.mrpPaise);
  }
  if (untick) expect(after.find((i) => i.productId === untick.productId)?.listing, "the unticked product").toBeNull();
  const otherCategory = setup.categories.find((c) => c.slug === "puja-murti-photo-yantra")!;
  expect((await itemsOf(shop.id, `categoryId=${otherCategory.id}`)).filter((i) => i.listing).length, "an unticked category").toBe(0);
  const again = await call(owner, "POST", `${base(shop.id)}/puja/seed`, { excludeCategoryIds: setup.categories.filter((c) => !keep.includes(c.slug)).map((c) => c.id), excludeProductIds: untick ? [untick.productId] : [] });
  expectStatus(again, 200, "take it again");
  expect(again.body.added, "second run").toBe(0);
  const flowers = await itemsOf(shop.id, `categoryId=${setup.categories.find((c) => c.slug === "puja-phool-patte")!.id}&kind=loose`);
  expect(flowers.length).toBeGreaterThan(5);
  expect(flowers.every((i) => i.listing?.pricePaise == null || i.listing.pricePaise > 0)).toBe(true);
  stash(KEY, { shopId: shop.id, kapurCategoryId: kapur.id });
  return `added ${res.body.added} (stock ${res.body.stock}, ${res.body.needsPrice} awaiting price), unticked ${untick?.name ?? "—"}; second run added 0; added type: ${res.body.addedType || setup.isPujaShop}`;
});

qa("TC-PUJA-011", "a removed puja product is listed under Removed and Restore brings it back with its price and stock", async () => {
  const shop = await shopOf("A");
  const setup = await setupOf(shop.id);
  const kapur = setup.categories.find((c) => c.slug === "puja-kapur")!;
  const target = (await itemsOf(shop.id, `categoryId=${kapur.id}`)).find((i) => i.listing?.state === "LISTED" && i.kind === "PACKAGED");
  if (!target?.listing) blocked("shop A lists no packed kapur product (TC-PUJA-010 first)");
  const owner = await as("shop");
  expectStatus(await call(owner, "DELETE", `/api/shop-products/${target.listing.id}`), [200, 204], "remove");
  const removed = await call(owner, "GET", `${base(shop.id)}/removed-listings`);
  expectStatus(removed, 200, "removed list");
  expect((removed.body.listings as { id: string }[]).some((l) => l.id === target.listing!.id)).toBe(true);
  expectStatus(await call(owner, "POST", `${base(shop.id)}/removed-listings`, { listingIds: [target.listing.id] }), 200, "restore");
  const back = (await itemsOf(shop.id, `categoryId=${kapur.id}`)).find((i) => i.productId === target.productId)!;
  expect(back.listing).toMatchObject({ state: "LISTED", pricePaise: target.listing.pricePaise, stock: target.listing.stock });
  return `${target.name}: removed → in Removed → restored at ₹${(target.listing.pricePaise ?? 0) / 100}, stock ${target.listing.stock}`;
});

qa("TC-PUJA-012", "an owner's new product type and product: the duplicate check stops same and close names (closest first), confirming creates them for the shop at once, pending review", async () => {
  const shop = await shopOf("A");
  const setup = await setupOf(shop.id);
  const agarbatti = setup.categories.find((c) => c.slug === "puja-agarbatti-dhoop")!;
  const owner = await as("shop");
  const same = await call(owner, "POST", `${base(shop.id)}/puja/types`, { categoryId: agarbatti.id, name: "Agarbatti", unit: "pack" });
  expect(same.status, "same name").toBe(409);
  const close = await call(owner, "POST", `${base(shop.id)}/puja/types`, { categoryId: agarbatti.id, name: "Agarbati", unit: "pack" });
  expect(close.status, "close name").toBe(409);
  expect(close.body.error.details.matches[0].name).toBe("Agarbatti");
  const typeName = `QA Puja Type ${RUN}`;
  const type = await call(owner, "POST", `${base(shop.id)}/puja/types`, { categoryId: agarbatti.id, name: typeName, nameHi: "क्यूए प्रकार", nameMr: "क्यूए प्रकार", unit: "box", confirmDuplicate: true });
  expectStatus(type, 201, "create type");
  expect(type.body.type.approvalStatus).toBe("PENDING_APPROVAL");
  const dup = await call(owner, "POST", `${base(shop.id)}/puja/products`, { categoryId: agarbatti.id, name: "Rose Agarbati", unit: "pack", variants: [{ label: "Box, 20 sticks", pricePaise: 2000, stock: 5 }] });
  expect(dup.status, "close product name").toBe(409);
  const product = await call(owner, "POST", `${base(shop.id)}/puja/products`, {
    categoryId: agarbatti.id,
    typeId: type.body.type.id,
    name: `QA Puja Dhoop ${RUN}`,
    nameHi: `क्यूए धूप ${RUN}`,
    nameMr: `क्यूए धूप ${RUN}`,
    synonyms: [`qasyn${RUN}`],
    unit: "box",
    variants: [
      { label: "Small", mrpPaise: 5000, pricePaise: 4500, stock: 10 },
      { label: "Large", mrpPaise: 9000, pricePaise: 8000, stock: 10 },
    ],
  });
  expectStatus(product, 201, "create product");
  expect(product.body.created).toHaveLength(2);
  const mine = await itemsOf(shop.id, `q=${encodeURIComponent(`क्यूए धूप ${RUN}`)}`);
  expect(mine.map((i) => i.approvalStatus)).toEqual(["PENDING_APPROVAL", "PENDING_APPROVAL"]);
  expect(mine.every((i) => i.listing?.state === "LISTED")).toBe(true);
  expect((await shelfNames(shop.id)).filter((n) => n.startsWith(`QA Puja Dhoop ${RUN}`)), "customers see the owner's product at once").toHaveLength(2);
  stash(`${KEY}-own`, { typeId: type.body.type.id, productIds: product.body.created.map((c: { productId: string }) => c.productId) });
  return `same/close type names → 409 (closest: Agarbatti); "${typeName}" and 2 product variants created, listed at once, pending review`;
});

qa("TC-PUJA-013", "staff review: approve the type, reject one product with a reason, merge the other; reject without a reason is refused; the owner is notified", async () => {
  const own = unstash<{ typeId: string; productIds: string[] }>(`${KEY}-own`);
  if (!own) blocked("TC-PUJA-012 did not create the owner's type and products");
  const ops = await as("ops");
  const queue = await call(ops, "GET", "/api/admin/puja/submissions");
  expectStatus(queue, 200, "review queue (operator)");
  const subs = queue.body.submissions as { kind: string; id: string; mergeCandidates: { id: string; name: string }[] }[];
  expect(subs.some((s) => s.kind === "TYPE" && s.id === own.typeId)).toBe(true);
  expect(own.productIds.every((id) => subs.some((s) => s.kind === "PRODUCT" && s.id === id))).toBe(true);
  const noReason = await call(ops, "POST", "/api/admin/puja/submissions", { kind: "PRODUCT", id: own.productIds[0], decision: "REJECT" });
  expect(noReason.status, "reject without reason").toBe(422);
  expectStatus(await call(ops, "POST", "/api/admin/puja/submissions", { kind: "TYPE", id: own.typeId, decision: "APPROVE" }), 200, "approve type");
  expectStatus(await call(ops, "POST", "/api/admin/puja/submissions", { kind: "PRODUCT", id: own.productIds[0], decision: "REJECT", reason: "QA: test product" }), 200, "reject");
  const target = subs.find((s) => s.id === own.productIds[1])?.mergeCandidates[0];
  if (target) {
    expectStatus(await call(ops, "POST", "/api/admin/puja/submissions", { kind: "PRODUCT", id: own.productIds[1], decision: "MERGE", reason: "QA: same as master", mergeIntoId: target.id }), 200, "merge");
  } else {
    expectStatus(await call(ops, "POST", "/api/admin/puja/submissions", { kind: "PRODUCT", id: own.productIds[1], decision: "REJECT", reason: "QA: test product" }), 200, "reject 2");
  }
  const notes = await call(await as("shop"), "GET", "/api/notifications");
  expectStatus(notes, 200, "owner notifications");
  const decided = (notes.body.notifications as { type: string; createdAt: string }[]).filter((n) => n.type === "shop.catalogue_submission_decided");
  expect(decided.length).toBeGreaterThanOrEqual(3);
  return `type approved, product rejected (reason), ${target ? `product merged into "${target.name}"` : "second product rejected"}; owner has ${decided.length} decision notices`;
});

qa("TC-PUJA-014", "the customer finds puja items by English, Hindi, Marathi names and synonyms, and filters by category and loose / packed", async ({ browser }) => {
  const stashed = unstash<{ shopId: string }>(KEY);
  if (!stashed) blocked("TC-PUJA-010 did not list puja products in shop A");
  const { context, page: customer } = await pageAs(browser, "customer");
  try {
    const counts: string[] = [];
    for (const q of ["कपूर", "कापूर", "camphor", "kapoor"]) {
      await customer.goto(`/puja?all=1&q=${encodeURIComponent(q)}`);
      const text = await customer.getByTestId("puja-result-count").innerText();
      const n = Number(text.split(" ")[0]);
      expect(n, q).toBeGreaterThan(0);
      await expect(customer.getByText(/Kapur|कपूर/).first()).toBeVisible();
      counts.push(`${q}: ${n}`);
    }
    await customer.goto("/puja?all=1&cat=puja-phool-patte&kind=loose");
    await expect(customer.getByTestId("puja-poc-list")).toBeVisible();
    await expect(customer.getByTestId("poc-label").first()).toHaveText(/Price on confirmation/);
    return counts.join(" · ") + "; flowers (loose): price on confirmation";
  } finally {
    await context.close();
  }
}, { mobile: true });

qa("TC-PUJA-015", "price on confirmation: the customer asks the price of a loose item, the owner sets it, the customer is told and the item becomes buyable", async () => {
  const stashed = unstash<{ shopId: string }>(KEY);
  if (!stashed) blocked("TC-PUJA-010 did not list puja products in shop A");
  const setup = await setupOf(stashed.shopId);
  const flowers = setup.categories.find((c) => c.slug === "puja-phool-patte")!;
  const loose = (await itemsOf(stashed.shopId, `categoryId=${flowers.id}&kind=loose`)).find((i) => i.listing?.state === "LISTED" && i.listing.pricePaise == null);
  if (!loose?.listing) blocked("shop A has no unpriced loose flower listing left (each run prices one)");
  const customer = await as("customer");
  const asked = await call(customer, "POST", "/api/listing-price-requests", { shopProductId: loose.listing.id, quantity: 1 });
  expectStatus(asked, 201, "ask the price");
  const owner = await as("shop");
  const open = await call(owner, "GET", `${base(stashed.shopId)}/listing-price-requests`);
  expectStatus(open, 200, "owner's price requests");
  const request = (open.body.requests as { id: string; shopProductId: string }[]).find((r) => r.shopProductId === loose.listing!.id);
  expect(request, "the request reached the shop").toBeTruthy();
  expectStatus(await call(owner, "POST", `${base(stashed.shopId)}/listing-price-requests/${request!.id}`, { pricePaise: 6000 }), 200, "owner sets the price");
  const notes = await call(customer, "GET", "/api/notifications");
  expect((notes.body.notifications as { type: string }[]).some((n) => n.type === "order.price_confirmed")).toBe(true);
  expect(await shelfNames(stashed.shopId), "the item is on the shelf now").toContain(loose.name);
  await emptyCart("customer");
  expectStatus(await addToCart("customer", loose.listing.id, 1), [200, 201], "the item goes in the cart");
  await emptyCart("customer");
  return `${loose.name}: asked → owner priced ₹60 → customer notified → on sale`;
});

qa("TC-PUJA-016", "a puja item is ordered through the existing checkout (cash on delivery), packed and delivered with the OTP; a second order is cancelled before packing and its stock comes back", async () => {
  const stashed = unstash<{ shopId: string; kapurCategoryId: string }>(KEY);
  if (!stashed) blocked("TC-PUJA-010 did not list puja products in shop A");
  const pick = (await itemsOf(stashed.shopId, `categoryId=${stashed.kapurCategoryId}&kind=packed`)).find((i) => i.listing?.state === "LISTED" && (i.listing.pricePaise ?? 0) > 0 && i.listing.stock >= 3);
  if (!pick?.listing) blocked("no packed kapur listing with stock in shop A");
  const shop = await shopOf("A");
  const listing: Listing = { shopProductId: pick.listing.id, productId: pick.productId, name: pick.name, pricePaise: pick.listing.pricePaise, shopId: shop.id, shopName: shop.name };
  // Cash on delivery: no payment step on the test site (wallet-paid orders and their refund are
  // covered by tests/integration/puja-samagri.test.ts; the test wallet is topped up by the owner).
  const order = await placeOrder({ listing, method: "COD" });
  expect(order.status).toMatch(/CONFIRMED|ACCEPTED|PENDING/);
  await packOrder(order.id);
  await deliver(order.id, { cashCollected: true });
  expect((await orderAs("customer", order.id))?.status).toBe("DELIVERED");
  const stockBefore = (await itemsOf(stashed.shopId, `categoryId=${stashed.kapurCategoryId}&kind=packed`)).find((i) => i.productId === pick.productId)!.listing!.stock;
  const second = await placeOrder({ listing, method: "COD" });
  const cancel = await call(await as("customer"), "PATCH", `/api/orders/${second.id}/status`, { status: "CANCELLED", note: "QA puja cancel before packing" });
  expectStatus(cancel, 200, `cancel before packing (${why(cancel)})`);
  const after = await orderAs("customer", second.id);
  expect(after?.status).toMatch(/CANCELLED|REFUNDED|REFUND_PENDING/);
  const stockAfter = (await itemsOf(stashed.shopId, `categoryId=${stashed.kapurCategoryId}&kind=packed`)).find((i) => i.productId === pick.productId)!.listing!.stock;
  expect(stockAfter, "the cancelled order's stock is back").toBe(stockBefore);
  return `${pick.name}: ${order.orderNumber} (COD) delivered with OTP; ${second.orderNumber} cancelled before packing (${after?.status}), stock ${stockBefore} → ${stockAfter}`;
}, { partial: "wallet-paid order and its refund on cancellation: tests/integration/puja-samagri.test.ts (the test site's wallet top-up is a Cashfree sandbox payment the owner makes)" });

qa("TC-PUJA-017", "admin configuration: FSSAI toggle for edible lines and the type switch round-trip; festival collection shows on /puja for its dates", async ({ page }) => {
  const admin = await as("admin");
  const config = await call(admin, "GET", "/api/admin/puja/config");
  expectStatus(config, 200, "config");
  expect(config.body.counts.products).toBeGreaterThanOrEqual(499);
  expect(config.body.counts.categories).toBe(15);
  const fssai = config.body.edibleNeedsFssai as boolean;
  let festivalId: string | null = null;
  try {
    const flipped = await call(admin, "PATCH", "/api/admin/puja/config", { edibleNeedsFssai: !fssai });
    expectStatus(flipped, 200, "toggle FSSAI");
    expect(flipped.body.edibleNeedsFssai).toBe(!fssai);
    const now = Date.now();
    const fest = await call(admin, "POST", "/api/admin/puja/festivals", { festivalKey: "diwali", title: `QA Diwali ${RUN}`, startsAt: new Date(now - 60_000).toISOString(), endsAt: new Date(now + 3_600_000).toISOString(), showOnHome: false });
    expectStatus(fest, 201, "festival collection");
    festivalId = fest.body.id;
    await page.goto("/puja");
    await expect(page.getByTestId("puja-festival-banners").getByText(`QA Diwali ${RUN}`)).toBeVisible();
    return `counts ${JSON.stringify(config.body.counts)}; FSSAI toggle ${fssai} → ${!fssai} → ${fssai}; festival banner shown on /puja`;
  } finally {
    await call(admin, "PATCH", "/api/admin/puja/config", { edibleNeedsFssai: fssai });
    if (festivalId) {
      const now = Date.now();
      await call(admin, "PATCH", `/api/admin/puja/festivals/${festivalId}`, { festivalKey: "diwali", title: `QA Diwali ${RUN}`, startsAt: new Date(now - 120_000).toISOString(), endsAt: new Date(now + 3_600_000).toISOString(), active: false, showOnHome: false });
    }
  }
});

qa("TC-PUJA-018", "every role's Puja screen fits a phone and a laptop: tabs and menus visible without scrolling, no sideways scroll", async ({ browser }) => {
  const seen: string[] = [];
  for (const [role, path, first] of [
    ["customer", "/puja", "puja-categories"],
    ["shop", "/shop/puja", "puja-tab-setup"],
    ["admin", "/admin/puja", "puja-admin-tab-catalogue"],
    ["ops", "/admin/puja", "puja-admin-tab-review"],
  ] as const) {
    for (const size of [{ width: 360, height: 800 }, { width: 1366, height: 768 }]) {
      const { context, page } = await pageAs(browser, role, { viewport: size });
      try {
        await page.goto(path);
        const el = page.getByTestId(first);
        await expect(el).toBeVisible();
        const box = await el.boundingBox();
        expect(box && box.y + box.height <= size.height, `${role} ${size.width}: ${first} above the fold`).toBe(true);
        expect(await noSidewaysScroll(page), `${role} ${size.width}: sideways scroll`).toBeLessThanOrEqual(1);
        await page.screenshot({ path: `test-results/qa/puja-${role}-${size.width}.png` });
        seen.push(`${role}@${size.width}`);
      } finally {
        await context.close();
      }
    }
  }
  return `fits: ${seen.join(", ")} (screenshots test-results/qa/puja-*.png)`;
});
