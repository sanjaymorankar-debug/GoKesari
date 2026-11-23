/**
 * Module 6 (docs/hindi-marathi-2026-11/): users.preferred_lang (migration 0186)
 * — saved by the language switch, read back for the board-language fallback,
 * and used for the main customer notifications. English stays the default.
 */
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { notificationDeliveries, notifications, users } from "@/server/db/schema";
import { getPreferredLang, getPreferredLangs, savePreferredLang } from "@/server/preferred-lang";
import { addToCart } from "@/server/services/cart";
import { NOTIFICATION_TYPES, notify } from "@/server/services/notifications";
import { cancelOrder, checkout } from "@/server/services/orders";
import {
  createCategory,
  createProduct,
  createShop,
  createShopProduct,
  createUser,
  createUserWithWallet,
  deliveryAddressId,
  resetDatabase,
} from "../helpers/fixtures";

beforeEach(resetDatabase);

const notificationsFor = (userId: string, type: string) =>
  db.query.notifications.findMany({ where: and(eq(notifications.userId, userId), eq(notifications.type, type)) });

describe("users.preferred_lang", () => {
  it("is null for a new account and saves en / hi / mr", async () => {
    const user = await createUser();
    expect(await getPreferredLang(user.id)).toBeNull();
    await savePreferredLang(user.id, "mr");
    expect(await getPreferredLang(user.id)).toBe("mr");
    await savePreferredLang(user.id, "en");
    expect(await getPreferredLang(user.id)).toBe("en");
  });

  it("the database refuses anything but en / hi / mr", async () => {
    const user = await createUser();
    await expect(db.update(users).set({ preferredLang: "fr" }).where(eq(users.id, user.id))).rejects.toThrow();
  });

  it("reads several people at once, leaving out those who never chose", async () => {
    const a = await createUser();
    const b = await createUser();
    await savePreferredLang(a.id, "hi");
    const map = await getPreferredLangs([a.id, b.id]);
    expect(map.get(a.id)).toBe("hi");
    expect(map.has(b.id)).toBe(false);
  });

  it("an unknown user reads as not chosen", async () => {
    expect(await getPreferredLang("00000000-0000-0000-0000-000000000000")).toBeNull();
  });
});

describe("notify() with lang", () => {
  const vars = { orderNumber: "GK-9001", shopName: "Kesari Dairy" };

  it("stays English for a person who never chose a language", async () => {
    const user = await createUser();
    await notify({ userId: user.id, type: NOTIFICATION_TYPES.ORDER_DELIVERED, vars, lang: "auto" });
    const [row] = await notificationsFor(user.id, NOTIFICATION_TYPES.ORDER_DELIVERED);
    expect(row.title).toBe("Order delivered");
    expect(row.body).toBe("Your order GK-9001 has been delivered. Enjoy!");
  });

  it("writes Hindi in-app and e-mail for a person who chose Hindi", async () => {
    const user = await createUser();
    await savePreferredLang(user.id, "hi");
    await notify({ userId: user.id, type: NOTIFICATION_TYPES.ORDER_DELIVERED, vars, lang: "auto", actionUrl: "/orders" });
    const [row] = await notificationsFor(user.id, NOTIFICATION_TYPES.ORDER_DELIVERED);
    expect(row.title).toBe("ऑर्डर डिलीवर हुआ");
    expect(row.body).toBe("आपका ऑर्डर GK-9001 डिलीवर हो गया है। धन्यवाद!");
    const [mail] = await db.select().from(notificationDeliveries).where(
      and(eq(notificationDeliveries.userId, user.id), eq(notificationDeliveries.channel, "EMAIL")),
    );
    expect(mail.subject).toBe("ऑर्डर डिलीवर हुआ — Gokesari");
    expect(mail.html).toContain("Gokesari पर आपकी सूचना सेटिंग के कारण आपको यह मिला है।");
  });

  it("without lang (every caller not changed by Module 6) stays English even for a Marathi user", async () => {
    const user = await createUser();
    await savePreferredLang(user.id, "mr");
    await notify({ userId: user.id, type: NOTIFICATION_TYPES.ORDER_DELIVERED, vars });
    const [row] = await notificationsFor(user.id, NOTIFICATION_TYPES.ORDER_DELIVERED);
    expect(row.title).toBe("Order delivered");
  });

  it("keeps the caller's English title and body for an event without a translation", async () => {
    const user = await createUser();
    await savePreferredLang(user.id, "mr");
    await notify({ userId: user.id, type: NOTIFICATION_TYPES.ORDER_RIDER_SEARCH, vars, lang: "auto" });
    const [row] = await notificationsFor(user.id, NOTIFICATION_TYPES.ORDER_RIDER_SEARCH);
    expect(row.title).toBe("Finding a rider");
  });
});

describe("checkout and cancel notifications follow the saved language", () => {
  async function setup(lang: "hi" | "mr" | null) {
    const { user: customer } = await createUserWithWallet({ balancePaise: 500_000 });
    if (lang) await savePreferredLang(customer.id, lang);
    const owner = await createUser({ role: "SHOP_OWNER" });
    const category = await createCategory({ department: "DAIRY", name: "Milk" });
    const product = await createProduct(category.id, { name: "Cow Milk", unit: "L" });
    const shop = await createShop(owner.id);
    const shopProduct = await createShopProduct(shop.id, product.id, { onlinePricePaise: 7000, onlineStock: 50 });
    await addToCart(customer.id, shopProduct.id, 1);
    const { orders } = await checkout({ userId: customer.id, requestId: `req-${customer.id}`, addressId: await deliveryAddressId(customer.id) });
    return { customer, owner, shop, order: orders[0] };
  }

  it("English customer: order confirmed text exactly as before", async () => {
    const { customer, shop, order } = await setup(null);
    const [row] = await notificationsFor(customer.id, NOTIFICATION_TYPES.ORDER_CONFIRMED);
    expect(row.title).toBe("Order confirmed");
    expect(row.body).toBe(`Your order ${order.orderNumber} from ${shop.name} is confirmed.`);
  });

  it("Marathi customer: order confirmed in Marathi; the shop owner still gets English", async () => {
    const { customer, owner, shop, order } = await setup("mr");
    await savePreferredLang(owner.id, "mr");
    const [row] = await notificationsFor(customer.id, NOTIFICATION_TYPES.ORDER_CONFIRMED);
    expect(row.title).toBe("ऑर्डर निश्चित झाली");
    expect(row.body).toBe(`${shop.name} कडून तुमची ऑर्डर ${order.orderNumber} निश्चित झाली आहे.`);
    const shopRows = await notificationsFor(owner.id, NOTIFICATION_TYPES.SHOP_NEW_ORDER);
    expect(shopRows[0].title).not.toMatch(/[ऀ-ॿ]/);
  });

  it("Hindi customer: a cancellation is in Hindi", async () => {
    const { customer, order } = await setup("hi");
    // Support cancels (the person who cancels is not told what they just did).
    const admin = await createUser({ role: "ADMIN" });
    await cancelOrder(order.id, { id: admin.id, role: "ADMIN" }, "Shop asked us to cancel");
    const rows = await notificationsFor(customer.id, NOTIFICATION_TYPES.ORDER_CANCELLED);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].title).toBe("ऑर्डर रद्द हुआ");
    expect(rows[0].body).toContain(order.orderNumber);
  });
});
