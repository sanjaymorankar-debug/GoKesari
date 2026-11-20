/**
 * Consultant appointments: loads members' calendars (hours, time off, booked
 * time) and asks lib/consult/slots which times are free. A time held for a
 * payment past its hold counts as free here; the booking transaction releases
 * such holds before it takes the time (expireHoldsFor).
 */
import { and, asc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";

import { freeSlots, nextFreeSlot, type BusyRow, type FreeSlot, type MemberCalendar, type ServiceShape, type SlotRules } from "@/lib/consult/slots";
import { addDays, istAt, istDateKey } from "@/lib/consult/time";
import { db, type DbClient } from "@/server/db";
import {
  consultBookingMembers,
  consultBookings,
  consultMembers,
  consultServices,
  consultTimeOff,
  consultWeeklyHours,
  type ConsultMember,
  type ConsultProfile,
  type ConsultService,
} from "@/server/db/schema";

const DAY = 86_400_000;

export function serviceShape(s: Pick<ConsultService, "id" | "durationMinutes" | "bookingKind" | "capacity" | "requiredMembers">): ServiceShape {
  return { id: s.id, durationMinutes: s.durationMinutes, bookingKind: s.bookingKind, capacity: s.capacity, requiredMembers: s.requiredMembers };
}

export function rulesOf(profile: Pick<ConsultProfile, "minNoticeMinutes" | "bookingWindowDays">, now: Date = new Date()): SlotRules {
  return { now, minNoticeMinutes: profile.minNoticeMinutes, bookingWindowDays: profile.bookingWindowDays };
}

/** Active members who offer a service (its member list, or everyone). */
export function membersForService(service: Pick<ConsultService, "memberIds">, members: readonly ConsultMember[]): ConsultMember[] {
  const active = members.filter((m) => m.status === "ACTIVE");
  return service.memberIds.length ? active.filter((m) => service.memberIds.includes(m.id)) : active;
}

/**
 * Calendars of `members` between two instants. `excludeBookingId`: leave that
 * booking's own time out (moving it). Expired holds are not busy.
 */
export async function loadCalendars(
  members: readonly Pick<ConsultMember, "id" | "profileId" | "slotMinutes" | "bufferMinutes" | "maxPerSlot">[],
  from: Date,
  to: Date,
  options: { client?: DbClient; excludeBookingId?: string; now?: Date } = {},
): Promise<MemberCalendar[]> {
  if (!members.length) return [];
  const client = options.client ?? db;
  const now = options.now ?? new Date();
  const ids = members.map((m) => m.id);
  const profileIds = [...new Set(members.map((m) => m.profileId))];
  const [hours, timeOff, busy] = await Promise.all([
    client.select().from(consultWeeklyHours).where(inArray(consultWeeklyHours.memberId, ids)),
    client
      .select()
      .from(consultTimeOff)
      .where(and(inArray(consultTimeOff.profileId, profileIds), lt(consultTimeOff.startsAt, to), gt(consultTimeOff.endsAt, from), or(isNull(consultTimeOff.memberId), inArray(consultTimeOff.memberId, ids)))),
    client
      .select({
        memberId: consultBookingMembers.memberId,
        startsAt: consultBookingMembers.startsAt,
        blocksUntil: consultBookingMembers.blocksUntil,
        shareKey: consultBookingMembers.shareKey,
        bookingId: consultBookingMembers.bookingId,
        attendees: consultBookings.attendees,
      })
      .from(consultBookingMembers)
      .innerJoin(consultBookings, eq(consultBookings.id, consultBookingMembers.bookingId))
      .where(
        and(
          inArray(consultBookingMembers.memberId, ids),
          eq(consultBookingMembers.active, true),
          lt(consultBookingMembers.startsAt, to),
          gt(consultBookingMembers.blocksUntil, from),
          sql`NOT (${consultBookings.status} = 'PENDING_PAYMENT' AND ${consultBookings.holdExpiresAt} < ${now.toISOString()}::timestamptz)`,
        ),
      ),
  ]);
  return members.map((m) => ({
    memberId: m.id,
    slotMinutes: m.slotMinutes,
    bufferMinutes: m.bufferMinutes,
    maxPerSlot: m.maxPerSlot,
    hours: hours.filter((h) => h.memberId === m.id),
    timeOff: timeOff.filter((t) => t.memberId === null || t.memberId === m.id).map((t) => ({ kind: t.kind, memberId: t.memberId, startsAt: t.startsAt, endsAt: t.endsAt })),
    busy: busy
      .filter((b) => b.memberId === m.id && b.bookingId !== options.excludeBookingId)
      .map<BusyRow>((b) => ({ start: b.startsAt.getTime(), end: b.blocksUntil.getTime(), shareKey: b.shareKey, attendees: b.attendees })),
  }));
}

export async function profileMembers(profileId: string, client: DbClient = db): Promise<ConsultMember[]> {
  return client.select().from(consultMembers).where(eq(consultMembers.profileId, profileId)).orderBy(asc(consultMembers.sortOrder), asc(consultMembers.createdAt));
}

/** Free times of a service per IST day (from → to inclusive, at most 62 days). */
export async function serviceAvailability(
  input: { profile: ConsultProfile; service: ConsultService; fromKey: string; toKey: string; memberId?: string | null; attendees?: number },
  now: Date = new Date(),
): Promise<Record<string, FreeSlot[]>> {
  const members = membersForService(input.service, await profileMembers(input.profile.id));
  const from = istAt(input.fromKey, 0);
  const to = new Date(istAt(input.toKey, 0).getTime() + DAY);
  const calendars = await loadCalendars(members, from, to, { now });
  return freeSlots(calendars, serviceShape(input.service), rulesOf(input.profile, now), input.fromKey, input.toKey, { memberId: input.memberId, attendees: input.attendees });
}

/**
 * The next free time of each profile (its earliest over its active
 * services), looking `days` ahead. For listings: loaded in a few queries
 * for all profiles at once.
 */
export async function nextAvailableByProfile(profiles: readonly ConsultProfile[], days = 14, now: Date = new Date()): Promise<Map<string, { start: string; serviceId: string } | null>> {
  const out = new Map<string, { start: string; serviceId: string } | null>();
  if (!profiles.length) return out;
  const ids = profiles.map((p) => p.id);
  const [members, services] = await Promise.all([
    db.select().from(consultMembers).where(and(inArray(consultMembers.profileId, ids), eq(consultMembers.status, "ACTIVE"))),
    db.select().from(consultServices).where(and(inArray(consultServices.profileId, ids), eq(consultServices.status, "ACTIVE"))),
  ]);
  const from = now;
  const to = istAt(addDays(istDateKey(now), days + 1), 0);
  const calendars = await loadCalendars(members, from, to, { now });
  for (const p of profiles) {
    let best: { start: string; serviceId: string } | null = null;
    const pm = members.filter((m) => m.profileId === p.id);
    for (const s of services.filter((x) => x.profileId === p.id)) {
      const cals = calendars.filter((c) => membersForService(s, pm).some((m) => m.id === c.memberId));
      const slot = nextFreeSlot(cals, serviceShape(s), rulesOf(p, now), days);
      if (slot && (!best || slot.start < best.start)) best = { start: slot.start, serviceId: s.id };
    }
    out.set(p.id, best);
  }
  return out;
}

