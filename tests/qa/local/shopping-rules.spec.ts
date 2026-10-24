/**
 * Shopping features behind business rules that are off by default, switched
 * on for the check and restored in `finally`: order-level coupons (F7),
 * scheduled delivery slots and slot capacity (GS-027 / F5), one parent
 * reference for a multi-shop order (F6), shop offers (F8), the price
 * comparison (F9) and external reference prices (dropped, F1.4.3).
 *
 * Local tier: changes /admin/settings and slot limits, and uses the local
 * database to give customer 2 a mobile number for the two-customer races.
 */
import type { Page } from "@playwright/test";

import { as } from "../lib/actors";
import { db } from "../lib/db";
import { deliver, onlyRiderOnline, packOrder } from "../lib/flows";
import { call, expectStatus, poll, RUN, why, type Answer } from "../lib/http";
import { expect, need, qa } from "../lib/record";
import { world } from "../lib/world";
import {
  cancelAsShop,
  cancelOwn,
  cartGroup,
  cartOf,
  checkoutAs,
  clearCart,
  fillCart,
  homeAddressId,
  listing,
  LOCAL,
  open,
  ordersOf,
  OWNER,
  payOnCartPage,
  rupees,
  shopId,
  shopName,
  shopSlug,
  signedPage,
  walletOf,
  withListing,
  withRules,
  withSecondBuyer,
  withShop,
} from "../lib/shopping-helpers";

/* ---------------------------------------------------------------- coupons */

interface CouponBody {
  code: string;
  description?: string;
  discountType: "FLAT" | "PERCENT";
  percent?: number | null;
  flatPaise?: number | null;
  minOrderPaise?: number;
  startsAt?: string | null;
  expiresAt?: string | null;
  usageLimit?: number | null;
  perCustomerLimit?: number | null;
  active?: boolean;
}

/** Creates coupons (admin), runs `fn` with rule "coupons" on, then switches them off again. */
async function withCoupons<T>(list: CouponBody[], fn: (codes: string[]) => Promise<T>): Promise<T> {
  return withRules({ coupons: { enabled: true } }, async () => {
    const created: { id: string; body: CouponBody }[] = [];
    try {
      for (const body of list) {
        const res = await call(await as("admin"), "POST", "/api/admin/coupons", body);
        expectStatus(res, 201, `create coupon ${body.code}`);
        created.push({ id: res.body.id, body });
      }
      return await fn(list.map((c) => c.code));
    } finally {
      for (const c of created) await call(await as("admin"), "PUT", `/api/admin/coupons/${c.id}`, { ...c.body, active: false });
    }
  });
}

const code = (tag: string) => `QA${tag}${RUN}`.toUpperCase().slice(0, 32);
const DAY = 86_400_000;

async function preview(couponCode: string, role: "customer" | "customer2" = "customer"): Promise<Answer> {
  return call(await as(role), "POST", "/api/checkout/coupon", { code: couponCode, requestId: `qa-${RUN}-preview-${couponCode.length}` });
}

/** A ₹300 cart: 4 × bread (₹40) + 2 × milk (₹70). */
async function cart300() {
  return fillCart("customer", [
    { item: listing("sharedA"), quantity: 4 },
    { item: listing("milk"), quantity: 2 },
  ]);
}

qa(["TC-CART-019", "TC-CART-027"], "a 10%-off-above-₹200 coupon on a ₹300 cart: ₹30 off shown before paying, the order charged ₹270, the code recorded and its use counted", async ({ browser }) => {
  const ten = code("TEN");
  return withCoupons([{ code: ten, discountType: "PERCENT", percent: 10, minOrderPaise: 20000, perCustomerLimit: 1 }], async () => {
    const cart = await cart300();
    expect(cart.subtotalPaise).toBe(30000);
    const start = await walletOf();
    const { context, page } = await signedPage(browser, "customer");
    let orderId: string | null = null;
    try {
      await open(page, "/cart");
      await page.getByTestId("coupon-input").fill(ten.toLowerCase());
      await page.getByRole("button", { name: "Apply" }).click();
      await expect(page.getByTestId("coupon-discount")).toContainText(`Coupon ${ten}`);
      await expect(page.getByTestId("coupon-discount")).toContainText(rupees(3000));
      await expect(page.getByText("Grand total").locator("..")).toContainText(rupees(cart.grandTotalPaise - 3000));
      await payOnCartPage(page);
      await page.waitForURL(/\/orders/, { timeout: 30_000 });
      const order = (await ordersOf()).find((o) => o.couponCode === ten);
      expect(order, "the order carries the coupon").toBeTruthy();
      orderId = order!.id;
      expect(order!.discountPaise).toBe(3000);
      expect(order!.totalPaise).toBe(cart.grandTotalPaise - 3000);
      expect(await walletOf(), "charged the discounted total").toBe(start - order!.totalPaise);
      await open(page, "/orders");
      await expect(page.getByTestId("order-card").filter({ hasText: order!.orderNumber }).first()).toContainText(`${ten} · saved ${rupees(3000)}`);
      const uses = ((await call(await as("admin"), "GET", "/api/admin/coupons")).body.coupons as { code: string; uses: number }[]).find((c) => c.code === ten)?.uses;
      expect(uses, "use counted").toBe(1);
      return `${ten} on ₹300: −₹30 shown, order ${order!.orderNumber} ${rupees(order!.totalPaise)}, wallet debited the same, admin shows 1 use`;
    } finally {
      await context.close();
      if (orderId) await cancelOwn("customer", orderId);
      await clearCart("customer");
    }
  });
}, { ...LOCAL, mobile: true, partial: "TC-CART-019 'vouchers still apply to wallet top-ups': the voucher field on /wallet is checked in the next check" });

qa("TC-CART-019", "with coupons off there is no coupon box; with them on the cart offers it; the wallet top-up keeps its voucher field", async ({ browser }) => {
  await fillCart("customer", [{ item: listing("packaged"), quantity: 1 }]);
  const { context, page } = await signedPage(browser, "customer");
  try {
    await open(page, "/cart");
    await expect(page.getByTestId("coupon-input"), "rule off: no coupon box").toHaveCount(0);
    const refused = await preview("ANYCODE");
    expect(refused.status, why(refused)).toBe(422);
    await withRules({ coupons: { enabled: true } }, async () => {
      await page.reload();
      await expect(page.getByTestId("coupon-input")).toBeVisible();
    });
    await open(page, "/wallet");
    await expect(page.getByLabel("Voucher code")).toBeVisible();
    return "rule off: no box, codes refused ('Coupons aren't available'); on: box shown; /wallet still has the voucher field";
  } finally {
    await context.close();
    await clearCart("customer");
  }
}, LOCAL);

qa(["TC-CART-028", "TC-FLD-130"], "coupon refusals: unknown, expired, not yet started, minimum not met, already used — each with its own message, total unchanged; blank = no discount; case and outer spaces handled; long or script text never a 500", async ({ browser }) => {
  const [used, expired, future, big] = [code("USED"), code("OLD"), code("NEW"), code("MIN")];
  return withCoupons(
    [
      { code: used, discountType: "FLAT", flatPaise: 1000, perCustomerLimit: 1 },
      { code: expired, discountType: "FLAT", flatPaise: 1000, startsAt: new Date(Date.now() - 3 * DAY).toISOString(), expiresAt: new Date(Date.now() - DAY).toISOString() },
      { code: future, discountType: "FLAT", flatPaise: 1000, startsAt: new Date(Date.now() + DAY).toISOString() },
      { code: big, discountType: "FLAT", flatPaise: 1000, minOrderPaise: 100000 },
    ],
    async () => {
      // Use `used` once.
      await fillCart("customer", [{ item: listing("packaged"), quantity: 1 }]);
      const first = await checkoutAs("customer", { addressId: await homeAddressId(), paymentMethod: "WALLET", couponCode: used });
      expectStatus(first, 201, "first use");
      await cancelOwn("customer", first.body.orders[0].id);
      const cart = await cart300();
      const messages: Record<string, string> = {};
      for (const [what, value, status] of [
        ["unknown", "NOSUCHCODE1", 422],
        ["expired", expired, 422],
        ["not started", future, 422],
        ["minimum not met", big, 422],
        ["already used", used, 409],
        ["blank", "", 422],
        ["100 characters", "X".repeat(100), 422],
        ["script", "<script>alert(1)</script>", 422],
      ] as [string, string, number][]) {
        const res = await preview(value);
        expect(res.status, `${what}: ${why(res)}`).toBe(status);
        messages[what] = res.body?.error?.message ?? "";
      }
      const distinct = ["unknown", "expired", "not started", "minimum not met", "already used"].map((k) => messages[k]);
      expect(new Set(distinct).size, `one message per reason: ${distinct.join(" | ")}`).toBe(5);
      expect(messages["minimum not met"]).toMatch(/minimum order of ₹1,000/);
      // Lower case with outer spaces is the same code; a blank code at checkout simply gives no discount.
      const same = await preview(`  ${big.toLowerCase()}  `);
      expect(same.body?.error?.message, "case and spaces normalised").toBe(messages["minimum not met"]);
      expect((await cartOf()).grandTotalPaise, "total unchanged").toBe(cart.grandTotalPaise);
      const blank = await checkoutAs("customer", { addressId: await homeAddressId(), paymentMethod: "WALLET", couponCode: "" });
      expectStatus(blank, 201, "checkout with a blank coupon");
      expect(blank.body.orders[0].discountPaise ?? 0, "no discount").toBe(0);
      await cancelOwn("customer", blank.body.orders[0].id);
      const tooLong = await checkoutAs("customer", { addressId: await homeAddressId(), paymentMethod: "WALLET", couponCode: "Y".repeat(100) });
      expect(tooLong.status, "100-character coupon at checkout").toBe(422);
      // The page shows the refusal as plain text.
      await cart300();
      const { context, page } = await signedPage(browser, "customer");
      let alerted = false;
      page.on("dialog", async (d) => {
        alerted = true;
        await d.dismiss();
      });
      try {
        await open(page, "/cart");
        await page.getByTestId("coupon-input").fill("<script>alert(1)</script>");
        await page.getByRole("button", { name: "Apply" }).click();
        await expect(page.getByText(/coupon code isn't valid|check the highlighted/i).first()).toBeVisible();
        expect(alerted).toBe(false);
        await expect(page.getByText("Grand total").locator("..")).toContainText(rupees(cart.grandTotalPaise));
      } finally {
        await context.close();
        await clearCart("customer");
      }
      return Object.entries(messages).map(([k, v]) => `${k}: "${v}"`).join("; ");
    },
  );
}, { ...LOCAL, partial: "'a coupon for another shop' does not exist: coupons are order-level and platform-wide (src/server/services/coupons.ts, marketplace-features-2026-10 F7)" });

qa("TC-CART-029", "coupon limits: a coupon larger than the cart never takes the total below the delivery fee; only one code per order; a cancelled order does not give the use back", async () => {
  const huge = code("HUGE");
  const once = code("ONCE");
  return withShop("A", { deliveryFeePaise: 2000, freeDeliveryAbovePaise: null }, () =>
    withCoupons(
      [
        { code: huge, discountType: "FLAT", flatPaise: 1_000_000, perCustomerLimit: null },
        { code: once, discountType: "FLAT", flatPaise: 500, perCustomerLimit: 1 },
      ],
      async () => {
        const item = listing("packaged");
        await fillCart("customer", [{ item, quantity: 1 }]);
        const res = await checkoutAs("customer", { addressId: await homeAddressId(), paymentMethod: "WALLET", couponCode: huge });
        expectStatus(res, 201, "coupon larger than the cart");
        const order = res.body.orders[0];
        await cancelOwn("customer", order.id);
        expect(order.discountPaise, "discount capped at the goods").toBe(item.pricePaise);
        expect(order.totalPaise, "total = delivery fee, never below zero").toBe(2000);
        await fillCart("customer", [{ item, quantity: 1 }]);
        const two = await checkoutAs("customer", { addressId: await homeAddressId(), paymentMethod: "WALLET", couponCode: [huge, once] });
        expect(two.status, "two codes in one request").toBe(422);
        const joined = await checkoutAs("customer", { addressId: await homeAddressId(), paymentMethod: "WALLET", couponCode: `${huge},${once}` });
        expect(joined.status, "two codes joined").toBe(422);
        const used = await checkoutAs("customer", { addressId: await homeAddressId(), paymentMethod: "WALLET", couponCode: once });
        expectStatus(used, 201, "use the one-time code");
        await cancelOwn("customer", used.body.orders[0].id);
        await fillCart("customer", [{ item, quantity: 1 }]);
        const again = await preview(once);
        expect(again.status, `reuse after cancelling: ${why(again)}`).toBe(409);
        await clearCart("customer");
        return `₹10,000 off a ₹${item.pricePaise! / 100} order → discount ₹${item.pricePaise! / 100}, total ₹20 (fee); two codes → 422; one-time code after a cancelled order → 409 "${again.body.error.message}"`;
      },
    ),
  );
}, { ...LOCAL, partial: "'cancelling restores the use' superseded: a use is one checkout and is not returned on cancellation (docs/marketplace-features-2026-10/README.md, Decisions); settlement: next check" });

qa(["TC-CART-029", "TC-CART-030"], "a couponed two-line order: a removed line is refunded at most what was paid, the rest on cancellation, never more than charged; when delivered, the platform bears the discount and the shop is paid the full goods", async () => {
  const off = code("SPLIT");
  return withCoupons([{ code: off, discountType: "FLAT", flatPaise: 2000, perCustomerLimit: null }], async () => {
    const butter = listing("packaged");
    const bread = listing("sharedA");
    await fillCart("customer", [{ item: butter, quantity: 1 }, { item: bread, quantity: 1 }]);
    const start = await walletOf();
    const res = await checkoutAs("customer", { addressId: await homeAddressId(), paymentMethod: "WALLET", couponCode: off });
    expectStatus(res, 201, "couponed order");
    const order = res.body.orders[0];
    const charged = start - (await walletOf());
    expect(charged).toBe(butter.pricePaise! + bread.pricePaise! - 2000);
    // The shop removes the bread line, then the order is cancelled.
    const items = (await ordersOf()).find((o) => o.id === order.id)!.items!;
    const breadLine = items.find((i) => i.productNameSnapshot === bread.name)!;
    expectStatus(await call(await as("shop"), "POST", `/api/orders/${order.id}/fulfilment`, { action: "accept" }), 200, "accept");
    expectStatus(await call(await as("shop"), "POST", `/api/orders/${order.id}/fulfilment`, { action: "remove", itemId: breadLine.id, reason: "Out of stock" }), 200, "remove a line");
    const afterLine = await walletOf();
    const lineRefund = afterLine - (start - charged);
    expect(lineRefund, "line refund never above the line").toBeLessThanOrEqual(bread.pricePaise!);
    await cancelAsShop("shop", order.id);
    const refunded = (await walletOf()) - (start - charged);
    expect(refunded, "total refunds equal what was charged, never more").toBe(charged);

    // Settlement of a delivered couponed order.
    await onlyRiderOnline("rider");
    await fillCart("customer", [{ item: butter, quantity: 2 }]);
    const paid = await checkoutAs("customer", { addressId: await homeAddressId(), paymentMethod: "WALLET", couponCode: off });
    expectStatus(paid, 201, "second couponed order");
    const second = paid.body.orders[0];
    await packOrder(second.id);
    await deliver(second.id);
    const [fin] = await db()`select goods_paise, discount_paise, commission_paise, shop_payable_paise from order_financials where order_id = ${second.id}`;
    expect(fin, "finance snapshot on delivery").toBeTruthy();
    expect(Number(fin.discount_paise)).toBe(2000);
    expect(Number(fin.goods_paise), "goods at full value").toBe(2 * butter.pricePaise!);
    expect([Number(fin.goods_paise), Number(fin.goods_paise) - Number(fin.commission_paise)], "shop paid on the full goods (less commission), not on the discounted total").toContain(Number(fin.shop_payable_paise));
    const [platform] = await db()`select amount_paise from finance_ledger_entries where order_id = ${second.id} and entity_type = 'PLATFORM' and entry_type = 'PROMOTIONAL_DISCOUNT'`;
    expect(Number(platform?.amount_paise), "platform ledger carries the discount").toBe(2000);
    return `charged ${rupees(charged)}; bread removed → ${rupees(lineRefund)} back (line ${rupees(bread.pricePaise!)}); cancel → total ${rupees(refunded)} = charged; delivered ${second.orderNumber}: discount ₹20 on the platform ledger, shop payable = goods ${rupees(Number(fin.goods_paise))} − commission`;
  });
}, { ...LOCAL, timeout: 300_000, partial: "refunds are capped at what was paid (the discount is used up by the last lines refunded — fulfilment.ts refundLine, README Decisions) rather than split pro rata" });

/* ----------------------------------------------------------- delivery slots */

interface Slot {
  key: string;
  date: string;
  label: string;
  remaining: number | null;
}

async function slotsFor(role: "customer" | "customer2" = "customer"): Promise<{ enabled: boolean; slots: Slot[] }> {
  const res = await call(await as(role), "GET", `/api/checkout/scheduled-slots?shopId=${shopId("A")}`);
  expectStatus(res, 200, "scheduled slots");
  return res.body;
}

function tomorrowIst() {
  return new Date(Date.now() + 330 * 60_000 + DAY).toISOString().slice(0, 10);
}

/** Scheduled slots on; with `perSlot`, shop A's slots take that many orders (capacity row removed afterwards). */
async function withSlots<T>(perSlot: number | null, fn: () => Promise<T>): Promise<T> {
  return withRules({ scheduledSlots: { enabled: true }, ...(perSlot != null ? { deliverySlots: { enabled: true } } : {}) }, async () => {
    let capacityId: string | null = null;
    if (perSlot != null) {
      const res = await call(await as("admin"), "PUT", "/api/admin/delivery-slots", { shopId: shopId("A"), expressPerHour: null, standardPerHour: null, scheduledPerDay: null, scheduledPerSlot: perSlot });
      expectStatus(res, 200, "slot capacity for shop A");
      capacityId = res.body.id;
    }
    try {
      return await fn();
    } finally {
      if (capacityId) await call(await as("admin"), "DELETE", `/api/admin/delivery-slots/${capacityId}`);
    }
  });
}

async function bookSlot(role: "customer" | "customer2", addressId: string, slotKey: string) {
  return checkoutAs(role, { addressId, paymentMethod: "WALLET", deliveryWindows: { [shopId("A")]: "SCHEDULED" }, scheduledSlots: { [shopId("A")]: slotKey } });
}

qa(["TC-CART-020", "TC-FLD-131"], "a scheduled slot for tomorrow: pay waits until a time is chosen; the order carries the slot; the shop sees it; no rider is sought until shortly before it", async ({ browser }) => {
  return withSlots(null, async () => {
    const { enabled, slots } = await slotsFor();
    expect(enabled).toBe(true);
    const slot = slots.find((s) => s.date === tomorrowIst());
    expect(slot, `a slot tomorrow (${tomorrowIst()}) among ${slots.length}`).toBeTruthy();
    await fillCart("customer", [{ item: listing("packaged"), quantity: 1 }]);
    const { context, page } = await signedPage(browser, "customer");
    let orderId: string | null = null;
    try {
      await open(page, "/cart");
      const group = cartGroup(page, shopName("A"));
      await group.getByRole("button", { name: "Scheduled" }).click();
      const picker = group.getByTestId("slot-picker");
      await expect(picker).toBeVisible();
      await expect(picker).toContainText("Pick a delivery time to place the order.");
      await expect(page.getByRole("button", { name: /Pay from wallet/ }), "a slot is required").toBeDisabled();
      await picker.getByRole("button", { name: slot!.label.split(", ")[0] }).click();
      await picker.getByTestId(`slot-${slot!.key}`).click();
      await expect(page.getByRole("button", { name: /Pay from wallet/ })).toBeEnabled();
      await payOnCartPage(page);
      await page.waitForURL(/\/orders/, { timeout: 30_000 });
      const order = (await ordersOf()).find((o) => o.scheduledSlotStart && o.shopId === shopId("A") && o.status === "CONFIRMED");
      expect(order, "order with the slot").toBeTruthy();
      orderId = order!.id;
      await open(page, "/orders");
      await expect(page.getByTestId("order-card").filter({ hasText: order!.orderNumber }).first()).toContainText(`Delivery ${slot!.label}`);
      // Shop sees it; at READY no rider is sought (the slot is tomorrow).
      const shop = await signedPage(browser, "shop");
      try {
        await open(shop.page, "/shop/orders");
        await expect(shop.page.getByText(`Deliver ${slot!.label}`).first()).toBeVisible();
      } finally {
        await shop.context.close();
      }
      await packOrder(order!.id);
      const offered = await poll(async () => (await call(await as("rider"), "GET", "/api/delivery-partner/deliveries")).body?.active?.orderId === order!.id, (v) => v, 8_000);
      expect(offered, "no rider offer a day ahead of the slot").toBe(false);
      return `slot ${slot!.label}: pay disabled until chosen; order ${order!.orderNumber} shows 'Delivery ${slot!.label}'; shop sees 'Deliver …'; READY → no rider offer yet`;
    } finally {
      await context.close();
      if (orderId) await cancelAsShop("shop", orderId);
      await clearCart("customer");
    }
  });
}, { ...LOCAL, mobile: true, partial: "the rider sees the slot once dispatch starts (dispatchLeadMinutes before it), which a same-day run cannot reach for a slot tomorrow" });

qa(["TC-CART-022", "TC-FLD-131"], "invalid slots are refused with a reason and no order: past, outside the shop's hours, made up, malformed", async () => {
  return withSlots(null, async () => {
    await fillCart("customer", [{ item: listing("packaged"), quantity: 1 }]);
    const address = await homeAddressId();
    const yesterday = new Date(Date.now() + 330 * 60_000 - DAY).toISOString().slice(0, 10);
    const before = (await ordersOf()).length;
    const seen: string[] = [];
    for (const [what, key, status] of [
      ["yesterday", `${yesterday}@10:00`, 422],
      ["after closing (default hours 08:00–20:00)", `${tomorrowIst()}@21:00`, 422],
      ["off the slot grid", `${tomorrowIst()}@09:17`, 422],
      ["beyond the days offered", "2030-01-01@10:00", 422],
      ["impossible time", `${tomorrowIst()}@25:00`, 422],
      ["malformed", "tomorrow-morning", 422],
    ] as [string, string, number][]) {
      const res = await bookSlot("customer", address, key);
      expect(res.status, `${what} (${key}): ${why(res)}`).toBe(status);
      seen.push(`${what} → ${res.status} "${(res.body?.error?.message ?? "").slice(0, 50)}"`);
    }
    expect((await ordersOf()).length, "no order").toBe(before);
    await clearCart("customer");
    return seen.join("; ");
  });
}, { ...LOCAL, partial: "a full slot is TC-CART-021" });

qa(["TC-CART-021", "TC-CART-023"], "slot capacity 1: a booked slot is no longer offered, two customers racing for the last place get exactly one booking (the other is refused, not charged), and cancelling frees the slot", async () => {
  return withSlots(1, () =>
    withSecondBuyer(async (address2) => {
      const address1 = await homeAddressId();
      const slots = (await slotsFor()).slots.filter((s) => s.date === tomorrowIst());
      expect(slots.length, "two slots tomorrow").toBeGreaterThanOrEqual(2);
      const [first, second] = slots;
      expect(first.remaining).toBe(1);
      const item = listing("packaged");
      await fillCart("customer", [{ item, quantity: 1 }]);
      const booked = await bookSlot("customer", address1, first.key);
      expectStatus(booked, 201, "customer 1 books the slot");
      const holder = booked.body.orders[0];
      const placed: string[] = [holder.id];
      try {
        const forOther = (await slotsFor("customer2")).slots.map((s) => s.key);
        expect(forOther, "the full slot is not offered to customer 2").not.toContain(first.key);
        // Race for the last place of the second slot.
        await fillCart("customer", [{ item, quantity: 1 }]);
        await fillCart("customer2", [{ item, quantity: 1 }]);
        const wallets = [await walletOf("customer"), await walletOf("customer2")];
        const [r1, r2] = await Promise.all([bookSlot("customer", address1, second.key), bookSlot("customer2", address2, second.key)]);
        const winners = [r1, r2].filter((r) => r.status === 201);
        const losers = [r1, r2].filter((r) => r.status !== 201);
        for (const w of winners) placed.push(w.body.orders[0].id);
        expect(winners.length, `race: ${why(r1)} / ${why(r2)}`).toBe(1);
        expect(losers[0].status).toBe(409);
        expect(losers[0].body?.error?.message).toMatch(/just filled up|choose another/i);
        const loserRole = r1.status === 201 ? "customer2" : "customer";
        expect(await walletOf(loserRole), "the other customer is not charged").toBe(wallets[loserRole === "customer" ? 0 : 1]);
        // Cancelling the holder frees the first slot.
        expectStatus(await cancelOwn("customer", holder.id), 200, "cancel the order holding the slot");
        placed.shift();
        const again = (await slotsFor("customer2")).slots.find((s) => s.key === first.key);
        expect(again?.remaining, "slot offered again after the cancellation").toBe(1);
        return `${first.label} booked → hidden for customer 2; race for ${second.label}: one 201, one 409 "${losers[0].body.error.message.slice(0, 60)}", loser not charged; cancel → ${first.label} offered again`;
      } finally {
        for (const id of placed) await cancelAsShop("shop", id);
        await clearCart("customer");
      }
    }),
  );
}, { ...LOCAL, timeout: 300_000, partial: "a full time slot is left out of the list rather than shown as 'Full' (scheduled-slots.ts lists only slots with places left)" });

/* ----------------------------------------------------------- parent orders */

async function placeAB(extra: Record<string, unknown> = {}) {
  await fillCart("customer", [
    { item: listing("packaged"), quantity: 1 },
    { item: listing("sharedB"), quantity: 1 },
  ]);
  return checkoutAs("customer", { addressId: await homeAddressId(), paymentMethod: "WALLET", ...extra });
}

qa(["TC-CART-024", "TC-CART-026"], "a two-shop checkout gets one parent reference over both shop orders; only the buyer sees it; shop A sees only its own order", async ({ browser }) => {
  need(world().users.shopB, "shop B");
  return withRules({ parentOrders: { enabled: true } }, async () => {
    const res = await placeAB();
    expectStatus(res, 201, "two-shop checkout");
    const ref = res.body.parentReference as string;
    const orders = res.body.orders as { id: string; orderNumber: string; shopId: string }[];
    try {
      expect(ref, "parent reference").toMatch(/^GK-\d{8}-[A-Z0-9]{6}$/);
      const a = orders.find((o) => o.shopId === shopId("A"))!;
      const b = orders.find((o) => o.shopId === shopId("B"))!;
      const { context, page } = await signedPage(browser, "customer");
      try {
        await open(page, `/orders/group/${ref}`);
        await expect(page.getByRole("heading", { name: `Order ${ref}` })).toBeVisible();
        const subs = page.getByTestId("sub-order");
        await expect(subs).toHaveCount(2);
        await expect(subs.filter({ hasText: a.orderNumber })).toContainText(/Confirmed/i);
        await expect(subs.filter({ hasText: b.orderNumber })).toContainText(/Confirmed/i);
        await open(page, "/orders");
        for (const o of [a, b]) await expect(page.getByTestId("order-card").filter({ hasText: o.orderNumber }).first()).toContainText(`Part of ${ref}`);
      } finally {
        await context.close();
      }
      // Visibility.
      const seen: string[] = [];
      for (const [role, path, ok] of [
        ["shop", `/orders/group/${ref}`, false],
        ["shop", `/orders/${b.id}`, false],
        ["shop", `/orders/${a.id}`, true],
        ["customer2", `/orders/group/${ref}`, false],
        ["customer2", `/orders/${a.id}`, false],
      ] as ["shop" | "customer2", string, boolean][]) {
        const r = await call(await as(role), "GET", path, undefined, { maxRedirects: 2 });
        if (ok) expect(r.status, `${role} ${path}`).toBe(200);
        else expect([403, 404], `${role} ${path} → ${r.status}`).toContain(r.status);
        seen.push(`${role} ${path.replace(ref, "GK-…").replace(/[0-9a-f-]{36}/, "…")} → ${r.status}`);
      }
      return `${ref} over ${a.orderNumber} (A) and ${b.orderNumber} (B), each with its status; /orders 'Part of ${ref}'; ${seen.join("; ")}`;
    } finally {
      for (const o of orders) await cancelOwn("customer", o.id);
    }
  });
}, { ...LOCAL, mobile: true });

qa("TC-CART-025", "under a parent order: a shop that just ran out is shown in the cart before paying and not charged; a shop that rejects its part refunds only that part", async ({ browser }) => {
  need(world().users.shopB, "shop B");
  const b = listing("sharedB");
  return withRules({ parentOrders: { enabled: true } }, async () => {
    // 1) Shop B runs out while its item is in the cart.
    await fillCart("customer", [{ item: listing("packaged"), quantity: 1 }, { item: b, quantity: 1 }]);
    const out = await withListing(OWNER.B, "B", b, { onlineStock: 0 }, { onlineStock: b.stock ?? 60 }, async () => {
      const { context, page } = await signedPage(browser, "customer");
      try {
        await open(page, "/cart");
        await expect(cartGroup(page, shopName("B")).getByTestId("delivery-warning")).toContainText(`None of the items from ${shopName("B")} can be ordered right now`);
      } finally {
        await context.close();
      }
      const start = await walletOf();
      const res = await checkoutAs("customer", { addressId: await homeAddressId(), paymentMethod: "WALLET" });
      expectStatus(res, 201, "checkout with shop B out of stock");
      const ids = (res.body.orders as { shopId: string; id: string; totalPaise: number }[]);
      expect(ids.map((o) => o.shopId), "only shop A's order").toEqual([shopId("A")]);
      expect(start - (await walletOf()), "only shop A charged").toBe(ids[0].totalPaise);
      for (const o of ids) await cancelOwn("customer", o.id);
      await clearCart("customer");
      return "B out of stock: cart names shop B before paying; checkout charges only A";
    });
    // 2) Shop B rejects its part of a completed purchase.
    const start = await walletOf();
    const res = await placeAB();
    expectStatus(res, 201, "two-shop checkout");
    const orders = res.body.orders as { id: string; shopId: string; totalPaise: number; orderNumber: string }[];
    const a = orders.find((o) => o.shopId === shopId("A"))!;
    const bOrder = orders.find((o) => o.shopId === shopId("B"))!;
    try {
      const reject = await call(await as("shopB"), "POST", `/api/orders/${bOrder.id}/fulfilment`, { action: "reject", reason: "QA cannot fulfil" });
      expectStatus(reject, 200, "shop B rejects");
      expect(await walletOf(), "only shop B's part refunded").toBe(start - a.totalPaise);
      const { context, page } = await signedPage(browser, "customer");
      try {
        await open(page, `/orders/group/${res.body.parentReference}`);
        await expect(page.getByTestId("sub-order").filter({ hasText: bOrder.orderNumber })).toContainText(/Cancelled|Rejected|Refund/i);
        await expect(page.getByTestId("sub-order").filter({ hasText: a.orderNumber })).toContainText(/Confirmed/i);
      } finally {
        await context.close();
      }
      return `${out}; B rejects ${bOrder.orderNumber} → ${rupees(bOrder.totalPaise)} refunded, A ${a.orderNumber} stays confirmed under ${res.body.parentReference}`;
    } finally {
      await cancelOwn("customer", a.id);
    }
  });
}, { ...LOCAL, mobile: true, partial: "the parent page shows each part's status; it has no overall 'partly cancelled' label (src/app/orders/group/[reference]/page.tsx)" });

/* ------------------------------------------------------------- shop offers */

async function offer(owner: "shop" | "shopB", shop: "A" | "B", body: Record<string, unknown>) {
  const res = await call(await as(owner), "POST", `/api/shops/${shopId(shop)}/offers`, body);
  expectStatus(res, 201, `offer ${body.title}`);
  return res.body as { id: string };
}

async function endOffer(owner: "shop" | "shopB", shop: "A" | "B", id: string, body: Record<string, unknown>) {
  await call(await as(owner), "PUT", `/api/shops/${shopId(shop)}/offers/${id}`, { ...body, active: false });
}

qa("TC-DISC-023", "a live shop offer is listed on the shop page with its terms and end date, lowers the cart price and is charged at checkout", async ({ browser }) => {
  const butter = listing("packaged");
  const body = { title: `QA 10% off ${RUN}`, targetType: "PRODUCT", shopProductId: butter.shopProductId, discountType: "PERCENT", percent: 10, startsAt: new Date(Date.now() - 60_000).toISOString(), endsAt: new Date(Date.now() + 3 * DAY).toISOString() };
  return withRules({ shopOffers: { enabled: true } }, async () => {
    const created = await offer("shop", "A", body);
    const offerPrice = butter.pricePaise! - Math.floor(butter.pricePaise! / 10);
    let orderId: string | null = null;
    try {
      const { context, page } = await signedPage(browser, "customer");
      try {
        await open(page, `/shops/${shopSlug("A")}`);
        const box = page.getByTestId("shop-offers");
        await expect(box).toContainText(body.title);
        await expect(box).toContainText(`10% off on ${butter.name}`);
        await expect(box).toContainText(/until \d{1,2} \w{3}/);
      } finally {
        await context.close();
      }
      await fillCart("customer", [{ item: butter, quantity: 1 }]);
      const line = (await cartOf()).groups[0].lines[0];
      expect(line.unitPricePaise, "cart at the offer price").toBe(offerPrice);
      const res = await checkoutAs("customer", { addressId: await homeAddressId(), paymentMethod: "WALLET" });
      expectStatus(res, 201, "checkout with the offer");
      orderId = res.body.orders[0].id;
      expect(res.body.orders[0].totalPaise, "charged at the offer price").toBe(offerPrice);
      return `"${body.title}" on the shop page (10% off on ${butter.name}, until …); cart and order at ${rupees(offerPrice)} instead of ${rupees(butter.pricePaise!)}`;
    } finally {
      if (orderId) await cancelOwn("customer", orderId);
      await endOffer("shop", "A", created.id, body);
      await clearCart("customer");
    }
  });
}, { ...LOCAL, mobile: true });

qa("TC-DISC-024", "expired and paused offers are not shown and a shop with no live offer shows no offers box", async ({ browser }) => {
  const butter = listing("packaged");
  const expired = { title: `QA expired ${RUN}`, targetType: "PRODUCT", shopProductId: butter.shopProductId, discountType: "FLAT", flatPaise: 500, startsAt: new Date(Date.now() - 5 * DAY).toISOString(), endsAt: new Date(Date.now() - DAY).toISOString() };
  const paused = { ...expired, title: `QA paused ${RUN}`, endsAt: new Date(Date.now() + 5 * DAY).toISOString(), active: false };
  return withRules({ shopOffers: { enabled: true } }, async () => {
    const a = await offer("shop", "A", expired);
    const b = await offer("shop", "A", paused);
    try {
      const { context, page } = await signedPage(browser, "customer");
      try {
        await open(page, `/shops/${shopSlug("A")}`);
        await expect(page.getByTestId("shop-offers")).toHaveCount(0);
        await expect(page.getByText(expired.title)).toHaveCount(0);
        await expect(page.getByText(paused.title)).toHaveCount(0);
        await open(page, `/shops/${shopSlug("C")}`);
        await expect(page.getByTestId("shop-offers")).toHaveCount(0);
      } finally {
        await context.close();
      }
      await fillCart("customer", [{ item: butter, quantity: 1 }]);
      expect((await cartOf()).groups[0].lines[0].unitPricePaise, "no discount from them").toBe(butter.pricePaise);
      await clearCart("customer");
      return "expired and paused offers hidden on shop A (no offers box), none on shop C, cart at the list price";
    } finally {
      await endOffer("shop", "A", a.id, expired);
      await endOffer("shop", "A", b.id, paused);
    }
  });
}, LOCAL);

/* -------------------------------------------------------- price comparison */

async function compareCard(page: Page, productName: string) {
  return page.getByTestId("home-price-comparison").locator("div.flex-col").filter({ hasText: productName }).first();
}

qa("TC-DISC-021", "price comparison (rule on): products sold by two delivering shops with each shop's price, the lowest marked, linking to the product page with the same prices", async ({ browser }) => {
  const a = listing("sharedA");
  const b = listing("sharedB");
  return withRules({ homePriceComparison: { enabled: true } }, async () => {
    const { context, page } = await signedPage(browser, "customer");
    try {
      await open(page, "/search/compare");
      const card = await compareCard(page, a.name);
      await expect(card).toBeVisible();
      const cheapest = card.getByTestId("cheapest-price");
      await expect(cheapest).toContainText(shopName(a.pricePaise! <= b.pricePaise! ? "A" : "B"));
      await expect(cheapest).toContainText(rupees(Math.min(a.pricePaise!, b.pricePaise!)));
      await expect(card.getByTestId("best-price")).toHaveCount(1);
      await expect(card.getByTestId("compared-price")).toContainText(rupees(Math.max(a.pricePaise!, b.pricePaise!)));
      await card.getByRole("link", { name: `Compare all shops: ${a.name}` }).click();
      await page.waitForURL(new RegExp(`/products/${a.productId}`));
      const comparison = page.getByTestId("price-comparison");
      await expect(comparison).toContainText(rupees(a.pricePaise!));
      await expect(comparison).toContainText(rupees(b.pricePaise!));
      // The home page links products sold by two nearby shops to the comparison.
      await open(page, "/");
      const links = await page.getByTestId("compare-n-prices").count();
      return `/search/compare: ${a.name} ${rupees(a.pricePaise!)} (A, Best price) vs ${rupees(b.pricePaise!)} (B); product page shows the same; home has ${links} 'Compare N prices' link(s)`;
    } finally {
      await context.close();
    }
  });
}, { ...LOCAL, mobile: true, partial: "the comparison moved from the home page to Shops › Compare prices (/search/compare, docs/homepage-uiux-2026-10); the home page links to it from product tiles" });

qa("TC-DISC-022", "the comparison never offers unpriced, out-of-stock or non-delivering listings", async ({ browser }) => {
  const a = listing("sharedA");
  const b = listing("sharedB");
  const sugar = listing("unpricedLoose");
  const ghee = listing("premium");
  return withRules({ homePriceComparison: { enabled: true } }, async () => {
    const { context, page } = await signedPage(browser, "customer");
    try {
      await open(page, "/search/compare");
      await expect(page.getByTestId("home-price-comparison")).not.toContainText(sugar.name);
      await expect(page.getByTestId("home-price-comparison"), "in-shop-only at B leaves ghee with one online offer").not.toContainText(ghee.name);
      await withListing(OWNER.B, "B", b, { onlineStock: 0 }, { onlineStock: b.stock ?? 60 }, async () => {
        await page.reload();
        await expect(page.locator("main")).not.toContainText(a.name);
      });
      await withShop("B", { serviceRadiusKm: 1 }, async () => {
        await page.reload();
        await expect(page.locator("main")).not.toContainText(a.name);
      });
      return "sugar (no price) and ghee (B in-shop only) never compared; bread drops out while B is out of stock and while B does not deliver to the customer";
    } finally {
      await context.close();
    }
  });
}, LOCAL);

/* --------------------------------------------------------- reference prices */

async function withReference<T>(productId: string, status: "VERIFIED" | "UNVERIFIED" | "REJECTED", referencedAt: Date, fn: () => Promise<T>): Promise<T> {
  const res = await call(await as("ops"), "POST", "/api/admin/price-references", {
    productId,
    pricePaise: 5500,
    sourceType: "MARKET_SURVEY",
    sourceName: `QA survey ${RUN}`,
    marketLocation: "Kothrud market",
    referencedAt: referencedAt.toISOString(),
  });
  expectStatus(res, 201, "record a reference price");
  if (status !== "UNVERIFIED") {
    const decide = await call(await as("admin"), "PATCH", `/api/admin/price-references/${res.body.id}`, status === "VERIFIED" ? { action: "verify" } : { action: "reject", note: "QA reject" });
    expectStatus(decide, 200, `${status} the reference`);
  }
  return fn();
}

qa(["TC-DISC-015", "TC-DISC-019", "TC-DISC-016", "TC-DISC-020"], "reference prices are never shown to customers (feature dropped) — verified and recent, with the rule on or off, unverified, rejected or stale — and never change the MRP or a shop price", async ({ browser }) => {
  const butter = listing("packaged");
  const seen: string[] = [];
  const page = async (label: string) => {
    const { context, page: p } = await signedPage(browser, "customer");
    try {
      await open(p, `/products/${butter.productId}`);
      await expect(p.getByTestId("reference-prices"), `${label}: no 'Reference prices' block`).toHaveCount(0);
      await expect(p.getByTestId("product-mrp")).toContainText(rupees(butter.mrpPaise ?? 6000));
      await expect(p.getByTestId("price-comparison")).toContainText(rupees(butter.pricePaise!));
      seen.push(label);
    } finally {
      await context.close();
    }
  };
  await withReference(butter.productId, "VERIFIED", new Date(Date.now() - DAY), async () => {
    await withRules({ externalPrices: { showToCustomers: true } }, () => page("verified + rule on"));
    await page("verified + rule off");
  });
  await withReference(butter.productId, "UNVERIFIED", new Date(), () => page("unverified"));
  await withReference(butter.productId, "REJECTED", new Date(), () => page("rejected"));
  await withReference(butter.productId, "VERIFIED", new Date(Date.now() - 200 * DAY), () => page("verified but 200 days old"));
  const api = await call(await as("customer"), "GET", `/api/products/${butter.productId}/price-references`);
  expect(api.status, "public reference API").toBe(404);
  return `no block for: ${seen.join(", ")}; MRP ${rupees(butter.mrpPaise ?? 6000)} and shop price ${rupees(butter.pricePaise!)} unchanged; public API 404`;
}, { ...LOCAL, partial: "expected result superseded: F1.4.3 'Online reference prices' is DROPPED and the block is never rendered (src/lib/price-references-drop.ts, batch-2026-10 WS-A)" });

qa("TC-CART-008", "with no rider online, only a scheduled delivery is offered", async ({ browser }) => {
  const riders = [world().users.rider?.id, world().users.rider2?.id].filter((id): id is string => Boolean(id));
  const was = await db()`select user_id, is_online from delivery_partners where user_id in ${db()(riders)}`;
  await db()`update delivery_partners set is_online = false where user_id in ${db()(riders)}`;
  try {
    const res = await call(await as("customer"), "GET", `/api/checkout/delivery-windows?shopId=${shopId("A")}`);
    expectStatus(res, 200, "delivery windows");
    expect(res.body).toMatchObject({ EXPRESS_30: false, STANDARD_60: false, SCHEDULED: true });
    await fillCart("customer", [{ item: listing("packaged"), quantity: 1 }]);
    const { context, page } = await signedPage(browser, "customer");
    try {
      await open(page, "/cart");
      const group = cartGroup(page, shopName("A"));
      await expect(group.getByRole("button", { name: "Scheduled" })).toBeVisible();
      await expect(group.getByRole("button", { name: /Express|Standard/ })).toHaveCount(0);
    } finally {
      await context.close();
      await clearCart("customer");
    }
    return "no rider online: API {EXPRESS_30: false, STANDARD_60: false, SCHEDULED: true}; the cart offers only 'Scheduled'";
  } finally {
    for (const r of was) await db()`update delivery_partners set is_online = ${r.is_online as boolean} where user_id = ${r.user_id as string}`;
  }
}, LOCAL);
