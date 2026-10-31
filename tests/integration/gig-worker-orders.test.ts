/**
 * Gig worker flow, order side (docs/gig-worker-2026-10): features 6–11 —
 * zoning on the live location, per-society authorise / block with the shop's
 * view, the partner's identity hidden from the shop for a blocked society,
 * pickup with an optional photo, delivery with configurable OTP, and the
 * completion step with push + SMS + in-app to both sides.
 */
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 150_000, hookTimeout: 90_000 });

import { db } from "@/server/db";
import { deliveryOrders, deliveryPartners, deliveryProofs, notificationDeliveries, notifications, orders, societies } from "@/server/db/schema";
import { addToCart } from "@/server/services/cart";
import {
  acceptDeliveryOffer,
  markDelivered,
  markPickedUp,
  startDelivery,
  withdrawOutOfZoneOffers,
} from "@/server/services/delivery-assignment";
import { updateMyLocation } from "@/server/services/delivery-partners";
import { uploadDeliveryProof } from "@/server/services/delivery-proofs";
import { acceptOrder, markOrderReady, startPicking } from "@/server/services/fulfilment";
import { NOTIFICATION_TYPES } from "@/server/services/notifications";
import { checkout } from "@/server/services/orders";
import { clearRuleCache, setRule } from "@/server/services/settings";
import {
  getShopOrderPartners,
  listShopDeliveryPartners,
  PARTNER_PENDING_LABEL,
  setSocietyPartnerAccess,
} from "@/server/services/society-partner-access";
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
  setDeliveryCode,
} from "../helpers/fixtures";

const SHOP = { latitude: 18.5, longitude: 73.85 };
const kmNorth = (km: number) => SHOP.latitude + km / 111.32;

beforeEach(async () => {
  await resetDatabase();
  clearRuleCache();
});

function png(width: number, height: number): Buffer {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  const dims = Buffer.alloc(8);
  dims.writeUInt32BE(width, 0);
  dims.writeUInt32BE(height, 4);
  return Buffer.concat([header, Buffer.from("IHDR"), dims, Buffer.from([8, 2, 0, 0, 0, 0, 0, 0, 0]), Buffer.alloc(64)]);
}

const notesFor = (userId: string, type: string) =>
  db.select().from(notifications).where(and(eq(notifications.userId, userId), eq(notifications.type, type)));

async function society(name: string) {
  const [row] = await db
    .insert(societies)
    .values({ name, slug: `${name.toLowerCase().replace(/\s+/g, "-")}-${Math.random().toString(36).slice(2, 8)}`, addressLine1: "Main Road", city: "Pune", pincode: "411001", status: "VERIFIED" })
    .returning();
  return row;
}

/** A packed order whose customer is `dropKm` north of the shop, optionally in a society. */
async function packedOrder(options: { dropKm?: number; societyId?: string | null } = {}) {
  const { user: customer } = await createUserWithWallet({ balancePaise: 500_000 });
  const owner = await createUser({ role: "SHOP_OWNER" });
  const admin = await createUser({ role: "ADMIN" });
  const category = await createCategory({ department: "DAIRY", name: "Milk" });
  const product = await createProduct(category.id, { name: "Cow Milk", unit: "L" });
  const shop = await createShop(owner.id, { status: "APPROVED", latitude: SHOP.latitude, longitude: SHOP.longitude });
  const sp = await createShopProduct(shop.id, product.id, { onlinePricePaise: 7000, onlineSaleEnabled: true });
  await addToCart(customer.id, sp.id, 1);
  const { orders: created } = await checkout({ userId: customer.id, requestId: `req-${customer.id}`, addressId: await deliveryAddressId(customer.id) });
  const [order] = await db
    .update(orders)
    .set({
      societyId: options.societyId ?? null,
      deliveryAddressSnapshot: {
        line1: "1 Test Road",
        city: "Pune",
        pincode: "411001",
        latitude: String(kmNorth(options.dropKm ?? 1)),
        longitude: String(SHOP.longitude),
      },
    })
    .where(eq(orders.id, created[0].id))
    .returning();
  const shopActor = { id: owner.id, role: "SHOP_OWNER" as const };
  await acceptOrder(order.id, shopActor);
  await startPicking(order.id, shopActor);
  return { order, customer, owner, shop, admin, shopActor, adminActor: { id: admin.id, role: "ADMIN" as const } };
}

async function rider(name: string, atKmNorth: number, options: { minutesAgo?: number; availability?: "READY" | "ACTIVE" } = {}) {
  const user = await createUser({ role: "DELIVERY_PARTNER" });
  const partner = await createDeliveryPartner(user.id, { isOnline: true, latitude: kmNorth(atKmNorth), longitude: SHOP.longitude, operatingRadiusKm: 20 });
  await db
    .update(deliveryPartners)
    .set({
      fullName: name,
      mobile: `98${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
      availability: options.availability ?? "READY",
      ...(options.minutesAgo ? { lastLocationAt: new Date(Date.now() - options.minutesAgo * 60_000) } : {}),
    })
    .where(eq(deliveryPartners.id, partner.id));
  return { user, partner, actor: { id: user.id, role: "DELIVERY_PARTNER" as const } };
}

const deliveryOf = async (orderId: string) => (await db.select().from(deliveryOrders).where(eq(deliveryOrders.orderId, orderId)))[0] ?? null;

/* ---------------------------------------------------------- feature 6 */

describe("feature 6 — zoning on the live location", () => {
  it("offers only to a Ready rider within the radius of both the pickup and the drop", async () => {
    const setup = await packedOrder({ dropKm: 6 });
    await rider("At The Shop", 0); // drop 6 km away: outside 5 km
    await rider("Halfway", 3, { availability: "ACTIVE" }); // in zone but Active: no new orders
    const halfwayReady = await rider("Halfway Ready", 3.2);
    await markOrderReady(setup.order.id, setup.shopActor);
    const offer = await deliveryOf(setup.order.id);
    expect(offer).toMatchObject({ status: "OFFERED", deliveryPartnerId: halfwayReady.partner.id });
  });

  it("uses the live location, not the registration address, and ignores a stale one", async () => {
    const setup = await packedOrder({ dropKm: 1 });
    const far = await rider("Registered Nearby, Now Far", 9);
    await db.update(deliveryPartners).set({ latitude: String(SHOP.latitude), longitude: String(SHOP.longitude) }).where(eq(deliveryPartners.id, far.partner.id));
    await rider("Stale Phone", 0.5, { minutesAgo: 40 });
    await markOrderReady(setup.order.id, setup.shopActor);
    expect(await deliveryOf(setup.order.id)).toBeNull();

    const fresh = await rider("Fresh", 0.8);
    const { dispatchReadyOrder } = await import("@/server/services/delivery-assignment");
    await dispatchReadyOrder(setup.order.id, { id: null, role: null }, "REOFFER");
    expect((await deliveryOf(setup.order.id))?.deliveryPartnerId).toBe(fresh.partner.id);
  });

  it("the radius is configurable from 3 to 5 km (default 5)", async () => {
    const setup = await packedOrder({ dropKm: 1 });
    await expect(setRule("riderZoning", { radiusKm: 2 }, setup.adminActor)).rejects.toMatchObject({ status: 422 });
    await expect(setRule("riderZoning", { radiusKm: 6 }, setup.adminActor)).rejects.toMatchObject({ status: 422 });
    await setRule("riderZoning", { radiusKm: 3 }, setup.adminActor);
    await rider("Four Km", 4);
    await markOrderReady(setup.order.id, setup.shopActor);
    expect(await deliveryOf(setup.order.id)).toBeNull();
  });

  it("each location update re-checks open offers: leaving the zone hands the order to the next rider", async () => {
    const setup = await packedOrder({ dropKm: 1 });
    const first = await rider("First", 0.2);
    const second = await rider("Second", 1.5);
    await markOrderReady(setup.order.id, setup.shopActor);
    const offer = await deliveryOf(setup.order.id);
    expect(offer?.deliveryPartnerId).toBe(first.partner.id);

    // Still inside: nothing changes.
    expect(await withdrawOutOfZoneOffers(first.partner.id, { latitude: kmNorth(0.5), longitude: SHOP.longitude })).toBe(0);
    // Rides 8 km away: the offer goes, and the order is offered to the next rider in the zone.
    await updateMyLocation(first.user.id, kmNorth(8), SHOP.longitude);
    const [withdrawn] = await db.select().from(deliveryOrders).where(eq(deliveryOrders.id, offer!.id));
    expect(withdrawn.deliveryPartnerId === second.partner.id || withdrawn.status === "CANCELLED").toBe(true);
    expect((await deliveryOf(setup.order.id))?.deliveryPartnerId).toBe(second.partner.id);
    // The first rider can no longer take it.
    await expect(acceptDeliveryOffer(offer!.id, first.user.id)).rejects.toMatchObject({ code: "FORBIDDEN" });

    // An offer still in hand is checked again at acceptance, on the live location (here moved
    // without a location update, so nothing withdrew it first).
    await db.update(deliveryPartners).set({ lastLocationLatitude: String(kmNorth(9)) }).where(eq(deliveryPartners.id, second.partner.id));
    await expect(acceptDeliveryOffer(offer!.id, second.user.id)).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("too far"),
    });
  });
});

/* ---------------------------------------------------------- features 7 and 8 */

describe("features 7 and 8 — societies authorise / block, identity hidden from the shop", () => {
  it("a partner blocked for the order's society is never offered it", async () => {
    const s = await society("Green Meadows");
    const setup = await packedOrder({ dropKm: 1, societyId: s.id });
    const blocked = await rider("Blocked Rider", 0.1);
    const allowed = await rider("Allowed Rider", 1);
    await setSocietyPartnerAccess({ societyId: s.id, deliveryPartnerId: blocked.partner.id, access: "BLOCKED", reason: "Complaint from residents" }, setup.adminActor);
    await markOrderReady(setup.order.id, setup.shopActor);
    expect((await deliveryOf(setup.order.id))?.deliveryPartnerId).toBe(allowed.partner.id);
  });

  it("only an admin decides; a block needs a reason", async () => {
    const s = await society("Lake View");
    const r = await rider("Someone", 0);
    const owner = await createUser({ role: "SHOP_OWNER" });
    await expect(setSocietyPartnerAccess({ societyId: s.id, deliveryPartnerId: r.partner.id, access: "AUTHORISED" }, { id: owner.id, role: "SHOP_OWNER" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const admin = await createUser({ role: "ADMIN" });
    await expect(setSocietyPartnerAccess({ societyId: s.id, deliveryPartnerId: r.partner.id, access: "BLOCKED" }, { id: admin.id, role: "ADMIN" })).rejects.toMatchObject({ status: 422 });
  });

  it("on an order in a blocked society the shop gets no name, photo or mobile — in the order data and its notifications", async () => {
    const s = await society("Palm Grove");
    const setup = await packedOrder({ dropKm: 1, societyId: s.id });
    const ravi = await rider("Ravi Secret", 0.1);
    await markOrderReady(setup.order.id, setup.shopActor);
    const offer = (await deliveryOf(setup.order.id))!;
    await acceptDeliveryOffer(offer.id, ravi.user.id);

    // Visible while not blocked: name and mobile.
    const before = (await getShopOrderPartners([setup.order.id])).get(setup.order.id)!;
    expect(before).toMatchObject({ hidden: false, label: "Ravi Secret", partner: { name: "Ravi Secret", mobile: expect.any(String) } });

    // Blocked after accepting: hidden from the shop from now on.
    await setSocietyPartnerAccess({ societyId: s.id, deliveryPartnerId: ravi.partner.id, access: "BLOCKED", reason: "Gate security complaint" }, setup.adminActor);
    const after = (await getShopOrderPartners([setup.order.id])).get(setup.order.id)!;
    expect(after).toEqual({ deliveryStatus: "ACCEPTED", partner: null, label: PARTNER_PENDING_LABEL, hidden: true });
    expect(JSON.stringify(after)).not.toContain("Ravi");

    const [accepted] = await db.select().from(deliveryOrders).where(eq(deliveryOrders.id, offer.id));
    await markPickedUp(offer.id, ravi.actor, accepted.pickupCode!);
    const [pickedUpNote] = await notesFor(setup.owner.id, NOTIFICATION_TYPES.SHOP_ORDER_PICKED_UP);
    expect(pickedUpNote.body).not.toContain("Ravi");
    expect(pickedUpNote.body).toContain("A delivery partner");
    // The customer is not the shop: they still see who is coming.
    const [buyerNote] = await notesFor(setup.customer.id, NOTIFICATION_TYPES.ORDER_PICKED_UP);
    expect(buyerNote).toBeTruthy();

    // ...and the shop's partner list does not show them.
    expect(await listShopDeliveryPartners(setup.shop.id, setup.shopActor)).toEqual([]);
  });

  it("the shop sees each partner's count of authorised and blocked societies, with the lists", async () => {
    const [a, b, c] = [await society("Alpha Towers"), await society("Beta Heights"), await society("Gamma Park")];
    const setup = await packedOrder({ dropKm: 1 });
    const meena = await rider("Meena", 0.1);
    await markOrderReady(setup.order.id, setup.shopActor);
    await acceptDeliveryOffer((await deliveryOf(setup.order.id))!.id, meena.user.id);
    for (const [s, access] of [[a, "AUTHORISED"], [b, "AUTHORISED"], [c, "BLOCKED"]] as const) {
      await setSocietyPartnerAccess({ societyId: s.id, deliveryPartnerId: meena.partner.id, access, reason: access === "BLOCKED" ? "Late deliveries" : null }, setup.adminActor);
    }
    const [row] = await listShopDeliveryPartners(setup.shop.id, setup.shopActor);
    expect(row).toMatchObject({ name: "Meena", authorisedCount: 2, blockedCount: 1 });
    expect(row.authorised.map((x) => x.name)).toEqual(["Alpha Towers", "Beta Heights"]);
    expect(row.blocked.map((x) => x.name)).toEqual(["Gamma Park"]);

    const stranger = await createUser({ role: "SHOP_OWNER" });
    await expect(listShopDeliveryPartners(setup.shop.id, { id: stranger.id, role: "SHOP_OWNER" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

/* ---------------------------------------------------------- features 9, 10 and 11 */

async function acceptedDelivery() {
  const setup = await packedOrder({ dropKm: 1 });
  const ravi = await rider("Ravi", 0.1);
  await markOrderReady(setup.order.id, setup.shopActor);
  const offer = (await deliveryOf(setup.order.id))!;
  await acceptDeliveryOffer(offer.id, ravi.user.id);
  const [accepted] = await db.select().from(deliveryOrders).where(eq(deliveryOrders.id, offer.id));
  return { ...setup, ravi, deliveryId: offer.id, pickupCode: accepted.pickupCode! };
}

describe("feature 9 — confirm picked up", () => {
  it("Assigned → Picked Up with a timestamp and an optional photo; shop and customer told", async () => {
    const d = await acceptedDelivery();
    const photo = await uploadDeliveryProof(d.deliveryId, d.ravi.actor, png(400, 300), "PICKUP");
    expect(photo.kind).toBe("PICKUP");
    const before = Date.now();
    const picked = await markPickedUp(d.deliveryId, d.ravi.actor, d.pickupCode);
    expect(picked.status).toBe("PICKED_UP");
    expect(picked.pickedUpAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    const [order] = await db.select().from(orders).where(eq(orders.id, d.order.id));
    expect(order.status).toBe("PICKED_UP");
    expect(await notesFor(d.customer.id, NOTIFICATION_TYPES.ORDER_PICKED_UP)).toHaveLength(1);
    expect(await notesFor(d.owner.id, NOTIFICATION_TYPES.SHOP_ORDER_PICKED_UP)).toHaveLength(1);
    const proofs = await db.select().from(deliveryProofs).where(eq(deliveryProofs.deliveryOrderId, d.deliveryId));
    expect(proofs.map((p) => p.kind)).toEqual(["PICKUP"]);
  });

  it("the pickup photo is optional and never counts as the photo at the door", async () => {
    const d = await acceptedDelivery();
    await setRule("deliveryProof", { photoRequired: true }, d.adminActor);
    await uploadDeliveryProof(d.deliveryId, d.ravi.actor, png(400, 300), "PICKUP");
    await markPickedUp(d.deliveryId, d.ravi.actor, d.pickupCode);
    await startDelivery(d.deliveryId, d.ravi.actor);
    await expect(markDelivered(d.deliveryId, d.ravi.actor, await setDeliveryCode(d.deliveryId))).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("photo"),
    });
    await uploadDeliveryProof(d.deliveryId, d.ravi.actor, png(400, 300), "DELIVERY");
    expect((await markDelivered(d.deliveryId, d.ravi.actor, await setDeliveryCode(d.deliveryId))).status).toBe("DELIVERED");
  });
});

describe("feature 10 — confirm delivered (OTP as configured)", () => {
  it("with the code required the drop needs it; Picked Up → Delivered", async () => {
    const d = await acceptedDelivery();
    await markPickedUp(d.deliveryId, d.ravi.actor, d.pickupCode);
    await startDelivery(d.deliveryId, d.ravi.actor);
    await expect(markDelivered(d.deliveryId, d.ravi.actor, "0000")).rejects.toBeTruthy();
    expect((await markDelivered(d.deliveryId, d.ravi.actor, await setDeliveryCode(d.deliveryId))).status).toBe("DELIVERED");
  });

  it("with deliveryOtp.required off no code is issued and the rider marks it delivered without one", async () => {
    const d = await acceptedDelivery();
    await setRule("deliveryOtp", { required: false }, d.adminActor);
    await markPickedUp(d.deliveryId, d.ravi.actor, d.pickupCode);
    const started = await startDelivery(d.deliveryId, d.ravi.actor);
    expect(started.deliveryOtpHash).toBeNull();
    expect((await markDelivered(d.deliveryId, d.ravi.actor)).status).toBe("DELIVERED");
  });
});

describe("feature 11 — completed, and both sides told by push, SMS and in-app", () => {
  it("a confirmed delivery completes the order once and queues push + SMS for the customer and the shop", async () => {
    const d = await acceptedDelivery();
    await markPickedUp(d.deliveryId, d.ravi.actor, d.pickupCode);
    await startDelivery(d.deliveryId, d.ravi.actor);
    await markDelivered(d.deliveryId, d.ravi.actor, await setDeliveryCode(d.deliveryId));

    const [order] = await db.select().from(orders).where(eq(orders.id, d.order.id));
    expect(order.status).toBe("DELIVERED");
    expect(order.completedAt).toBeInstanceOf(Date);
    for (const [userId, type] of [
      [d.customer.id, NOTIFICATION_TYPES.ORDER_COMPLETED],
      [d.owner.id, NOTIFICATION_TYPES.SHOP_ORDER_COMPLETED],
    ] as const) {
      const notes = await notesFor(userId, type);
      expect(notes, type).toHaveLength(1);
      expect(notes[0].body).toContain(order.orderNumber);
      const outbound = await db
        .select({ channel: notificationDeliveries.channel })
        .from(notificationDeliveries)
        .where(and(eq(notificationDeliveries.userId, userId), eq(notificationDeliveries.type, type)));
      expect(outbound.map((o) => o.channel).sort(), type).toEqual(["PUSH", "SMS"]);
    }
  });

  it("with rule orderCompletion off, a delivered order is not marked completed", async () => {
    const d = await acceptedDelivery();
    await setRule("orderCompletion", { enabled: false }, d.adminActor);
    await markPickedUp(d.deliveryId, d.ravi.actor, d.pickupCode);
    await startDelivery(d.deliveryId, d.ravi.actor);
    await markDelivered(d.deliveryId, d.ravi.actor, await setDeliveryCode(d.deliveryId));
    const [order] = await db.select().from(orders).where(eq(orders.id, d.order.id));
    expect(order.completedAt).toBeNull();
    expect(await notesFor(d.customer.id, NOTIFICATION_TYPES.ORDER_COMPLETED)).toHaveLength(0);
  });
});
