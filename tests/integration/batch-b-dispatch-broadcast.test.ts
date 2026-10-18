/**
 * batch-2026-10 WS-B — F3.3.2 broadcast rider offers with radius widening
 * (rule dispatchBroadcast). Flag off: the single-offer flow is untouched.
 */
import { and, eq, inArray } from "drizzle-orm";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });

const state = vi.hoisted(() => ({
  session: null as null | {
    user: { id: string; email: string; name: string | null; image: string | null; role: UserRole; status: "ACTIVE" };
  },
}));
vi.mock("@/server/auth", () => ({ auth: async () => state.session, handlers: {}, signIn: async () => {}, signOut: async () => {} }));

import { GET as offersGet } from "@/app/api/delivery-partner/broadcast-offers/route";
import { PATCH as offerPatch } from "@/app/api/delivery-partner/broadcast-offers/[id]/route";
import { POST as sweepPost } from "@/app/api/cron/timeout-sweep/route";
import { db } from "@/server/db";
import {
  deliveryOfferBroadcasts,
  deliveryOfferRecipients,
  deliveryOrders,
  notifications,
  orders,
  platformSettings,
} from "@/server/db/schema";
import { NOTIFICATION_TYPES } from "@/server/notifications/types";
import {
  assignNearestPartner,
  dispatchReadyOrder,
  expireStaleOffers,
  getRiderSearchStatus,
} from "@/server/services/delivery-assignment";
import {
  acceptBroadcastOffer,
  declineBroadcastOffer,
  effectiveRadiiKm,
  listMyBroadcastOffers,
  runBroadcastSweep,
} from "@/server/services/dispatch-broadcast";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { updateOrderStatus } from "@/server/services/orders";
import { call } from "../helpers/http";
import { createDeliveryPartner, createOrder, createShop, createUser, resetDatabase } from "../helpers/fixtures";

const SHOP = { latitude: 18.5, longitude: 73.85 };
const kmNorth = (km: number) => SHOP.latitude + km / 111;
const SYSTEM = { id: null, role: null };

beforeEach(async () => {
  state.session = null;
  await resetDatabase();
  await db.delete(platformSettings).where(inArray(platformSettings.key, ["dispatchBroadcast", "dispatch"]));
  clearRuleCache();
});

async function admin() {
  const a = await createUser({ role: "ADMIN" });
  return { id: a.id, role: "ADMIN" as const };
}

async function enableBroadcast(overrides: Record<string, unknown> = {}) {
  await setRule("dispatchBroadcast", { enabled: true, ...overrides }, await admin());
}

async function rider(km: number, overrides: Parameters<typeof createDeliveryPartner>[1] = {}) {
  const user = await createUser({ role: "DELIVERY_PARTNER" });
  const partner = await createDeliveryPartner(user.id, {
    isOnline: true,
    latitude: kmNorth(km),
    longitude: SHOP.longitude,
    operatingRadiusKm: 10,
    ...overrides,
  });
  return { user, partner };
}

/** A READY order offered to the nearest rider, the offer already older than the single-offer window. */
async function staleOffer(riderKms: number[] = [0.3, 1.5, 3.5, 5.5]) {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const shop = await createShop(owner.id, SHOP);
  const riders = [];
  for (const km of riderKms) riders.push(await rider(km));
  const customer = await createUser();
  const order = await createOrder(customer.id, shop.id, { status: "READY" });
  const offer = await assignNearestPartner(order.id, { id: owner.id, role: "SHOP_OWNER" });
  await db
    .update(deliveryOrders)
    .set({ offeredAt: new Date(Date.now() - 90_000) })
    .where(eq(deliveryOrders.id, offer.id));
  return { owner, shop, riders, customer, order, offer };
}

async function recipientsOf(broadcastId: string) {
  return db.select().from(deliveryOfferRecipients).where(eq(deliveryOfferRecipients.broadcastId, broadcastId));
}

async function openBroadcast(orderId: string) {
  const [b] = await db.select().from(deliveryOfferBroadcasts).where(eq(deliveryOfferBroadcasts.orderId, orderId));
  return b;
}

async function forceNextStep(broadcastId: string) {
  await db
    .update(deliveryOfferBroadcasts)
    .set({ nextStepAt: new Date(Date.now() - 1000) })
    .where(eq(deliveryOfferBroadcasts.id, broadcastId));
}

function signIn(user: { id: string; email: string; name: string | null; role: UserRole }) {
  state.session = { user: { id: user.id, email: user.email, name: user.name, image: null, role: user.role, status: "ACTIVE" } };
}

describe("dispatchBroadcast — flag off (default)", () => {
  it("TC-B26-B-001 the sweep does nothing and a stale single offer expires to the next rider exactly as before", async () => {
    const { order, offer, riders } = await staleOffer([0.3, 1.5]);
    expect(await runBroadcastSweep()).toEqual({ enabled: false, started: 0, widened: 0, expired: 0, closed: 0 });
    expect(await db.select().from(deliveryOfferBroadcasts)).toHaveLength(0);
    // The existing expiry: the dispatch TTL (120 s) has not passed yet for a 90 s old offer.
    expect(await expireStaleOffers()).toBe(0);
    await db.update(deliveryOrders).set({ offeredAt: new Date(Date.now() - 200_000) }).where(eq(deliveryOrders.id, offer.id));
    expect(await expireStaleOffers()).toBe(1);
    const [row] = await db.select().from(deliveryOrders).where(eq(deliveryOrders.orderId, order.id));
    expect(row.status).toBe("OFFERED");
    expect(row.deliveryPartnerId).toBe(riders[1].partner.id);
    expect(row.rejectedPartnerIds).toEqual([riders[0].partner.id]);
  });

  it("TC-B26-B-002 the cron timeout-sweep reports no broadcast part while the flag is off, and one when it is on", async () => {
    const cron = () =>
      new NextRequest("http://localhost/api/cron/timeout-sweep", {
        method: "POST",
        headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
      });
    const off = await (await sweepPost(cron())).json();
    expect(off).not.toHaveProperty("dispatchBroadcast");
    await enableBroadcast();
    const on = await (await sweepPost(cron())).json();
    expect(on.dispatchBroadcast).toMatchObject({ enabled: true, started: 0 });
    expect(on.errors).toEqual([]);
  });
});

describe("dispatchBroadcast — on", () => {
  it("TC-B26-B-003 a single offer nobody accepted in time is broadcast to every eligible rider within the first radius", async () => {
    await enableBroadcast();
    const { order, offer, riders, owner } = await staleOffer();
    const result = await runBroadcastSweep();
    expect(result).toMatchObject({ enabled: true, started: 1 });

    const [row] = await db.select().from(deliveryOrders).where(eq(deliveryOrders.id, offer.id));
    expect(row.status).toBe("REJECTED");
    const b = await openBroadcast(order.id);
    expect(b).toMatchObject({ status: "OPEN", step: 0, radiusM: 2000, originalPartnerId: riders[0].partner.id });
    const reached = (await recipientsOf(b.id)).map((r) => r.deliveryPartnerId).sort();
    expect(reached).toEqual([riders[0].partner.id, riders[1].partner.id].sort());

    // Event-driven: each reached rider and the shop are told at once.
    const told = await db
      .select({ userId: notifications.userId })
      .from(notifications)
      .where(eq(notifications.type, NOTIFICATION_TYPES.DELIVERY_BROADCAST_OFFERED));
    expect(told.map((n) => n.userId).sort()).toEqual([riders[0].user.id, riders[1].user.id].sort());
    const shopTold = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, owner.id), eq(notifications.type, NOTIFICATION_TYPES.SHOP_RIDER_OFFER_BROADCAST)));
    expect(shopTold).toHaveLength(1);

    // The normal search does not offer the order to anyone else meanwhile.
    expect(await dispatchReadyOrder(order.id, SYSTEM, "SWEEP")).toBeNull();
    expect((await getRiderSearchStatus(order.id)).message).toContain("every rider within 2 km");
  });

  it("TC-B26-B-004 the radius widens 2 → 4 → 6 km step by step, then the broadcast expires and the search carries on", async () => {
    await enableBroadcast();
    const { order, riders } = await staleOffer();
    await runBroadcastSweep();
    const b = await openBroadcast(order.id);

    await forceNextStep(b.id);
    expect(await runBroadcastSweep()).toMatchObject({ widened: 1 });
    expect((await openBroadcast(order.id))).toMatchObject({ step: 1, radiusM: 4000 });
    expect((await recipientsOf(b.id)).find((r) => r.deliveryPartnerId === riders[2].partner.id)?.radiusStep).toBe(1);

    await forceNextStep(b.id);
    await runBroadcastSweep();
    expect(await openBroadcast(order.id)).toMatchObject({ step: 2, radiusM: 6000 });
    expect((await recipientsOf(b.id)).map((r) => r.deliveryPartnerId)).toContain(riders[3].partner.id);

    await forceNextStep(b.id);
    expect(await runBroadcastSweep()).toMatchObject({ expired: 1 });
    const closed = await openBroadcast(order.id);
    expect(closed.status).toBe("EXPIRED");
    expect((await recipientsOf(b.id)).every((r) => r.outcome === "EXPIRED")).toBe(true);
    // The rider who let the single offer lapse is not offered it again; the next nearest is.
    const [row] = await db.select().from(deliveryOrders).where(eq(deliveryOrders.orderId, order.id));
    expect(row.rejectedPartnerIds).toContain(riders[0].partner.id);
    expect(row.status).toBe("OFFERED");
    expect(row.deliveryPartnerId).toBe(riders[1].partner.id);
  });

  it("TC-B26-B-005 maxRadiusKm caps the radii and maxRecipientsPerStep limits each step (nearest first)", async () => {
    expect(effectiveRadiiKm({ radiiKm: [2, 4, 6], maxRadiusKm: 4 })).toEqual([2, 4]);
    expect(effectiveRadiiKm({ radiiKm: [5, 8], maxRadiusKm: 3 })).toEqual([3]);
    await enableBroadcast({ maxRecipientsPerStep: 1 });
    const { order, riders } = await staleOffer([0.3, 0.8, 1.2]);
    await runBroadcastSweep();
    const reached = (await recipientsOf((await openBroadcast(order.id)).id)).map((r) => r.deliveryPartnerId);
    // The original rider always, plus the one nearest other rider.
    expect(reached.sort()).toEqual([riders[0].partner.id, riders[1].partner.id].sort());
  });

  it("TC-B26-B-006 ineligible riders are never reached: offline, not approved, busy, declined, out of their own radius", async () => {
    await enableBroadcast();
    const { order, offer, shop } = await staleOffer([0.3]);
    const offline = await rider(1, { isOnline: false });
    const suspended = await rider(1.1, { status: "SUSPENDED" });
    const shortRange = await rider(1.2, { operatingRadiusKm: 1 });
    const busy = await rider(0.9);
    const other = await createOrder((await createUser()).id, shop.id, { status: "READY" });
    await db.insert(deliveryOrders).values({ orderId: other.id, deliveryPartnerId: busy.partner.id, status: "PICKED_UP" });
    const declined = await rider(0.7);
    await db
      .update(deliveryOrders)
      .set({ rejectedPartnerIds: [declined.partner.id] })
      .where(eq(deliveryOrders.id, offer.id));
    const ok = await rider(1.4);

    await runBroadcastSweep();
    const reached = (await recipientsOf((await openBroadcast(order.id)).id)).map((r) => r.deliveryPartnerId);
    expect(reached).toContain(ok.partner.id);
    for (const p of [offline, suspended, shortRange, busy, declined]) expect(reached).not.toContain(p.partner.id);
  });

  it("TC-B26-B-007 with the busy-rider fallback on, a busy rider under the cap is reached too", async () => {
    await setRule("dispatch", { busyRidersAsFallback: true, maxActiveDeliveriesPerRider: 2 }, await admin());
    await enableBroadcast();
    const { order, shop } = await staleOffer([0.3]);
    const busy = await rider(0.9);
    const other = await createOrder((await createUser()).id, shop.id, { status: "READY" });
    await db.insert(deliveryOrders).values({ orderId: other.id, deliveryPartnerId: busy.partner.id, status: "PICKED_UP" });
    await runBroadcastSweep();
    const reached = (await recipientsOf((await openBroadcast(order.id)).id)).map((r) => r.deliveryPartnerId);
    expect(reached).toContain(busy.partner.id);
  });

  it("TC-B26-B-008 two riders accepting at the same moment: exactly one wins, the others see Offer taken and are notified", async () => {
    await enableBroadcast();
    const { order, riders } = await staleOffer([0.3, 0.6, 0.9, 1.2]);
    await runBroadcastSweep();
    const b = await openBroadcast(order.id);

    // Two parallel transactions racing for the same broadcast row.
    const [r1, r2] = await Promise.allSettled([
      acceptBroadcastOffer(b.id, riders[1].user.id),
      acceptBroadcastOffer(b.id, riders[2].user.id),
    ]);
    const outcomes = [r1, r2];
    const won = outcomes.filter((r) => r.status === "fulfilled");
    const lost = outcomes.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0].reason).toMatchObject({ code: "CONFLICT", details: { reason: "OFFER_TAKEN" } });

    const winner = r1.status === "fulfilled" ? riders[1] : riders[2];
    const loser = winner === riders[1] ? riders[2] : riders[1];
    const [row] = await db.select().from(deliveryOrders).where(eq(deliveryOrders.orderId, order.id));
    expect(row).toMatchObject({ status: "ACCEPTED", deliveryPartnerId: winner.partner.id });
    expect(row.pickupCode).toMatch(/^\d{4}$/);
    const [o] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(o.status).toBe("ASSIGNED");

    const outcomesByPartner = new Map((await recipientsOf(b.id)).map((r) => [r.deliveryPartnerId, r.outcome]));
    expect(outcomesByPartner.get(winner.partner.id)).toBe("ACCEPTED");
    for (const r of riders.filter((x) => x !== winner)) expect(outcomesByPartner.get(r.partner.id)).toBe("TAKEN_BY_OTHER");
    expect((await openBroadcast(order.id))).toMatchObject({ status: "TAKEN", winnerPartnerId: winner.partner.id });

    const takenNotices = await db
      .select({ userId: notifications.userId })
      .from(notifications)
      .where(eq(notifications.type, NOTIFICATION_TYPES.DELIVERY_OFFER_TAKEN));
    expect(takenNotices.map((n) => n.userId).sort()).toEqual(riders.filter((x) => x !== winner).map((x) => x.user.id).sort());

    // The loser's dashboard shows "Offer taken" instead of an Accept button.
    const view = await listMyBroadcastOffers(loser.user.id);
    expect(view).toEqual([expect.objectContaining({ broadcastId: b.id, state: "TAKEN" })]);
    // A late accept is refused the same way.
    await expect(acceptBroadcastOffer(b.id, riders[3].user.id)).rejects.toMatchObject({ details: { reason: "OFFER_TAKEN" } });
  });

  it("TC-B26-B-009 only a reached rider can accept; a decline is remembered and blocks a later accept", async () => {
    await enableBroadcast();
    const { order, riders } = await staleOffer([0.3, 0.6, 3.5]);
    await runBroadcastSweep();
    const b = await openBroadcast(order.id);
    // 3.5 km: outside the first radius — not reached yet.
    await expect(acceptBroadcastOffer(b.id, riders[2].user.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await declineBroadcastOffer(b.id, riders[1].user.id);
    await expect(acceptBroadcastOffer(b.id, riders[1].user.id)).rejects.toMatchObject({ code: "CONFLICT" });
    const [row] = await db.select().from(deliveryOrders).where(eq(deliveryOrders.orderId, order.id));
    expect(row.rejectedPartnerIds).toContain(riders[1].partner.id);
    // The original rider can still take it.
    const accepted = await acceptBroadcastOffer(b.id, riders[0].user.id);
    expect(accepted.status).toBe("ACCEPTED");
  });

  it("TC-B26-B-010 an order cancelled during a broadcast cannot be accepted and the sweep closes the broadcast", async () => {
    await enableBroadcast();
    const { order, riders } = await staleOffer([0.3, 0.6]);
    await runBroadcastSweep();
    const b = await openBroadcast(order.id);
    await updateOrderStatus(order.id, "CANCELLED", { id: (await admin()).id, role: "ADMIN" }, "Customer asked");
    await expect(acceptBroadcastOffer(b.id, riders[1].user.id)).rejects.toMatchObject({ code: "CONFLICT" });
    await forceNextStep(b.id);
    expect(await runBroadcastSweep()).toMatchObject({ closed: 1 });
    expect((await openBroadcast(order.id)).status).toBe("CANCELLED");
  });

  it("TC-B26-B-011 the rider's list shows open offers with a countdown and earnings estimate, and marks them seen", async () => {
    await enableBroadcast();
    const { order, riders } = await staleOffer([0.3, 0.6]);
    await db.update(deliveryOrders).set({ distanceKm: "2.5" }).where(eq(deliveryOrders.orderId, order.id));
    await runBroadcastSweep();
    const [offer] = await listMyBroadcastOffers(riders[1].user.id);
    expect(offer).toMatchObject({ state: "OPEN", orderNumber: order.orderNumber, deliveryLegKm: 2.5 });
    expect(offer.secondsLeft).toBeGreaterThan(100); // two more steps of 60 s after this one
    expect(offer.distanceToShopKm).toBeCloseTo(0.6, 1);
    expect(typeof offer.earningsPaise === "number" || offer.earningsPaise === null).toBe(true);
    const [rec] = await db
      .select()
      .from(deliveryOfferRecipients)
      .where(eq(deliveryOfferRecipients.deliveryPartnerId, riders[1].partner.id));
    expect(rec.seenAt).not.toBeNull();
  });

  it("TC-B26-B-012 routes: list (flag off → disabled), accept → 200, a second rider → 409 OFFER_TAKEN, no session → 401", async () => {
    const { order, riders } = await staleOffer([0.3, 0.6, 0.9]);
    signIn(riders[1].user);
    expect((await call(offersGet, "/api/delivery-partner/broadcast-offers")).body).toEqual({ enabled: false, pollSeconds: null, offers: [] });

    await enableBroadcast();
    await runBroadcastSweep();
    const b = await openBroadcast(order.id);
    const list = await call(offersGet, "/api/delivery-partner/broadcast-offers");
    expect(list.body.offers[0]).toMatchObject({ broadcastId: b.id, state: "OPEN" });

    const first = await call(offerPatch, `/api/delivery-partner/broadcast-offers/${b.id}`, {
      method: "PATCH",
      params: { id: b.id },
      body: { action: "accept" },
    });
    expect(first.status).toBe(200);
    expect(first.body.status).toBe("ACCEPTED");
    expect(first.body).not.toHaveProperty("pickupCode");

    signIn(riders[2].user);
    const second = await call(offerPatch, `/api/delivery-partner/broadcast-offers/${b.id}`, {
      method: "PATCH",
      params: { id: b.id },
      body: { action: "accept" },
    });
    expect(second.status).toBe(409);
    expect(second.body.error.details.reason).toBe("OFFER_TAKEN");

    state.session = null;
    expect((await call(offersGet, "/api/delivery-partner/broadcast-offers")).status).toBe(401);
  });

  it("TC-B26-B-013 a rider who accepted the single offer before the sweep keeps it — no broadcast starts", async () => {
    await enableBroadcast();
    const { order, riders, offer } = await staleOffer([0.3, 0.6]);
    const { acceptDeliveryOffer } = await import("@/server/services/delivery-assignment");
    // Accept just inside the dispatch TTL (the stale offer is 90 s old; TTL 120 s).
    const accepted = await acceptDeliveryOffer(offer.id, riders[0].user.id);
    expect(accepted.status).toBe("ACCEPTED");
    expect(await runBroadcastSweep()).toMatchObject({ started: 0 });
    expect(await openBroadcast(order.id)).toBeUndefined();
  });
});
