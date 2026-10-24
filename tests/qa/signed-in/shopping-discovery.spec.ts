/**
 * Discovery as a signed-in customer with a delivery location: the home page,
 * the shop list (nearest first, filters, "show all"), shop and product
 * search limited to the shops that deliver, the product page's price
 * comparison, the shop page and its in-shop-only products. The guest halves
 * of TC-DISC-001/004/005/007/012/013/017/018/022 are guest/storefront.spec.ts.
 *
 * Signed-in tier. Shop settings changed for a check (shop B's radius, a
 * listing's stock, shop A's delivery options) are put back in `finally`.
 */
import type { Page } from "@playwright/test";

import { anonymous, call, expectStatus } from "../lib/http";
import { blocked, expect, need, qa } from "../lib/record";
import { BASE_URL } from "../lib/target";
import { world } from "../lib/world";
import {
  hoursClosedNow,
  listing,
  open,
  OWNER,

  shopName,
  shopSlug,
  signedPage,
  SIGNED,
  watchPage,
  withListing,
  withShop,
} from "../lib/shopping-helpers";

/** Rows of the product page's "Compare prices" card, in page order. */
async function comparisonRows(page: Page) {
  const rows = page.getByTestId("price-comparison").locator(":scope > div");
  const out: { shop: string; text: string }[] = [];
  for (let i = 0; i < (await rows.count()); i++) {
    const row = rows.nth(i);
    out.push({ shop: (await row.getByRole("link").first().innerText()).trim(), text: (await row.innerText()).replace(/\s+/g, " ") });
  }
  return out;
}

/** Shop cards in page order: name and the fulfilment line. */
async function shopCards(page: Page, scope = page.locator("main")) {
  const cards = scope.getByTestId("shop-card");
  const out: { name: string; text: string; km: number | null; delivers: boolean }[] = [];
  for (let i = 0; i < (await cards.count()); i++) {
    const text = (await cards.nth(i).innerText()).replace(/\s+/g, " ");
    const name = (await cards.nth(i).getByRole("heading").first().innerText()).trim();
    const km = text.match(/· ([\d.]+) km/)?.[1];
    out.push({ name, text, km: km ? Number(km) : null, delivers: /Delivers to you/.test(text) });
  }
  return out;
}

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

qa("TC-DISC-001", "home with a location: deliver-to bar, search first, 'Shops near you' without duplicate cards, then the shelves", async ({ browser }) => {
  const { context, page } = await signedPage(browser, "customer");
  const errors = watchPage(page);
  try {
    await open(page, "/");
    await expect(page.getByTestId("deliver-to-label")).toContainText(world().location?.pincode ?? /\d{6}/);
    await expect(page.getByRole("combobox", { name: /Search products, shops and categories/i }).first()).toBeVisible();
    const shops = page.getByTestId("home-shops");
    await expect(shops).toBeVisible();
    await expect(page.getByTestId("home-set-location")).toHaveCount(0);
    const cards = await shopCards(page, shops);
    expect(cards.length, "shops near the default address").toBeGreaterThan(0);
    const names = cards.map((c) => c.name.toLowerCase());
    expect(new Set(names).size, `duplicate shop cards: ${names.join(", ")}`).toBe(names.length);
    expect(cards.some((c) => sameName(c.name, shopName("A"))), "shop A is near the customer").toBe(true);
    await expect(page.getByTestId("popular-in-area").or(page.getByTestId("buy-again")).first()).toBeVisible();
    expect(errors, errors.join(" | ")).toEqual([]);
    return `home: deliver-to ${world().location?.pincode}, search box, ${cards.length} distinct shop cards, popular/buy-again shelf; no hydration error`;
  } finally {
    await context.close();
  }
}, { ...SIGNED, mobile: true, partial: "the featured / Kesari / Green shelves were replaced by categories, 'Shops near you' and 'Popular in your area' (docs/homepage-uiux-2026-10)" });

qa("TC-DISC-002", "/shops with a location: delivering shops first, nearest first, each with its distance", async ({ browser }) => {
  const { context, page } = await signedPage(browser, "customer");
  try {
    await open(page, "/shops");
    const cards = await shopCards(page);
    const ours = ["A", "B", "C"].map((k) => cards.find((c) => sameName(c.name, shopName(k as "A" | "B" | "C"))));
    for (const [i, card] of ours.entries()) expect(card, `shop ${"ABC"[i]} is listed`).toBeTruthy();
    for (const card of ours) expect(card!.text, `${card!.name} shows delivery and distance`).toMatch(/Delivers to you · [\d.]+ km/);
    // Delivering shops come before the others; among those with a distance, nearest first.
    const firstNotDelivering = cards.findIndex((c) => !c.delivers);
    if (firstNotDelivering >= 0) expect(cards.slice(firstNotDelivering).every((c) => !c.delivers), "delivering shops first").toBe(true);
    const distances = cards.filter((c) => c.delivers && c.km != null).map((c) => c.km!);
    expect(distances, "nearest first").toEqual([...distances].sort((a, b) => a - b));
    return `${cards.length} shops; ours: ${ours.map((c) => `${c!.name} ${c!.km} km`).join(", ")}; distances in order ${distances.join(" ≤ ")}`;
  } finally {
    await context.close();
  }
}, { ...SIGNED, mobile: true, partial: "the list also shows nearby shops that do not deliver (marked 'Pickup · outside its delivery area', after the delivering ones) — src/app/shops/page.tsx, superseding 'only delivering shops'" });

qa("TC-DISC-003", "'Show all shops' (?all=1) keeps the type filter", async ({ browser }) => {
  const { context, page } = await signedPage(browser, "customer");
  try {
    await open(page, "/shops?type=DAIRY");
    for (const card of await shopCards(page)) expect(card.text, `${card.name} is a dairy`).toMatch(/Dairy/i);
    await page.getByRole("link", { name: /^Show all/ }).click();
    await page.waitForURL(/all=1/);
    const url = new URL(page.url());
    const listed = await shopCards(page);
    expect(url.searchParams.get("type"), `the type filter after 'Show all shops' (${url.pathname}${url.search})`).toBe("DAIRY");
    for (const card of listed) expect(card.text, `${card.name} is a dairy`).toMatch(/Dairy/i);
    return `?type=DAIRY → Show all → ${url.search}, ${listed.length} dairy shops`;
  } finally {
    await context.close();
  }
}, SIGNED);

qa(["TC-DISC-004", "TC-DISC-005"], "shop search by area and type, filters by type, classification and delivery (alone and combined), and a helpful empty state", async ({ browser }) => {
  const api = await anonymous();
  const seen: string[] = [];
  try {
    const list = async (query: string) => {
      const res = await call(api, "GET", `/api/shops?${query}&limit=100`);
      expectStatus(res, 200, `/api/shops?${query}`);
      return (Array.isArray(res.body) ? res.body : (res.body?.shops ?? [])) as { name: string; shopType: string; classification: string | null; deliveryAvailable: boolean; area: string | null }[];
    };
    const byArea = await list("q=Kothrud");
    expect(byArea.some((s) => sameName(s.name, shopName("A"))), "area 'Kothrud' finds shop A").toBe(true);
    seen.push(`area Kothrud: ${byArea.length}`);
    const dairy = await list("type=DAIRY");
    expect(dairy.length).toBeGreaterThan(0);
    expect(dairy.every((s) => s.shopType === "DAIRY"), "type filter").toBe(true);
    expect(dairy.some((s) => sameName(s.name, shopName("A")))).toBe(true);
    const kesari = await list("classification=KESARI");
    expect(kesari.every((s) => s.classification === "KESARI"), "classification filter").toBe(true);
    const delivering = await list("delivery=true");
    expect(delivering.every((s) => s.deliveryAvailable), "delivery filter").toBe(true);
    const combined = await list("type=DAIRY&classification=KESARI&delivery=true");
    expect(combined.every((s) => s.shopType === "DAIRY" && s.classification === "KESARI" && s.deliveryAvailable), "combined filters").toBe(true);
    expect(combined.length).toBeLessThanOrEqual(Math.min(dairy.length, kesari.length, delivering.length));
    seen.push(`DAIRY ${dairy.length}, KESARI ${kesari.length}, delivery ${delivering.length}, all three ${combined.length}`);
  } finally {
    await api.dispose();
  }
  const { context, page } = await signedPage(browser, "customer");
  try {
    await open(page, "/shops?all=1&q=Kothrud");
    expect((await shopCards(page)).some((c) => sameName(c.name, shopName("A")))).toBe(true);
    await open(page, "/shops?all=1&q=zzqqxxnoshop");
    await expect(page.getByText("No shops match these filters.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Clear filters" })).toHaveAttribute("href", "/shops?all=1");
  } finally {
    await context.close();
  }
  return `${seen.join("; ")}; page: area search lists shop A; no match → "No shops match these filters." with Clear filters`;
}, { ...SIGNED, partial: "the Kesari/Green filter is not offered on the page (removed from the cards, src/components/shop-grid.tsx); it is checked on /api/shops" });

qa("TC-DISC-006", "product search lists only offers from shops that deliver to the customer, nearest first, with distance and 'Compare prices'", async ({ browser }) => {
  const a = listing("sharedA");
  listing("sharedB");
  need(world().users.shopB, "shop B's owner");
  // Shop B (≈1.3 km from the customer's address) stops short with a 1 km radius.
  return withShop("B", { serviceRadiusKm: 1 }, async () => {
    const { context, page } = await signedPage(browser, "customer");
    try {
      await open(page, `/search?q=${encodeURIComponent(a.name)}`);
      const cards = page.getByTestId("product-card").filter({ hasText: a.name });
      await expect(cards.first()).toBeVisible();
      const texts = await cards.allInnerTexts();
      expect(texts.some((t) => t.includes(shopName("B"))), "shop B's offer (does not deliver here) is not listed").toBe(false);
      const ours = cards.filter({ hasText: shopName("A") }).first();
      await expect(ours).toContainText(/· [\d.]+ km/);
      await expect(ours.getByRole("link", { name: /Compare prices/ })).toBeVisible();
      // ?all=1 brings shop B's offer back.
      await open(page, `/search?q=${encodeURIComponent(a.name)}&all=1`);
      await expect(page.getByTestId("product-card").filter({ hasText: a.name }).filter({ hasText: shopName("B") }).first()).toBeVisible();
      return `"${a.name}": only ${shopName("A")} (with km and Compare prices) while shop B's radius is 1 km; ?all=1 adds shop B`;
    } finally {
      await context.close();
    }
  });
}, { ...SIGNED, mobile: true });

qa(["TC-DISC-007", "TC-FLD-022"], "search box signed in: blank and no-match give clear messages, outer spaces are ignored, symbols are text", async ({ browser }) => {
  const a = listing("packaged");
  const { context, page } = await signedPage(browser, "customer");
  try {
    await open(page, "/search?q=");
    await expect(page.getByTestId("search-start")).toBeVisible();
    await open(page, "/search?q=zzqqxxnotaproduct");
    await expect(page.getByTestId("search-no-results")).toContainText("zzqqxxnotaproduct");
    await open(page, `/search?q=${encodeURIComponent(`   ${a.name}   `)}`);
    await expect(page.getByRole("heading", { name: `Results for "${a.name}"` })).toBeVisible();
    await expect(page.getByTestId("product-card").filter({ hasText: a.name }).first()).toBeVisible();
    // "%" and "_" are characters to look for, not wildcards: nothing is named with them.
    const counts: string[] = [];
    let matched = 0;
    for (const q of ["%", "_", "%%_"]) {
      await open(page, `/search?q=${encodeURIComponent(q)}`);
      const found = (await page.getByTestId("product-card").count()) + (await page.getByTestId("shop-card").count());
      matched += found;
      counts.push(`"${q}" → ${found} results${found ? "" : " (no-results message)"}`);
    }
    expect(matched, `symbols act as LIKE wildcards and match every product/shop: ${counts.join("; ")}`).toBe(0);
    return `blank → start prompt; no match → "Nothing found for …"; outer spaces trimmed; ${counts.join("; ")}`;
  } finally {
    await context.close();
  }
}, { ...SIGNED, partial: "script and Hindi inputs (escaped, no script) are the guest check in guest/storefront.spec.ts" });

qa(["TC-DISC-008", "TC-DISC-009"], "product page lists every shop selling it with price, distance and delivers-to-you; buyable+delivering first, then price; 'Lowest price' on the cheapest", async ({ browser }) => {
  const a = listing("sharedA");
  const b = listing("sharedB");
  const { context, page } = await signedPage(browser, "customer");
  try {
    await open(page, `/search?q=${encodeURIComponent(a.name)}`);
    await page.getByTestId("product-card").filter({ hasText: a.name }).first().getByRole("link", { name: /Compare/ }).click();
    await page.waitForURL(new RegExp(`/(products/${a.productId}|search/compare)`));
    if (!page.url().includes(`/products/${a.productId}`)) await open(page, `/products/${a.productId}`);
    const rows = await comparisonRows(page);
    const rowA = rows.find((r) => r.shop === shopName("A"));
    const rowB = rows.find((r) => r.shop === shopName("B"));
    expect(rowA, "shop A listed").toBeTruthy();
    expect(rowB, "shop B listed").toBeTruthy();
    for (const [row, item] of [[rowA!, a], [rowB!, b]] as const) {
      expect(row.text).toMatch(/[\d.]+ km away · Delivers to you/);
      expect(row.text).toContain(`₹${item.pricePaise! / 100}`);
    }
    const cheaper = a.pricePaise! <= b.pricePaise! ? rowA! : rowB!;
    const dearer = cheaper === rowA ? rowB! : rowA!;
    expect(rows.indexOf(cheaper), "cheaper first").toBeLessThan(rows.indexOf(dearer));
    expect(cheaper.text).toContain("Lowest price");
    expect(dearer.text).not.toContain("Lowest price");
    return rows.map((r) => r.text.slice(0, 90)).join(" | ");
  } finally {
    await context.close();
  }
}, { ...SIGNED, mobile: true, partial: "the plan's 'Shop B cheaper' data is the other way round here (A ₹40, B ₹45): the same rule is asserted on the cheaper shop" });

qa("TC-DISC-011", "comparison: out-of-stock, in-shop-only and unpriced rows are shown, marked not available online, and sort after buyable rows", async ({ browser }) => {
  const a = listing("sharedA");
  const b = listing("sharedB");
  const ghee = listing("premium");
  listing("offlineOnly");
  const sugar = listing("unpricedLoose");
  return withListing(OWNER.B, "B", b, { onlineStock: 0 }, { onlineStock: b.stock ?? 60 }, async () => {
    const { context, page } = await signedPage(browser, "customer");
    try {
      await open(page, `/products/${a.productId}`);
      let rows = await comparisonRows(page);
      const outOfStock = rows.findIndex((r) => r.shop === shopName("B"));
      expect(outOfStock, "out-of-stock row still shown").toBeGreaterThanOrEqual(0);
      expect(rows[outOfStock].text).toContain("Not available online");
      expect(rows[outOfStock].text).not.toContain("Lowest price");
      expect(outOfStock, "after the buyable row").toBeGreaterThan(rows.findIndex((r) => r.shop === shopName("A")));

      await open(page, `/products/${ghee.productId}`);
      rows = await comparisonRows(page);
      const inShop = rows.findIndex((r) => r.shop === shopName("B"));
      expect(inShop, "in-shop-only row shown").toBeGreaterThanOrEqual(0);
      expect(rows[inShop].text).toMatch(/Not available online.*In-shop price only/);
      expect(inShop).toBeGreaterThan(rows.findIndex((r) => r.shop === shopName("A")));
      await expect(page.getByRole("heading", { name: "Buy from" })).toBeVisible();

      await open(page, `/products/${sugar.productId}`);
      rows = await comparisonRows(page);
      const unpriced = rows.find((r) => r.shop === shopName("A"));
      expect(unpriced?.text).toContain("Not available online");
      await expect(page.getByText("No shop can deliver this to you online right now")).toBeVisible();
    } finally {
      await context.close();
    }
    return "bread: B out of stock → marked, after A; ghee: B in-shop only → marked, after A; sugar (no price): marked, no 'Buy from'";
  });
}, { ...SIGNED, mobile: true });

qa(["TC-DISC-012"], "a malformed product id shows the branded 404 page, not a 500", async ({ browser }) => {
  const { context, page } = await signedPage(browser, "customer");
  try {
    for (const path of ["/products/not-a-uuid", "/products/00000000-0000-4000-8000-000000000000"]) {
      const res = await page.goto(path);
      expect(res?.status(), path).toBe(404);
      await expect(page.locator("body")).not.toContainText(/Internal Server Error|at .*\.js:\d+/);
    }
  } finally {
    await context.close();
  }
  return "/products/not-a-uuid and a random uuid → 404 (signed in)";
}, SIGNED);

qa("TC-DISC-013", "shop page: profile, catalogue, opening hours with the closed-now state, delivery fee and free-above threshold, pickup-only", async ({ browser }) => {
  const shown: string[] = [];
  await withShop("A", { deliveryFeePaise: 2000, freeDeliveryAbovePaise: 30000, openingHours: hoursClosedNow() }, async () => {
    const { context, page } = await signedPage(browser, "customer");
    try {
      await open(page, `/shops/${shopSlug("A")}`);
      await expect(page.getByRole("heading", { name: shopName("A"), level: 1 })).toBeVisible();
      await expect(page.getByText("Closed", { exact: true }).first()).toBeVisible();
      await expect(page.getByTestId("shop-delivery-line")).toHaveText("Delivery ₹20, free above ₹300");
      await expect(page.getByTestId("shop-products").getByTestId("product-card").first()).toBeVisible();
      await page.getByText("Shop info, opening hours and reviews").click();
      const info = page.getByTestId("shop-info");
      await expect(info).toContainText("Owner / Proprietor");
      await expect(info).toContainText(/Mon: 06:00–22:00/);
      await expect(info).toContainText(/: Closed/);
      shown.push("Closed badge, Delivery ₹20, free above ₹300, products, owner, hours");
    } finally {
      await context.close();
    }
  });
  await withShop("A", { deliveryAvailable: false }, async () => {
    const { context, page } = await signedPage(browser, "customer");
    try {
      await open(page, `/shops/${shopSlug("A")}`);
      await expect(page.getByTestId("shop-delivery-line")).toHaveText("Pickup only");
      await expect(page.getByText("Open now", { exact: true }).first()).toBeVisible();
      shown.push("delivery off → Pickup only, Open now");
    } finally {
      await context.close();
    }
  });
  return shown.join("; ");
}, { ...SIGNED, mobile: true, partial: "rating with recent reviews needs a delivered, rated order: local/shopping-delivery-leg.spec.ts; minimum order: next check" });

qa("TC-DISC-013", "shop page shows the shop's minimum order value", async ({ browser }) => {
  return withShop("A", { minOrderPaise: 15000 }, async () => {
    const { context, page } = await signedPage(browser, "customer");
    try {
      await open(page, `/shops/${shopSlug("A")}`);
      await page.getByText("Shop info, opening hours and reviews").click();
      const header = page.locator("main").locator("div.p-6").first();
      await expect(header, "minimum order ₹150 shown on the shop page (src/app/shops/[slug]/page.tsx renders fee, free-above and pickup only)").toContainText(/minimum|min\.? order/i, { timeout: 5_000 });
      await expect(header).toContainText("₹150");
      return "minimum order ₹150 shown";
    } finally {
      await context.close();
    }
  });
}, SIGNED);

qa("TC-DISC-014", "an in-shop-only product is shown on the shop page with 'In-shop only', a disabled control and no 'Add to cart'", async ({ browser }) => {
  const item = listing("offlineOnly");
  need(world().shops.B, "shop B");
  const { context, page } = await signedPage(browser, "customer");
  try {
    await open(page, `/shops/${shopSlug("B")}`);
    let card = page.getByTestId("product-card").filter({ hasText: item.name });
    for (let p = 2; (await card.count()) === 0 && p <= 5; p++) {
      const next = page.getByRole("link", { name: String(p), exact: true });
      if (!(await next.count())) break;
      await next.first().click();
      await page.waitForLoadState("networkidle").catch(() => {});
      card = page.getByTestId("product-card").filter({ hasText: item.name });
    }
    if ((await card.count()) === 0) blocked(`"${item.name}" is not on shop B's page`);
    await expect(card.first().getByRole("button", { name: "In-shop only" })).toBeDisabled();
    await expect(card.first().getByRole("button", { name: "Add to cart" })).toHaveCount(0);
    await expect(card.first()).toContainText(/in shop/i);
    return `${item.name} at ${shopName("B")}: 'In-shop only' disabled, no Add to cart`;
  } finally {
    await context.close();
  }
}, { ...SIGNED, mobile: true });

qa("TC-DISC-017", "category pages signed in: /dairy opens the Dairy category, its products link to working product pages", async ({ browser }) => {
  const { context, page } = await signedPage(browser, "customer");
  try {
    await page.goto("/dairy");
    await page.waitForURL(/\/category\/DAIRY/);
    const cards = page.getByTestId("product-card");
    await expect(cards.first()).toBeVisible();
    const count = await cards.count();
    const link = cards.first().getByRole("link", { name: /Compare/ }).first();
    const href = await link.getAttribute("href");
    expect(href).toMatch(/^\/(products\/|search\/compare\?product=)/);
    await open(page, href!);
    await expect(page.getByRole("heading").first()).toBeVisible();
    return `/dairy → /category/DAIRY, ${count} cards on page 1; ${href} opens`;
  } finally {
    await context.close();
  }
}, { ...SIGNED, partial: "the category page lists products of every shop, not only the ones near the customer (src/app/category/[type]/page.tsx)" });

qa("TC-DISC-022", "a PIN no shop delivers to: a clear 'no shops near this location' state, no empty shelf", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: BASE_URL });
  const page = await context.newPage();
  try {
    expect((await page.request.post("/api/location", { data: { pincode: "799001" } })).status()).toBe(200);
    await open(page, "/");
    await expect(page.getByTestId("home-shops")).toContainText(/No shops near this location yet/i);
    await expect(page.getByTestId("home-shops").getByTestId("shop-card")).toHaveCount(0);
    await open(page, "/search/compare");
    await expect(page.getByText("Nothing to compare yet.")).toBeVisible();
    return "PIN 799001: home says 'No shops near this location yet…', compare page 'Nothing to compare yet.'";
  } finally {
    await context.close();
  }
}, { ...SIGNED, mobile: true, partial: "unpriced / out-of-stock / non-delivering listings in the comparison: local/shopping-rules.spec.ts (rule homePriceComparison)" });
