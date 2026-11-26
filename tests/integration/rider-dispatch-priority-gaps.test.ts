/**
 * Flow review 26-Nov-2026: two rider-dispatch gaps, written as the behaviour Rider App v2 promises
 * (both failed before the fix).
 *  1. A rider who booked the running slot is "offered first" (riderSlotBooking) — but
 *     assignNearestPartner re-sorts candidates in rankCandidates by distance score.
 *  2. The job board (riderJobBoard) should only show a job to a rider that normal dispatch would
 *     offer it to: Ready (not Active), live location (≤ 15 min old), customer within 5 km.
 */
import { eq, inArray } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/server/db";
import { deliveryOrders, deliveryPartners, orders, platformSettings, riderEarningSlots, riderSlotBookings } from "@/server/db/schema";
import { assignNearestPartner, findEligiblePartnersNearShop } from "@/server/services/delivery-assignment";
import { bookedPartnerIdsNow } from "@/server/services/rider-slot-bookings";
import { acceptJob, listOpenJobs } from "@/server/services/rider-job-board";
import { clearRuleCache } from "@/server/services/settings";
import { createDeliveryPartner, createOrder, createShop, createUser, resetDatabase } from "../helpers/fixtures";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });

const SHOP = { latitude: 18.5, longitude: 73.85 };
const kmNorth = (km: number) => SHOP.latitude + km / 111;
const dispatcher = { id: "", role: "ADMIN" as const };

function istDateKey(d = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

beforeEach(async () => {
  await resetDatabase();
  await db.delete(platformSettings).where(inArray(platformSettings.key, ["dispatch", "riderSlotBooking", "riderTiers", "riderJobBoard", "riderZoning", "batching"]));
  await db.delete(riderEarningSlots);
  clearRuleCache();
  const admin = await createUser({ role: "ADMIN" });
  dispatcher.id = admin.id;
});

async function shopAndReadyOrder(customerKmNorth: number | null = null) {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const shop = await createShop(owner.id, { latitude: SHOP.latitude, longitude: SHOP.longitude });
  const customer = await createUser();
  const order = await createOrder(customer.id, shop.id, { status: "READY" });
  if (customerKmNorth != null) {
    const [row] = await db.select().from(orders).where(eq(orders.id, order.id));
    await db
      .update(orders)
      .set({ deliveryAddressSnapshot: { ...(row.deliveryAddressSnapshot ?? {}), latitude: kmNorth(customerKmNorth), longitude: SHOP.longitude } as never })
      .where(eq(orders.id, order.id));
  }
  return { shop, order };
}

describe("gap 1: booked-slot priority in normal dispatch", () => {
  it("offers the order to the rider who booked the running slot, even when an unbooked rider is nearer", async () => {
    const { order } = await shopAndReadyOrder();
    const nearUser = await createUser({ role: "DELIVERY_PARTNER" });
    const near = await createDeliveryPartner(nearUser.id, { isOnline: true, latitude: kmNorth(0.5), longitude: SHOP.longitude });
    const bookedUser = await createUser({ role: "DELIVERY_PARTNER" });
    const booked = await createDeliveryPartner(bookedUser.id, { isOnline: true, latitude: kmNorth(3), longitude: SHOP.longitude });

    // An all-day bookable slot, booked by the farther rider for today (IST).
    const [slot] = await db
      .insert(riderEarningSlots)
      .values({ name: "All day", startTime: "00:00", endTime: "23:59", bookable: true })
      .returning();
    await db.insert(riderSlotBookings).values({ deliveryPartnerId: booked.id, slotId: slot.id, slotDate: istDateKey() });

    // Precondition: the booking counts as "running now" for dispatch, and that helper does put the booked rider first.
    expect((await bookedPartnerIdsNow()).has(booked.id)).toBe(true);
    const eligible = await findEligiblePartnersNearShop(SHOP);
    expect(eligible.map((c) => c.partner.id)).toEqual([booked.id, near.id]);

    const offer = await assignNearestPartner(order.id, dispatcher);
    expect({ offeredTo: offer.deliveryPartnerId === booked.id ? "booked rider (3 km)" : offer.deliveryPartnerId === near.id ? "unbooked rider (0.5 km)" : offer.deliveryPartnerId }).toEqual({
      offeredTo: "booked rider (3 km)",
    });
  });
});

describe("gap 2: job board applies the same rules as normal dispatch offers", () => {
  /** A READY order whose single offer another rider turned down — what the board lists. */
  async function openJob(customerKmNorth: number) {
    const { order } = await shopAndReadyOrder(customerKmNorth);
    const otherUser = await createUser({ role: "DELIVERY_PARTNER" });
    const other = await createDeliveryPartner(otherUser.id, { isOnline: false });
    await db.insert(deliveryOrders).values({ orderId: order.id, deliveryPartnerId: other.id, status: "REJECTED", rejectedPartnerIds: [other.id] });
    return order;
  }

  async function boardRider(opts: { availability: "READY" | "ACTIVE"; locationAgeMinutes: number }) {
    const user = await createUser({ role: "DELIVERY_PARTNER" });
    const partner = await createDeliveryPartner(user.id, { isOnline: true, latitude: kmNorth(1), longitude: SHOP.longitude, operatingRadiusKm: 8 });
    await db
      .update(deliveryPartners)
      .set({ availability: opts.availability, lastLocationAt: new Date(Date.now() - opts.locationAgeMinutes * 60_000) })
      .where(eq(deliveryPartners.id, partner.id));
    return user;
  }

  it("control: a Ready rider with a fresh location, customer nearby, sees the job", async () => {
    await openJob(2);
    const user = await boardRider({ availability: "READY", locationAgeMinutes: 1 });
    const board = await listOpenJobs(user.id);
    expect(board.jobs).toHaveLength(1);
  });

  it("hides the job when the customer is beyond the 5 km zone from the rider", async () => {
    await openJob(15); // rider at 1 km north, customer at 15 km north: 14 km apart
    const user = await boardRider({ availability: "READY", locationAgeMinutes: 1 });
    const board = await listOpenJobs(user.id);
    expect(board.jobs).toHaveLength(0);
  });

  it("hides the job when the rider's location is older than 15 minutes", async () => {
    await openJob(2);
    const user = await boardRider({ availability: "READY", locationAgeMinutes: 120 });
    const board = await listOpenJobs(user.id);
    expect(board.jobs).toHaveLength(0);
  });

  it("hides the job from an Active (on duty, no new offers) rider", async () => {
    await openJob(2);
    const user = await boardRider({ availability: "ACTIVE", locationAgeMinutes: 1 });
    const board = await listOpenJobs(user.id);
    expect(board.jobs).toHaveLength(0);
    expect(board.blockedReason).toBe("NOT_READY");
  });

  it("refuses Accept for an out-of-zone job or an Active rider, and lets a Ready rider in the zone take it", async () => {
    const far = await openJob(15);
    const farRow = await db.query.deliveryOrders.findFirst({ where: eq(deliveryOrders.orderId, far.id) });
    const ready = await boardRider({ availability: "READY", locationAgeMinutes: 1 });
    await expect(acceptJob(ready.id, `d:${farRow!.id}`)).rejects.toMatchObject({ code: "CONFLICT" });

    const near = await openJob(2);
    const nearRow = await db.query.deliveryOrders.findFirst({ where: eq(deliveryOrders.orderId, near.id) });
    const active = await boardRider({ availability: "ACTIVE", locationAgeMinutes: 1 });
    await expect(acceptJob(active.id, `d:${nearRow!.id}`)).rejects.toMatchObject({ code: "CONFLICT" });

    const taken = await acceptJob(ready.id, `d:${nearRow!.id}`);
    expect(taken.status).toBe("ACCEPTED");
  });
});
