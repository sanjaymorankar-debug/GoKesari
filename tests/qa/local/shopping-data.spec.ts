/**
 * Shopping checks that need the local server's database, secret or global
 * rules: the audit row of a radius change, a shop without coordinates, shops
 * that are pickup-only, pending or suspended, the closed-shop alerts and their
 * cron, two customers racing for the last unit, the no-address prompt, pack
 * sizes, a broken product image, and the rider's routing and navigation with
 * the routing service unavailable.
 *
 * Local tier. Data arranged in the database is put back in `finally`.
 */
import { as } from "../lib/actors";
import { db } from "../lib/db";
import { deliveryCode, offerFor, onlyRiderOnline, pickupCode, riderAction } from "../lib/flows";
import { call, expectStatus, RUN, why } from "../lib/http";
import { messagesTo } from "../lib/mail";
import { blocked, expect, need, qa } from "../lib/record";
import { BASE_URL } from "../lib/target";
import { world } from "../lib/world";
import {
  cancelAsShop,
  cancelOwn,
  checkoutAs,
  clearCart,
  fillCart,
  homeAddressId,
  hoursClosedNow,
  listing,
  LOCAL,
  open,
  OWNER,
  patchShop,
  pointNorth,
  shopAsOwner,
  shopId,
  shopName,
  shopSlug,
  signedPage,
  validateCart,
  walletOf,
  withAddresses,
  withListing,
  withRules,
  withSecondBuyer,
  withShop,
} from "../lib/shopping-helpers";

qa("TC-LOC-011", "each radius change leaves an audit entry with the previous and the new value", async () => {
  const before = (await shopAsOwner("A")).serviceRadiusKm;
  const since = new Date();
  try {
    for (const km of [2, 50, 1]) expectStatus(await patchShop("A", { serviceRadiusKm: km }), 200, `radius ${km}`);
  } finally {
    await patchShop("A", { serviceRadiusKm: before });
  }
  const rows = await db()`select previous_value, new_value, actor_id from audit_logs
    where entity_type = 'shop' and entity_id = ${shopId("A")} and action = 'shop.updated' and created_at >= ${since} order by created_at`;
  const steps = rows.map((r) => `${(r.previous_value as { serviceRadiusKm: number }).serviceRadiusKm}→${(r.new_value as { serviceRadiusKm: number }).serviceRadiusKm}`);
  expect(steps.slice(0, 4)).toEqual([`${before}→2`, "2→50", "50→1", `1→${before}`]);
  expect(rows.every((r) => r.actor_id === world().users.shop?.id), "the owner is the actor").toBe(true);
  return `audit rows: ${steps.join(", ")} (actor: the shop owner)`;
}, LOCAL);

qa("TC-LOC-016", "a shop without coordinates is matched by PIN only: listed for its own PIN, not for another", async ({ browser }) => {
  const id = shopId("C");
  const [shop] = await db()`select latitude, longitude from shops where id = ${id}`;
  await db()`update shops set latitude = null, longitude = null where id = ${id}`;
  try {
    const seen: string[] = [];
    for (const [pincode, listed] of [[world().location!.pincode, true], ["411045", false]] as [string, boolean][]) {
      const context = await browser.newContext({ baseURL: BASE_URL });
      const page = await context.newPage();
      try {
        expect((await page.request.post("/api/location", { data: { pincode } })).status()).toBe(200);
        await open(page, "/shops");
        const card = page.getByTestId("shop-card").filter({ hasText: shopName("C") });
        if (listed) {
          await expect(card.first()).toContainText("Delivers to you");
          await expect(card.first()).not.toContainText(" km");
        } else await expect(card).toHaveCount(0);
        seen.push(`PIN ${pincode}: ${listed ? "listed, delivers, no distance" : "not listed"}`);
      } finally {
        await context.close();
      }
    }
    return seen.join("; ");
  } finally {
    await db()`update shops set latitude = ${shop.latitude as string}, longitude = ${shop.longitude as string} where id = ${id}`;
  }
}, LOCAL);

qa("TC-LOC-017", "a shop with delivery off is never listed as delivering; pending and suspended shops are not listed at all, also with ?all=1", async ({ browser }) => {
  const pending = need(world().shops.pending, "the pending shop");
  const seen: string[] = [];
  const { context, page } = await signedPage(browser, "customer");
  try {
    await withShop("C", { deliveryAvailable: false }, async () => {
      await open(page, "/shops");
      const card = page.getByTestId("shop-card").filter({ hasText: shopName("C") });
      await expect(card.first()).toContainText("Pickup only");
      await expect(card.first()).not.toContainText("Delivers to you");
      await open(page, "/shops?delivery=true");
      await expect(page.getByTestId("shop-card").filter({ hasText: shopName("C") })).toHaveCount(0);
      seen.push("delivery off: 'Pickup only', not in the delivering filter");
    });
    const absent = async (name: string, what: string) => {
      for (const path of ["/shops", "/shops?all=1", `/shops?all=1&q=${encodeURIComponent(name)}`, `/search?q=${encodeURIComponent(name)}&all=1`]) {
        await open(page, path);
        await expect(page.getByTestId("shop-card").filter({ hasText: name }), `${what} on ${path}`).toHaveCount(0);
      }
      const api = await call(await as("customer"), "GET", `/api/shops?q=${encodeURIComponent(name)}`);
      expect(JSON.stringify(api.body)).not.toContain(name);
    };
    await absent(pending.name, "pending shop");
    const slug = await call(await as("customer"), "GET", `/shops/${pending.slug}`);
    expect(slug.status, "pending shop page").toBe(404);
    seen.push("pending: absent from /shops, ?all=1, search and the API; its page 404");
    const suspend = await call(await as("admin"), "POST", `/api/shops/${shopId("C")}/suspend`, { reason: "QA visibility check" });
    expectStatus(suspend, 200, "suspend shop C");
    try {
      await absent(shopName("C"), "suspended shop");
      seen.push("suspended: absent everywhere");
    } finally {
      expectStatus(await call(await as("admin"), "POST", `/api/shops/${shopId("C")}/reactivate`, { note: "QA visibility check done" }), 200, "reactivate shop C");
    }
  } finally {
    await context.close();
  }
  return seen.join("; ");
}, LOCAL);

qa("TC-LOC-025", "an order placed while the shop is closed: shop and customer are told at once; when the shop opens, one 'orders waiting' and one 'shop now open' — never twice", async () => {
  const item = listing("packaged");
  const since = Date.now();
  const cron = async () => {
    const res = await call(await as("customer"), "POST", "/api/cron/notifications", undefined, { headers: { authorization: `Bearer ${process.env.CRON_SECRET ?? blocked("CRON_SECRET is not set")}` } });
    expectStatus(res, 200, "notifications cron");
    return res.body;
  };
  const titles = async (role: "shop" | "customer", number: string) => {
    const res = await call(await as(role), "GET", "/api/notifications");
    expectStatus(res, 200, "notifications");
    return (res.body.notifications as { title: string; body: string; createdAt: string }[]).filter((n) => n.body.includes(number)).map((n) => n.title);
  };
  let orderId: string | null = null;
  try {
    let number = "";
    await withShop("A", { openingHours: hoursClosedNow() }, async () => {
      await fillCart("customer", [{ item, quantity: 1 }]);
      const res = await checkoutAs("customer", { addressId: await homeAddressId(), paymentMethod: "WALLET", acknowledgeClosedShopIds: [shopId("A")] });
      expectStatus(res, 201, "order while closed");
      orderId = res.body.orders[0].id;
      number = res.body.orders[0].orderNumber;
      expect(await titles("shop", number)).toContain("New order while your shop is closed");
      expect(await titles("customer", number)).toContain("Order placed — shop is closed now");
      // While still closed the sweep sends nothing.
      await cron();
      expect(await titles("shop", number)).not.toContain("Your shop is open — orders are waiting");
    });
    // The shop is open again (hours restored): the sweep alerts once, however often it runs.
    const first = await cron();
    await cron();
    const shop = await titles("shop", number);
    const customer = await titles("customer", number);
    expect(shop.filter((t) => t === "Your shop is open — orders are waiting"), `shop: ${shop.join(" | ")}`).toHaveLength(1);
    expect(customer.filter((t) => t === "The shop is open now"), `customer: ${customer.join(" | ")}`).toHaveLength(1);
    const mails = messagesTo(need(world().users.shop, "shop owner").email, since).filter((m) => m.body.includes(number)).length;
    return `${number}: at once → shop 'New order while your shop is closed', customer 'Order placed — shop is closed now'; on opening (cron ×2, ${JSON.stringify(first.opening)}) → exactly one 'orders waiting' and one 'shop is open now'; ${mails} e-mail(s) to the shop mentioning it`;
  } finally {
    if (orderId) await cancelOwn("customer", orderId);
    await clearCart("customer");
  }
}, { ...LOCAL, partial: "e-mail delivery is recorded in the detail (count of mails to the shop owner), not asserted" });

qa("TC-CART-013", "two customers pay for the last unit at the same moment: one order, the other OUT_OF_STOCK with no debit", async () => {
  const item = listing("lowStock");
  return withListing(OWNER.A, "A", item, { onlineStock: 1 }, { onlineStock: item.stock ?? 2 }, () =>
    withSecondBuyer(async (address2) => {
      await fillCart("customer", [{ item, quantity: 1 }]);
      await fillCart("customer2", [{ item, quantity: 1 }]);
      const wallets = { customer: await walletOf("customer"), customer2: await walletOf("customer2") };
      const [r1, r2] = await Promise.all([
        checkoutAs("customer", { addressId: await homeAddressId(), paymentMethod: "WALLET" }),
        checkoutAs("customer2", { addressId: address2, paymentMethod: "WALLET" }),
      ]);
      const won = [r1, r2].filter((r) => r.status === 201);
      try {
        expect(won.length, `${why(r1)} / ${why(r2)}`).toBe(1);
        const lost = r1.status === 201 ? r2 : r1;
        const loser = r1.status === 201 ? "customer2" : "customer";
        expect(lost.status).toBe(409);
        expect(lost.body?.error?.code, why(lost)).toMatch(/OUT_OF_STOCK|CONFLICT|PRODUCT_NOT_PURCHASABLE_ONLINE/);
        expect(await walletOf(loser), "no debit for the loser").toBe(wallets[loser]);
        return `stock 1: one 201, the other ${lost.status} ${lost.body.error.code} "${lost.body.error.message}", loser's wallet unchanged`;
      } finally {
        for (const r of won) await cancelAsShop("shop", r.body.orders[0].id);
        await clearCart("customer");
      }
    }),
  );
}, LOCAL);

qa("TC-CART-015", "an account with a mobile but no saved address sees 'Add a delivery address' instead of pay", async ({ browser }) => {
  const user = need(world().users.customer2, "customer 2");
  const phone = `+9176${String(Date.now()).slice(-8)}`;
  const addresses = await db()`select id from addresses where user_id = ${user.id!} and deleted_at is null`;
  await db()`update users set phone = ${phone.slice(3)}, phone_e164 = ${phone} where id = ${user.id!}`;
  await db()`update addresses set deleted_at = now() where user_id = ${user.id!} and deleted_at is null`;
  try {
    await fillCart("customer2", [{ item: listing("packaged"), quantity: 1 }]);
    const { context, page } = await signedPage(browser, "customer2");
    try {
      await open(page, "/cart");
      const prompt = page.getByTestId("checkout-missing-details");
      await expect(prompt).toContainText("Add a delivery address before ordering.");
      await expect(prompt.getByRole("link", { name: "Add address" })).toHaveAttribute("href", "/profile/addresses");
      await expect(prompt).not.toContainText("mobile number");
      await expect(page.getByRole("button", { name: /Pay from wallet/ })).toHaveCount(0);
    } finally {
      await context.close();
    }
    return "mobile set, no address: 'Add a delivery address before ordering.' + Add address, no pay button";
  } finally {
    for (const a of addresses) await db()`update addresses set deleted_at = null where id = ${a.id as string}`;
    await db()`update users set phone = null, phone_e164 = null where id = ${user.id!}`;
    await clearCart("customer2");
  }
}, LOCAL);

qa("TC-DISC-010", "a 500 ml pack: the comparison shows the price per litre and the price of the pack", async ({ browser }) => {
  const milk = listing("milk");
  await db()`update products set unit_size_milli = 500 where id = ${milk.productId}`;
  try {
    const { context, page } = await signedPage(browser, "customer");
    try {
      await open(page, `/products/${milk.productId}`);
      const row = page.getByTestId("price-comparison").locator(":scope > div").filter({ hasText: shopName("A") }).first();
      await expect(row).toContainText(`₹${milk.pricePaise! / 100} / L`);
      await expect(row).toContainText(`₹${milk.pricePaise! / 200} per 0.5 L`);
    } finally {
      await context.close();
    }
    return `pack 500 ml: "₹${milk.pricePaise! / 100} / L" and "₹${milk.pricePaise! / 200} per 0.5 L" on the comparison`;
  } finally {
    await db()`update products set unit_size_milli = 1000 where id = ${milk.productId}`;
  }
}, { ...LOCAL, partial: "a 500 ml and a 1 L pack are two catalogue products, so they never meet on one comparison; each row shows the per-unit and the pack price so they compare fairly" });

qa("TC-DISC-018", "a product photo whose URL is broken falls back to a neutral placeholder, never a broken-image icon", async ({ browser }) => {
  const butter = listing("packaged");
  const [row] = await db()`select image_url from shop_products where id = ${butter.shopProductId}`;
  await db()`update shop_products set image_url = ${`/qa-missing-${RUN}.jpg`} where id = ${butter.shopProductId}`;
  try {
    const { context, page } = await signedPage(browser, "customer");
    try {
      const results: string[] = [];
      for (const path of [`/shops/${shopSlug("A")}`, `/search?q=${encodeURIComponent(butter.name)}`]) {
        await open(page, path);
        const card = page.locator(`[data-testid="product-card"][data-product-name="${butter.name}"]`).first();
        await card.scrollIntoViewIfNeeded();
        // Give the image time to fail and a late onError time to swap in the fallback.
        await page.waitForTimeout(2000);
        const state = await card.evaluate((el) => {
          const img = el.querySelector("img");
          return {
            fallback: Boolean(el.querySelector('[data-testid="image-fallback"]')),
            broken: img ? img.complete && img.naturalWidth === 0 && !img.src.startsWith("data:") : false,
            src: img?.getAttribute("src") ?? null,
          };
        });
        expect(state.broken, `${path}: the ${butter.name} card shows a broken image (${state.src}) instead of the placeholder`).toBe(false);
        expect(state.fallback || state.src?.startsWith("data:"), `${path}: placeholder shown`).toBe(true);
        results.push(path.split("?")[0]);
      }
      // The product page (no category tile) uses the grey placeholder.
      await open(page, `/products/${butter.productId}?shop=${shopSlug("A")}`);
      await page.waitForTimeout(2000);
      const broken = await page.evaluate(() => [...document.images].filter((i) => i.complete && i.naturalWidth === 0 && !i.src.startsWith("data:")).map((i) => i.src));
      expect(broken, `product page: broken images ${broken.join(", ")}`).toEqual([]);
      results.push("/products/[id]");
      return `broken photo URL: placeholder on ${results.join(", ")}`;
    } finally {
      await context.close();
    }
  } finally {
    await db()`update shop_products set image_url = ${(row?.image_url as string | null) ?? null} where id = ${butter.shopProductId}`;
  }
}, { ...LOCAL, mobile: true, partial: "the 'no image at all' half is the guest check in guest/storefront.spec.ts" });

qa("TC-LOC-029", "road distance and routed arrival time for customer and rider", async () => {
  if (!process.env.GOOGLE_MAPS_SERVER_API_KEY) {
    blocked("needs a routing provider: GOOGLE_MAPS_SERVER_API_KEY (Google Routes) or a reachable OSRM server — the local server has neither and no outbound internet; the straight-line fallback is TC-LOC-031");
  }
  blocked("a routing key is set, but the routed ETA must be compared on a live delivery with real roads (staging)");
}, LOCAL);

qa(["TC-LOC-031", "TC-LOC-032", "TC-LOC-030"], "routing on but unreachable: list, cart and checkout use the same straight-line rule, nothing fails; the rider gets in-app navigation to the shop, then (only after pickup) to the customer, re-routed off the route, plus the Google Maps link", async ({ browser }) => {
  await onlyRiderOnline("rider");
  const item = listing("packaged");
  const at = pointNorth(4.9);
  return withRules(
    {
      routing: { enabled: true, provider: "osrm", osrmBaseUrl: "http://127.0.0.1:9", timeoutMs: 500, cacheSeconds: 0 },
      riderNavigation: { enabled: true, provider: "mock" },
    },
    () =>
      withAddresses("customer", [{ ...at, line1: `QA 4.9 km ${RUN}` }], async ([address]) => {
        const notes: string[] = [];
        // LOC-032: one rule everywhere — straight-line km against the radius.
        const context = await browser.newContext({ baseURL: BASE_URL });
        const page = await context.newPage();
        try {
          expect((await page.request.post("/api/location", { data: { ...at, label: "QA 4.9 km" } })).status()).toBe(200);
          await open(page, "/shops?delivery=true");
          await expect(page.getByTestId("shop-card").filter({ hasText: shopName("A") }).first()).toContainText("Delivers to you · 4.9 km");
        } finally {
          await context.close();
        }
        await fillCart("customer", [{ item, quantity: 1 }]);
        const check = (await validateCart("customer", address.id)).shops.find((s) => s.shopName === shopName("A"))!;
        expect(check.eligible && check.distanceKm === 4.9, "cart: straight-line 4.9 km, served").toBe(true);
        const windows = await call(await as("customer"), "GET", `/api/checkout/delivery-windows?shopId=${shopId("A")}`);
        expectStatus(windows, 200, "delivery windows with routing down");
        const res = await checkoutAs("customer", { addressId: address.id, paymentMethod: "WALLET" });
        expectStatus(res, 201, "checkout with routing down");
        const order = res.body.orders[0];
        notes.push(`list, cart and checkout all straight-line (4.9 km ≤ 5); checkout ${order.orderNumber} with OSRM unreachable`);
        let delivered = false;
        try {
          for (const action of ["accept", "start", "ready"]) expectStatus(await call(await as("shop"), "POST", `/api/orders/${order.id}/fulfilment`, { action }), 200, `shop ${action}`);
          const offer = await offerFor(order.id, "rider");
          if (offer.status === "OFFERED") expectStatus(await riderAction(offer.deliveryOrderId, "accept"), 200, "rider accepts");
          const nav = async (q = "") => {
            const r = await call(await as("rider"), "GET", `/api/delivery-orders/${offer.deliveryOrderId}/navigation${q}`);
            expectStatus(r, 200, `navigation ${q}`);
            return r;
          };
          const toShop = await nav();
          expect(toShop.body.leg).toBe("TO_SHOP");
          expect(toShop.body.destination.latitude).toBeCloseTo(world().location!.lat, 3);
          expect(toShop.body.route.polyline.length, "a route is drawn").toBeGreaterThan(0);
          expect(toShop.body.googleMapsUrl).toMatch(/^https:\/\/www\.google\.com\/maps\/dir\//);
          expect(toShop.text, "customer's location not given before pickup").not.toContain(String(at.latitude).slice(0, 7));
          const off = await nav(`?lat=${world().location!.lat + 0.02}&lng=${world().location!.lng + 0.02}`);
          expect(off.body.origin.latitude, "re-routed from where the rider is").toBeCloseTo(world().location!.lat + 0.02, 4);
          expect(off.body.route.polyline).not.toBe(toShop.body.route.polyline);
          const dash = await call(await as("rider"), "GET", "/delivery-partner", undefined, { maxRedirects: 2 });
          expectStatus(dash, 200, "rider dashboard with routing down");
          expect(dash.text, "Google Maps link on the rider's job").toContain("https://www.google.com/maps/dir/");
          const code = await pickupCode(order.id);
          expectStatus(await riderAction(offer.deliveryOrderId, "pickup", code ? { pickupCode: code } : {}), 200, "pickup");
          const toCustomer = await nav();
          expect(toCustomer.body.leg).toBe("TO_CUSTOMER");
          expect(toCustomer.body.destination.latitude).toBeCloseTo(at.latitude, 4);
          notes.push(`navigation: TO_SHOP (${toShop.body.route.provider}, ${toShop.body.route.distanceMeters} m) → re-routed from an off-route point → after pickup TO_CUSTOMER; Google Maps link on the dashboard`);
          expectStatus(await riderAction(offer.deliveryOrderId, "start"), 200, "start");
          const otp = await deliveryCode(order.id);
          expectStatus(await riderAction(offer.deliveryOrderId, "deliver", { otp }), 200, "deliver");
          delivered = true;
        } finally {
          if (!delivered) await cancelAsShop("shop", order.id);
          await clearCart("customer");
        }
        return notes.join("; ");
      }),
  );
}, { ...LOCAL, timeout: 300_000, partial: "routing reachable (a real road route, 'far by road' addresses) needs a routing provider — see TC-LOC-029; the 'approximate' marker is the tracking map's 'in a straight line' and is not shown at checkout, which shows no ETA" });
