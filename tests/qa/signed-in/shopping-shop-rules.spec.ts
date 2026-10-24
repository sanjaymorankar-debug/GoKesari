/**
 * The shop's own delivery rules and how customers meet them: the delivery
 * radius (and its boundaries), extra delivery PIN zones, the minimum order,
 * "pause new orders", ordering from a closed shop, and opening hours judged
 * in IST. The shop owner changes them in /shop/manage/location (or the API);
 * the customer side is checked on /shops, /cart and POST /api/checkout.
 *
 * Signed-in tier: shop A's owner on shop A, the customer on their own cart.
 * Every setting is put back in `finally`; orders placed are cancelled.
 */
import type { Page } from "@playwright/test";

import { expectStatus, RUN, why } from "../lib/http";
import { expect, qa } from "../lib/record";
import { BASE_URL } from "../lib/target";
import {
  cancelOwn,
  cartGroup,
  cartOf,
  checkoutAs,
  clearCart,
  fillCart,
  hhmm,
  homeAddressId,
  hoursClosedNow,
  istNow,
  listing,
  open,
  ordersOf,
  patchShop,
  payOnCartPage,
  pointNorth,
  shopAsOwner,
  shopId,
  shopName,
  shopSlug,
  signedPage,
  SIGNED,
  validateCart,
  watchPage,
  withAddresses,
  withShop,
} from "../lib/shopping-helpers";

const FAR = { pincode: "411057", latitude: 18.5913, longitude: 73.7389 };

/** Shop A's location settings page, as its owner. */
async function locationForm(page: Page) {
  await open(page, "/shop/manage/location");
  const radius = page.getByTestId("service-radius");
  await expect(radius).toBeVisible();
  return {
    radius,
    zones: page.getByTestId("delivery-zones"),
    minOrder: page.getByTestId("min-order"),
    pause: page.getByLabel(/Pause new orders/),
    save: async () => {
      await page.getByRole("button", { name: "Save location" }).click();
      await expect(page.getByText("Saved.").or(page.getByRole("alert")).first()).toBeVisible();
    },
  };
}

/** The customer's /shops card for shop A at a location (own browser context). */
async function shopACardAt(page: Page, at: { latitude: number; longitude: number; pincode?: string | null }) {
  expect((await page.request.post("/api/location", { data: { ...at, label: "QA point" } })).status()).toBe(200);
  await open(page, "/shops");
  return page.getByTestId("shop-card").filter({ hasText: shopName("A") });
}

qa("TC-LOC-011", "the shop owner sets the delivery radius to 2, 50 and 1 km in the Location card; each is saved", async ({ browser }) => {
  const original = (await shopAsOwner("A")).serviceRadiusKm;
  const { context, page } = await signedPage(browser, "shop");
  try {
    const form = await locationForm(page);
    for (const km of [2, 50, 1]) {
      await form.radius.fill(String(km));
      await form.save();
      await expect(page.getByText("Saved.")).toBeVisible();
      expect((await shopAsOwner("A")).serviceRadiusKm, `radius ${km} saved`).toBe(km);
      await page.reload();
      await expect(page.getByTestId("service-radius")).toHaveValue(String(km));
    }
    return "2, 50 and 1 km saved from /shop/manage/location and shown after reload";
  } finally {
    await context.close();
    await patchShop("A", { serviceRadiusKm: original });
  }
}, { ...SIGNED, partial: "the audit entry with the previous value is checked in local/shopping-rules.spec.ts (needs the database)" });

qa("TC-LOC-012", "radius 0, 51, 2.5, −1 and empty are refused (422) and the stored radius is unchanged", async ({ browser }) => {
  const before = (await shopAsOwner("A")).serviceRadiusKm;
  const seen: string[] = [];
  for (const value of [0, 51, 2.5, -1, "", null]) {
    const res = await patchShop("A", { serviceRadiusKm: value });
    expect(res.status, `radius ${JSON.stringify(value)}: ${why(res)}`).toBe(422);
    seen.push(`${JSON.stringify(value)}→422`);
  }
  expect((await shopAsOwner("A")).serviceRadiusKm, "unchanged").toBe(before);
  const { context, page } = await signedPage(browser, "shop");
  try {
    const form = await locationForm(page);
    await form.radius.fill("51");
    await page.getByRole("button", { name: "Save location" }).click();
    await expect(page.getByRole("alert").first()).toBeVisible();
    await expect(page.getByText("Saved.")).toHaveCount(0);
    expect((await shopAsOwner("A")).serviceRadiusKm).toBe(before);
  } finally {
    await context.close();
  }
  return `${seen.join(", ")}; the form shows an error for 51; radius stays ${before} km`;
}, SIGNED);

qa("TC-LOC-014", "radius 2 km: addresses 1.9 and 2.0 km away are served, 2.1 km is not; the distance shown is the straight-line distance", async ({ browser }) => {
  const results: string[] = [];
  await fillCart("customer", [{ item: listing("packaged"), quantity: 1 }]);
  try {
    await withShop("A", { serviceRadiusKm: 2 }, () =>
      withAddresses(
        "customer",
        [1.9, 2.0, 2.1].map((km) => ({ ...pointNorth(km), line1: `QA ${km} km ${RUN}` })),
        async (saved) => {
          for (const [i, km] of [1.9, 2.0, 2.1].entries()) {
            const check = (await validateCart("customer", saved[i].id)).shops.find((s) => s.shopName === shopName("A"))!;
            expect(check.distanceKm, `distance at ${km} km`).toBe(km);
            expect(check.eligible, `served at ${km} km`).toBe(km <= 2);
            const context = await browser.newContext({ baseURL: BASE_URL });
            const page = await context.newPage();
            try {
              const card = await shopACardAt(page, pointNorth(km));
              await expect(card.first()).toContainText(km <= 2 ? `Delivers to you · ${km === 2 ? "2" : km} km` : `outside its delivery area · ${km} km`);
            } finally {
              await context.close();
            }
            results.push(`${km} km → ${check.eligible ? "served" : "not served"}`);
          }
        },
      ),
    );
  } finally {
    await clearCart("customer");
  }
  return results.join(", ");
}, SIGNED);

qa("TC-LOC-015", "an extra delivery PIN zone beyond the radius: after the shop adds the customer's PIN, the shop appears for it and checkout is allowed", async ({ browser }) => {
  const item = listing("packaged");
  return withAddresses("customer", [{ ...FAR, line1: `QA zone ${RUN}`, area: "Hinjewadi" }], async ([far]) => {
    await fillCart("customer", [{ item, quantity: 1 }]);
    const before = (await validateCart("customer", far.id)).shops.find((s) => s.shopName === shopName("A"))!;
    expect(before.eligible, "outside the radius at first").toBe(false);
    const original = (await shopAsOwner("A")).deliveryPincodes ?? [];
    const { context: shopCtx, page: shopPage } = await signedPage(browser, "shop");
    let orderId: string | null = null;
    try {
      const form = await locationForm(shopPage);
      await form.zones.fill(FAR.pincode);
      await form.save();
      await expect(shopPage.getByText("Saved.")).toBeVisible();
      expect((await shopAsOwner("A")).deliveryPincodes).toContain(FAR.pincode);
      const after = (await validateCart("customer", far.id)).shops.find((s) => s.shopName === shopName("A"))!;
      expect(after.eligible, "served through the extra zone").toBe(true);
      const context = await browser.newContext({ baseURL: BASE_URL });
      const page = await context.newPage();
      try {
        const card = await shopACardAt(page, FAR);
        await expect(card.first()).toContainText("Delivers to you");
      } finally {
        await context.close();
      }
      const res = await checkoutAs("customer", { addressId: far.id, paymentMethod: "WALLET" });
      expectStatus(res, 201, "checkout to the extra zone");
      orderId = res.body.orders[0].id;
      return `${FAR.pincode} (12 km): not served → zone added in the Location card → listed as delivering, checkout ${res.body.orders[0].orderNumber}`;
    } finally {
      await shopCtx.close();
      if (orderId) await cancelOwn("customer", orderId);
      await patchShop("A", { deliveryPincodes: original });
      await clearCart("customer");
    }
  });
}, SIGNED);

qa("TC-LOC-022", "minimum order ₹200: below it the cart says 'add ₹X more' with Add items and pay disabled, the API refuses; exactly ₹200 is allowed", async ({ browser }) => {
  const bread = listing("sharedA");
  const price = bread.pricePaise!;
  const exact = Math.ceil(20000 / price);
  return withShop("A", { minOrderPaise: price * exact }, async () => {
    const min = price * exact;
    await fillCart("customer", [{ item: bread, quantity: 2 }]);
    const short = min - 2 * price;
    const { context, page } = await signedPage(browser, "customer");
    let orderId: string | null = null;
    try {
      await open(page, "/cart");
      const warning = cartGroup(page, shopName("A")).getByTestId("delivery-warning");
      await expect(warning).toContainText(`needs a minimum order of ₹${min / 100} — add ₹${short / 100} more`);
      await expect(warning.getByRole("button", { name: "Add items" })).toBeVisible();
      await expect(page.getByRole("button", { name: /Pay from wallet/ })).toBeDisabled();
      const refused = await checkoutAs("customer", { addressId: await homeAddressId(), paymentMethod: "WALLET" });
      expect(refused.status, why(refused)).toBe(422);
      expect(refused.body?.error?.message).toMatch(/minimum order/i);
      await warning.getByRole("button", { name: "Add items" }).click();
      await page.waitForURL(new RegExp(`/shops/${shopSlug("A")}`));
      await fillCart("customer", [{ item: bread, quantity: exact }]);
      await open(page, "/cart");
      await expect(cartGroup(page, shopName("A")).getByTestId("delivery-warning")).toHaveCount(0);
      await expect(page.getByRole("button", { name: /Pay from wallet/ })).toBeEnabled();
      const res = await checkoutAs("customer", { addressId: await homeAddressId(), paymentMethod: "WALLET" });
      expectStatus(res, 201, `exactly ₹${min / 100}`);
      orderId = res.body.orders[0].id;
      return `minimum ₹${min / 100}: cart ₹${(2 * price) / 100} → 'add ₹${short / 100} more' + Add items (to the shop page), pay disabled, API 422; exactly ₹${min / 100} → order placed`;
    } finally {
      await context.close();
      if (orderId) await cancelOwn("customer", orderId);
      await clearCart("customer");
    }
  });
}, { ...SIGNED, partial: "the pickup exemption is TC-CART-016 in shopping-cart.spec.ts; ₹200 is rounded up to a whole number of the ₹40 test bread (₹200)" });

qa("TC-LOC-023", "pause new orders: the shop leaves the delivering lists, the cart says 'not taking new orders' with 'Remove these items', checkout refuses; un-pausing restores everything", async ({ browser }) => {
  const item = listing("packaged");
  await fillCart("customer", [{ item, quantity: 1 }]);
  const { context: shopCtx, page: shopPage } = await signedPage(browser, "shop");
  const { context, page } = await signedPage(browser, "customer");
  let orderId: string | null = null;
  try {
    let form = await locationForm(shopPage);
    await form.pause.check();
    await form.save();
    expect((await shopAsOwner("A")).ordersPaused).toBe(true);

    await open(page, "/shops");
    await expect(page.getByTestId("shop-card").filter({ hasText: shopName("A") }).first()).toContainText("Not taking orders online right now");
    await open(page, "/shops?delivery=true");
    await expect(page.getByTestId("shop-card").filter({ hasText: shopName("A") })).toHaveCount(0);
    await open(page, "/cart");
    const warning = cartGroup(page, shopName("A")).getByTestId("delivery-warning");
    await expect(warning).toContainText("is not taking new orders right now");
    await expect(warning.getByRole("button", { name: "Remove these items" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Pay from wallet/ })).toBeDisabled();
    const refused = await checkoutAs("customer", { addressId: await homeAddressId(), paymentMethod: "WALLET" });
    expect([409, 422], why(refused)).toContain(refused.status);
    expect(refused.body?.error?.message).toMatch(/not taking new orders/i);

    form = await locationForm(shopPage);
    await form.pause.uncheck();
    await form.save();
    expect((await shopAsOwner("A")).ordersPaused).toBe(false);
    await open(page, "/shops");
    await expect(page.getByTestId("shop-card").filter({ hasText: shopName("A") }).first()).toContainText("Delivers to you");
    await open(page, "/cart");
    await expect(cartGroup(page, shopName("A")).getByTestId("delivery-warning")).toHaveCount(0);
    const res = await checkoutAs("customer", { addressId: await homeAddressId(), paymentMethod: "WALLET" });
    expectStatus(res, 201, "after un-pausing");
    orderId = res.body.orders[0].id;
    return "paused: 'Not taking orders online right now' on /shops, gone from ?delivery=true, cart warning + Remove these items, pay disabled, checkout refused; un-paused: all back, order placed";
  } finally {
    await shopCtx.close();
    await context.close();
    await patchShop("A", { ordersPaused: false });
    if (orderId) await cancelOwn("customer", orderId);
    await clearCart("customer");
  }
}, { ...SIGNED, partial: "a paused shop is still listed on /shops, marked 'Not taking orders online right now' (src/components/shop-grid-view.tsx), and is absent from the delivering filter" });

qa("TC-LOC-024", "a closed shop: the cart says it might be closed and when it opens; pay → No keeps the cart, Yes places the order; the API without the acknowledgement answers 409", async ({ browser }) => {
  const item = listing("packaged");
  return withShop("A", { openingHours: hoursClosedNow() }, async () => {
    await fillCart("customer", [{ item, quantity: 1 }]);
    const noAck = await checkoutAs("customer", { addressId: await homeAddressId(), paymentMethod: "WALLET" });
    expect(noAck.status, why(noAck)).toBe(409);
    expect(noAck.body?.error?.message).toMatch(/closed right now/i);
    const { context, page } = await signedPage(browser, "customer");
    let orderId: string | null = null;
    try {
      await open(page, "/cart");
      const warning = cartGroup(page, shopName("A")).getByTestId("delivery-warning");
      await expect(warning).toContainText(/might be closed right now \(opens \w{3} 6:00 AM\)/);
      await payOnCartPage(page, "no");
      await expect(page.getByTestId("shop-closed-confirm")).toHaveCount(0);
      expect((await cartOf()).groups.length, "No keeps the cart").toBe(1);
      await payOnCartPage(page, "yes");
      await page.waitForURL(/\/orders/, { timeout: 30_000 });
      const orders = await ordersOf();
      const placed = orders.find((o) => o.shopId === shopId("A") && o.status === "CONFIRMED");
      orderId = placed?.id ?? null;
      expect(placed, "Yes placed the order").toBeTruthy();
      return `API without ack → 409 "${noAck.body.error.message.slice(0, 60)}…"; cart 'might be closed (opens … 6:00 AM)'; No keeps the cart; Yes → ${placed!.orderNumber}`;
    } finally {
      await context.close();
      if (orderId) await cancelOwn("customer", orderId);
      await clearCart("customer");
    }
  });
}, { ...SIGNED, mobile: true });

qa("TC-LOC-026", "opening hours are judged in IST: no hours = open; a closed day is closed whatever the browser's time zone, with no hydration error", async ({ browser }) => {
  const seen: string[] = [];
  for (const timezoneId of ["Asia/Kolkata", "America/Los_Angeles", "Pacific/Kiritimati"]) {
    const { context, page } = await signedPage(browser, "customer", { timezoneId });
    const errors = watchPage(page);
    try {
      await open(page, `/shops/${shopSlug("A")}`);
      await expect(page.getByText("Open now", { exact: true }).first(), `no hours → open (${timezoneId})`).toBeVisible();
      await withShop("A", { openingHours: hoursClosedNow() }, async () => {
        await open(page, `/shops/${shopSlug("A")}`);
        await expect(page.getByText("Closed", { exact: true }).first(), `closed today in IST (${timezoneId})`).toBeVisible();
        await open(page, "/shops");
        await expect(page.getByTestId("shop-card").filter({ hasText: shopName("A") }).first()).toContainText(/Closed · opens \w{3} 6:00 AM/);
      });
      expect(errors, `${timezoneId}: ${errors.join(" | ")}`).toEqual([]);
      seen.push(timezoneId);
    } finally {
      await context.close();
    }
  }
  return `browser zones ${seen.join(", ")}: no hours → Open now; today closed (IST) → Closed / 'Closed · opens … 6:00 AM'; no hydration errors`;
}, { ...SIGNED, mobile: true, partial: "hours that cross midnight: next check" });

qa("TC-LOC-026", "hours that cross midnight (e.g. 18:00–02:00) count as open between the opening time and the closing time after midnight", async ({ browser }) => {
  const now = istNow();
  const days = [0, 1, 2, 3, 4, 5, 6];
  // Evening: open since an hour ago, closing at 02:00 tonight. Morning: yesterday's hours run until an hour from now.
  const evening = now.minutes >= 12 * 60;
  const hours = evening
    ? days.map((day) => ({ day, open: day === now.day ? hhmm(now.minutes - 60) : "06:00", close: day === now.day ? "02:00" : "22:00" }))
    : days.map((day) => (day === (now.day + 6) % 7 ? { day, open: "22:00", close: hhmm(now.minutes + 60) } : day === now.day ? { day, open: "23:00", close: "23:30", closed: true } : { day, open: "06:00", close: "22:00" }));
  const describe = evening ? `today ${hhmm(now.minutes - 60)}–02:00` : `yesterday 22:00–${hhmm(now.minutes + 60)}`;
  return withShop("A", { openingHours: hours }, async () => {
    const { context, page } = await signedPage(browser, "customer");
    try {
      await open(page, `/shops/${shopSlug("A")}`);
      const closed = await page.getByText("Closed", { exact: true }).count();
      await expect(page.getByText("Open now", { exact: true }).first(), `IST ${hhmm(now.minutes)} is within ${describe}, but the shop page shows ${closed ? "Closed" : "no Open now badge"} (src/lib/shop-hours.ts isShopOpenNow compares open ≤ now ≤ close on one day)`).toBeVisible({ timeout: 5_000 });
      return `IST ${hhmm(now.minutes)} with hours ${describe}: Open now`;
    } finally {
      await context.close();
    }
  });
}, SIGNED);
