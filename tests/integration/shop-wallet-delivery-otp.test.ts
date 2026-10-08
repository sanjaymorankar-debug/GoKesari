/**
 * Shop prepaid wallet + OTP-confirmed delivery (docs/shop-wallet-delivery-otp-2026-10).
 *
 * Covers the test checklist: correct code, wrong code, lockout (ticket +
 * alerts), resend (limits, old code dead), double submission (charged once),
 * the wrong delivery partner, low wallet balance (cannot accept, cannot be
 * ordered from, alert), cancelled order (nothing charged), the delivery charge
 * per km, commission returned on refunds, and the database's own guards on
 * the wallet balance and ledger.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
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

import { POST as deliveryCodeRoute } from "@/app/api/orders/[id]/delivery-code/route";
import { PATCH as deliveryOrderRoute } from "@/app/api/delivery-orders/[id]/route";
import { PATCH as orderStatusRoute } from "@/app/api/orders/[id]/status/route";
import { POST as shopTopupRoute } from "@/app/api/shops/[id]/wallet/topup/route";
import { GET as shopWalletRoute } from "@/app/api/shops/[id]/wallet/route";
import { resetRateLimits } from "@/server/api/rate-limit";
import { RULES } from "@/server/config/rules";
import { db } from "@/server/db";
import {
  commissionRates,
  deliveryOrders,
  domainEvents,
  financialAdjustments,
  financeLedgerEntries,
  grievances,
  notifications,
  orderFinancials,
  orders,
  platformSettings,
  shopWalletTransactions,
  shopWallets,
  wallets,
} from "@/server/db/schema";
import { addToCart } from "@/server/services/cart";
import { validateCartForLocation } from "@/server/services/cart-validation";
import {
  acceptDeliveryOffer,
  assignNearestPartner,
  confirmDeliveryByOperator,
  markDelivered,
  markPickedUp,
  startDelivery,
} from "@/server/services/delivery-assignment";
import { requestNewDeliveryCode } from "@/server/services/delivery-otp";
import { getShopPendingPayable, refundDeliveredOrder, setCommissionRate, shopDeliveryChargeFor } from "@/server/services/finance";
import { acceptOrder } from "@/server/services/fulfilment";
import { NOTIFICATION_TYPES } from "@/server/services/notifications";
import { cancelOrder, checkout, updateOrderStatus } from "@/server/services/orders";
import { createShopWalletTopUpOrder, settleMockTopUp, signForMock } from "@/server/services/payments";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { listServiceableShops } from "@/server/services/serviceability";
import { adjustShopWallet, getShopWalletView } from "@/server/services/shop-wallet";
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
const PRICE = 10_500; // ₹105 goods
const RULE_KEYS = ["shopWallet", "deliveryOtp"];
let admin = { id: "", role: "ADMIN" as const };

/**
 * Rule shopWallet on with its defaults — the agreed amounts: delivery charge
 * ₹5 per km (₹25 when the distance is not known), ₹200 minimum, reminder below
 * ₹300. Commission is the 1% platform rate set in beforeEach. The test
 * addresses have no map location, so a drop's distance is not known unless a
 * test sets one (legDistance): one ₹105 order then costs the shop
 * ₹1.05 + ₹25 = ₹26.05.
 */
async function enableWallet(overrides: Record<string, number | boolean> = {}) {
  await setRule("shopWallet", { enabled: true, ...overrides }, admin);
}

beforeEach(async () => {
  await resetDatabase();
  await db.delete(commissionRates);
  await db.delete(platformSettings).where(inArray(platformSettings.key, RULE_KEYS));
  clearRuleCache();
  resetRateLimits();
  state.outbox = [];
  state.session = null;
  const a = await createUser({ role: "ADMIN" });
  admin = { id: a.id, role: "ADMIN" };
  await setCommissionRate({ scope: "DEFAULT", rateBp: 100 }, admin); // agreed 1%
});

function signIn(user: { id: string; email: string; name: string | null }, role: UserRole) {
  state.session = { user: { id: user.id, email: user.email, name: user.name, image: null, role, status: "ACTIVE" } };
}

async function shopWithMilk() {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const cat = await createCategory({ department: "DAIRY", name: "Milk" });
  const milk = await createProduct(cat.id, { name: "Cow Milk", unit: "L" });
  const shop = await createShop(owner.id, { name: "Dairy One", latitude: SHOP.latitude, longitude: SHOP.longitude });
  const sp = await createShopProduct(shop.id, milk.id, { onlinePricePaise: PRICE, onlineStock: 50 });
  return { shop, sp, owner, ownerActor: { id: owner.id, role: "SHOP_OWNER" as const } };
}

async function placeOrder(spId: string) {
  const { user } = await createUserWithWallet({ balancePaise: 500_000 });
  await addToCart(user.id, spId, 1);
  const { orders: placed } = await checkout({ userId: user.id, addressId: await deliveryAddressId(user.id), requestId: `r-${Math.random()}` });
  return { customer: user, order: placed[0] };
}

/** Credits the shop wallet the way a recharge does (admin adjustment = a ledger entry). */
async function fund(shopId: string, amountPaise: number) {
  await adjustShopWallet({ shopId, direction: "CREDIT", amountPaise, reason: "Test recharge", requestId: `fund-${Math.random()}` }, admin);
}

/** Order accepted by the shop, packed, given to a rider, picked up and the drop started. */
async function startedDrop(opts: { fundPaise?: number } = {}) {
  const ctx = await shopWithMilk();
  if (opts.fundPaise) await fund(ctx.shop.id, opts.fundPaise);
  const { order, customer } = await placeOrder(ctx.sp.id);
  await acceptOrder(order.id, ctx.ownerActor);
  await db.update(orders).set({ status: "READY" }).where(eq(orders.id, order.id));
  const riderUser = await createUser({ role: "DELIVERY_PARTNER" });
  await createDeliveryPartner(riderUser.id, { isOnline: true, latitude: SHOP.latitude, longitude: SHOP.longitude, operatingRadiusKm: 20 });
  const offer = await assignNearestPartner(order.id, ctx.ownerActor);
  const rider = { id: riderUser.id, role: "DELIVERY_PARTNER" as const };
  await acceptDeliveryOffer(offer.id, rider.id);
  const [accepted] = await db.select().from(deliveryOrders).where(eq(deliveryOrders.id, offer.id));
  await markPickedUp(offer.id, rider, accepted.pickupCode!);
  state.outbox = [];
  await startDelivery(offer.id, rider);
  return { ...ctx, order, customer, rider, riderUser, deliveryId: offer.id };
}

/** The shop-to-customer distance dispatch would have stored for the drop. */
async function legDistance(deliveryId: string, km: string, routeSource: "ROAD" | "STRAIGHT_LINE" | null = "STRAIGHT_LINE") {
  await db.update(deliveryOrders).set({ distanceKm: km, routeSource }).where(eq(deliveryOrders.id, deliveryId));
}

/** The code the customer was emailed (the database holds only its hash). */
function emailedCode(to: string): string {
  const mail = [...state.outbox].reverse().find((m) => m.to === to && /is your delivery code/.test(m.subject));
  expect(mail, `delivery code email to ${to}`).toBeDefined();
  return mail!.subject.slice(0, 4);
}

async function ledger(shopId: string) {
  return db.select().from(shopWalletTransactions).where(eq(shopWalletTransactions.shopId, shopId)).orderBy(shopWalletTransactions.seq);
}

async function balance(shopId: string) {
  const [wallet] = await db.select().from(shopWallets).where(eq(shopWallets.shopId, shopId));
  return wallet?.balancePaise ?? 0;
}

async function notes(userId: string, type: string) {
  return db.select().from(notifications).where(and(eq(notifications.userId, userId), eq(notifications.type, type)));
}

/* -------------------------------------------------------------- correct code */

describe("correct delivery code", () => {
  it("emails a hashed code, completes the order and debits commission + delivery charge in the same step", async () => {
    await enableWallet();
    const d = await startedDrop({ fundPaise: 50_000 });

    const [row] = await db.select().from(deliveryOrders).where(eq(deliveryOrders.id, d.deliveryId));
    expect(row.deliveryOtp).toBeNull();
    expect(row.deliveryOtpHash).toMatch(/^[0-9a-f]{16}:[0-9a-f]{64}$/);
    const code = emailedCode(d.customer.email);
    expect(row.deliveryOtpHash).not.toContain(code);

    await legDistance(d.deliveryId, "2.37"); // priced on 2.4 km × ₹5 = ₹12.00
    const delivered = await markDelivered(d.deliveryId, d.rider, code);
    expect(delivered.status).toBe("DELIVERED");
    expect(delivered.deliveryConfirmation).toBe("CUSTOMER_OTP");
    expect(delivered.deliveryOtpHash).toBeNull(); // spent
    expect(delivered.deliveryOtpUsedAt).not.toBeNull();
    const [order] = await db.select().from(orders).where(eq(orders.id, d.order.id));
    expect(order.status).toBe("DELIVERED");

    // Two separate ledger entries linked to the order, each with its balance after.
    const entries = await ledger(d.shop.id);
    const charges = entries.filter((e) => e.orderId === d.order.id);
    expect(charges.map((e) => [e.type, e.direction, e.amountPaise])).toEqual([
      ["COMMISSION", "DEBIT", 105],
      ["DELIVERY_CHARGE", "DEBIT", 1_200],
    ]);
    expect(charges[1].reason).toContain("2.4 km");
    expect(charges[0].balanceAfterPaise).toBe(50_000 - 105);
    expect(charges[1].balanceAfterPaise).toBe(50_000 - 1_305);
    expect(await balance(d.shop.id)).toBe(48_695);

    // Settlement no longer withholds the commission the wallet paid.
    const [snapshot] = await db.select().from(orderFinancials).where(eq(orderFinancials.orderId, d.order.id));
    expect(snapshot).toMatchObject({
      commissionCollection: "SHOP_WALLET",
      commissionPaise: 105,
      shopPayablePaise: PRICE,
      shopDeliveryChargePaise: 1_200,
      shopDeliveryDistanceM: 2_400,
    });
    expect(await getShopPendingPayable(d.shop.id)).toMatchObject({ goodsPaise: PRICE, commissionPaise: 0, netPaise: PRICE });
    const platformFee = await db
      .select()
      .from(financeLedgerEntries)
      .where(eq(financeLedgerEntries.idempotencyKey, `order:${d.order.id}:shop-delivery-charge:platform`));
    expect(platformFee).toHaveLength(1);

    // Shop: amounts and new balance; buyer: delivered; rider: confirmed — at once.
    const [shopNote] = await notes(d.owner.id, NOTIFICATION_TYPES.SHOP_ORDER_DELIVERED);
    expect(shopNote.body).toContain("commission ₹1.05");
    expect(shopNote.body).toContain("delivery charge ₹12.00 (2.4 km)");
    expect(shopNote.body).toContain("New balance: ₹486.95");
    expect(await notes(d.customer.id, NOTIFICATION_TYPES.ORDER_DELIVERED)).toHaveLength(1);
    expect(await notes(d.riderUser.id, NOTIFICATION_TYPES.DELIVERY_CONFIRMED)).toHaveLength(1);
  });

  it("with the rule off: nothing is debited and commission is withheld at settlement as before", async () => {
    const d = await startedDrop();
    await markDelivered(d.deliveryId, d.rider, emailedCode(d.customer.email));
    expect(await ledger(d.shop.id)).toHaveLength(0);
    const [snapshot] = await db.select().from(orderFinancials).where(eq(orderFinancials.orderId, d.order.id));
    expect(snapshot).toMatchObject({ commissionCollection: "SETTLEMENT", shopPayablePaise: PRICE - 105 });
    expect(await getShopPendingPayable(d.shop.id)).toMatchObject({ commissionPaise: 105, netPaise: PRICE - 105 });
  });

  it("a drop started before 0059 (plain-text code) still completes with its code, which is then cleared", async () => {
    const d = await startedDrop();
    await db.update(deliveryOrders).set({ deliveryOtp: "4321", deliveryOtpHash: null }).where(eq(deliveryOrders.id, d.deliveryId));
    await expect(markDelivered(d.deliveryId, d.rider, "1234")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const delivered = await markDelivered(d.deliveryId, d.rider, "4321");
    expect(delivered).toMatchObject({ status: "DELIVERED", deliveryOtp: null, deliveryOtpHash: null, deliveryConfirmation: "CUSTOMER_OTP" });
  });
});

/* ---------------------------------------------------------------- wrong code */

describe("wrong delivery code", () => {
  it("is refused with the attempts left, counted, and nothing is completed or charged", async () => {
    await enableWallet();
    const d = await startedDrop({ fundPaise: 50_000 });
    const code = emailedCode(d.customer.email);
    const wrong = code === "1111" ? "2222" : "1111";

    await expect(markDelivered(d.deliveryId, d.rider, wrong)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: expect.stringContaining("4 attempts left"),
    });
    // Malformed input is not a guess and is not counted.
    await expect(markDelivered(d.deliveryId, d.rider, "12")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const [row] = await db.select().from(deliveryOrders).where(eq(deliveryOrders.id, d.deliveryId));
    expect(row.deliveryOtpAttempts).toBe(1);
    expect(row.status).toBe("PICKED_UP");
    const [order] = await db.select().from(orders).where(eq(orders.id, d.order.id));
    expect(order.status).toBe("OUT_FOR_DELIVERY");
    expect((await ledger(d.shop.id)).filter((e) => e.orderId)).toHaveLength(0);

    // The right code still works afterwards.
    expect((await markDelivered(d.deliveryId, d.rider, code)).status).toBe("DELIVERED");
  });
});

/* ------------------------------------------------------------------- lockout */

describe("lockout", () => {
  it("locks after the configured attempts, raises a support ticket and tells customer, shop and support", async () => {
    await enableWallet();
    await setRule("deliveryOtp", { maxAttempts: 3 }, admin);
    const d = await startedDrop({ fundPaise: 50_000 });
    const code = emailedCode(d.customer.email);
    const wrong = code === "1111" ? "2222" : "1111";

    await expect(markDelivered(d.deliveryId, d.rider, wrong)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(markDelivered(d.deliveryId, d.rider, wrong)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(markDelivered(d.deliveryId, d.rider, wrong)).rejects.toMatchObject({
      code: "CONFLICT",
      details: { locked: true, ticketNumber: expect.stringMatching(/^GRV-\d{6}$/) },
    });

    const [row] = await db.select().from(deliveryOrders).where(eq(deliveryOrders.id, d.deliveryId));
    expect(row.deliveryOtpLockedAt).not.toBeNull();
    expect(row.deliveryOtpAttempts).toBe(3);
    const [ticket] = await db.select().from(grievances).where(eq(grievances.orderId, d.order.id));
    expect(ticket).toMatchObject({ category: "ORDER", status: "OPEN", email: d.customer.email, submittedByUserId: null });
    expect(row.deliveryOtpTicketId).toBe(ticket.id);

    // Locked: even the right code is refused now, and nothing is charged.
    await expect(markDelivered(d.deliveryId, d.rider, code)).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await ledger(d.shop.id)).filter((e) => e.orderId)).toHaveLength(0);
    // The customer cannot get a new code for a locked drop either.
    await expect(requestNewDeliveryCode(d.order.id, { id: d.customer.id, role: "CUSTOMER" })).rejects.toMatchObject({ code: "CONFLICT" });

    expect(await notes(d.customer.id, NOTIFICATION_TYPES.ORDER_DELIVERY_CODE_LOCKED)).toHaveLength(1);
    expect(await notes(d.owner.id, NOTIFICATION_TYPES.SHOP_DELIVERY_CODE_LOCKED)).toHaveLength(1);
    expect(await notes(admin.id, NOTIFICATION_TYPES.SUPPORT_DELIVERY_CODE_LOCKED)).toHaveLength(1);
    const locked = await db.select().from(domainEvents).where(eq(domainEvents.type, "delivery.code_locked"));
    expect(locked).toHaveLength(1);

    // Operations confirm it — completed and charged exactly once.
    await confirmDeliveryByOperator(d.order.id, admin, "Called the customer, parcel received");
    expect((await ledger(d.shop.id)).filter((e) => e.orderId).map((e) => e.type)).toEqual(["COMMISSION", "DELIVERY_CHARGE"]);
    expect(await notes(d.riderUser.id, NOTIFICATION_TYPES.DELIVERY_CONFIRMED)).toHaveLength(1);
  });

  it("concurrent wrong attempts never go past the limit, and only one ticket is raised", async () => {
    await setRule("deliveryOtp", { maxAttempts: 3 }, admin);
    const d = await startedDrop();
    const code = emailedCode(d.customer.email);
    const wrong = code === "1111" ? "2222" : "1111";
    await Promise.allSettled(Array.from({ length: 6 }, () => markDelivered(d.deliveryId, d.rider, wrong)));
    const [row] = await db.select().from(deliveryOrders).where(eq(deliveryOrders.id, d.deliveryId));
    expect(row.deliveryOtpAttempts).toBe(3);
    expect(await db.select().from(grievances).where(eq(grievances.orderId, d.order.id))).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------- resend */

describe("resend", () => {
  it("gives the customer a new code (emailed and shown once), kills the old one, and is rate-limited", async () => {
    await setRule("deliveryOtp", { resendCooldownSeconds: 60, maxResends: 2 }, admin);
    const d = await startedDrop();
    const first = emailedCode(d.customer.email);
    const buyer = { id: d.customer.id, role: "CUSTOMER" as const };

    // Cooldown counts from when the code was sent.
    await expect(requestNewDeliveryCode(d.order.id, buyer)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    await db.update(deliveryOrders).set({ deliveryOtpSentAt: new Date(Date.now() - 61_000) }).where(eq(deliveryOrders.id, d.deliveryId));

    const fresh = await requestNewDeliveryCode(d.order.id, buyer);
    expect(fresh.code).toMatch(/^\d{4}$/);
    expect(fresh.resendsLeft).toBe(1);
    expect(fresh.sentTo).toMatch(/\*/);
    expect(emailedCode(d.customer.email)).toBe(fresh.code);

    if (fresh.code !== first) {
      await expect(markDelivered(d.deliveryId, d.rider, first)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    }
    await db.update(deliveryOrders).set({ deliveryOtpSentAt: new Date(Date.now() - 61_000) }).where(eq(deliveryOrders.id, d.deliveryId));
    await requestNewDeliveryCode(d.order.id, buyer);
    await db.update(deliveryOrders).set({ deliveryOtpSentAt: new Date(Date.now() - 61_000) }).where(eq(deliveryOrders.id, d.deliveryId));
    await expect(requestNewDeliveryCode(d.order.id, buyer)).rejects.toMatchObject({
      code: "RATE_LIMITED",
      message: expect.stringContaining("as many new codes"),
    });
    expect((await markDelivered(d.deliveryId, d.rider, emailedCode(d.customer.email))).status).toBe("DELIVERED");
  });

  it("only the order's own customer can ask, through the route too", async () => {
    await setRule("deliveryOtp", { resendCooldownSeconds: 0 }, admin);
    const d = await startedDrop();
    const stranger = await createUser();
    await expect(requestNewDeliveryCode(d.order.id, { id: stranger.id, role: "CUSTOMER" })).rejects.toMatchObject({ code: "NOT_FOUND" });

    signIn(stranger, "CUSTOMER");
    const refused = await call(deliveryCodeRoute, `/api/orders/${d.order.id}/delivery-code`, { method: "POST", params: { id: d.order.id } });
    expect(refused.status).toBe(404);

    signIn(d.customer, "CUSTOMER");
    const allowed = await call(deliveryCodeRoute, `/api/orders/${d.order.id}/delivery-code`, { method: "POST", params: { id: d.order.id } });
    expect(allowed.status).toBe(200);
    expect(allowed.body.code).toMatch(/^\d{4}$/);
  });
});

/* -------------------------------------------------------------- double submit */

describe("double submission", () => {
  it("completes and charges the order once, however many submits race", async () => {
    await enableWallet();
    const d = await startedDrop({ fundPaise: 50_000 });
    const code = emailedCode(d.customer.email);

    const results = await Promise.allSettled(Array.from({ length: 4 }, () => markDelivered(d.deliveryId, d.rider, code)));
    expect(results.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    for (const r of results) if (r.status === "fulfilled") expect(r.value.status).toBe("DELIVERED");

    // A later repeat (the rider's app retrying) is a no-op too.
    expect((await markDelivered(d.deliveryId, d.rider, code)).status).toBe("DELIVERED");

    const charges = (await ledger(d.shop.id)).filter((e) => e.orderId === d.order.id);
    expect(charges.map((e) => e.type)).toEqual(["COMMISSION", "DELIVERY_CHARGE"]);
    expect(await balance(d.shop.id)).toBe(50_000 - 2_605);
    expect(await db.select().from(orderFinancials).where(eq(orderFinancials.orderId, d.order.id))).toHaveLength(1);
  });

  it("the database refuses a second commission for the same order", async () => {
    await enableWallet();
    const d = await startedDrop({ fundPaise: 50_000 });
    await markDelivered(d.deliveryId, d.rider, emailedCode(d.customer.email));
    const [wallet] = await db.select().from(shopWallets).where(eq(shopWallets.shopId, d.shop.id));
    const bal = wallet.balancePaise;
    await expect(
      db.insert(shopWalletTransactions).values({
        walletId: wallet.id,
        shopId: d.shop.id,
        type: "COMMISSION",
        direction: "DEBIT",
        amountPaise: 105,
        balanceBeforePaise: bal,
        balanceAfterPaise: bal - 105,
        orderId: d.order.id,
        reason: "duplicate",
        idempotencyKey: "another-key",
      }),
    ).rejects.toThrow();
    expect(await balance(d.shop.id)).toBe(bal);
  });
});

/* ------------------------------------------------------ wrong delivery partner */

describe("wrong delivery partner", () => {
  it("another rider cannot enter the code (403), and their attempt is not counted", async () => {
    const d = await startedDrop();
    const code = emailedCode(d.customer.email);
    const otherUser = await createUser({ role: "DELIVERY_PARTNER" });
    await createDeliveryPartner(otherUser.id, { isOnline: true, latitude: SHOP.latitude, longitude: SHOP.longitude });

    await expect(markDelivered(d.deliveryId, { id: otherUser.id, role: "DELIVERY_PARTNER" }, code)).rejects.toMatchObject({ code: "FORBIDDEN" });
    signIn(otherUser, "DELIVERY_PARTNER");
    const viaRoute = await call(deliveryOrderRoute, `/api/delivery-orders/${d.deliveryId}`, {
      method: "PATCH",
      params: { id: d.deliveryId },
      body: { action: "deliver", otp: code },
    });
    expect(viaRoute.status).toBe(403);
    // A customer cannot use the rider endpoint at all.
    signIn(d.customer, "CUSTOMER");
    const asCustomer = await call(deliveryOrderRoute, `/api/delivery-orders/${d.deliveryId}`, {
      method: "PATCH",
      params: { id: d.deliveryId },
      body: { action: "deliver", otp: code },
    });
    expect(asCustomer.status).toBe(403);

    const [row] = await db.select().from(deliveryOrders).where(eq(deliveryOrders.id, d.deliveryId));
    expect(row.status).toBe("PICKED_UP");
    expect(row.deliveryOtpAttempts).toBe(0);
    expect((await markDelivered(d.deliveryId, d.rider, code)).status).toBe("DELIVERED");
  });

  it("nobody else completes a rider-carried order without the code — not the shop, not a plain status change", async () => {
    await enableWallet();
    const d = await startedDrop({ fundPaise: 50_000 });
    await expect(updateOrderStatus(d.order.id, "DELIVERED", d.ownerActor)).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("delivery code"),
    });
    signIn(d.owner, "SHOP_OWNER");
    const viaRoute = await call(orderStatusRoute, `/api/orders/${d.order.id}/status`, {
      method: "PATCH",
      params: { id: d.order.id },
      body: { status: "DELIVERED" },
    });
    expect(viaRoute.status).toBe(409);
    const [order] = await db.select().from(orders).where(eq(orders.id, d.order.id));
    expect(order.status).toBe("OUT_FOR_DELIVERY");
    expect((await ledger(d.shop.id)).filter((e) => e.orderId)).toHaveLength(0);
  });

  it("the rider's API never returns the code or its hash", async () => {
    const d = await startedDrop();
    signIn(d.riderUser, "DELIVERY_PARTNER");
    const res = await call(deliveryOrderRoute, `/api/delivery-orders/${d.deliveryId}`, {
      method: "PATCH",
      params: { id: d.deliveryId },
      body: { action: "arrived_customer" },
    });
    expect(res.status).toBe(200);
    expect(res.body.deliveryOtpHash).toBeUndefined();
    expect(res.body.deliveryOtp).toBeUndefined();
    expect(res.body).toMatchObject({ needsDeliveryOtp: true, deliveryCodeLocked: false });
  });
});

/* -------------------------------------------------------- low wallet balance */

describe("low wallet balance", () => {
  it("a shop below the minimum cannot accept a new order and is told to recharge; a recharge unblocks it", async () => {
    const { shop, sp, ownerActor, owner } = await shopWithMilk();
    // Placed before the wallet rule applied (a ₹0 shop cannot be ordered from at all).
    const { order } = await placeOrder(sp.id);
    await enableWallet(); // ₹200 minimum

    await expect(acceptOrder(order.id, ownerActor)).rejects.toMatchObject({
      code: "INSUFFICIENT_BALANCE",
      message: expect.stringContaining("Recharge your shop wallet"),
      details: { balancePaise: 0, minBalancePaise: 20_000, rechargeUrl: "/shop/wallet" },
    });
    const [still] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(still.status).toBe("CONFIRMED");

    // Recharge through the gateway flow (mock mode): credits the SHOP wallet, not the owner's own.
    const intent = await createShopWalletTopUpOrder(shop.id, owner.id, 20_000);
    const paymentId = `mock_pay_${intent.gatewayOrderId.slice(-12)}`;
    const settled = await settleMockTopUp({
      userId: owner.id,
      gatewayOrderId: intent.gatewayOrderId,
      gatewayPaymentId: paymentId,
      signature: signForMock(intent.gatewayOrderId, paymentId),
    });
    expect(settled.balancePaise).toBe(20_000);
    const replay = await settleMockTopUp({
      userId: owner.id,
      gatewayOrderId: intent.gatewayOrderId,
      gatewayPaymentId: paymentId,
      signature: signForMock(intent.gatewayOrderId, paymentId),
    });
    expect(replay.alreadyProcessed).toBe(true);
    expect(await balance(shop.id)).toBe(20_000);
    expect(await db.select().from(wallets).where(eq(wallets.userId, owner.id))).toHaveLength(0);
    expect(await notes(owner.id, NOTIFICATION_TYPES.SHOP_WALLET_TOPUP_SUCCESS)).toHaveLength(1);

    expect((await acceptOrder(order.id, ownerActor)).status).toBe("ACCEPTED");
  });

  it("alerts the owner once when a charge takes the balance below the threshold", async () => {
    await enableWallet({ minBalancePaise: 0, lowBalanceThresholdPaise: 5_000 });
    const d = await startedDrop({ fundPaise: 6_000 });
    await markDelivered(d.deliveryId, d.rider, emailedCode(d.customer.email));
    expect(await balance(d.shop.id)).toBe(6_000 - 2_605);
    const alerts = await notes(d.owner.id, NOTIFICATION_TYPES.SHOP_WALLET_LOW_BALANCE);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].body).toContain("₹33.95");

    const view = await getShopWalletView(d.shop.id);
    expect(view).toMatchObject({ enabled: true, balancePaise: 3_395, lowBalance: true, canAcceptOrders: true });
  });

  it("a delivered order is charged even past zero; the shop is then blocked until it recharges", async () => {
    await enableWallet({ minBalancePaise: 0, lowBalanceThresholdPaise: 0 });
    const d = await startedDrop({ fundPaise: 1_000 });
    await markDelivered(d.deliveryId, d.rider, emailedCode(d.customer.email));
    expect(await balance(d.shop.id)).toBe(1_000 - 2_605);
    const [shopNote] = await notes(d.owner.id, NOTIFICATION_TYPES.SHOP_ORDER_DELIVERED);
    expect(shopNote.body).toContain("Recharge your wallet to keep accepting new orders");
    // Below the minimum: customers cannot even order from the shop now.
    await expect(placeOrder(d.sp.id)).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("is not taking new orders right now"),
    });
  });
});

/* ---------------------------------------------------------- cancelled order */

describe("cancelled order", () => {
  it("nothing is deducted, and the delivery code dies with it", async () => {
    await enableWallet();
    const d = await startedDrop({ fundPaise: 50_000 });
    const code = emailedCode(d.customer.email);
    await cancelOrder(d.order.id, admin, "Customer not reachable");
    expect((await ledger(d.shop.id)).filter((e) => e.orderId)).toHaveLength(0);
    expect(await balance(d.shop.id)).toBe(50_000);
    const [row] = await db.select().from(deliveryOrders).where(eq(deliveryOrders.id, d.deliveryId));
    expect(row.deliveryOtpHash).toBeNull();
    await expect(markDelivered(d.deliveryId, d.rider, code)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await db.select().from(orderFinancials).where(eq(orderFinancials.orderId, d.order.id))).toHaveLength(0);
  });
});

/* ------------------------------------------------- wallet integrity & access */

describe("wallet integrity and access", () => {
  it("the rule's defaults are the agreed amounts, and it stays off until switched on", () => {
    expect(RULES.shopWallet.defaults).toMatchObject({
      enabled: false,
      deliveryChargePaise: 0,
      deliveryChargePerKmPaise: 500,
      deliveryChargeUnknownDistancePaise: 2_500,
      minBalancePaise: 20_000,
      lowBalanceThresholdPaise: 30_000,
    });
  });

  it("the balance can only change through a ledger entry; entries are immutable", async () => {
    const { shop } = await shopWithMilk();
    await fund(shop.id, 10_000);
    await expect(db.update(shopWallets).set({ balancePaise: 999_999 }).where(eq(shopWallets.shopId, shop.id))).rejects.toThrow();
    await expect(db.execute(sql`UPDATE shop_wallet_transactions SET amount_paise = 1`)).rejects.toThrow();
    await expect(db.execute(sql`DELETE FROM shop_wallet_transactions`)).rejects.toThrow();
    expect(await balance(shop.id)).toBe(10_000);
  });

  it("an admin debit never overdraws and a repeated request adjusts once", async () => {
    const { shop } = await shopWithMilk();
    await fund(shop.id, 10_000);
    await expect(
      adjustShopWallet({ shopId: shop.id, direction: "DEBIT", amountPaise: 20_000, reason: "Correction", requestId: "debit-1" }, admin),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_BALANCE" });
    const once = { shopId: shop.id, direction: "DEBIT" as const, amountPaise: 4_000, reason: "Correction", requestId: "debit-2" };
    await adjustShopWallet(once, admin);
    expect((await adjustShopWallet(once, admin)).deduplicated).toBe(true);
    expect(await balance(shop.id)).toBe(6_000);
  });

  it("only the shop's owner sees and recharges its wallet", async () => {
    await enableWallet();
    const { shop, owner } = await shopWithMilk();
    const other = await createUser({ role: "SHOP_OWNER" });

    signIn(other, "SHOP_OWNER");
    expect((await call(shopWalletRoute, `/api/shops/${shop.id}/wallet`, { params: { id: shop.id } })).status).toBe(403);
    expect(
      (await call(shopTopupRoute, `/api/shops/${shop.id}/wallet/topup`, { method: "POST", params: { id: shop.id }, body: { amountPaise: 20_000 } })).status,
    ).toBe(403);

    signIn(owner, "SHOP_OWNER");
    const view = await call(shopWalletRoute, `/api/shops/${shop.id}/wallet`, { params: { id: shop.id } });
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({
      balancePaise: 0,
      minBalancePaise: 20_000,
      commissionRateBp: 100,
      deliveryChargePaise: 0,
      deliveryChargePerKmPaise: 500,
      deliveryChargeUnknownDistancePaise: 2_500,
    });
    const tooSmall = await call(shopTopupRoute, `/api/shops/${shop.id}/wallet/topup`, { method: "POST", params: { id: shop.id }, body: { amountPaise: 500 } });
    expect(tooSmall.status).toBe(422);
    const started = await call(shopTopupRoute, `/api/shops/${shop.id}/wallet/topup`, { method: "POST", params: { id: shop.id }, body: { amountPaise: 20_000 } });
    expect(started.status).toBe(200);
    expect(started.body.mock).toBe(true);
  });
});

/* ------------------------------------------------------ delivery charge per km */

describe("delivery charge per km", () => {
  const perKm = { deliveryChargePaise: 0, deliveryChargePerKmPaise: 500, deliveryChargeUnknownDistancePaise: 2_500 };

  it("is ₹5 per km of the shop-to-customer distance, to 0.1 km, plus any flat part", () => {
    expect(shopDeliveryChargeFor({ distanceKm: "2.37", routeSource: "STRAIGHT_LINE" }, perKm)).toEqual({ chargePaise: 1_200, distanceM: 2_400 });
    expect(shopDeliveryChargeFor({ distanceKm: "3.25", routeSource: "ROAD" }, perKm)).toEqual({ chargePaise: 1_650, distanceM: 3_300 });
    expect(shopDeliveryChargeFor({ distanceKm: "0.04", routeSource: "ROAD" }, perKm)).toEqual({ chargePaise: 0, distanceM: 0 });
    expect(shopDeliveryChargeFor({ distanceKm: "3", routeSource: "ROAD" }, { ...perKm, deliveryChargePaise: 1_000 })).toEqual({
      chargePaise: 2_500,
      distanceM: 3_000,
    });
  });

  it("charges the unknown-distance amount when the distance is missing or not shop-to-customer", () => {
    const unknown = { chargePaise: 2_500, distanceM: null };
    expect(shopDeliveryChargeFor({ distanceKm: null, routeSource: null }, perKm)).toEqual(unknown);
    // No route source: dispatch fell back to the rider's distance to the shop.
    expect(shopDeliveryChargeFor({ distanceKm: "1.2", routeSource: null }, perKm)).toEqual(unknown);
    expect(shopDeliveryChargeFor({ distanceKm: "n/a", routeSource: "ROAD" }, perKm)).toEqual(unknown);
  });

  it("debits the per-km charge at delivery and tells the shop the distance", async () => {
    await enableWallet();
    const d = await startedDrop({ fundPaise: 50_000 });
    await legDistance(d.deliveryId, "6.04", "ROAD"); // 6.0 km × ₹5 = ₹30
    await markDelivered(d.deliveryId, d.rider, emailedCode(d.customer.email));
    const charge = (await ledger(d.shop.id)).find((e) => e.type === "DELIVERY_CHARGE");
    expect(charge).toMatchObject({ amountPaise: 3_000, orderId: d.order.id });
    expect(charge!.reason).toContain("6.0 km");
    const [shopNote] = await notes(d.owner.id, NOTIFICATION_TYPES.SHOP_ORDER_DELIVERED);
    expect(shopNote.body).toContain("delivery charge ₹30.00 (6.0 km)");
  });

  it("an unknown distance is charged ₹25 and says so", async () => {
    await enableWallet();
    const d = await startedDrop({ fundPaise: 50_000 });
    await legDistance(d.deliveryId, "1.10", null);
    await markDelivered(d.deliveryId, d.rider, emailedCode(d.customer.email));
    const charge = (await ledger(d.shop.id)).find((e) => e.type === "DELIVERY_CHARGE");
    expect(charge).toMatchObject({ amountPaise: 2_500 });
    expect(charge!.reason).toContain("distance not known");
    const [snapshot] = await db.select().from(orderFinancials).where(eq(orderFinancials.orderId, d.order.id));
    expect(snapshot.shopDeliveryDistanceM).toBeNull();
  });
});

/* ------------------------------------------- ordering from a low-balance shop */

describe("checkout from a shop below the wallet minimum", () => {
  it("is refused as 'not taking new orders' everywhere a customer orders, until the shop recharges", async () => {
    await enableWallet(); // ₹200 minimum; the shop has ₹0
    const { shop, sp } = await shopWithMilk();
    const { user } = await createUserWithWallet({ balancePaise: 500_000 });
    await addToCart(user.id, sp.id, 1);
    const addressId = await deliveryAddressId(user.id);

    // Cart check: blocking, with the same words as a paused shop (never the wallet).
    const location = { label: "Home", pincode: "411001", latitude: SHOP.latitude, longitude: SHOP.longitude, source: "ADDRESS" as const, addressId, societyId: null };
    const cart = await validateCartForLocation(user.id, location);
    expect(cart.ok).toBe(false);
    expect(cart.shops[0].issues).toEqual([expect.objectContaining({ code: "ORDERS_PAUSED", blocking: true })]);
    expect(cart.shops[0].issues[0].message).not.toMatch(/wallet|balance|recharge/i);
    // Discovery: not listed among the shops that deliver here.
    expect((await listServiceableShops(location)).map((s) => s.id)).not.toContain(shop.id);
    // Checkout: refused before any payment.
    await expect(checkout({ userId: user.id, addressId, requestId: "low-1" })).rejects.toMatchObject({
      code: "CONFLICT",
      message: `${shop.name} is not taking new orders right now.`,
    });
    expect(await db.select().from(orders).where(eq(orders.shopId, shop.id))).toHaveLength(0);

    // Recharged to the minimum: open again everywhere.
    await fund(shop.id, 20_000);
    expect((await validateCartForLocation(user.id, location)).ok).toBe(true);
    expect((await listServiceableShops(location)).map((s) => s.id)).toContain(shop.id);
    const { orders: placed } = await checkout({ userId: user.id, addressId, requestId: "low-2" });
    expect(placed).toHaveLength(1);
  });

  it("changes nothing while the rule is off", async () => {
    const { sp } = await shopWithMilk(); // ₹0 wallet, rule off
    const { order } = await placeOrder(sp.id);
    expect(order.status).toBe("CONFIRMED");
  });
});

/* -------------------------------------------- commission back on refunds */

describe("refund after delivery", () => {
  async function deliveredFromWallet() {
    await enableWallet();
    const d = await startedDrop({ fundPaise: 50_000 });
    await legDistance(d.deliveryId, "2.0"); // ₹10 delivery charge
    await markDelivered(d.deliveryId, d.rider, emailedCode(d.customer.email));
    expect(await balance(d.shop.id)).toBe(50_000 - 105 - 1_000);
    return d;
  }

  it("returns the commission on the refunded goods to the wallet, in proportion, never more than was charged", async () => {
    const d = await deliveredFromWallet();
    const half = { orderNumber: d.order.orderNumber, amountPaise: PRICE / 2, reason: "Half the milk spoiled", chargeTo: "SHOP" as const };

    const first = await refundDeliveredOrder({ ...half, requestId: "rf-1" }, admin);
    // The settlement recovers the refunded goods in full; the commission on them goes back to the wallet.
    expect(first.amountPaise).toBe(-PRICE / 2);
    let back = (await ledger(d.shop.id)).filter((e) => e.type === "COMMISSION_REFUND");
    expect(back.map((e) => [e.direction, e.amountPaise, e.orderId])).toEqual([["CREDIT", 53, d.order.id]]); // 1% of ₹52.50, rounded
    expect(back[0].reason).toContain("Commission returned on ₹52.50 refunded");
    expect(await balance(d.shop.id)).toBe(48_895 + 53);

    // A retried request returns nothing more.
    await refundDeliveredOrder({ ...half, requestId: "rf-1" }, admin);
    expect((await ledger(d.shop.id)).filter((e) => e.type === "COMMISSION_REFUND")).toHaveLength(1);

    // The rest: capped at the ₹1.05 charged (53 + 52), and the delivery charge stays.
    await refundDeliveredOrder({ ...half, requestId: "rf-2" }, admin);
    back = (await ledger(d.shop.id)).filter((e) => e.type === "COMMISSION_REFUND");
    expect(back.map((e) => e.amountPaise)).toEqual([53, 52]);
    expect(await balance(d.shop.id)).toBe(50_000 - 1_000);
    const adjustments = await db.select().from(financialAdjustments).where(eq(financialAdjustments.orderId, d.order.id));
    expect(adjustments.map((a) => a.amountPaise).sort()).toEqual([-PRICE / 2, -PRICE / 2]);
    const [order] = await db.select().from(orders).where(eq(orders.id, d.order.id));
    expect(order.status).toBe("REFUNDED");

    // Journaled as a commission reversal, and the owner is told.
    const reversal = await db
      .select()
      .from(financeLedgerEntries)
      .where(and(eq(financeLedgerEntries.orderId, d.order.id), eq(financeLedgerEntries.entryType, "COMMISSION"), eq(financeLedgerEntries.direction, "DEBIT"), eq(financeLedgerEntries.entityType, "PLATFORM")));
    expect(reversal.map((r) => r.amountPaise).sort()).toEqual([52, 53]);
    expect(await notes(d.owner.id, NOTIFICATION_TYPES.SHOP_WALLET_ADJUSTED)).toHaveLength(3); // test recharge + two returns
  });

  it("returns nothing when the platform bears the refund", async () => {
    const d = await deliveredFromWallet();
    const adj = await refundDeliveredOrder(
      { orderNumber: d.order.orderNumber, amountPaise: 2_000, reason: "Goodwill", chargeTo: "PLATFORM", requestId: "rf-p" },
      admin,
    );
    expect(adj.amountPaise).toBe(0);
    expect((await ledger(d.shop.id)).filter((e) => e.type === "COMMISSION_REFUND")).toHaveLength(0);
  });

  it("with the rule off the settlement nets the commission off the recovery, as before", async () => {
    const d = await startedDrop();
    await markDelivered(d.deliveryId, d.rider, emailedCode(d.customer.email));
    const adj = await refundDeliveredOrder(
      { orderNumber: d.order.orderNumber, amountPaise: PRICE / 2, reason: "Half spoiled", chargeTo: "SHOP", requestId: "rf-s" },
      admin,
    );
    expect(adj.amountPaise).toBe(-(PRICE / 2 - 53));
    expect(await ledger(d.shop.id)).toHaveLength(0);
  });
});
