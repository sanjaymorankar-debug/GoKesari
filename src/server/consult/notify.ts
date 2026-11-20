/**
 * Consultant appointments: who is told what, at once (event-driven — every
 * change notifies the customer and the firm in the same request, in-app,
 * e-mail and push), and the only timed messages: reminders before the
 * appointment, kept as scheduled_notices rows (kind CONSULT_REMINDER) that the
 * every-minute notification job sends.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";

import { CONSULT_BOOKING_PATH, CONSULT_MODE_LABELS, CONSULT_SHOP_PATH } from "@/lib/consult/constants";
import { formatPaise } from "@/lib/money";
import { formatSlot } from "@/lib/consult/time";
import { db, type DbClient } from "@/server/db";
import { consultBookingMembers, consultBookings, consultMembers, consultProfiles, scheduledNotices, shops, type ConsultBooking, type ScheduledNotice } from "@/server/db/schema";
import { notify, NOTIFICATION_TYPES, type NotificationType } from "@/server/services/notifications";
import { getRule } from "@/server/services/settings";

export const CONSULT_REMINDER_KIND = "CONSULT_REMINDER";

export type BookingNotice =
  | "BOOKED"
  | "CONFIRMED"
  | "PENDING_APPROVAL"
  | "RESCHEDULED"
  | "CANCELLED"
  | "REJECTED"
  | "PAYMENT_RECEIVED"
  | "PAYMENT_FAILED"
  | "REFUND"
  | "COMPLETED"
  | "NO_SHOW"
  | "DISPUTE";

const TYPE_OF: Record<BookingNotice, NotificationType> = {
  BOOKED: NOTIFICATION_TYPES.CONSULT_BOOKED,
  CONFIRMED: NOTIFICATION_TYPES.CONSULT_CONFIRMED,
  PENDING_APPROVAL: NOTIFICATION_TYPES.CONSULT_PENDING_APPROVAL,
  RESCHEDULED: NOTIFICATION_TYPES.CONSULT_RESCHEDULED,
  CANCELLED: NOTIFICATION_TYPES.CONSULT_CANCELLED,
  REJECTED: NOTIFICATION_TYPES.CONSULT_CANCELLED,
  PAYMENT_RECEIVED: NOTIFICATION_TYPES.CONSULT_PAYMENT,
  PAYMENT_FAILED: NOTIFICATION_TYPES.CONSULT_PAYMENT,
  REFUND: NOTIFICATION_TYPES.CONSULT_REFUND,
  COMPLETED: NOTIFICATION_TYPES.CONSULT_COMPLETED,
  NO_SHOW: NOTIFICATION_TYPES.CONSULT_COMPLETED,
  DISPUTE: NOTIFICATION_TYPES.CONSULT_DISPUTE,
};

interface Recipients {
  customerId: string;
  firmUserIds: string[];
  firmName: string;
  memberNames: string[];
}

async function recipientsOf(booking: ConsultBooking, client: DbClient): Promise<Recipients> {
  const [firm] = await client
    .select({ ownerId: shops.ownerId, name: consultProfiles.displayName })
    .from(consultProfiles)
    .innerJoin(shops, eq(shops.id, consultProfiles.shopId))
    .where(eq(consultProfiles.id, booking.profileId));
  const members = await client
    .select({ userId: consultMembers.userId, name: consultMembers.name })
    .from(consultBookingMembers)
    .innerJoin(consultMembers, eq(consultMembers.id, consultBookingMembers.memberId))
    .where(eq(consultBookingMembers.bookingId, booking.id));
  const firmUserIds = new Set<string>();
  if (firm?.ownerId) firmUserIds.add(firm.ownerId);
  for (const m of members) if (m.userId) firmUserIds.add(m.userId);
  firmUserIds.delete(booking.customerId);
  return { customerId: booking.customerId, firmUserIds: [...firmUserIds], firmName: firm?.name ?? "the consultant", memberNames: [...new Set(members.map((m) => m.name))] };
}

function lines(booking: ConsultBooking, r: Recipients): { when: string; what: string; with: string } {
  return {
    when: formatSlot(booking.startsAt),
    what: `${booking.serviceName} (${CONSULT_MODE_LABELS[booking.mode].en.toLowerCase()})`,
    with: r.memberNames.length ? `${r.memberNames.join(", ")} — ${r.firmName}` : r.firmName,
  };
}

/**
 * Tells the customer and the firm about a change. Inside a transaction the
 * rows are written with it and sent right after it commits. Never throws.
 */
export async function tellBooking(booking: ConsultBooking, event: BookingNotice, extra: { note?: string | null; amountPaise?: number; by?: string } = {}, client: DbClient = db): Promise<void> {
  try {
    const r = await recipientsOf(booking, client);
    const l = lines(booking, r);
    const ref = booking.bookingNumber;
    const customerUrl = `${CONSULT_BOOKING_PATH}/${booking.id}`;
    const firmUrl = `${CONSULT_SHOP_PATH}?booking=${booking.id}`;
    const amount = extra.amountPaise != null ? formatPaise(extra.amountPaise) : "";
    const note = extra.note ? ` ${extra.note}` : "";
    const msgs: { customer?: [string, string]; firm?: [string, string] } = {};
    switch (event) {
      case "BOOKED":
        msgs.customer = [`Booking ${ref} received`, `${l.what} with ${l.with} on ${l.when}. Complete the payment to confirm it.`];
        break;
      case "CONFIRMED":
        msgs.customer = [`Appointment confirmed: ${l.when}`, `${ref}: ${l.what} with ${l.with}.${booking.meetingUrl ? ` Join: ${booking.meetingUrl}` : ""}`];
        msgs.firm = [`New booking ${ref}: ${l.when}`, `${booking.visitorName} booked ${l.what}${booking.attendees > 1 ? ` for ${booking.attendees} people` : ""}.`];
        break;
      case "PENDING_APPROVAL":
        msgs.customer = [`Booking ${ref} sent to ${r.firmName}`, `${l.what} on ${l.when}. You will be told as soon as it is accepted.`];
        msgs.firm = [`Booking request ${ref}: please accept or decline`, `${booking.visitorName} asked for ${l.what} on ${l.when}.`];
        break;
      case "RESCHEDULED":
        msgs.customer = [`Appointment moved to ${l.when}`, `${ref}: ${l.what} with ${l.with}.${note}`];
        msgs.firm = [`Booking ${ref} moved to ${l.when}`, `${booking.visitorName}: ${l.what}.${note}`];
        break;
      case "CANCELLED":
        msgs.customer = [`Appointment ${ref} cancelled`, `${l.what} on ${l.when} was cancelled${extra.by ? ` by ${extra.by}` : ""}.${note}`];
        msgs.firm = [`Booking ${ref} cancelled`, `${booking.visitorName}'s ${l.what} on ${l.when} was cancelled${extra.by ? ` by ${extra.by}` : ""}.${note}`];
        break;
      case "REJECTED":
        msgs.customer = [`Booking ${ref} declined`, `${r.firmName} could not take ${l.what} on ${l.when}.${note} Any online payment is refunded in full.`];
        break;
      case "PAYMENT_RECEIVED":
        msgs.customer = [`Payment received for ${ref}`, `${amount} received for ${l.what} on ${l.when}. Your receipt is on the booking page.`];
        msgs.firm = [`Payment received for ${ref}`, `${amount} for ${booking.visitorName}'s ${l.what}.`];
        break;
      case "PAYMENT_FAILED":
        msgs.customer = [`Payment for ${ref} did not go through`, `The time on ${l.when} was released. You can book again.`];
        break;
      case "REFUND":
        msgs.customer = [`Refund for ${ref}: ${amount}`, `${amount} is being returned to your original payment method (usually 5–7 working days).${note}`];
        break;
      case "COMPLETED":
        msgs.customer = [`Thank you — appointment ${ref} completed`, `How was ${l.with}? Rate your appointment on the booking page.`];
        msgs.firm = [`Booking ${ref} completed`, `${booking.visitorName}'s ${l.what} is marked completed.`];
        break;
      case "NO_SHOW":
        msgs.customer = [`Appointment ${ref} marked as missed`, `${r.firmName} marked you absent for ${l.when}.${note} If this is wrong, raise a dispute on the booking page.`];
        break;
      case "DISPUTE":
        msgs.customer = [`We received your dispute about ${ref}`, `Our support team and ${r.firmName} have been told.${note}`];
        msgs.firm = [`Dispute raised on booking ${ref}`, `${booking.visitorName} raised a dispute about ${l.what} on ${l.when}.${note}`];
        break;
    }
    const type = TYPE_OF[event];
    if (msgs.customer) {
      await notify({ userId: r.customerId, type, title: msgs.customer[0], body: msgs.customer[1], actionUrl: customerUrl, channels: ["PUSH"], metadata: { bookingId: booking.id, event } }, client);
    }
    if (msgs.firm) {
      for (const userId of r.firmUserIds) {
        await notify({ userId, type, title: msgs.firm[0], body: msgs.firm[1], actionUrl: firmUrl, channels: ["PUSH"], metadata: { bookingId: booking.id, event } }, client);
      }
    }
  } catch (error) {
    console.error("[consult] notice failed", booking.id, event, error);
  }
}

/* ---------------------------------------------------------------- reminders */

/** Puts (or moves) the reminders of a confirmed booking; past times are skipped. */
export async function scheduleReminders(booking: Pick<ConsultBooking, "id" | "startsAt">, client: DbClient = db, now: Date = new Date()): Promise<void> {
  const rule = await getRule("consultBooking");
  for (const hours of rule.reminderHours) {
    const key = `consult-reminder:${booking.id}:${hours}h`;
    const dueAt = new Date(booking.startsAt.getTime() - hours * 3_600_000);
    if (dueAt.getTime() <= now.getTime()) {
      await client.update(scheduledNotices).set({ cancelledAt: now, updatedAt: now }).where(and(eq(scheduledNotices.key, key), isNull(scheduledNotices.sentAt)));
      continue;
    }
    await client
      .insert(scheduledNotices)
      .values({ kind: CONSULT_REMINDER_KIND, key, dueAt, payload: { bookingId: booking.id, hours: String(hours) } })
      .onConflictDoUpdate({ target: scheduledNotices.key, set: { dueAt, sentAt: null, cancelledAt: null, updatedAt: now } });
  }
}

export async function cancelReminders(bookingId: string, client: DbClient = db, now: Date = new Date()): Promise<void> {
  const rule = await getRule("consultBooking");
  const keys = [...new Set([...rule.reminderHours, 24, 1])].map((h) => `consult-reminder:${bookingId}:${h}h`);
  await client.update(scheduledNotices).set({ cancelledAt: now, updatedAt: now }).where(and(inArray(scheduledNotices.key, keys), isNull(scheduledNotices.sentAt), isNull(scheduledNotices.cancelledAt)));
}

/** Sends one due reminder (called by the scheduled-notices sweep). False: skipped (booking no longer upcoming). */
export async function sendConsultReminder(notice: ScheduledNotice): Promise<boolean> {
  const bookingId = notice.payload.bookingId;
  if (!bookingId) return false;
  const [booking] = await db.select().from(consultBookings).where(eq(consultBookings.id, bookingId));
  if (!booking || booking.status !== "CONFIRMED" || booking.startsAt.getTime() <= Date.now()) return false;
  const hours = Number(notice.payload.hours ?? 0);
  const r = await recipientsOf(booking, db);
  const l = lines(booking, r);
  const soon = hours <= 1 ? "in about an hour" : `on ${l.when}`;
  const where = booking.mode === "VIDEO" && booking.meetingUrl ? ` Join: ${booking.meetingUrl}` : booking.mode === "PHONE" ? " You will get a call at that time." : "";
  await notify({
    userId: r.customerId,
    type: NOTIFICATION_TYPES.CONSULT_REMINDER,
    title: `Reminder: appointment ${soon}`,
    body: `${booking.bookingNumber}: ${l.what} with ${l.with}, ${l.when}.${where}`,
    actionUrl: `${CONSULT_BOOKING_PATH}/${booking.id}`,
    channels: ["PUSH"],
    dedupeKey: `${notice.key}:customer:${booking.startsAt.getTime()}`,
    metadata: { bookingId: booking.id, hours },
  });
  for (const userId of r.firmUserIds) {
    await notify({
      userId,
      type: NOTIFICATION_TYPES.CONSULT_REMINDER,
      title: `Upcoming: ${booking.visitorName} ${soon}`,
      body: `${booking.bookingNumber}: ${l.what}, ${l.when}.`,
      actionUrl: `${CONSULT_SHOP_PATH}?booking=${booking.id}`,
      channels: ["PUSH"],
      dedupeKey: `${notice.key}:${userId}:${booking.startsAt.getTime()}`,
      metadata: { bookingId: booking.id, hours },
    });
  }
  return true;
}
