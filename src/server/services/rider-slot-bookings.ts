/**
 * Optional slot booking (Rider App v2, rule riderSlotBooking — OFF by default).
 *
 *  - Slots are the admin's rider earning slots marked `bookable` (Rider earnings → slots). A rider
 *    sees them for today and the next daysAhead − 1 days (APP_TIMEZONE calendar), with the slot's
 *    pay boost, how many riders booked it against its capacity (null = no limit) and their own booking.
 *  - Booking is race-safe: a transaction-scoped advisory lock per (slot, date) around the capacity
 *    count, and the partial unique index (one live booking per rider, slot and date).
 *  - A booking may be cancelled until cancelCutoffMinutes before the start. Both are audited.
 *  - bookedPartnerIdsNow(now) — riders with a booking for a slot running now — is for dispatch.
 *  - sendSlotReminders(now) runs from the every-minute timeout sweep while the rule is on.
 */
import { and, count, eq, inArray, isNull, sql } from "drizzle-orm";

import { conflict, notFound, validationFailed } from "@/lib/errors";
import { getEnv } from "@/lib/env";
import { localTime } from "@/lib/earnings-calc";
import {
  addDaysKey,
  bookableDates,
  canBook,
  canCancel,
  reminderDue,
  slotBoostTags,
  slotRunsOn,
  slotWindow,
} from "@/lib/rider-growth";
import { db } from "@/server/db";
import { deliveryPartners, riderEarningSlots, riderSlotBookings, type RiderEarningSlot, type RiderSlotBooking } from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { NOTIFICATION_TYPES, notify } from "./notifications";
import { getRule } from "./settings";

const tz = () => getEnv().APP_TIMEZONE;

async function bookableSlots(): Promise<RiderEarningSlot[]> {
  return db
    .select()
    .from(riderEarningSlots)
    .where(and(eq(riderEarningSlots.isActive, true), eq(riderEarningSlots.bookable, true)));
}

const hhmm = (d: Date) => localTime(d, tz());

export interface BookableSlotView {
  slotId: string;
  name: string;
  date: string;
  startTime: string;
  endTime: string;
  startsAt: string;
  endsAt: string;
  boost: string[];
  booked: number;
  capacity: number | null;
  full: boolean;
  myBookingId: string | null;
  canBook: boolean;
  canCancel: boolean;
}

export interface SlotsView {
  enabled: boolean;
  daysAhead: number;
  cancelCutoffMinutes: number;
  days: { date: string; slots: BookableSlotView[] }[];
}

export async function listBookableSlots(partnerId: string, now: Date = new Date()): Promise<SlotsView> {
  const rule = await getRule("riderSlotBooking");
  const base = { enabled: rule.enabled, daysAhead: rule.daysAhead, cancelCutoffMinutes: rule.cancelCutoffMinutes };
  if (!rule.enabled) return { ...base, days: [] };

  const dates = bookableDates(now, rule.daysAhead, tz());
  const slots = await bookableSlots();
  if (slots.length === 0) return { ...base, days: dates.map((date) => ({ date, slots: [] })) };
  const slotIds = slots.map((s) => s.id);

  const [counts, mine] = await Promise.all([
    db
      .select({ slotId: riderSlotBookings.slotId, date: riderSlotBookings.slotDate, n: count() })
      .from(riderSlotBookings)
      .where(and(inArray(riderSlotBookings.slotId, slotIds), inArray(riderSlotBookings.slotDate, dates), eq(riderSlotBookings.status, "BOOKED")))
      .groupBy(riderSlotBookings.slotId, riderSlotBookings.slotDate),
    db
      .select({ id: riderSlotBookings.id, slotId: riderSlotBookings.slotId, date: riderSlotBookings.slotDate })
      .from(riderSlotBookings)
      .where(
        and(
          eq(riderSlotBookings.deliveryPartnerId, partnerId),
          inArray(riderSlotBookings.slotDate, dates),
          eq(riderSlotBookings.status, "BOOKED"),
        ),
      ),
  ]);

  const days = dates.map((date) => {
    const list: BookableSlotView[] = [];
    for (const slot of slots) {
      if (!slotRunsOn(slot, date)) continue;
      const { start, end } = slotWindow(slot, date, tz());
      if (end.getTime() <= now.getTime()) continue; // over already
      const booked = Number(counts.find((c) => c.slotId === slot.id && c.date === date)?.n ?? 0);
      const myBookingId = mine.find((m) => m.slotId === slot.id && m.date === date)?.id ?? null;
      const full = slot.bookingCapacity != null && booked >= slot.bookingCapacity;
      list.push({
        slotId: slot.id,
        name: slot.name,
        date,
        startTime: slot.startTime,
        endTime: slot.endTime,
        startsAt: start.toISOString(),
        endsAt: end.toISOString(),
        boost: slotBoostTags(slot),
        booked,
        capacity: slot.bookingCapacity,
        full,
        myBookingId,
        canBook: !myBookingId && !full && canBook(end, now),
        canCancel: Boolean(myBookingId) && canCancel(start, now, rule.cancelCutoffMinutes),
      });
    }
    list.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    return { date, slots: list };
  });
  return { ...base, days };
}

interface RiderRef {
  partnerId: string;
  userId: string;
}

async function requireApprovedRider(partnerId: string) {
  const partner = await db.query.deliveryPartners.findFirst({
    where: and(eq(deliveryPartners.id, partnerId), isNull(deliveryPartners.deletedAt)),
    columns: { id: true, status: true },
  });
  if (!partner) throw notFound("Delivery partner profile");
  if (partner.status !== "APPROVED") throw conflict("You can book slots once your delivery partner account is approved.");
}

export async function bookSlot(rider: RiderRef, slotId: string, date: string, now: Date = new Date()): Promise<RiderSlotBooking> {
  const rule = await getRule("riderSlotBooking");
  if (!rule.enabled) throw conflict("Slot booking is not open right now.");
  await requireApprovedRider(rider.partnerId);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !bookableDates(now, rule.daysAhead, tz()).includes(date)) {
    throw validationFailed(`You can book slots for the next ${rule.daysAhead} days only.`);
  }
  const slot = await db.query.riderEarningSlots.findFirst({ where: eq(riderEarningSlots.id, slotId) });
  if (!slot || !slotRunsOn(slot, date)) throw notFound("Slot");
  const { start, end } = slotWindow(slot, date, tz());
  if (!canBook(end, now)) throw conflict("This slot is over.");

  const booking = await db.transaction(async (tx) => {
    // One booking at a time per slot and date, so the capacity count cannot be raced past.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`rider-slot:${slotId}:${date}`}))`);
    const [mine] = await tx
      .select({ id: riderSlotBookings.id })
      .from(riderSlotBookings)
      .where(
        and(
          eq(riderSlotBookings.deliveryPartnerId, rider.partnerId),
          eq(riderSlotBookings.slotId, slotId),
          eq(riderSlotBookings.slotDate, date),
          eq(riderSlotBookings.status, "BOOKED"),
        ),
      );
    if (mine) throw conflict("You have already booked this slot.");
    if (slot.bookingCapacity != null) {
      const [row] = await tx
        .select({ n: count() })
        .from(riderSlotBookings)
        .where(and(eq(riderSlotBookings.slotId, slotId), eq(riderSlotBookings.slotDate, date), eq(riderSlotBookings.status, "BOOKED")));
      if (Number(row?.n ?? 0) >= slot.bookingCapacity) throw conflict("This slot is full. Pick another slot.");
    }
    const [created] = await tx
      .insert(riderSlotBookings)
      .values({ deliveryPartnerId: rider.partnerId, slotId, slotDate: date, status: "BOOKED" })
      .onConflictDoNothing()
      .returning();
    if (!created) throw conflict("You have already booked this slot.");
    await recordAudit(
      {
        actorId: rider.userId,
        actorRole: "DELIVERY_PARTNER",
        action: AUDIT_ACTIONS.RIDER_SLOT_BOOKED,
        entityType: "rider_slot_booking",
        entityId: created.id,
        newValue: { slotId, slotName: slot.name, date, startsAt: start.toISOString(), status: "BOOKED" },
      },
      tx,
    );
    return created;
  });
  return booking;
}

export async function cancelSlotBooking(rider: RiderRef, bookingId: string, now: Date = new Date()): Promise<RiderSlotBooking> {
  const rule = await getRule("riderSlotBooking");
  if (!rule.enabled) throw conflict("Slot booking is not open right now.");
  const booking = await db.query.riderSlotBookings.findFirst({ where: eq(riderSlotBookings.id, bookingId) });
  if (!booking || booking.deliveryPartnerId !== rider.partnerId) throw notFound("Booking");
  if (booking.status !== "BOOKED") throw conflict("This booking is already cancelled.");
  const slot = await db.query.riderEarningSlots.findFirst({ where: eq(riderEarningSlots.id, booking.slotId) });
  if (!slot) throw notFound("Slot");
  const { start } = slotWindow(slot, booking.slotDate, tz());
  if (!canCancel(start, now, rule.cancelCutoffMinutes)) {
    throw conflict(`Bookings can be cancelled until ${rule.cancelCutoffMinutes} minutes before the slot starts.`);
  }
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(riderSlotBookings)
      .set({ status: "CANCELLED", cancelledAt: now })
      .where(and(eq(riderSlotBookings.id, bookingId), eq(riderSlotBookings.status, "BOOKED")))
      .returning();
    if (!row) throw conflict("This booking is already cancelled.");
    await recordAudit(
      {
        actorId: rider.userId,
        actorRole: "DELIVERY_PARTNER",
        action: AUDIT_ACTIONS.RIDER_SLOT_CANCELLED,
        entityType: "rider_slot_booking",
        entityId: row.id,
        previousValue: { status: "BOOKED" },
        newValue: { slotId: row.slotId, slotName: slot.name, date: row.slotDate, status: "CANCELLED" },
      },
      tx,
    );
    return row;
  });
}

/** Live bookings dated yesterday or today (yesterday's may cross midnight), with their slot. */
async function bookingsAround(now: Date) {
  const today = localTime(now, tz()).dateKey;
  return db
    .select({ booking: riderSlotBookings, slot: riderEarningSlots })
    .from(riderSlotBookings)
    .innerJoin(riderEarningSlots, eq(riderEarningSlots.id, riderSlotBookings.slotId))
    .where(and(eq(riderSlotBookings.status, "BOOKED"), inArray(riderSlotBookings.slotDate, [addDaysKey(today, -1), today, addDaysKey(today, 1)])));
}

/**
 * For dispatch: riders with a booking for a slot that is running at `now`. Empty while the rule is
 * off. Whether they are online is the caller's check.
 */
export async function bookedPartnerIdsNow(now: Date = new Date()): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    if (!(await getRule("riderSlotBooking")).enabled) return out;
    for (const { booking, slot } of await bookingsAround(now)) {
      if (!slot.isActive) continue;
      const { start, end } = slotWindow(slot, booking.slotDate, tz());
      if (start.getTime() <= now.getTime() && now.getTime() < end.getTime()) out.add(booking.deliveryPartnerId);
    }
  } catch (error) {
    console.error("[rider-slots] booked-rider lookup failed", error);
  }
  return out;
}

/**
 * Reminds riders whose booked slot starts within reminderMinutes. Each booking is claimed
 * (reminded_at set) before the notice goes out, so overlapping sweeps send one reminder.
 */
export async function sendSlotReminders(now: Date = new Date()): Promise<{ enabled: boolean; sent: number }> {
  const rule = await getRule("riderSlotBooking");
  if (!rule.enabled) return { enabled: false, sent: 0 };
  let sent = 0;
  for (const { booking, slot } of await bookingsAround(now)) {
    if (booking.remindedAt || !slot.isActive) continue;
    const { start } = slotWindow(slot, booking.slotDate, tz());
    if (!reminderDue(start, now, rule.reminderMinutes)) continue;
    const [claimed] = await db
      .update(riderSlotBookings)
      .set({ remindedAt: now })
      .where(and(eq(riderSlotBookings.id, booking.id), isNull(riderSlotBookings.remindedAt), eq(riderSlotBookings.status, "BOOKED")))
      .returning({ id: riderSlotBookings.id });
    if (!claimed) continue;
    const partner = await db.query.deliveryPartners.findFirst({
      where: eq(deliveryPartners.id, booking.deliveryPartnerId),
      columns: { userId: true },
    });
    if (!partner) continue;
    const t = hhmm(start);
    const startText = `${String(Math.floor(t.minutes / 60)).padStart(2, "0")}:${String(t.minutes % 60).padStart(2, "0")}`;
    await notify({
      userId: partner.userId,
      type: NOTIFICATION_TYPES.RIDER_SLOT_REMINDER,
      vars: { slotName: slot.name, start: startText },
      actionUrl: "/delivery-partner/slots",
      dedupeKey: `rider-slot-reminder:${booking.id}`,
      lang: "auto",
    });
    sent++;
  }
  return { enabled: true, sent };
}
