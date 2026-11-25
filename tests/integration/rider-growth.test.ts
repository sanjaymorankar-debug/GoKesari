/**
 * Rider App v2 growth: slot booking (capacity, cut-off, reminders, dispatch set), Refer & Earn
 * (code, registration link, qualification paid once) and the tier priority set. Rules are OFF
 * by default; each test turns on what it needs.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/server/db";
import {
  deliveryOrders,
  deliveryPartners,
  financialAdjustments,
  notifications,
  platformSettings,
  riderEarningSlots,
  riderReferrals,
  riderSlotBookings,
} from "@/server/db/schema";
import {
  checkReferralQualification,
  ensureReferralCode,
  getMyReferrals,
  recordReferral,
  resolveReferrerForRegistration,
} from "@/server/services/rider-referrals";
import { bookSlot, bookedPartnerIdsNow, cancelSlotBooking, listBookableSlots, sendSlotReminders } from "@/server/services/rider-slot-bookings";
import { priorityPartnerIds, tierMetricsFor } from "@/server/services/rider-tiers";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { createDeliveryPartner, createOrder, createShop, createUser, resetDatabase } from "../helpers/fixtures";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });

const RULE_KEYS = ["riderSlotBooking", "riderReferral", "riderTiers"];
let admin: { id: string; role: "ADMIN" };

beforeEach(async () => {
  await resetDatabase();
  await db.delete(platformSettings).where(inArray(platformSettings.key, RULE_KEYS));
  await db.delete(riderEarningSlots);
  clearRuleCache();
  const a = await createUser({ role: "ADMIN" });
  admin = { id: a.id, role: "ADMIN" };
});

async function rider() {
  const user = await createUser({ role: "DELIVERY_PARTNER" });
  const partner = await createDeliveryPartner(user.id);
  await db.update(deliveryPartners).set({ reviewedAt: new Date("2026-12-01T00:00:00Z") }).where(eq(deliveryPartners.id, partner.id));
  return { user, partner, ref: { partnerId: partner.id, userId: user.id } };
}

// 10 Dec 2026, 11.30 IST.
const NOW = new Date("2026-12-10T06:00:00Z");

describe("slot booking", () => {
  async function slot(capacity: number | null) {
    const [row] = await db
      .insert(riderEarningSlots)
      .values({ name: "Lunch rush", startTime: "12:00", endTime: "14:00", bookable: true, bookingCapacity: capacity, surgeMultiplierBp: 12000, peakBonusPaise: 1500 })
      .returning();
    return row;
  }

  it("is closed while the rule is off", async () => {
    const r = await rider();
    const s = await slot(2);
    expect((await listBookableSlots(r.partner.id, NOW)).days).toEqual([]);
    await expect(bookSlot(r.ref, s.id, "2026-12-10", NOW)).rejects.toThrow(/not open/);
    expect((await bookedPartnerIdsNow(NOW)).size).toBe(0);
  });

  it("books up to capacity, cancels before the cut-off, reminds once and feeds dispatch", async () => {
    await setRule("riderSlotBooking", { enabled: true, daysAhead: 7, cancelCutoffMinutes: 60, reminderMinutes: 45 }, admin);
    const s = await slot(1);
    const a = await rider();
    const b = await rider();

    const view = await listBookableSlots(a.partner.id, NOW);
    expect(view.days).toHaveLength(7);
    expect(view.days[0].slots[0]).toMatchObject({ slotId: s.id, date: "2026-12-10", booked: 0, capacity: 1, canBook: true });
    expect(view.days[0].slots[0].boost).toEqual(["×1.2 pay", "+₹15 per order"]);

    const booking = await bookSlot(a.ref, s.id, "2026-12-10", NOW);
    await expect(bookSlot(a.ref, s.id, "2026-12-10", NOW)).rejects.toThrow(/already booked/);
    await expect(bookSlot(b.ref, s.id, "2026-12-10", NOW)).rejects.toThrow(/full/);
    await expect(bookSlot(b.ref, s.id, "2026-12-30", NOW)).rejects.toThrow(/next 7 days/);

    // Cut-off: 60 minutes before 12.00 IST = 05.30 UTC; NOW is 06.00 UTC.
    await expect(cancelSlotBooking(a.ref, booking.id, NOW)).rejects.toThrow(/60 minutes/);
    await expect(cancelSlotBooking(b.ref, booking.id, new Date("2026-12-10T05:00:00Z"))).rejects.toThrow(/not found/i);

    // Reminder: the slot starts at 06.30 UTC, within 45 minutes of NOW; sent once.
    expect(await sendSlotReminders(NOW)).toEqual({ enabled: true, sent: 1 });
    expect(await sendSlotReminders(NOW)).toEqual({ enabled: true, sent: 0 });
    const notes = await db.select().from(notifications).where(eq(notifications.userId, a.user.id));
    expect(notes.some((n) => n.type === "delivery.rider_slot_reminder")).toBe(true);

    // Dispatch: booked riders while the slot runs.
    expect([...(await bookedPartnerIdsNow(new Date("2026-12-10T07:00:00Z")))]).toEqual([a.partner.id]);
    expect((await bookedPartnerIdsNow(NOW)).size).toBe(0);

    // Cancel in time frees the place.
    const tomorrow = await bookSlot(a.ref, s.id, "2026-12-11", NOW);
    const cancelled = await cancelSlotBooking(a.ref, tomorrow.id, NOW);
    expect(cancelled.status).toBe("CANCELLED");
    await bookSlot(b.ref, s.id, "2026-12-11", NOW);
  });

  it("never overbooks under concurrent requests", async () => {
    await setRule("riderSlotBooking", { enabled: true, daysAhead: 7, cancelCutoffMinutes: 60, reminderMinutes: 15 }, admin);
    const s = await slot(2);
    const riders = await Promise.all([rider(), rider(), rider(), rider(), rider()]);
    await Promise.allSettled(riders.map((r) => bookSlot(r.ref, s.id, "2026-12-12", NOW)));
    const rows = await db
      .select()
      .from(riderSlotBookings)
      .where(and(eq(riderSlotBookings.slotId, s.id), eq(riderSlotBookings.status, "BOOKED")));
    expect(rows).toHaveLength(2);
  });
});

describe("refer & earn", () => {
  it("does nothing while the rule is off", async () => {
    const r = await rider();
    expect(await ensureReferralCode(r.partner.id)).toBeNull();
    expect(await resolveReferrerForRegistration("GKRAAAAAA", r.user.id)).toBeNull();
  });

  it("links a referral, pays the reward once on qualifying and notifies the referrer", async () => {
    await setRule("riderReferral", { enabled: true, rewardPaise: 50_000, deliveriesRequired: 2, withinDays: 30 }, admin);
    const referrer = await rider();
    const code = await ensureReferralCode(referrer.partner.id);
    expect(code).toMatch(/^GKR[A-Z0-9]{6}$/);
    expect(await ensureReferralCode(referrer.partner.id)).toBe(code);

    // Own code and unknown code refused.
    await expect(resolveReferrerForRegistration(code!, referrer.user.id)).rejects.toThrow(/own referral code/);
    await expect(resolveReferrerForRegistration("GKRZZZZZZ", referrer.user.id)).rejects.toThrow(/not valid/);

    const newbie = await rider();
    expect(await resolveReferrerForRegistration(code!.toLowerCase(), newbie.user.id)).toBe(referrer.partner.id);
    const referral = await recordReferral(newbie.partner.id, referrer.partner.id);
    expect(referral).toMatchObject({ status: "PENDING", deliveriesRequired: 2, rewardPaise: 50_000 });
    // A later rule change does not move the goalposts.
    await setRule("riderReferral", { enabled: true, rewardPaise: 10_000, deliveriesRequired: 50, withinDays: 30 }, admin);

    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id);
    const deliverOne = async (at: string) => {
      const customer = await createUser();
      const order = await createOrder(customer.id, shop.id, { status: "DELIVERED" });
      await db.insert(deliveryOrders).values({ orderId: order.id, deliveryPartnerId: newbie.partner.id, status: "DELIVERED", deliveredAt: new Date(at) });
    };
    await deliverOne("2026-12-02T10:00:00Z");
    expect(await checkReferralQualification(newbie.partner.id, NOW)).toBe("PENDING");
    await deliverOne("2026-12-03T10:00:00Z");
    const [first, second] = await Promise.all([
      checkReferralQualification(newbie.partner.id, NOW),
      checkReferralQualification(newbie.partner.id, NOW),
    ]);
    expect([first, second]).toEqual(["QUALIFIED", "QUALIFIED"]);
    expect(await checkReferralQualification(newbie.partner.id, NOW)).toBe("QUALIFIED");

    const adjustments = await db.select().from(financialAdjustments).where(eq(financialAdjustments.deliveryPartnerId, referrer.partner.id));
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0]).toMatchObject({ type: "RIDER_ADJUSTMENT", amountPaise: 50_000, status: "PENDING" });
    const [row] = await db.select().from(riderReferrals).where(eq(riderReferrals.id, referral!.id));
    expect(row.paidAdjustmentId).toBe(adjustments[0].id);
    const notes = await db.select().from(notifications).where(eq(notifications.userId, referrer.user.id));
    expect(notes.filter((n) => n.type === "delivery.rider_referral_qualified")).toHaveLength(1);

    const view = await getMyReferrals(referrer.partner.id, NOW);
    expect(view.earnedPaise).toBe(50_000);
    expect(view.referrals[0]).toMatchObject({ name: "Test", status: "QUALIFIED", delivered: 2, required: 2 });
    // Privacy: the referrer sees a first name and progress only.
    expect(Object.keys(view.referrals[0]).sort()).toEqual(["createdAt", "daysLeft", "delivered", "id", "name", "required", "rewardPaise", "status"]);
  });

  it("expires a referral past its window", async () => {
    await setRule("riderReferral", { enabled: true, rewardPaise: 50_000, deliveriesRequired: 5, withinDays: 7 }, admin);
    const referrer = await rider();
    const newbie = await rider();
    await recordReferral(newbie.partner.id, referrer.partner.id);
    expect(await checkReferralQualification(newbie.partner.id, NOW)).toBe("EXPIRED");
    expect(await db.select().from(financialAdjustments)).toHaveLength(0);
  });
});

describe("tier priority", () => {
  it("is empty while the rule is off and lists priority-tier riders when on", async () => {
    const r = await rider();
    expect((await priorityPartnerIds([r.partner.id])).size).toBe(0);
    await setRule(
      "riderTiers",
      {
        enabled: true,
        tiers: [
          { name: "Bronze", minDeliveries: 0, minRatingX100: 0, minAcceptancePct: 0, minOnTimePct: 0, extraIncentivePct: 0, priority: false },
          { name: "Starter+", minDeliveries: 0, minRatingX100: 0, minAcceptancePct: 0, minOnTimePct: 0, extraIncentivePct: 1, priority: true },
        ],
      },
      admin,
    );
    expect([...(await priorityPartnerIds([r.partner.id]))]).toEqual([r.partner.id]);
  });

  it("measures deliveries, acceptance and on-time over the last 7 days", async () => {
    const me = await rider();
    const other = await rider();
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id);
    const now = new Date();
    const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);
    const job = async (partnerId: string, values: Partial<typeof deliveryOrders.$inferInsert>, promisedByAt: Date | null) => {
      const customer = await createUser();
      const order = await createOrder(customer.id, shop.id, { status: "DELIVERED" });
      if (promisedByAt) await db.execute(sql`update orders set promised_by_at = ${promisedByAt.toISOString()} where id = ${order.id}`);
      await db.insert(deliveryOrders).values({ orderId: order.id, deliveryPartnerId: partnerId, ...values });
    };
    // Two delivered (one on time, one late), one turned down (now with another rider).
    await job(me.partner.id, { status: "DELIVERED", acceptedAt: hoursAgo(5), deliveredAt: hoursAgo(4) }, hoursAgo(3));
    await job(me.partner.id, { status: "DELIVERED", acceptedAt: hoursAgo(3), deliveredAt: hoursAgo(1) }, hoursAgo(2));
    await job(other.partner.id, { status: "ACCEPTED", acceptedAt: hoursAgo(2), rejectedPartnerIds: [me.partner.id] }, null);
    // Older than 7 days: not counted.
    await job(me.partner.id, { status: "DELIVERED", acceptedAt: hoursAgo(24 * 9), deliveredAt: hoursAgo(24 * 9) }, null);

    const m = (await tierMetricsFor([me.partner.id], now)).get(me.partner.id)!;
    expect(m).toMatchObject({ deliveries: 2, acceptancePct: 67, onTimePct: 50 });
  });
});
