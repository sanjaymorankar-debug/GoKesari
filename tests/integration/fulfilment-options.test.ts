/**
 * Fulfilment options and scheduling (docs/four-features-2026-10, feature 1).
 *
 * Pickup (pickup code), the shop's own delivery (delivery link + the
 * customer's delivery code) and GoKesari delivery partners (the existing rider
 * dispatch), each with a date and time slot; changing the plan until the order
 * leaves; customer notifications; no GoKesari delivery charge for pickup / own
 * delivery; permissions; validation; wrong-code lockout.
 */
import { and, eq, inArray } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  outbox: [] as { to: string; subject: string; text: string }[],
  session: null as null | {
    user: { id: string; email: string; name: string | null; image: null; role: UserRole; status: "ACTIVE" };
  },
}));

vi.mock("@/server/email/transport", () => ({
  emailMode: () => "smtp",
  sendEmail: async (message: { to: string; subject: string; text: string }) => {
    state.outbox.push(message);
  },
  EmailUnavailableError: class extends Error {},
}));

vi.mock("@/server/auth", () => ({
  auth: async () => state.session,
  handlers: {},
  signIn: async () => {},
  signOut: async () => {},
}));

import { GET as planGet, POST as planRoute } from "@/app/api/orders/[id]/fulfilment-plan/route";
import { POST as handoverRoute } from "@/app/api/orders/[id]/fulfilment-plan/handover/route";
import { POST as ownCodeRoute } from "@/app/api/orders/[id]/fulfilment-plan/code/route";
import { POST as fulfilmentRoute } from "@/app/api/orders/[id]/fulfilment/route";
import { PATCH as statusRoute } from "@/app/api/orders/[id]/status/route";
import { POST as staffAddRoute, GET as staffListRoute } from "@/app/api/shops/[id]/delivery-staff/route";
import { PATCH as staffPatchRoute } from "@/app/api/shops/[id]/delivery-staff/[staffId]/route";
import { GET as linkGet, POST as linkPost } from "@/app/api/delivery-link/[token]/route";
import { availableSlotDays } from "@/lib/fulfilment-options";
import { resetRateLimits } from "@/server/api/rate-limit";
import { db } from "@/server/db";
import {
  commissionRates,
  deliveryOrders,
  deliveryPartners,
  grievances,
  notifications,
  orderFulfilmentArrangements,
  orders,
  platformSettings,
  riderSearches,
  shopWalletTransactions,
  shops,
} from "@/server/db/schema";
import { addToCart } from "@/server/services/cart";
import { acceptDeliveryOffer, findRiderNow, markDelivered, markPickedUp, startDelivery } from "@/server/services/delivery-assignment";
import { setCommissionRate } from "@/server/services/finance";
import { acceptOrder, startPicking } from "@/server/services/fulfilment";
import { pickupCodeFor, getBuyerFulfilmentViews, getShopFulfilmentViews } from "@/server/services/fulfilment-options";
import { checkout } from "@/server/services/orders";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { adjustShopWallet } from "@/server/services/shop-wallet";
import { call } from "../helpers/http";
import {
  createCategory,
  createDeliveryPartner,
  createProduct,
  createShop,
  createShopProduct,
  createUser,
  createUserWithWallet,
  deliveryAddressId,
  resetDatabase,
} from "../helpers/fixtures";

const SHOP = { latitude: 18.5, longitude: 73.85 };
const PRICE = 10_500;
let admin = { id: "", role: "ADMIN" as const };

/** Every half hour of the day, so "now" is always a slot whenever the suite runs. */
const RULES = { enabled: true, slotMinutes: 30, firstSlotHour: 0, lastSlotHour: 24, maxDaysAhead: 7, gokesariLeadMinutes: 45 } as const;

beforeEach(async () => {
  await resetDatabase();
  await db.delete(commissionRates);
  await db.delete(platformSettings).where(inArray(platformSettings.key, ["fulfilmentOptions", "shopWallet", "deliveryOtp"]));
  clearRuleCache();
  resetRateLimits();
  state.outbox = [];
  state.session = null;
  const a = await createUser({ role: "ADMIN" });
  admin = { id: a.id, role: "ADMIN" };
  await setCommissionRate({ scope: "DEFAULT", rateBp: 100 }, admin);
});

async function enable(overrides: Partial<typeof RULES> = {}) {
  await setRule("fulfilmentOptions", { ...RULES, ...overrides }, admin);
}

function signIn(user: { id: string; email: string; name: string | null }, role: UserRole) {
  state.session = { user: { id: user.id, email: user.email, name: user.name, image: null, role, status: "ACTIVE" } };
}

function nowSlot(): string {
  return availableSlotDays(RULES)[0].slots[0].key;
}

/** A slot at least three hours away (rider search must wait for it). */
function laterSlot(): string {
  const limit = Date.now() + 3 * 3_600_000;
  for (const day of availableSlotDays(RULES)) for (const slot of day.slots) if (new Date(slot.start).getTime() > limit) return slot.key;
  throw new Error("no later slot");
}

async function setup(opts: { deliveryAvailable?: boolean; withRider?: boolean } = {}) {
  const owner = await createUser({ role: "SHOP_OWNER", name: "Owner" });
  const cat = await createCategory({ department: "DAIRY", name: "Milk" });
  const milk = await createProduct(cat.id, { name: "Cow Milk", unit: "L" });
  const shop = await createShop(owner.id, {
    name: "Dairy One",
    latitude: SHOP.latitude,
    longitude: SHOP.longitude,
    deliveryAvailable: opts.deliveryAvailable ?? true,
  });
  const sp = await createShopProduct(shop.id, milk.id, { onlinePricePaise: PRICE, onlineStock: 50 });
  let riderUser = null as Awaited<ReturnType<typeof createUser>> | null;
  if (opts.withRider) {
    riderUser = await createUser({ role: "DELIVERY_PARTNER" });
    await createDeliveryPartner(riderUser.id, { isOnline: true, latitude: SHOP.latitude, longitude: SHOP.longitude, operatingRadiusKm: 20 });
  }
  return { owner, shop, sp, ownerActor: { id: owner.id, role: "SHOP_OWNER" as const }, riderUser };
}

async function preparingOrder(ctx: Awaited<ReturnType<typeof setup>>, opts: { address?: boolean; cod?: boolean } = {}) {
  const { user } = await createUserWithWallet({ balancePaise: 500_000 });
  await addToCart(user.id, ctx.sp.id, 1);
  const { orders: placed } = await checkout({
    userId: user.id,
    addressId: opts.address === false ? null : await deliveryAddressId(user.id),
    requestId: `r-${Math.random()}`,
    paymentMethod: opts.cod ? "COD" : "WALLET",
  });
  await acceptOrder(placed[0].id, ctx.ownerActor);
  await startPicking(placed[0].id, ctx.ownerActor);
  return { customer: user, order: placed[0] };
}

async function addStaff(shopId: string, owner: { id: string; email: string; name: string | null }, name = "Ramesh", mobile = "9876500001") {
  signIn(owner, "SHOP_OWNER");
  const res = await call(staffAddRoute, `/api/shops/${shopId}/delivery-staff`, { method: "POST", body: { name, mobile }, params: { id: shopId } });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; name: string };
}

async function plan(orderId: string, body: Record<string, unknown>) {
  return call(planRoute, `/api/orders/${orderId}/fulfilment-plan`, { method: "POST", body, params: { id: orderId } });
}

async function handover(orderId: string, body: Record<string, unknown>) {
  return call(handoverRoute, `/api/orders/${orderId}/fulfilment-plan/handover`, { method: "POST", body, params: { id: orderId } });
}

async function orderStatus(orderId: string) {
  const [row] = await db.select({ status: orders.status }).from(orders).where(eq(orders.id, orderId));
  return row.status;
}

async function notes(userId: string, type: string) {
  return db.select().from(notifications).where(and(eq(notifications.userId, userId), eq(notifications.type, type)));
}

function emailedCode(to: string): string {
  const mail = [...state.outbox].reverse().find((m) => m.to === to && /is your delivery code/.test(m.subject));
  expect(mail, `delivery code email to ${to}`).toBeDefined();
  return mail!.subject.slice(0, 4);
}

async function planRow(orderId: string) {
  const [row] = await db.select().from(orderFulfilmentArrangements).where(eq(orderFulfilmentArrangements.orderId, orderId));
  return row;
}

/* ------------------------------------------------------------- rule off */

describe("rule off (default)", () => {
  it("marking ready works exactly as before, with no plan", async () => {
    const ctx = await setup();
    const { order } = await preparingOrder(ctx);
    signIn(ctx.owner, "SHOP_OWNER");
    const res = await call(fulfilmentRoute, `/api/orders/${order.id}/fulfilment`, { method: "POST", body: { action: "ready" }, params: { id: order.id } });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("READY");
    expect(await planRow(order.id)).toBeUndefined();
    // Choosing an option is refused while the rule is off.
    const refused = await plan(order.id, { option: "PICKUP", slotKey: nowSlot() });
    expect(refused.status).toBe(409);
  });
});

/* --------------------------------------------------------------- pickup */

describe("customer pickup", () => {
  it("must be chosen when marking ready; pickup code completes it; no GoKesari delivery charge", async () => {
    await enable();
    await setRule("shopWallet", { enabled: true }, admin);
    const ctx = await setup({ withRider: true });
    await adjustShopWallet({ shopId: ctx.shop.id, direction: "CREDIT", amountPaise: 50_000, reason: "Test", requestId: `f-${Math.random()}` }, admin);
    const { order, customer } = await preparingOrder(ctx);
    signIn(ctx.owner, "SHOP_OWNER");

    // The old one-click ready now asks for a choice.
    const bare = await call(fulfilmentRoute, `/api/orders/${order.id}/fulfilment`, { method: "POST", body: { action: "ready" }, params: { id: order.id } });
    expect(bare.status).toBe(409);
    expect(bare.body.error.details.needsFulfilmentChoice).toBe(true);

    const slot = nowSlot();
    const res = await plan(order.id, { option: "PICKUP", slotKey: slot, markReady: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.order.status).toBe("READY");
    expect(res.body.plan).toMatchObject({ option: "PICKUP", slotKey: slot, completed: false });

    // The same "mark ready" again (double tap, retried request) answers with what was done.
    const repeat = await plan(order.id, { option: "PICKUP", slotKey: slot, markReady: true });
    expect(repeat.status, JSON.stringify(repeat.body)).toBe(200);
    expect(repeat.body.order.status).toBe("READY");

    // No rider is looked for, even with one online next door.
    expect(await db.select().from(deliveryOrders).where(eq(deliveryOrders.orderId, order.id))).toHaveLength(0);
    expect(await db.select().from(riderSearches).where(eq(riderSearches.orderId, order.id))).toHaveLength(0);

    // The customer is told at once (in the app; email queued), with the time.
    const [note, ...more] = await notes(customer.id, "order.fulfilment_set");
    expect(more).toHaveLength(0); // the repeat told nobody twice
    expect(note.title).toBe("Ready for pickup");
    expect(note.body).toContain("Pickup from the shop");

    // The customer sees the pickup code; it is not stored anywhere.
    const view = (await getBuyerFulfilmentViews([order.id], customer)).get(order.id)!;
    const row = await planRow(order.id);
    expect(view.pickupCode).toBe(pickupCodeFor(row));
    expect(view.pickupCode).toMatch(/^\d{4}$/);
    expect(JSON.stringify(row)).not.toContain(`"${view.pickupCode}"`);

    // Neither the manual buttons nor a plain status change can complete it.
    const manual = await call(statusRoute, `/api/orders/${order.id}/status`, { method: "PATCH", body: { status: "DELIVERED" }, params: { id: order.id } });
    expect(manual.status).toBe(409);
    const out = await call(statusRoute, `/api/orders/${order.id}/status`, { method: "PATCH", body: { status: "OUT_FOR_DELIVERY" }, params: { id: order.id } });
    expect(out.status).toBe(409);

    const wrong = view.pickupCode === "0000" ? "1111" : "0000";
    const bad = await handover(order.id, { action: "pickup", code: wrong });
    expect(bad.status).toBe(422);
    expect(bad.body.error.message).toContain("4 attempts left");

    const good = await handover(order.id, { action: "pickup", code: view.pickupCode });
    expect(good.status, JSON.stringify(good.body)).toBe(200);
    expect(good.body.status).toBe("DELIVERED");
    expect((await planRow(order.id)).completedVia).toBe("PICKUP_CODE");

    // Commission from the wallet as the existing rule says; no delivery charge.
    const charges = await db.select().from(shopWalletTransactions).where(eq(shopWalletTransactions.orderId, order.id));
    expect(charges.map((c) => c.type)).toEqual(["COMMISSION"]);

    // A second submit changes nothing and answers with the delivered order.
    const again = await handover(order.id, { action: "pickup", code: view.pickupCode });
    expect(again.status).toBe(200);
    expect(again.body.status).toBe("DELIVERED");
    expect(await db.select().from(shopWalletTransactions).where(eq(shopWalletTransactions.orderId, order.id))).toHaveLength(1);
  });

  it("a cash-on-delivery pickup needs the cash confirmed", async () => {
    await enable();
    const ctx = await setup();
    await db.update(shops).set({ codEnabled: true }).where(eq(shops.id, ctx.shop.id));
    const { order, customer } = await preparingOrder(ctx, { cod: true });
    signIn(ctx.owner, "SHOP_OWNER");
    expect((await plan(order.id, { option: "PICKUP", slotKey: nowSlot(), markReady: true })).status).toBe(200);
    const code = (await getBuyerFulfilmentViews([order.id], customer)).get(order.id)!.pickupCode!;
    const noCash = await handover(order.id, { action: "pickup", code });
    expect(noCash.status).toBe(422);
    const paid = await handover(order.id, { action: "pickup", code, cashCollected: true });
    expect(paid.status).toBe(200);
    const [row] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(row.codCollectedAt).not.toBeNull();
  });

  it("five wrong codes lock the pickup, raise a ticket and alert support; operations confirm it", async () => {
    await enable();
    const ctx = await setup();
    const { order, customer } = await preparingOrder(ctx);
    signIn(ctx.owner, "SHOP_OWNER");
    await plan(order.id, { option: "PICKUP", slotKey: nowSlot(), markReady: true });
    const code = (await getBuyerFulfilmentViews([order.id], customer)).get(order.id)!.pickupCode!;
    const wrong = code === "0000" ? "1111" : "0000";
    for (let i = 0; i < 4; i += 1) expect((await handover(order.id, { action: "pickup", code: wrong })).status).toBe(422);
    const fifth = await handover(order.id, { action: "pickup", code: wrong });
    expect(fifth.status).toBe(409);
    expect(fifth.body.error.details.locked).toBe(true);
    // Even the right code is refused now.
    expect((await handover(order.id, { action: "pickup", code })).status).toBe(409);
    const [ticket] = await db.select().from(grievances).where(eq(grievances.orderId, order.id));
    expect(ticket.subject).toContain("Pickup code locked");
    expect(await notes(admin.id, "support.fulfilment_code_locked")).toHaveLength(1);
    expect(await notes(customer.id, "order.fulfilment_code_locked")).toHaveLength(1);

    // The shop cannot override; operations can.
    expect((await handover(order.id, { action: "confirm", note: "Called the customer" })).status).toBe(403);
    const adminUser = { id: admin.id, email: "admin@test.local", name: "Admin" };
    signIn(adminUser, "ADMIN");
    const confirmed = await handover(order.id, { action: "confirm", note: "Called the customer, collected" });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect(confirmed.body.status).toBe("DELIVERED");
  });
});

/* --------------------------------------------------- shop's own delivery */

describe("shop's own delivery", () => {
  it("staff screen, delivery link, out for delivery with an emailed code, completed by the customer's code", async () => {
    await enable();
    await setRule("deliveryOtp", { maxAttempts: 5, resendCooldownSeconds: 0, maxResends: 3 }, admin);
    await setRule("shopWallet", { enabled: true }, admin);
    const ctx = await setup();
    await adjustShopWallet({ shopId: ctx.shop.id, direction: "CREDIT", amountPaise: 50_000, reason: "Test", requestId: `f-${Math.random()}` }, admin);
    const ramesh = await addStaff(ctx.shop.id, ctx.owner);
    const { order, customer } = await preparingOrder(ctx);
    signIn(ctx.owner, "SHOP_OWNER");

    const res = await plan(order.id, { option: "SHOP_DELIVERY", slotKey: nowSlot(), staffId: ramesh.id, markReady: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.plan.staff.name).toBe("Ramesh");
    const link: string = res.body.plan.staffLinkPath;
    expect(link).toMatch(/^\/delivery\/[0-9a-f-]{36}\.[A-Za-z0-9_-]{32}$/);
    const token = link.split("/").pop()!;

    // The delivery person opens the link without signing in.
    state.session = null;
    const view = await call(linkGet, link.replace("/delivery/", "/api/delivery-link/"), { params: { token } });
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ orderNumber: order.orderNumber, staffName: "Ramesh", canStart: true, canComplete: false });
    expect(view.body.customer.address).toContain("2 Test Lane");

    // A tampered link is a 404.
    const forged = `${token.slice(0, -2)}xx`;
    expect((await call(linkGet, `/api/delivery-link/${forged}`, { params: { token: forged } })).status).toBe(404);

    state.outbox = [];
    const started = await call(linkPost, `/api/delivery-link/${token}`, { method: "POST", body: { action: "start" }, params: { token } });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect(started.body).toMatchObject({ status: "OUT_FOR_DELIVERY", canComplete: true });
    expect(await orderStatus(order.id)).toBe("OUT_FOR_DELIVERY");
    const code = emailedCode(customer.email);

    // Once out, the plan can no longer be changed.
    signIn(ctx.owner, "SHOP_OWNER");
    expect((await plan(order.id, { option: "PICKUP", slotKey: nowSlot() })).status).toBe(409);

    // The customer can get a fresh code (old one dies), shown once.
    signIn(customer, "CUSTOMER");
    const fresh = await call(ownCodeRoute, `/api/orders/${order.id}/fulfilment-plan/code`, { method: "POST", params: { id: order.id } });
    expect(fresh.status, JSON.stringify(fresh.body)).toBe(200);
    expect(fresh.body.code).toMatch(/^\d{4}$/);
    // Another customer cannot.
    const stranger = await createUser();
    signIn(stranger, "CUSTOMER");
    expect((await call(ownCodeRoute, `/api/orders/${order.id}/fulfilment-plan/code`, { method: "POST", params: { id: order.id } })).status).toBe(404);

    state.session = null;
    if (fresh.body.code !== code) {
      const stale = await call(linkPost, `/api/delivery-link/${token}`, { method: "POST", body: { action: "complete", code }, params: { token } });
      expect(stale.status).toBe(422);
    }
    const done = await call(linkPost, `/api/delivery-link/${token}`, { method: "POST", body: { action: "complete", code: fresh.body.code }, params: { token } });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.status).toBe("DELIVERED");
    expect(done.body.customer).toBeNull(); // the customer's details are gone from the link
    expect((await planRow(order.id)).completedVia).toBe("DELIVERY_CODE");

    const charges = await db.select().from(shopWalletTransactions).where(eq(shopWalletTransactions.orderId, order.id));
    expect(charges.map((c) => c.type)).toEqual(["COMMISSION"]);
    expect(await notes(ctx.owner.id, "shop.order_delivered")).toHaveLength(1);
  });

  it("changing the option, person and time notifies the customer; the old link stops working", async () => {
    await enable();
    const ctx = await setup();
    const ramesh = await addStaff(ctx.shop.id, ctx.owner);
    const suresh = await addStaff(ctx.shop.id, ctx.owner, "Suresh", "9876500002");
    const { order, customer } = await preparingOrder(ctx);
    signIn(ctx.owner, "SHOP_OWNER");
    await plan(order.id, { option: "PICKUP", slotKey: nowSlot(), markReady: true });

    const later = laterSlot();
    const toRamesh = await plan(order.id, { option: "SHOP_DELIVERY", slotKey: later, staffId: ramesh.id });
    expect(toRamesh.status, JSON.stringify(toRamesh.body)).toBe(200);
    const oldToken = toRamesh.body.plan.staffLinkPath.split("/").pop();
    const changed = await notes(customer.id, "order.fulfilment_changed");
    expect(changed).toHaveLength(1);
    expect(changed[0].body).toContain("Shop's own delivery (Ramesh)");
    expect(changed[0].body).toContain("Before: Pickup from the shop");

    const toSuresh = await plan(order.id, { option: "SHOP_DELIVERY", slotKey: later, staffId: suresh.id });
    expect(toSuresh.status).toBe(200);
    expect((await call(linkGet, `/api/delivery-link/${oldToken}`, { params: { token: oldToken } })).status).toBe(404);
    expect(await notes(customer.id, "order.fulfilment_changed")).toHaveLength(2);
    expect((await planRow(order.id)).version).toBe(3);

    // Saving the same plan again tells nobody.
    expect((await plan(order.id, { option: "SHOP_DELIVERY", slotKey: later, staffId: suresh.id })).status).toBe(200);
    expect(await notes(customer.id, "order.fulfilment_changed")).toHaveLength(2);

    // Suresh cannot be deactivated while he holds the order; Ramesh can.
    const busy = await call(staffPatchRoute, `/api/shops/${ctx.shop.id}/delivery-staff/${suresh.id}`, {
      method: "PATCH",
      body: { isActive: false },
      params: { id: ctx.shop.id, staffId: suresh.id },
    });
    expect(busy.status).toBe(409);
    const off = await call(staffPatchRoute, `/api/shops/${ctx.shop.id}/delivery-staff/${ramesh.id}`, {
      method: "PATCH",
      body: { isActive: false },
      params: { id: ctx.shop.id, staffId: ramesh.id },
    });
    expect(off.status).toBe(200);
    expect(off.body.isActive).toBe(false);
    // A deactivated person cannot be chosen.
    expect((await plan(order.id, { option: "SHOP_DELIVERY", slotKey: later, staffId: ramesh.id })).status).toBe(422);
  });

  it("validation: a slot not offered, no delivery person, another shop's person, no delivery address", async () => {
    await enable();
    const ctx = await setup();
    const other = await setup();
    const theirs = await addStaff(other.shop.id, other.owner, "Other", "9876500009");
    const { order } = await preparingOrder(ctx);
    signIn(ctx.owner, "SHOP_OWNER");
    expect((await plan(order.id, { option: "PICKUP", slotKey: "2020-01-01@10:00" })).status).toBe(422);
    expect((await plan(order.id, { option: "SHOP_DELIVERY", slotKey: nowSlot() })).status).toBe(422);
    expect((await plan(order.id, { option: "SHOP_DELIVERY", slotKey: nowSlot(), staffId: theirs.id })).status).toBe(422);

    const pickupOnly = await setup({ deliveryAvailable: false });
    const mine = await addStaff(pickupOnly.shop.id, pickupOnly.owner, "Mine", "9876500010");
    const { order: noAddress } = await preparingOrder(pickupOnly, { address: false });
    signIn(pickupOnly.owner, "SHOP_OWNER");
    expect((await plan(noAddress.id, { option: "SHOP_DELIVERY", slotKey: nowSlot(), staffId: mine.id })).status).toBe(422);
    expect((await plan(noAddress.id, { option: "GOKESARI_PARTNER", slotKey: nowSlot() })).status).toBe(422);
    expect((await plan(noAddress.id, { option: "PICKUP", slotKey: nowSlot(), markReady: true })).status).toBe(200);
  });
});

/* ------------------------------------------------ GoKesari delivery partner */

describe("GoKesari delivery partner", () => {
  it("uses the existing rider dispatch and delivery-code completion (delivery charge applies)", async () => {
    await enable();
    await setRule("shopWallet", { enabled: true }, admin);
    const ctx = await setup({ withRider: true });
    await adjustShopWallet({ shopId: ctx.shop.id, direction: "CREDIT", amountPaise: 50_000, reason: "Test", requestId: `f-${Math.random()}` }, admin);
    const { order, customer } = await preparingOrder(ctx);
    signIn(ctx.owner, "SHOP_OWNER");
    const res = await plan(order.id, { option: "GOKESARI_PARTNER", slotKey: nowSlot(), markReady: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const [offer] = await db.select().from(deliveryOrders).where(eq(deliveryOrders.orderId, order.id));
    expect(offer.status).toBe("OFFERED");
    const rider = { id: ctx.riderUser!.id, role: "DELIVERY_PARTNER" as const };
    await acceptDeliveryOffer(offer.id, rider.id);
    const [accepted] = await db.select().from(deliveryOrders).where(eq(deliveryOrders.id, offer.id));
    await markPickedUp(offer.id, rider, accepted.pickupCode!);
    state.outbox = [];
    await startDelivery(offer.id, rider);
    await markDelivered(offer.id, rider, emailedCode(customer.email));
    expect(await orderStatus(order.id)).toBe("DELIVERED");
    const charges = await db.select().from(shopWalletTransactions).where(eq(shopWalletTransactions.orderId, order.id));
    expect(charges.map((c) => c.type).sort()).toEqual(["COMMISSION", "DELIVERY_CHARGE"]);
  });

  it("a later slot waits for its lead time; Find rider now goes straight through", async () => {
    await enable();
    const ctx = await setup({ withRider: true });
    const { order } = await preparingOrder(ctx);
    signIn(ctx.owner, "SHOP_OWNER");
    const res = await plan(order.id, { option: "GOKESARI_PARTNER", slotKey: laterSlot(), markReady: true });
    expect(res.status).toBe(200);
    expect(res.body.plan.riderSearchFrom).not.toBeNull();
    expect(await db.select().from(deliveryOrders).where(eq(deliveryOrders.orderId, order.id))).toHaveLength(0);
    const offer = await findRiderNow(order.id, ctx.ownerActor);
    expect(offer.status).toBe("OFFERED");
  });

  it("switching to pickup before the rider picks up releases the rider, who is told", async () => {
    await enable();
    const ctx = await setup({ withRider: true });
    const { order, customer } = await preparingOrder(ctx);
    signIn(ctx.owner, "SHOP_OWNER");
    await plan(order.id, { option: "GOKESARI_PARTNER", slotKey: nowSlot(), markReady: true });
    const [offer] = await db.select().from(deliveryOrders).where(eq(deliveryOrders.orderId, order.id));
    await acceptDeliveryOffer(offer.id, ctx.riderUser!.id);
    expect(await orderStatus(order.id)).toBe("ASSIGNED");

    const res = await plan(order.id, { option: "PICKUP", slotKey: nowSlot() });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await orderStatus(order.id)).toBe("READY");
    const [released] = await db.select().from(deliveryOrders).where(eq(deliveryOrders.id, offer.id));
    expect(released.status).toBe("CANCELLED");
    expect(await notes(ctx.riderUser!.id, "delivery.cancelled")).toHaveLength(1);
    expect(await notes(customer.id, "order.fulfilment_changed")).toHaveLength(1);
    const [search] = await db.select().from(riderSearches).where(eq(riderSearches.orderId, order.id));
    expect(search.status).not.toBe("SEARCHING");

    // Once a rider has picked an order up, the plan is fixed.
    const again = await setup({ withRider: true });
    const { order: second } = await preparingOrder(again);
    signIn(again.owner, "SHOP_OWNER");
    await plan(second.id, { option: "GOKESARI_PARTNER", slotKey: nowSlot(), markReady: true });
    const [o2] = await db.select().from(deliveryOrders).where(eq(deliveryOrders.orderId, second.id));
    // Whichever of the two nearby riders was offered it.
    const [partner] = await db.select({ userId: deliveryPartners.userId }).from(deliveryPartners).where(eq(deliveryPartners.id, o2.deliveryPartnerId));
    await acceptDeliveryOffer(o2.id, partner.userId);
    const [a2] = await db.select().from(deliveryOrders).where(eq(deliveryOrders.id, o2.id));
    await markPickedUp(o2.id, { id: partner.userId, role: "DELIVERY_PARTNER" }, a2.pickupCode!);
    expect((await plan(second.id, { option: "PICKUP", slotKey: nowSlot() })).status).toBe(409);
  });
});

/* ------------------------------------------------------------ permissions */

describe("permissions", () => {
  it("only the shop's owner or operations may plan; operations' change tells the shop", async () => {
    await enable();
    const ctx = await setup();
    const { order, customer } = await preparingOrder(ctx);

    const otherOwner = await createUser({ role: "SHOP_OWNER" });
    await createShop(otherOwner.id, { name: "Other" });
    signIn(otherOwner, "SHOP_OWNER");
    expect((await plan(order.id, { option: "PICKUP", slotKey: nowSlot(), markReady: true })).status).toBe(403);
    signIn(customer, "CUSTOMER");
    expect((await plan(order.id, { option: "PICKUP", slotKey: nowSlot(), markReady: true })).status).toBe(403);
    expect((await call(planGet, `/api/orders/${order.id}/fulfilment-plan`, { params: { id: order.id } })).status).toBe(403);
    expect((await call(staffListRoute, `/api/shops/${ctx.shop.id}/delivery-staff`, { params: { id: ctx.shop.id } })).status).toBe(403);
    state.session = null;
    expect((await plan(order.id, { option: "PICKUP", slotKey: nowSlot() })).status).toBe(401);

    const operator = await createUser({ role: "OPERATOR" });
    signIn(operator, "OPERATOR");
    const res = await plan(order.id, { option: "PICKUP", slotKey: nowSlot(), markReady: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await notes(ctx.owner.id, "shop.fulfilment_changed")).toHaveLength(1);

    const views = await getShopFulfilmentViews([order.id]);
    expect(views.get(order.id)?.option).toBe("PICKUP");
  });
});
