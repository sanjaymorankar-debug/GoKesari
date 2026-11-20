/**
 * Newspaper and periodical subscriptions (docs/newspaper-subscriptions-2026-11),
 * against real PostgreSQL: the title list, the nearby-vendor search, the
 * grouped submission and its refusals, the vendor's notice and subscriber
 * list, the API routes, and daily generation on the right days only.
 */
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | {
    user: { id: string; email: string; name: string | null; image: string | null; role: UserRole; status: "ACTIVE" };
  },
}));

vi.mock("@/server/auth", () => ({
  auth: async () => state.session,
  handlers: {},
  signIn: async () => {},
  signOut: async () => {},
}));

import { GET as vendorsRoute } from "@/app/api/subscriptions/newspapers/vendors/route";
import { GET as titlesRoute, POST as subscribeRoute } from "@/app/api/subscriptions/newspapers/route";
import { POST as singleSubscribeRoute } from "@/app/api/subscriptions/route";
import { addDays, todayIn } from "@/lib/dates";
import { getEnv } from "@/lib/env";
import { NOTIFICATION_TYPES } from "@/server/notifications/types";
import { db } from "@/server/db";
import {
  notifications,
  orders,
  periodicalTitles,
  shops,
  subscriptionOrders,
  subscriptions,
  users,
  wallets,
} from "@/server/db/schema";
import {
  findNewspaperVendors,
  listPeriodicalTitles,
  listSubscribersForShop,
  subscribeToNewspapers,
} from "@/server/services/newspaper-subscriptions";
import { cancelSubscription, createSubscription, dayOfMonth, generateDailyOrders } from "@/server/services/subscriptions";
import { call } from "../helpers/http";
import {
  createCategory,
  createProduct,
  createShop,
  createShopProduct,
  createStandardMilkSetup,
  createUser,
  createUserWithWallet,
  deliveryAddressId,
  resetDatabase,
} from "../helpers/fixtures";

const TODAY = todayIn(getEnv().APP_TIMEZONE);
const DAY_1 = addDays(TODAY, 1);
const DAY_2 = addDays(TODAY, 2);

beforeEach(async () => {
  state.session = null;
  await resetDatabase();
});

function signInAs(user: { id: string; email: string; name: string | null; role: UserRole }) {
  state.session = { user: { id: user.id, email: user.email, name: user.name, image: null, role: user.role, status: "ACTIVE" } };
}

async function title(categoryId: string, name: string, details: { kind: "NEWSPAPER" | "MAGAZINE"; language: string; publication: "DAILY" | "WEEKLY" | "FORTNIGHTLY" | "MONTHLY" }) {
  const product = await createProduct(categoryId, { name, unit: "piece", subscribable: true });
  await db.insert(periodicalTitles).values({ productId: product.id, ...details });
  return product;
}

/**
 * Two vendors near the customer (PIN 411001) and one far away (PIN 560001):
 *   near — Times of India ₹6, Lokmat ₹5, India Today ₹60
 *   other — Times of India ₹7 only
 *   far — every title, but does not deliver to 411001
 */
async function setup() {
  const { user: customer } = await createUserWithWallet({ balancePaise: 100_000 });
  await db.update(users).set({ name: "Asha Patil" }).where(eq(users.id, customer.id));
  const addressId = await deliveryAddressId(customer.id);

  const papers = await createCategory({ department: "NEWSPAPER_VENDOR", name: "Newspapers" });
  const mags = await createCategory({ department: "NEWSPAPER_VENDOR", name: "Magazines & Periodicals" });
  const toi = await title(papers.id, "The Times of India", { kind: "NEWSPAPER", language: "English", publication: "DAILY" });
  const lokmat = await title(papers.id, "Lokmat", { kind: "NEWSPAPER", language: "Marathi", publication: "DAILY" });
  const indiaToday = await title(mags.id, "India Today", { kind: "MAGAZINE", language: "English", publication: "WEEKLY" });
  // A magazine a vendor added later, with no periodical_titles row: still a title (its category says so).
  const vendorAdded = await createProduct(mags.id, { name: "Local Monthly", unit: "piece", subscribable: true });

  const nearOwner = await createUser({ role: "SHOP_OWNER" });
  const near = await createShop(nearOwner.id, { name: "Sai News Agency", shopType: "NEWSPAPER_VENDOR" });
  const nearToi = await createShopProduct(near.id, toi.id, { onlinePricePaise: 600, trackInventory: false });
  const nearLokmat = await createShopProduct(near.id, lokmat.id, { onlinePricePaise: 500, trackInventory: false });
  const nearIndiaToday = await createShopProduct(near.id, indiaToday.id, { onlinePricePaise: 6000, trackInventory: false });

  const otherOwner = await createUser({ role: "SHOP_OWNER" });
  const other = await createShop(otherOwner.id, { name: "Corner Book Stall", shopType: "BOOKSTORE" });
  const otherToi = await createShopProduct(other.id, toi.id, { onlinePricePaise: 700, trackInventory: false });
  // Listed but not sold online: not an offer.
  await createShopProduct(other.id, lokmat.id, { onlineSaleEnabled: false, onlinePricePaise: null });

  const farOwner = await createUser({ role: "SHOP_OWNER" });
  const far = await createShop(farOwner.id, { name: "Far Away News", shopType: "NEWSPAPER_VENDOR" });
  await db.update(shops).set({ pincode: "560001" }).where(eq(shops.id, far.id));
  const farToi = await createShopProduct(far.id, toi.id, { onlinePricePaise: 400, trackInventory: false });
  await createShopProduct(far.id, lokmat.id, { onlinePricePaise: 400, trackInventory: false });

  return {
    customer, addressId, toi, lokmat, indiaToday, vendorAdded,
    near, nearOwner, nearToi, nearLokmat, nearIndiaToday,
    other, otherToi, far, farToi,
  };
}

async function shopNotices(ownerId: string) {
  return db
    .select()
    .from(notifications)
    .where(and(eq(notifications.userId, ownerId), eq(notifications.type, NOTIFICATION_TYPES.SHOP_NEW_SUBSCRIPTION)));
}

describe("the title list", () => {
  it("lists newspapers and magazines, inferring a magazine from its category", async () => {
    const f = await setup();
    const { category } = await createStandardMilkSetup();
    expect(category).toBeTruthy();

    const titles = await listPeriodicalTitles();
    const names = titles.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["The Times of India", "Lokmat", "India Today", "Local Monthly"]));
    expect(names).not.toContain("Cow Milk");
    // Newspapers first.
    expect(titles[0].kind).toBe("NEWSPAPER");

    const india = titles.find((t) => t.productId === f.indiaToday.id)!;
    expect(india).toMatchObject({ kind: "MAGAZINE", publication: "WEEKLY", defaultSchedule: { frequency: "WEEKLY", weekdays: [7] } });
    const local = titles.find((t) => t.productId === f.vendorAdded.id)!;
    expect(local).toMatchObject({ kind: "MAGAZINE", publication: "MONTHLY", defaultSchedule: { frequency: "MONTHLY", monthDays: [1] } });
  });
});

describe("finding vendors near the address", () => {
  it("shows vendors who deliver there and sell the titles — most titles first; not the far one", async () => {
    const f = await setup();
    const vendors = await findNewspaperVendors({
      userId: f.customer.id,
      addressId: f.addressId,
      productIds: [f.toi.id, f.lokmat.id],
    });
    expect(vendors.map((v) => v.name)).toEqual(["Sai News Agency", "Corner Book Stall"]);
    expect(vendors[0].offers.map((o) => [o.name, o.pricePaise])).toEqual([
      ["Lokmat", 500],
      ["The Times of India", 600],
    ]);
    expect(vendors[0].missingProductIds).toEqual([]);
    expect(vendors[1].offers.map((o) => o.name)).toEqual(["The Times of India"]);
    expect(vendors[1].missingProductIds).toEqual([f.lokmat.id]);
  });

  it("refuses another customer's address and a product that is not a title", async () => {
    const f = await setup();
    const stranger = await createUser();
    await expect(findNewspaperVendors({ userId: stranger.id, addressId: f.addressId, productIds: [f.toi.id] })).rejects.toThrow(
      /saved delivery addresses/,
    );
    const { product: milk } = await createStandardMilkSetup();
    await expect(findNewspaperVendors({ userId: f.customer.id, addressId: f.addressId, productIds: [milk.id] })).rejects.toThrow(
      /not available for subscription/,
    );
  });
});

describe("subscribing to several titles from one vendor", () => {
  it("creates one subscription per title, grouped, and tells the vendor once", async () => {
    const f = await setup();
    const created = await subscribeToNewspapers({
      userId: f.customer.id,
      shopId: f.near.id,
      addressId: f.addressId,
      startDate: DAY_1,
      items: [
        { shopProductId: f.nearToi.id, copies: 1, frequency: "DAILY" },
        { shopProductId: f.nearLokmat.id, copies: 2, frequency: "WEEKLY", weekdays: [7, 6, 7] },
        { shopProductId: f.nearIndiaToday.id, copies: 1, frequency: "MONTHLY", monthDays: [15, 1] },
      ],
    });

    expect(created).toHaveLength(3);
    const bundleId = created[0].bundleId;
    expect(bundleId).toBeTruthy();
    expect(created.every((s) => s.bundleId === bundleId && s.shopId === f.near.id && s.status === "ACTIVE")).toBe(true);
    const lokmatSub = created.find((s) => s.shopProductId === f.nearLokmat.id)!;
    expect(lokmatSub).toMatchObject({ quantityMilli: 2000, frequency: "WEEKLY", weekdays: [6, 7], monthDays: [] });
    const mag = created.find((s) => s.shopProductId === f.nearIndiaToday.id)!;
    expect(mag).toMatchObject({ frequency: "MONTHLY", monthDays: [1, 15], weekdays: [] });
    expect(mag.nextDeliveryDate === null || [1, 15].includes(dayOfMonth(mag.nextDeliveryDate))).toBe(true);

    const notices = await shopNotices(f.nearOwner.id);
    expect(notices).toHaveLength(1);
    expect(notices[0].title).toBe("New subscriber — 3 items");
    expect(notices[0].body).toContain("Asha Patil subscribed to");
    expect(notices[0].body).toContain("The Times of India (1 copy, every day)");
    expect(notices[0].body).toContain("Lokmat (2 copies, Sat, Sun)");
    expect(notices[0].body).toContain("India Today (1 copy, 1st and 15th of the month)");
    expect(notices[0].body).toContain("Deliver to: Pune, 411001");
    expect(notices[0].actionUrl).toBe("/shop/manage/subscribers");

    const customerNotices = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, f.customer.id), eq(notifications.type, NOTIFICATION_TYPES.SUBSCRIPTION_CREATED)));
    expect(customerNotices).toHaveLength(1);
    expect(customerNotices[0].title).toBe("3 subscriptions created");
  });

  it("is all or nothing — one bad item creates nothing", async () => {
    const f = await setup();
    await expect(
      subscribeToNewspapers({
        userId: f.customer.id,
        shopId: f.near.id,
        addressId: f.addressId,
        startDate: DAY_1,
        items: [
          { shopProductId: f.nearToi.id, copies: 1, frequency: "DAILY" },
          { shopProductId: f.otherToi.id, copies: 1, frequency: "DAILY" },
        ],
      }),
    ).rejects.toThrow(/chosen vendor/);
    await expect(
      subscribeToNewspapers({
        userId: f.customer.id,
        shopId: f.near.id,
        addressId: f.addressId,
        startDate: DAY_1,
        items: [
          { shopProductId: f.nearToi.id, copies: 1, frequency: "DAILY" },
          { shopProductId: f.nearIndiaToday.id, copies: 1, frequency: "MONTHLY", monthDays: [30] },
        ],
      }),
    ).rejects.toThrow(/between 1 and 28/);
    await expect(
      subscribeToNewspapers({
        userId: f.customer.id,
        shopId: f.near.id,
        addressId: f.addressId,
        startDate: DAY_1,
        items: [{ shopProductId: f.nearToi.id, copies: 11, frequency: "DAILY" }],
      }),
    ).rejects.toThrow(/1 to 10/);
    await expect(
      subscribeToNewspapers({
        userId: f.customer.id,
        shopId: f.near.id,
        addressId: f.addressId,
        startDate: DAY_1,
        items: [
          { shopProductId: f.nearToi.id, copies: 1, frequency: "DAILY" },
          { shopProductId: f.nearToi.id, copies: 1, frequency: "DAILY" },
        ],
      }),
    ).rejects.toThrow(/only once/);
    expect(await db.select().from(subscriptions)).toHaveLength(0);
    expect(await shopNotices(f.nearOwner.id)).toHaveLength(0);
  });

  it("refuses a vendor who does not deliver to the address", async () => {
    const f = await setup();
    await expect(
      subscribeToNewspapers({
        userId: f.customer.id,
        shopId: f.far.id,
        addressId: f.addressId,
        startDate: DAY_1,
        items: [{ shopProductId: f.farToi.id, copies: 1, frequency: "DAILY" }],
      }),
    ).rejects.toThrow(/does not deliver to the chosen address/);
  });

  it("refuses a product that is not a newspaper or magazine", async () => {
    const f = await setup();
    const milk = await createProduct((await createCategory({ department: "DAIRY", name: "Milk" })).id, { name: "Cow Milk", unit: "L" });
    const nearMilk = await createShopProduct(f.near.id, milk.id, { onlinePricePaise: 7000 });
    await expect(
      subscribeToNewspapers({
        userId: f.customer.id,
        shopId: f.near.id,
        addressId: f.addressId,
        startDate: DAY_1,
        items: [{ shopProductId: nearMilk.id, copies: 1, frequency: "DAILY" }],
      }),
    ).rejects.toThrow(/not available for subscription/);
  });
});

describe("daily generation for newspaper subscriptions", () => {
  it("delivers a day-of-month magazine only on its day; the daily paper every day", async () => {
    const f = await setup();
    await subscribeToNewspapers({
      userId: f.customer.id,
      shopId: f.near.id,
      addressId: f.addressId,
      startDate: DAY_1,
      items: [
        { shopProductId: f.nearToi.id, copies: 2, frequency: "DAILY" },
        // DAY_1's day of the month, capped to 28 so the schedule is valid on any calendar day.
        { shopProductId: f.nearIndiaToday.id, copies: 1, frequency: "MONTHLY", monthDays: [Math.min(dayOfMonth(DAY_1), 28)] },
      ],
    });
    const magazineDue = dayOfMonth(DAY_1) <= 28;

    const day1 = await generateDailyOrders(DAY_1);
    expect(day1.generated).toBe(magazineDue ? 2 : 1);
    const day2 = await generateDailyOrders(DAY_2);
    expect(day2.generated).toBe(1);

    // 2 copies × ₹6 each day, plus ₹60 for the magazine on its day.
    const [wallet] = await db.select().from(wallets).where(eq(wallets.userId, f.customer.id));
    expect(wallet.balancePaise).toBe(100_000 - 1200 * 2 - (magazineDue ? 6000 : 0));
    const subOrders = await db.select().from(subscriptionOrders);
    expect(subOrders.every((o) => o.status !== "WALLET_INSUFFICIENT")).toBe(true);
    const shopOrders = await db.select().from(orders).where(eq(orders.shopId, f.near.id));
    expect(shopOrders.every((o) => o.source === "SUBSCRIPTION")).toBe(true);
  });
});

describe("the vendor's side", () => {
  it("lists running subscribers with customer, address and schedule; cancelled ones drop off", async () => {
    const f = await setup();
    const created = await subscribeToNewspapers({
      userId: f.customer.id,
      shopId: f.near.id,
      addressId: f.addressId,
      startDate: DAY_1,
      items: [
        { shopProductId: f.nearToi.id, copies: 1, frequency: "DAILY" },
        { shopProductId: f.nearLokmat.id, copies: 1, frequency: "DAILY" },
      ],
    });
    let list = await listSubscribersForShop(f.near.id);
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ customerName: "Asha Patil", isPeriodical: true, address: "2 Test Lane, Pune, 411001" });
    expect(await listSubscribersForShop(f.other.id)).toHaveLength(0);

    await cancelSubscription(created[0].id, "moving house", { id: f.customer.id, role: "CUSTOMER" });
    list = await listSubscribersForShop(f.near.id);
    expect(list.map((s) => s.subscriptionId)).toEqual([created[1].id]);
  });

  it("is told about a single (milk) subscription too", async () => {
    const { customer, owner, shopProduct } = await createStandardMilkSetup();
    await deliveryAddressId(customer.id);
    await createSubscription({ userId: customer.id, shopProductId: shopProduct.id, quantityMilli: 2000, startDate: DAY_1 });
    const notices = await shopNotices(owner.id);
    expect(notices).toHaveLength(1);
    expect(notices[0].title).toBe("New subscriber");
    expect(notices[0].body).toContain("Cow Milk (2 L, every day)");
  });

  it("is not told about a draft until it is started", async () => {
    const { customer, owner, shopProduct } = await createStandardMilkSetup();
    await createSubscription({ userId: customer.id, shopProductId: shopProduct.id, quantityMilli: 1000, startDate: DAY_1, draft: true });
    expect(await shopNotices(owner.id)).toHaveLength(0);
  });
});

describe("the API routes", () => {
  it("lists titles, finds vendors and subscribes for a signed-in customer", async () => {
    const f = await setup();
    const titles = await call(titlesRoute, "/api/subscriptions/newspapers");
    expect(titles.status).toBe(200);
    expect(titles.body.length).toBeGreaterThanOrEqual(4);

    expect((await call(vendorsRoute, `/api/subscriptions/newspapers/vendors?addressId=${f.addressId}&productIds=${f.toi.id}`)).status).toBe(401);

    signInAs(f.customer);
    const vendors = await call(vendorsRoute, `/api/subscriptions/newspapers/vendors?addressId=${f.addressId}&productIds=${f.toi.id},${f.lokmat.id}`);
    expect(vendors.status).toBe(200);
    expect(vendors.body[0].name).toBe("Sai News Agency");
    expect((await call(vendorsRoute, `/api/subscriptions/newspapers/vendors?addressId=${f.addressId}&productIds=nope`)).status).toBe(422);

    const created = await call(subscribeRoute, "/api/subscriptions/newspapers", {
      method: "POST",
      body: {
        shopId: f.near.id,
        addressId: f.addressId,
        startDate: DAY_1,
        items: [
          { shopProductId: f.nearToi.id, copies: 1, frequency: "DAILY" },
          { shopProductId: f.nearIndiaToday.id, copies: 1, frequency: "MONTHLY", monthDays: [1] },
        ],
      },
    });
    expect(created.status).toBe(201);
    expect(created.body.subscriptions).toHaveLength(2);
    expect(created.body.bundleId).toBeTruthy();

    const yesterday = await call(subscribeRoute, "/api/subscriptions/newspapers", {
      method: "POST",
      body: { shopId: f.near.id, addressId: f.addressId, startDate: addDays(TODAY, -1), items: [{ shopProductId: f.nearToi.id, frequency: "DAILY" }] },
    });
    expect(yesterday.status).toBe(422);
  });

  it("accepts a MONTHLY schedule on the single-subscription route", async () => {
    const f = await setup();
    signInAs(f.customer);
    const res = await call(singleSubscribeRoute, "/api/subscriptions", {
      method: "POST",
      body: { shopProductId: f.nearIndiaToday.id, quantityMilli: 1000, frequency: "MONTHLY", monthDays: [5], startDate: DAY_1, addressId: f.addressId },
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ frequency: "MONTHLY", monthDays: [5] });

    const bad = await call(singleSubscribeRoute, "/api/subscriptions", {
      method: "POST",
      body: { shopProductId: f.nearIndiaToday.id, quantityMilli: 1000, frequency: "MONTHLY", monthDays: [], startDate: DAY_1 },
    });
    expect(bad.status).toBe(422);
  });
});
