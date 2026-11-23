/**
 * Subscription plans (docs/subscription-plans-2026-11), against real
 * PostgreSQL: a shop makes any product a plan (a tiffin lunch here), customers
 * near it find and take it within its rules, the plan price is what each
 * delivery is charged, the shop is told and sees what to prepare.
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

import { GET as listPlansRoute, POST as createPlanRoute } from "@/app/api/shops/[id]/subscription-plans/route";
import { PATCH as patchPlanRoute } from "@/app/api/shops/[id]/subscription-plans/[planId]/route";
import { GET as nearRoute } from "@/app/api/subscription-plans/route";
import { POST as subscribeRoute } from "@/app/api/subscription-plans/[planId]/subscribe/route";
import { addDays, isoWeekday, todayIn, type IsoDate } from "@/lib/dates";
import { getEnv } from "@/lib/env";
import { db } from "@/server/db";
import { notifications, orderItems, orders, shops, subscriptionOrders, subscriptions, wallets } from "@/server/db/schema";
import { NOTIFICATION_TYPES } from "@/server/notifications/types";
import {
  createPlan,
  findPlansNear,
  listShopPlans,
  planPrepSheet,
  removePlan,
  setPlanActive,
  subscribeToPlan,
  updatePlan,
  type PlanInput,
} from "@/server/services/subscription-plans";
import { createSubscription, generateDailyOrders, skipDate, updateSubscription } from "@/server/services/subscriptions";
import { call } from "../helpers/http";
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

const TODAY = todayIn(getEnv().APP_TIMEZONE);
/** The next date on or after `from` with this ISO weekday (1 Mon … 7 Sun). */
function nextWeekday(from: IsoDate, weekday: number): IsoDate {
  for (let i = 0; i < 7; i += 1) {
    const d = addDays(from, i);
    if (isoWeekday(d) === weekday) return d;
  }
  throw new Error("unreachable");
}
/** A Monday at least two days ahead, so lead days never bite; the Sunday before it. */
const MONDAY = nextWeekday(addDays(TODAY, 2), 1);
const SUNDAY = addDays(MONDAY, 6);

beforeEach(async () => {
  state.session = null;
  await resetDatabase();
});

function signInAs(user: { id: string; email: string; name: string | null; role: UserRole }) {
  state.session = { user: { id: user.id, email: user.email, name: user.name, image: null, role: user.role, status: "ACTIVE" } };
}

const lunchPlan = (shopProductId: string, patch: Partial<PlanInput> = {}): PlanInput => ({
  shopProductId,
  name: "Veg lunch thali",
  description: "Dal, sabzi, 4 rotis, rice",
  kind: "MEAL",
  slot: "LUNCH",
  slotWindow: "12:30–2 pm",
  serviceDays: [1, 2, 3, 4, 5, 6],
  allowedFrequencies: ["DAILY", "WEEKLY"],
  pricePaise: 8000,
  termDays: [],
  leadDays: 1,
  ...patch,
});

/**
 * A tiffin kitchen (PIN 411001, delivers there) selling "Veg Lunch Thali" ONLY
 * on subscription: the listing is not on sale online and has no online price,
 * and the catalogue product is not marked subscribable. A second shop far away.
 */
async function setup() {
  const owner = await createUser({ role: "SHOP_OWNER", name: "Annapurna Owner" });
  const kitchen = await createShop(owner.id, { name: "Annapurna Tiffin", shopType: "RESTAURANT" });
  const meals = await createCategory({ department: "RESTAURANT", name: "Thalis" });
  const thali = await createProduct(meals.id, { name: "Veg Lunch Thali", unit: "piece", subscribable: false });
  const thaliListing = await createShopProduct(kitchen.id, thali.id, { onlineSaleEnabled: false, onlinePricePaise: null, trackInventory: false });
  const dinner = await createProduct(meals.id, { name: "Dinner Combo", unit: "piece", subscribable: false });
  const dinnerListing = await createShopProduct(kitchen.id, dinner.id, { onlinePricePaise: 12000, trackInventory: false });

  const { user: customer } = await createUserWithWallet({ balancePaise: 100_000 });
  const addressId = await deliveryAddressId(customer.id);

  const farOwner = await createUser({ role: "SHOP_OWNER" });
  const far = await createShop(farOwner.id, { name: "Far Kitchen", shopType: "RESTAURANT" });
  await db.update(shops).set({ pincode: "560001" }).where(eq(shops.id, far.id));
  const farListing = await createShopProduct(far.id, thali.id, { onlineSaleEnabled: false, onlinePricePaise: null, trackInventory: false });

  return { owner, kitchen, thali, thaliListing, dinnerListing, customer, addressId, farOwner, far, farListing };
}

const actorOf = (u: { id: string; role: UserRole }) => ({ id: u.id, role: u.role });

describe("a shop's plans", () => {
  it("makes any of its products a plan — even one not subscribable in the catalogue and not on sale online", async () => {
    const f = await setup();
    const plan = await createPlan(f.kitchen.id, lunchPlan(f.thaliListing.id), actorOf(f.owner));
    expect(plan).toMatchObject({ shopId: f.kitchen.id, kind: "MEAL", slot: "LUNCH", serviceDays: [1, 2, 3, 4, 5, 6], pricePaise: 8000, isActive: true });

    const listed = await listShopPlans(f.kitchen.id);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ productName: "Veg Lunch Thali", effectivePricePaise: 8000, listingPricePaise: null, subscribers: 0 });
  });

  it("refuses another shop's product, a duplicate name, a priceless plan on a priceless listing, bad rules", async () => {
    const f = await setup();
    await expect(createPlan(f.kitchen.id, lunchPlan(f.farListing.id), actorOf(f.owner))).rejects.toThrow(/your shop's products/);
    await createPlan(f.kitchen.id, lunchPlan(f.thaliListing.id), actorOf(f.owner));
    await expect(createPlan(f.kitchen.id, lunchPlan(f.thaliListing.id, { name: "VEG LUNCH THALI" }), actorOf(f.owner))).rejects.toThrow(/already have a plan/);
    await expect(createPlan(f.kitchen.id, lunchPlan(f.thaliListing.id, { name: "No price", pricePaise: null }), actorOf(f.owner))).rejects.toThrow(/subscriber price/);
    await expect(createPlan(f.kitchen.id, lunchPlan(f.thaliListing.id, { name: "No days", serviceDays: [] }), actorOf(f.owner))).rejects.toThrow(/days this plan is delivered/);
    // The dinner listing has an online price, so a plan without its own price is fine.
    const dinner = await createPlan(f.kitchen.id, lunchPlan(f.dinnerListing.id, { name: "Dinner", slot: "DINNER", pricePaise: null }), actorOf(f.owner));
    expect((await listShopPlans(f.kitchen.id)).find((p) => p.id === dinner.id)!.effectivePricePaise).toBe(12000);
  });
});

describe("customers find and take a plan", () => {
  it("lists plans of shops that deliver to the address, filtered by kind and slot; not the far shop, not a plan that is off", async () => {
    const f = await setup();
    const lunch = await createPlan(f.kitchen.id, lunchPlan(f.thaliListing.id), actorOf(f.owner));
    await createPlan(f.kitchen.id, lunchPlan(f.dinnerListing.id, { name: "Dinner", slot: "DINNER", pricePaise: null }), actorOf(f.owner));
    await createPlan(f.far.id, lunchPlan(f.farListing.id, { name: "Far lunch" }), actorOf(f.farOwner));
    const off = await createPlan(f.kitchen.id, lunchPlan(f.thaliListing.id, { name: "Old plan" }), actorOf(f.owner));
    await setPlanActive(f.kitchen.id, off.id, false, actorOf(f.owner));

    const location = { pincode: "411001", latitude: null, longitude: null, source: "ADDRESS" as const, label: "Home", addressId: null, societyId: null };
    const all = await findPlansNear(location);
    expect(all.map((p) => p.name).sort()).toEqual(["Dinner", "Veg lunch thali"]);
    const lunches = await findPlansNear(location, { slot: "LUNCH" });
    expect(lunches.map((p) => p.id)).toEqual([lunch.id]);
    expect(lunches[0]).toMatchObject({ pricePaise: 8000, shop: { name: "Annapurna Tiffin" }, kind: "MEAL" });
    expect(await findPlansNear(location, { kind: "NEWSPAPER" })).toEqual([]);
  });

  it("'every delivery day' on a Mon–Sat lunch plan subscribes Mon–Sat at the plan price, and tells the shop", async () => {
    const f = await setup();
    const plan = await createPlan(f.kitchen.id, lunchPlan(f.thaliListing.id), actorOf(f.owner));
    const sub = await subscribeToPlan({
      userId: f.customer.id,
      planId: plan.id,
      quantityMilli: 2000,
      frequency: "DAILY",
      startDate: MONDAY,
      addressId: f.addressId,
    });
    expect(sub).toMatchObject({ planId: plan.id, shopId: f.kitchen.id, frequency: "WEEKLY", weekdays: [1, 2, 3, 4, 5, 6], quantityMilli: 2000 });

    const [notice] = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, f.owner.id), eq(notifications.type, NOTIFICATION_TYPES.SHOP_NEW_SUBSCRIPTION)));
    expect(notice.body).toContain("Veg lunch thali (2 piece, Mon–Sat, Lunch (12:30–2 pm))");
    expect((await listShopPlans(f.kitchen.id))[0].subscribers).toBe(1);
  });

  it("charges the plan price on delivery days only — Monday yes, Sunday no — for a subscription-only listing", async () => {
    const f = await setup();
    const plan = await createPlan(f.kitchen.id, lunchPlan(f.thaliListing.id), actorOf(f.owner));
    await subscribeToPlan({ userId: f.customer.id, planId: plan.id, quantityMilli: 1000, frequency: "DAILY", startDate: MONDAY, addressId: f.addressId });

    expect((await generateDailyOrders(MONDAY)).generated).toBe(1);
    expect((await generateDailyOrders(SUNDAY)).generated).toBe(0);
    const [wallet] = await db.select().from(wallets).where(eq(wallets.userId, f.customer.id));
    expect(wallet.balancePaise).toBe(100_000 - 8000);
    const [line] = await db.select().from(orderItems).innerJoin(orders, eq(orders.id, orderItems.orderId)).where(eq(orders.shopId, f.kitchen.id));
    expect(line.order_items.unitPricePaise).toBe(8000);
    expect(line.orders.source).toBe("SUBSCRIPTION");
    const [subOrder] = await db.select().from(subscriptionOrders);
    expect(subOrder).toMatchObject({ deliveryDate: MONDAY, unitPricePaise: 8000, totalPaise: 8000 });
  });

  it("without a plan the same listing cannot be subscribed (not subscribable, not on sale online)", async () => {
    const f = await setup();
    await expect(
      createSubscription({ userId: f.customer.id, shopProductId: f.thaliListing.id, quantityMilli: 1000, startDate: MONDAY, addressId: f.addressId }),
    ).rejects.toThrow(/not available for subscription/);
  });

  it("keeps the customer within the plan's rules", async () => {
    const f = await setup();
    const plan = await createPlan(f.kitchen.id, lunchPlan(f.thaliListing.id, { leadDays: 2, termDays: [7, 30] }), actorOf(f.owner));
    const base = { userId: f.customer.id, planId: plan.id, quantityMilli: 1000, addressId: f.addressId };

    await expect(subscribeToPlan({ ...base, frequency: "DAILY", startDate: addDays(TODAY, 1), termDays: 7 })).rejects.toThrow(/at the earliest/);
    await expect(subscribeToPlan({ ...base, frequency: "WEEKLY", weekdays: [7], startDate: MONDAY, termDays: 7 })).rejects.toThrow(/days this plan is delivered/);
    await expect(subscribeToPlan({ ...base, frequency: "MONTHLY", monthDays: [1], startDate: MONDAY, termDays: 7 })).rejects.toThrow(/days of the month/);
    await expect(subscribeToPlan({ ...base, frequency: "DAILY", startDate: MONDAY })).rejects.toThrow(/plan length: 7, 30/);
    await expect(subscribeToPlan({ ...base, frequency: "DAILY", startDate: MONDAY, termDays: 10 })).rejects.toThrow(/plan length/);

    const sub = await subscribeToPlan({ ...base, frequency: "DAILY", startDate: MONDAY, termDays: 7 });
    expect(sub.endDate).toBe(addDays(MONDAY, 6));
    // Later changes stay within the plan too.
    await expect(updateSubscription(sub.id, { frequency: "WEEKLY", weekdays: [7] }, actorOf(f.customer))).rejects.toThrow(/days this plan is delivered/);
    const changed = await updateSubscription(sub.id, { frequency: "WEEKLY", weekdays: [1, 3, 5] }, actorOf(f.customer));
    expect(changed.weekdays).toEqual([1, 3, 5]);
    await expect(updateSubscription(sub.id, { shopProductId: f.dinnerListing.id }, actorOf(f.customer))).rejects.toThrow(/stays on its plan's product/);
  });

  it("refuses a shop that does not deliver to the address, and a plan that is off", async () => {
    const f = await setup();
    const far = await createPlan(f.far.id, lunchPlan(f.farListing.id), actorOf(f.farOwner));
    await expect(
      subscribeToPlan({ userId: f.customer.id, planId: far.id, quantityMilli: 1000, frequency: "DAILY", startDate: MONDAY, addressId: f.addressId }),
    ).rejects.toThrow(/does not deliver to the chosen address/);
    const plan = await createPlan(f.kitchen.id, lunchPlan(f.thaliListing.id), actorOf(f.owner));
    await setPlanActive(f.kitchen.id, plan.id, false, actorOf(f.owner));
    await expect(
      subscribeToPlan({ userId: f.customer.id, planId: plan.id, quantityMilli: 1000, frequency: "DAILY", startDate: MONDAY, addressId: f.addressId }),
    ).rejects.toThrow(/not found/i);
  });

  it("a removed plan keeps delivering to its running subscribers; its product cannot change while they exist", async () => {
    const f = await setup();
    const plan = await createPlan(f.kitchen.id, lunchPlan(f.thaliListing.id), actorOf(f.owner));
    await subscribeToPlan({ userId: f.customer.id, planId: plan.id, quantityMilli: 1000, frequency: "DAILY", startDate: MONDAY, addressId: f.addressId });
    await expect(updatePlan(f.kitchen.id, plan.id, lunchPlan(f.dinnerListing.id), actorOf(f.owner))).rejects.toThrow(/cannot change/);
    await removePlan(f.kitchen.id, plan.id, actorOf(f.owner));
    expect(await listShopPlans(f.kitchen.id)).toEqual([]);
    expect((await generateDailyOrders(MONDAY)).generated).toBe(1);
  });
});

describe("the shop's prep sheet", () => {
  it("counts each plan's deliveries and quantity per day — serving days and skips included", async () => {
    const f = await setup();
    const plan = await createPlan(f.kitchen.id, lunchPlan(f.thaliListing.id), actorOf(f.owner));
    const a = await subscribeToPlan({ userId: f.customer.id, planId: plan.id, quantityMilli: 2000, frequency: "DAILY", startDate: MONDAY, addressId: f.addressId });
    const { user: second } = await createUserWithWallet({ balancePaise: 50_000 });
    const secondAddress = await deliveryAddressId(second.id);
    await subscribeToPlan({ userId: second.id, planId: plan.id, quantityMilli: 1000, frequency: "WEEKLY", weekdays: [1, 3], startDate: MONDAY, addressId: secondAddress });
    await skipDate(a.id, addDays(MONDAY, 2), actorOf(f.customer)); // Wednesday off for the first customer

    const sheet = await planPrepSheet(f.kitchen.id, { from: MONDAY, days: 7 });
    expect(sheet.dates[0]).toBe(MONDAY);
    expect(sheet.rows).toHaveLength(1);
    const row = sheet.rows[0];
    expect(row).toMatchObject({ label: "Veg lunch thali", slot: "LUNCH" });
    expect(row.days[MONDAY]).toEqual({ deliveries: 2, quantityMilli: 3000 });
    expect(row.days[addDays(MONDAY, 1)]).toEqual({ deliveries: 1, quantityMilli: 2000 }); // Tue: only the first
    expect(row.days[addDays(MONDAY, 2)]).toEqual({ deliveries: 1, quantityMilli: 1000 }); // Wed: first skipped, second on
    expect(row.days[SUNDAY]).toEqual({ deliveries: 0, quantityMilli: 0 }); // the kitchen does not serve Sunday
  });
});

describe("the API routes", () => {
  it("lets the owner manage plans, refuses another shop's owner, and lets a customer find and take one", async () => {
    const f = await setup();
    const body = lunchPlan(f.thaliListing.id);

    expect((await call(createPlanRoute, `/api/shops/${f.kitchen.id}/subscription-plans`, { method: "POST", body, params: { id: f.kitchen.id } })).status).toBe(401);
    signInAs(f.farOwner);
    expect((await call(createPlanRoute, `/api/shops/${f.kitchen.id}/subscription-plans`, { method: "POST", body, params: { id: f.kitchen.id } })).status).toBe(403);

    signInAs(f.owner);
    const created = await call(createPlanRoute, `/api/shops/${f.kitchen.id}/subscription-plans`, { method: "POST", body, params: { id: f.kitchen.id } });
    expect(created.status).toBe(201);
    const bad = await call(createPlanRoute, `/api/shops/${f.kitchen.id}/subscription-plans`, {
      method: "POST",
      body: { ...body, name: "Bad", slot: "MIDNIGHT" },
      params: { id: f.kitchen.id },
    });
    expect(bad.status).toBe(422);
    const listed = await call(listPlansRoute, `/api/shops/${f.kitchen.id}/subscription-plans`, { params: { id: f.kitchen.id } });
    expect(listed.body.map((p: { name: string }) => p.name)).toEqual(["Veg lunch thali"]);
    const toggled = await call(patchPlanRoute, `/api/shops/${f.kitchen.id}/subscription-plans/${created.body.id}`, {
      method: "PATCH",
      body: { isActive: true },
      params: { id: f.kitchen.id, planId: created.body.id },
    });
    expect(toggled.status).toBe(200);

    signInAs(f.customer);
    const near = await call(nearRoute, `/api/subscription-plans?addressId=${f.addressId}&kind=MEAL`);
    expect(near.status).toBe(200);
    expect(near.body.map((p: { id: string }) => p.id)).toEqual([created.body.id]);
    const taken = await call(subscribeRoute, `/api/subscription-plans/${created.body.id}/subscribe`, {
      method: "POST",
      body: { quantityMilli: 1000, frequency: "DAILY", startDate: MONDAY, addressId: f.addressId },
      params: { planId: created.body.id },
    });
    expect(taken.status).toBe(201);
    expect(taken.body).toMatchObject({ planId: created.body.id, frequency: "WEEKLY" });
    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, taken.body.id));
    expect(row.planId).toBe(created.body.id);
  });
});
