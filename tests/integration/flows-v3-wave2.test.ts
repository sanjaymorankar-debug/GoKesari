/**
 * Flow spec v3, wave 2 (docs/flows-v3/wave2.md; migration 0222). Every item with its flag ON, and the same path with
 * the flag OFF behaving exactly as before.
 *   F19 (flow_f19): 10-minute acceptance, WhatsApp reminder plan, alternative shop, rider search timings, no-rider
 *                   cancel, pickup not collected.
 *   F16 (flow_f16): cancel until packing, shop-agreed cancel after packing, return photo / non-returnable rules,
 *                   dispute from a declined return, shop told of a return refund, failed-delivery refund.
 *   F20 (flow_f20): one shop declines → customer told, cancels the rest.
 *   F3  (flow_f3):  packed straight from accepted, 2% commission fallback.
 *   F2  (flow_f2):  no referral code before the first order, code after it, explicit payment choice.
 *   F13 (flow_f13): category → items at stock 100, master-list adds at 100, duplicate choice, own product type,
 *                   ready-for-product-upload e-mail.
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FeatureFlagKey, UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | { user: { id: string; email: string; name: string | null; image: null; role: UserRole; status: "ACTIVE" } },
}));
vi.mock("@/server/auth", () => ({ auth: async () => state.session, handlers: {}, signIn: async () => {}, signOut: async () => {} }));

import { POST as productTypesPost } from "@/app/api/shops/[id]/product-types/route";
import { POST as cancelRequestPost } from "@/app/api/orders/[id]/cancel-request/route";
import { db } from "@/server/db";
import {
  deliveryOrders,
  documentEmails,
  featureFlags,
  notifications,
  orderDisputes,
  orderFulfilmentArrangements,
  orderItems,
  orders,
  platformSettings,
  products,
  riderSearches,
  shopProducts,
  wallets,
} from "@/server/db/schema";
import { decideCancelRequest, notifyShopReturnRefunded, requestCancellation, runFailedDeliveryRefunds, disputeDeclinedReturn } from "@/server/flows/f16-cancellations";
import { assertExplicitPayment, referralAfterFirstOrderIds } from "@/server/flows/f2-order";
import { cancelRemainingGroupOrders } from "@/server/flows/f20-multishop";
import { cancelUncollectedPickup, runNoRiderCancellations } from "@/server/flows/f19-timeouts";
import { dispatchBroadcastRule, dispatchRule } from "@/server/flows/wave2-rules";
import { addToCart } from "@/server/services/cart";
import { createProductForShop } from "@/server/services/catalogue";
import { applySignupReferralCode } from "@/server/services/customer-signup-referrals";
import { clearFeatureFlagCache } from "@/server/services/feature-flags";
import { resolveCommissionRate } from "@/server/services/finance";
import { acceptOrder, markOrderReady, rejectOrder, startPicking } from "@/server/services/fulfilment";
import { cancelOrder, checkout } from "@/server/services/orders";
import { createReferralCode } from "@/server/services/referrals";
import { setReferralSetting } from "@/server/services/referral-settings";
import { rejectReturn, requestReturn } from "@/server/services/returns";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { runShopAcceptanceSweep } from "@/server/services/shop-acceptance";
import { addPickedProducts, chooseCategories } from "@/server/services/shop-product-setup";
import { queueShopWelcomeKit } from "@/server/shop-banner/welcome-kit";
import { whatsAppPlanFor } from "@/server/whatsapp/shop-orders/queue";
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

const START = 500_000;
const GOODS = 7000;
const FEE = 1500;
const MIN = 60_000;
const RULE_KEYS = ["parentOrders", "shopAcceptance", "cancellation", "orderFlowsV3", "customerSignupReferral", "dispatch", "dispatchBroadcast", "returns"];

async function setFlag(key: FeatureFlagKey, enabled: boolean) {
  await db.insert(featureFlags).values({ key, enabled }).onConflictDoUpdate({ target: featureFlags.key, set: { enabled } });
  clearFeatureFlagCache();
}

async function clearRules() {
  for (const key of RULE_KEYS) await db.delete(platformSettings).where(eq(platformSettings.key, key));
  clearRuleCache();
}

type Person = Awaited<ReturnType<typeof createUser>>;
const actorOf = (u: { id: string; role: UserRole }) => ({ id: u.id, role: u.role });
function signInAs(u: Person) {
  state.session = { user: { id: u.id, email: u.email, name: u.name, image: null, role: u.role, status: "ACTIVE" } };
}

let admin: Person;

beforeEach(async () => {
  state.session = null;
  await resetDatabase();
  await clearRules();
  admin = await createUser({ role: "ADMIN" });
});
afterEach(async () => {
  await clearRules();
  clearFeatureFlagCache();
});

const balanceOf = async (userId: string) => (await db.query.wallets.findFirst({ where: eq(wallets.userId, userId) }))!.balancePaise;
const orderRow = async (orderId: string) => (await db.query.orders.findFirst({ where: eq(orders.id, orderId) }))!;
const notesOf = (userId: string, type: string) =>
  db.select().from(notifications).where(and(eq(notifications.userId, userId), eq(notifications.type, type)));

/** One customer, one shop selling milk; a wallet order (goods + delivery fee) placed. */
async function placeOrder(options: { department?: "DAIRY" | "BAKERY" | "GROCERY_KIRANA"; shopName?: string } = {}) {
  const { user: customer } = await createUserWithWallet({ balancePaise: START });
  const owner = await createUser({ role: "SHOP_OWNER" });
  const category = await createCategory({
    department: options.department ?? "DAIRY",
    name: options.department === "BAKERY" ? "Bread" : options.department === "GROCERY_KIRANA" ? "Household" : "Milk",
  });
  const product = await createProduct(category.id, { name: options.department === "BAKERY" ? "White Bread" : "Cow Milk", unit: "L" });
  const shop = await createShop(owner.id, { name: options.shopName ?? "Dairy One", deliveryFeePaise: FEE, latitude: 18.52, longitude: 73.85 });
  const sp = await createShopProduct(shop.id, product.id, { onlinePricePaise: GOODS, onlineStock: 50 });
  await addToCart(customer.id, sp.id, 1);
  const { orders: created } = await checkout({ userId: customer.id, requestId: `req-${customer.id}`, addressId: await deliveryAddressId(customer.id) });
  return { customer, owner, shop, product, category, sp, order: created[0] };
}

/* ======================================================================= F19 */

describe("F19 order timeouts (flow_f19)", () => {
  it("acceptance: on → 10 minutes even with rule shopAcceptance off; off → no accept-by time", async () => {
    const off = await placeOrder();
    expect((await orderRow(off.order.id)).acceptByAt).toBeNull();
    await setFlag("flow_f19", true);
    const before = Date.now();
    const on = await placeOrder({ shopName: "Dairy Two" });
    const acceptBy = (await orderRow(on.order.id)).acceptByAt!;
    expect(acceptBy.getTime() - before).toBeGreaterThanOrEqual(10 * MIN - 1000);
    expect(acceptBy.getTime() - before).toBeLessThan(11 * MIN);
  });

  it("the half-time reminder is planned for WhatsApp, behind flow_f19", () => {
    expect(whatsAppPlanFor("order.accept_reminder", { orderId: "x", minutes: 5 }, null)).toMatchObject({ kind: "STATUS_UPDATE", flowFlag: "flow_f19" });
  });

  it("a silent shop: cancelled with a full refund and the customer pointed to a nearby shop with the same items", async () => {
    await setFlag("flow_f19", true);
    const s = await placeOrder();
    const otherOwner = await createUser({ role: "SHOP_OWNER" });
    const other = await createShop(otherOwner.id, { name: "Dairy Next Door", latitude: 18.521, longitude: 73.851 });
    await createShopProduct(other.id, s.product.id, { onlinePricePaise: GOODS, onlineStock: 10 });

    const result = await runShopAcceptanceSweep(new Date(Date.now() + 11 * MIN));
    expect(result.cancelled).toBe(1);
    expect(await balanceOf(s.customer.id)).toBe(START);
    const [suggestion] = await notesOf(s.customer.id, "order.alternative_shop");
    expect(suggestion.actionUrl).toBe(`/shops/${other.slug}`);
  });

  it("off: the sweep does nothing (rule shopAcceptance off) and no suggestion is sent", async () => {
    const s = await placeOrder();
    const result = await runShopAcceptanceSweep(new Date(Date.now() + 60 * MIN));
    expect(result.cancelled).toBe(0);
    expect((await orderRow(s.order.id)).status).toBe("CONFIRMED");
    expect(await notesOf(s.customer.id, "order.alternative_shop")).toHaveLength(0);
  });

  it("rider search: on → widens every 5 minutes and stops after 20; off → the stored rules", async () => {
    expect((await dispatchRule()).maxSearchMinutes).toBe(30);
    expect((await dispatchBroadcastRule()).enabled).toBe(false);
    await setFlag("flow_f19", true);
    expect((await dispatchRule()).maxSearchMinutes).toBe(20);
    expect(await dispatchBroadcastRule()).toMatchObject({ enabled: true, stepSeconds: 300 });
  });

  async function readyWithStoppedSearch(minutesAgo: number) {
    const s = await placeOrder();
    await db.update(orders).set({ status: "READY" }).where(eq(orders.id, s.order.id));
    const stoppedAt = new Date(Date.now() - minutesAgo * MIN);
    await db.insert(riderSearches).values({ orderId: s.order.id, status: "STOPPED", stopReason: "TIME_LIMIT", attempts: 3, maxAttempts: 10, stoppedAt, updatedAt: stoppedAt });
    return s;
  }

  it("no rider: cancelled with a full refund once the wait after the search has passed; off → untouched", async () => {
    const s = await readyWithStoppedSearch(15);
    expect(await runNoRiderCancellations()).toEqual({ cancelled: 0, skipped: 0 });
    expect((await orderRow(s.order.id)).status).toBe("READY");

    await setFlag("flow_f19", true);
    const result = await runNoRiderCancellations();
    expect(result.cancelled).toBe(1);
    expect((await orderRow(s.order.id)).status).toBe("REFUNDED");
    expect(await balanceOf(s.customer.id)).toBe(START);
    expect(await notesOf(s.owner.id, "shop.order_no_rider_cancelled")).toHaveLength(1);
  });

  it("no rider: left alone within the wait, or when the shop switched to pickup / its own delivery", async () => {
    await setFlag("flow_f19", true);
    const recent = await readyWithStoppedSearch(5);
    const switched = await readyWithStoppedSearch(30);
    await db.insert(orderFulfilmentArrangements).values({
      orderId: switched.order.id,
      shopId: switched.shop.id,
      option: "PICKUP",
      scheduledStart: new Date(),
      scheduledEnd: new Date(Date.now() + 60 * MIN),
    });
    expect((await runNoRiderCancellations()).cancelled).toBe(0);
    expect((await orderRow(recent.order.id)).status).toBe("READY");
    expect((await orderRow(switched.order.id)).status).toBe("READY");
  });

  async function readyPickup(slotEndedMinutesAgo: number) {
    const s = await placeOrder();
    await db.update(orders).set({ status: "READY" }).where(eq(orders.id, s.order.id));
    const end = new Date(Date.now() - slotEndedMinutesAgo * MIN);
    await db.insert(orderFulfilmentArrangements).values({ orderId: s.order.id, shopId: s.shop.id, option: "PICKUP", scheduledStart: new Date(end.getTime() - 60 * MIN), scheduledEnd: end });
    return s;
  }

  it("pickup not collected: the shop may cancel after slot end + 60 min (full refund), not before; off → not available", async () => {
    const late = await readyPickup(90);
    await expect(cancelUncollectedPickup(late.order.id, actorOf(late.owner))).rejects.toMatchObject({ code: "NOT_FOUND" });

    await setFlag("flow_f19", true);
    const early = await readyPickup(30);
    await expect(cancelUncollectedPickup(early.order.id, actorOf(early.owner))).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(cancelUncollectedPickup(late.order.id, actorOf(late.customer))).rejects.toMatchObject({ code: "FORBIDDEN" });
    const cancelled = await cancelUncollectedPickup(late.order.id, actorOf(late.owner));
    expect(cancelled.status).toBe("REFUNDED");
    expect(await balanceOf(late.customer.id)).toBe(START);
  });
});

/* ======================================================================= F16 */

describe("F16 cancellations, refunds, returns (flow_f16)", () => {
  for (const status of ["ACCEPTED", "PREPARING"] as const) {
    it(`the customer cancels at ${status}: on → full refund incl. delivery fee; off → blocked as before`, async () => {
      const off = await placeOrder();
      await acceptOrder(off.order.id, actorOf(off.owner));
      if (status === "PREPARING") await startPicking(off.order.id, actorOf(off.owner));
      await expect(cancelOrder(off.order.id, actorOf(off.customer), "x", { selfService: true })).rejects.toThrow(/contact the shop/);

      await setFlag("flow_f16", true);
      const result = await cancelOrder(off.order.id, actorOf(off.customer), "Changed my mind", { selfService: true });
      expect(result.status).toBe("REFUNDED");
      expect(await balanceOf(off.customer.id)).toBe(START);
    });
  }

  async function packed() {
    const s = await placeOrder();
    await acceptOrder(s.order.id, actorOf(s.owner));
    await startPicking(s.order.id, actorOf(s.owner));
    await db.update(orders).set({ status: "READY" }).where(eq(orders.id, s.order.id));
    return s;
  }

  it("after packing: the customer asks, the shop agrees → full refund, no charge", async () => {
    await setFlag("flow_f16", true);
    const s = await packed();
    await expect(cancelOrder(s.order.id, actorOf(s.customer), "x", { selfService: true })).rejects.toThrow();
    await requestCancellation(s.order.id, actorOf(s.customer), "Ordered twice");
    await expect(requestCancellation(s.order.id, actorOf(s.customer))).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await notesOf(s.owner.id, "shop.cancel_requested")).toHaveLength(1);
    await expect(decideCancelRequest(s.order.id, actorOf(s.customer), { accept: true })).rejects.toMatchObject({ code: "FORBIDDEN" });

    const decided = await decideCancelRequest(s.order.id, actorOf(s.owner), { accept: true });
    expect(decided.request.status).toBe("ACCEPTED");
    expect(decided.orderStatus).toBe("REFUNDED");
    expect(await balanceOf(s.customer.id)).toBe(START);
    expect(await notesOf(s.customer.id, "order.cancel_request_decided")).toHaveLength(1);
  });

  it("after packing: the shop declines → the order carries on and the customer is told", async () => {
    await setFlag("flow_f16", true);
    const s = await packed();
    await requestCancellation(s.order.id, actorOf(s.customer));
    const decided = await decideCancelRequest(s.order.id, actorOf(s.owner), { accept: false, note: "Already with the rider" });
    expect(decided.request.status).toBe("DECLINED");
    expect((await orderRow(s.order.id)).status).toBe("READY");
    expect(await balanceOf(s.customer.id)).toBe(START - GOODS - FEE);
  });

  it("after packing, off: no request (404), the route too", async () => {
    const s = await packed();
    await expect(requestCancellation(s.order.id, actorOf(s.customer))).rejects.toMatchObject({ code: "NOT_FOUND" });
    signInAs(s.customer);
    const res = await call(cancelRequestPost, `/api/orders/${s.order.id}/cancel-request`, { method: "POST", body: {}, params: { id: s.order.id } });
    expect(res.status).toBe(404);
  });

  async function delivered(department: "DAIRY" | "BAKERY" | "GROCERY_KIRANA" = "DAIRY") {
    const s = await placeOrder({ department });
    await db.update(orders).set({ status: "DELIVERED" }).where(eq(orders.id, s.order.id));
    const [line] = await db.select().from(orderItems).where(eq(orderItems.orderId, s.order.id));
    return { ...s, line };
  }
  const ret = (s: Awaited<ReturnType<typeof delivered>>, reason: "QUALITY_ISSUE" | "MISSING_ITEM" | "EXPIRED") =>
    requestReturn({ orderId: s.order.id, reason, items: [{ orderItemId: s.line.id, quantityMilli: 1000, condition: "OPENED" }] }, actorOf(s.customer));

  it("returns: a photo only for damaged / wrong items (on); off → the stored per-reason rule asks for one", async () => {
    // A household (non-food) item: the photo rule alone decides.
    const off = await delivered("GROCERY_KIRANA");
    await expect(ret(off, "QUALITY_ISSUE")).rejects.toThrow(/photo/);
    await setFlag("flow_f16", true);
    expect((await ret(off, "QUALITY_ISSUE")).status).toBe("UNDER_REVIEW");
  });

  it("returns: food / medicine categories are not returnable except for defects (on); off → allowed", async () => {
    const off = await delivered("BAKERY");
    expect((await ret(off, "MISSING_ITEM")).status).toBe("UNDER_REVIEW");

    await setFlag("flow_f16", true);
    const on = await delivered("BAKERY");
    await expect(ret(on, "MISSING_ITEM")).rejects.toThrow(/not returnable/);
    expect((await ret(on, "EXPIRED")).status).toBe("UNDER_REVIEW");
  });

  it("a declined return can be taken to a dispute once (on); off → 404", async () => {
    const s = await delivered();
    const r = await ret(s, "MISSING_ITEM");
    await rejectReturn(r.id, actorOf(s.owner), "The item was in the bag");
    await expect(disputeDeclinedReturn(r.id, actorOf(s.customer), "The bag had only one packet in it.")).rejects.toMatchObject({ code: "NOT_FOUND" });

    await setFlag("flow_f16", true);
    const dispute = await disputeDeclinedReturn(r.id, actorOf(s.customer), "The bag had only one packet in it.");
    expect(dispute.reason).toBe("SHORT_QUANTITY");
    const [row] = await db.select().from(orderDisputes).where(eq(orderDisputes.id, dispute.id));
    expect(row.returnRequestId).toBe(r.id);
    await expect(disputeDeclinedReturn(r.id, actorOf(s.customer), "Again, the bag had one packet.")).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("the shop is told when a return is refunded (on); off → nothing", async () => {
    const s = await delivered();
    const r = await ret(s, "MISSING_ITEM");
    await notifyShopReturnRefunded(r);
    expect(await notesOf(s.owner.id, "shop.return_refunded")).toHaveLength(0);
    await setFlag("flow_f16", true);
    await notifyShopReturnRefunded(r);
    expect(await notesOf(s.owner.id, "shop.return_refunded")).toHaveLength(1);
  });

  it("failed delivery: refunded automatically after the wait (on); off → left for the shop", async () => {
    const s = await placeOrder();
    const riderUser = await createUser({ role: "DELIVERY_PARTNER" });
    const rider = await createDeliveryPartner(riderUser.id);
    const failedAt = new Date(Date.now() - 45 * MIN);
    await db.insert(deliveryOrders).values({ orderId: s.order.id, deliveryPartnerId: rider.id, status: "FAILED", failedAt, failureReason: "Customer not at home" });
    await db.update(orders).set({ status: "FAILED", updatedAt: failedAt }).where(eq(orders.id, s.order.id));

    expect((await runFailedDeliveryRefunds()).cancelled).toBe(0);
    expect((await orderRow(s.order.id)).status).toBe("FAILED");
    await setFlag("flow_f16", true);
    expect((await runFailedDeliveryRefunds()).cancelled).toBe(1);
    expect((await orderRow(s.order.id)).status).toBe("REFUNDED");
    expect(await balanceOf(s.customer.id)).toBe(START);
  });
});

/* ======================================================================= F20 */

describe("F20 multi-shop cart (flow_f20)", () => {
  async function twoShopCheckout() {
    await setRule("parentOrders", { enabled: true }, actorOf(admin));
    const { user: customer } = await createUserWithWallet({ balancePaise: START });
    const category = await createCategory({ department: "DAIRY", name: "Milk" });
    const product = await createProduct(category.id, { name: "Cow Milk", unit: "L" });
    const ownerA = await createUser({ role: "SHOP_OWNER" });
    const ownerB = await createUser({ role: "SHOP_OWNER" });
    const shopA = await createShop(ownerA.id, { name: "Shop A", deliveryFeePaise: FEE });
    const shopB = await createShop(ownerB.id, { name: "Shop B", deliveryFeePaise: FEE });
    await addToCart(customer.id, (await createShopProduct(shopA.id, product.id, { onlinePricePaise: GOODS, onlineStock: 9 })).id, 1);
    await addToCart(customer.id, (await createShopProduct(shopB.id, product.id, { onlinePricePaise: GOODS, onlineStock: 9 })).id, 1);
    const { orders: created } = await checkout({ userId: customer.id, requestId: `g-${customer.id}`, addressId: await deliveryAddressId(customer.id) });
    expect(created).toHaveLength(2);
    expect(created[0].orderGroupId).not.toBeNull();
    const a = created.find((o) => o.shopId === shopA.id)!;
    const b = created.find((o) => o.shopId === shopB.id)!;
    return { customer, ownerA, a, b };
  }

  it("on: one shop declines → the customer is told and cancels the rest (full refund)", async () => {
    await setFlag("flow_f20", true);
    const g = await twoShopCheckout();
    await rejectOrder(g.a.id, actorOf(g.ownerA), "Out of stock");
    expect(await notesOf(g.customer.id, "order.group_part_cancelled")).toHaveLength(1);
    const result = await cancelRemainingGroupOrders(g.a.id, actorOf(g.customer));
    expect(result.cancelled).toEqual([g.b.orderNumber]);
    expect((await orderRow(g.b.id)).status).toBe("REFUNDED");
    expect(await balanceOf(g.customer.id)).toBe(START);
  });

  it("off: no notice and no cancel-the-rest", async () => {
    const g = await twoShopCheckout();
    await rejectOrder(g.a.id, actorOf(g.ownerA), "Out of stock");
    expect(await notesOf(g.customer.id, "order.group_part_cancelled")).toHaveLength(0);
    await expect(cancelRemainingGroupOrders(g.a.id, actorOf(g.customer))).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await orderRow(g.b.id)).status).toBe("CONFIRMED");
  });
});

/* ======================================================================== F3 */

describe("F3 order fulfilment (flow_f3)", () => {
  it("packed straight from accepted: on → READY; off → refused as before", async () => {
    const s = await placeOrder();
    await acceptOrder(s.order.id, actorOf(s.owner));
    await expect(markOrderReady(s.order.id, actorOf(s.owner))).rejects.toThrow(/Start preparing/);
    await setFlag("flow_f3", true);
    expect((await markOrderReady(s.order.id, actorOf(s.owner))).status).toBe("READY");
  });

  it("commission with no rate configured: on → 2%; off → 0%", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id);
    expect((await resolveCommissionRate(shop)).rateBp).toBe(0);
    await setFlag("flow_f3", true);
    expect((await resolveCommissionRate(shop)).rateBp).toBe(200);
  });
});

/* ======================================================================== F2 */

describe("F2 customer order (flow_f2)", () => {
  it("a MANDATORY referral setting: off → first order refused; on → it goes through and the code is optional after it", async () => {
    await setReferralSetting("referral_required_customer", "MANDATORY", actorOf(admin));
    await setRule("customerSignupReferral", { enabled: true }, actorOf(admin));
    await createReferralCode({ code: "PUNELNCH", label: "Pune launch" }, actorOf(admin));
    const owner = await createUser({ role: "SHOP_OWNER" });
    const category = await createCategory({ department: "DAIRY", name: "Milk" });
    const product = await createProduct(category.id);
    const shop = await createShop(owner.id);
    const sp = await createShopProduct(shop.id, product.id, { onlinePricePaise: GOODS, onlineStock: 9 });
    const { user } = await createUserWithWallet({ balancePaise: START });
    await addToCart(user.id, sp.id, 1);
    const addressId = await deliveryAddressId(user.id);
    const refused = await checkout({ userId: user.id, requestId: "r-1", addressId, paymentMethod: "WALLET" }).catch((e) => e);
    expect(refused.code).toBe("CONFLICT");

    await setFlag("flow_f2", true);
    const { orders: placed } = await checkout({ userId: user.id, requestId: "r-2", addressId, paymentMethod: "WALLET" });
    expect(await referralAfterFirstOrderIds(user.id)).toEqual([placed[0].id]);
    const ids = await referralAfterFirstOrderIds(user.id);
    expect((await applySignupReferralCode(user.id, "punelnch", actorOf(user), { firstOrderIds: ids })).code).toBe("PUNELNCH");
    expect(await referralAfterFirstOrderIds(user.id)).toEqual([]);
  });

  it("off: no referral box after the first order", async () => {
    await setRule("customerSignupReferral", { enabled: true }, actorOf(admin));
    const s = await placeOrder();
    expect(await referralAfterFirstOrderIds(s.customer.id)).toEqual([]);
  });

  it("explicit payment: on → a personal order without a method is refused; off or with a method → fine", async () => {
    await expect(assertExplicitPayment({})).resolves.toBeUndefined();
    await setFlag("flow_f2", true);
    await expect(assertExplicitPayment({})).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(assertExplicitPayment({ paymentMethod: "COD" })).resolves.toBeUndefined();
    await expect(assertExplicitPayment({ orderType: "B2B" })).resolves.toBeUndefined();
  });
});

/* ======================================================================= F13 */

describe("F13 product and inventory setup (flow_f13)", () => {
  async function shopAndMaster() {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id);
    const category = await createCategory({ department: "DAIRY", name: "Milk" });
    const a = await createProduct(category.id, { name: "Cow Milk" });
    const b = await createProduct(category.id, { name: "Buffalo Milk" });
    return { owner, shop, category, a, b };
  }
  const listings = (shopId: string) => db.select().from(shopProducts).where(eq(shopProducts.shopId, shopId));

  it("choosing a category: on → every item listed at stock 100; off → nothing listed", async () => {
    const off = await shopAndMaster();
    expect(await chooseCategories(off.shop.id, [off.category.id], actorOf(off.owner))).toEqual({ added: 1 });
    expect(await listings(off.shop.id)).toHaveLength(0);

    await setFlag("flow_f13", true);
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, { name: "Second Dairy" });
    const result = await chooseCategories(shop.id, [off.category.id], actorOf(owner));
    expect(result.listed).toBe(2);
    const rows = await listings(shop.id);
    expect(rows.map((r) => r.onlineStock)).toEqual([100, 100]);
    expect(rows.every((r) => !r.stockPending)).toBe(true);
  });

  it("picking from the master list: on → stock 100; off → Needs Stock (0)", async () => {
    const s = await shopAndMaster();
    await chooseCategories(s.shop.id, [s.category.id], actorOf(s.owner));
    await addPickedProducts(s.shop.id, [s.a.id], actorOf(s.owner));
    await setFlag("flow_f13", true);
    await addPickedProducts(s.shop.id, [s.b.id], actorOf(s.owner));
    const rows = await listings(s.shop.id);
    expect(rows.find((r) => r.productId === s.a.id)).toMatchObject({ onlineStock: 0, stockPending: true });
    expect(rows.find((r) => r.productId === s.b.id)).toMatchObject({ onlineStock: 100, stockPending: false });
  });

  it("exact name match: on → the owner chooses (use existing / add new); off → reused silently", async () => {
    const s = await shopAndMaster();
    const input = { shopId: s.shop.id, categoryId: s.category.id, name: "Cow Milk", unit: "L", askOnExactMatch: true };
    const off = await createProductForShop(input, actorOf(s.owner), true);
    expect(off.reusedExisting).toBe(true);

    await setFlag("flow_f13", true);
    const owner2 = await createUser({ role: "SHOP_OWNER" });
    const shop2 = await createShop(owner2.id, { name: "Shop Two" });
    const asked = await createProductForShop({ ...input, shopId: shop2.id }, actorOf(owner2), true).catch((e) => e);
    expect(asked.code).toBe("CONFLICT");
    expect(asked.details.exactMatch).toMatchObject({ id: s.a.id });
    expect((await createProductForShop({ ...input, shopId: shop2.id, duplicateChoice: "USE_EXISTING" }, actorOf(owner2), true)).product.id).toBe(s.a.id);
    const added = await createProductForShop({ ...input, shopId: shop2.id, name: "Cow Milk", duplicateChoice: "ADD_NEW", unit: "L" }, actorOf(owner2), true);
    expect(added.reusedExisting).toBe(false);
    expect(added.product.id).not.toBe(s.a.id);
    expect((await db.select().from(products).where(eq(products.id, added.product.id)))[0].approvalStatus).toBe("PENDING_APPROVAL");
  });

  it("own product type for any shop type: on → created (sent for review); off → 404", async () => {
    const s = await shopAndMaster();
    signInAs(s.owner);
    const body = { categoryId: s.category.id, name: "A2 Gir Cow Milk", unit: "L" };
    expect((await call(productTypesPost, `/api/shops/${s.shop.id}/product-types`, { method: "POST", body, params: { id: s.shop.id } })).status).toBe(404);
    await setFlag("flow_f13", true);
    const res = await call(productTypesPost, `/api/shops/${s.shop.id}/product-types`, { method: "POST", body, params: { id: s.shop.id } });
    expect(res.status).toBe(201);
    expect((res.body as { type: { approvalStatus: string } }).type.approvalStatus).toBe("PENDING_APPROVAL");
  });

  it("ready-for-product-upload e-mail when a shop goes live: on → queued once; off → not", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id);
    await queueShopWelcomeKit(shop, db, { deliverNow: false });
    const ready = () => db.select().from(documentEmails).where(and(eq(documentEmails.docType, "SHOP_READY_FOR_PRODUCTS"), eq(documentEmails.docId, shop.id)));
    expect(await ready()).toHaveLength(0);

    await setFlag("flow_f13", true);
    const owner2 = await createUser({ role: "SHOP_OWNER" });
    const shop2 = await createShop(owner2.id, { name: "Live Dairy" });
    await queueShopWelcomeKit(shop2, db, { deliverNow: false });
    await queueShopWelcomeKit(shop2, db, { deliverNow: false });
    const rows = await db.select().from(documentEmails).where(and(eq(documentEmails.docType, "SHOP_READY_FOR_PRODUCTS"), eq(documentEmails.docId, shop2.id)));
    expect(rows).toHaveLength(1);
    expect(rows[0].subject).toContain("add your products");
  });
});
