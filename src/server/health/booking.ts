/**
 * GoKesari Health: booking a doctor or care provider for a person in the family, on top of the consult
 * engine (no double booking, holds, payments, refunds, reminders and settlement all come from there),
 * plus the clinic's day: Today list, token numbers, live queue, walk-ins booked on a patient's behalf.
 */
import { and, asc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";

import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { addDays, istAt, istDateKey } from "@/lib/consult/time";
import { CONSULT_MODES } from "@/lib/consult/constants";
import { SHARE_CHOICES } from "@/lib/health/constants";
import { requireFirmAccess } from "@/server/consult/access";
import { createBooking, type CreatedBooking } from "@/server/consult/bookings";
import { publicAvailability } from "@/server/consult/discovery";
import { completionCode } from "@/server/consult/otp";
import { db } from "@/server/db";
import {
  consultBookingMembers,
  consultBookings,
  consultMembers,
  consultServices,
  healthAppointmentLinks,
  healthClinicSettings,
  healthConsultations,
  healthPatients,
  healthPrescriptions,
  healthSuggestions,
  users,
} from "@/server/db/schema";
import { doctorStatus, patientAudience, requireHealthEnabled, requirePatientAccess, type HealthActor } from "./access";
import { applyBookingShareChoice } from "./consent";
import { ageText } from "./consultations";
import { publishHealthEvent } from "./events";
import { addTimeline } from "./timeline";

export const healthBookingInput = z.object({
  patientId: z.string().uuid(),
  serviceId: z.string().uuid(),
  memberId: z.string().uuid().nullish(),
  mode: z.enum(CONSULT_MODES),
  start: z.string().datetime({ offset: true }),
  reason: z.string().trim().max(1000).nullish(),
  shareRecords: z.enum(SHARE_CHOICES).default("OFF"),
  paymentMode: z.enum(["ONLINE", "PAY_AT_VISIT"]).nullish(),
  visitAddress: z.string().trim().max(400).nullish(),
  visitLatitude: z.number().min(-90).max(90).nullish(),
  visitLongitude: z.number().min(-180).max(180).nullish(),
  /** Book now from a doctor's suggestion / referral on a prescription. */
  suggestionId: z.string().uuid().nullish(),
  consent: z.literal(true, { message: "Please agree to share the details with the doctor." }),
});

/** Unverified doctors cannot be booked through Health (members of doctor categories only). */
async function assertBookable(serviceId: string, memberId: string | null | undefined): Promise<void> {
  const [svc] = await db.select().from(consultServices).where(eq(consultServices.id, serviceId));
  if (!svc) throw notFound("Service");
  const memberIds = memberId ? [memberId] : svc.memberIds?.length ? svc.memberIds : (await db.select({ id: consultMembers.id }).from(consultMembers).where(and(eq(consultMembers.profileId, svc.profileId), eq(consultMembers.status, "ACTIVE")))).map((m) => m.id);
  let anyOk = false;
  for (const id of memberIds) {
    const s = await doctorStatus(id);
    if (!s.isDoctor || s.verified) anyOk = true;
    else if (memberId) throw forbidden("This doctor is not verified yet and cannot be booked.");
  }
  if (!anyOk) throw forbidden("This doctor is not verified yet and cannot be booked.");
}

async function nextToken(memberId: string, start: Date): Promise<number> {
  const day = istDateKey(start);
  const [{ n }] = await db.execute<{ n: number }>(sql`
    select coalesce(max(l.token_number), 0)::int as n
      from health.appointment_links l
      join consult_booking_members bm on bm.booking_id = l.booking_id
      join consult_bookings b on b.id = l.booking_id
     where bm.member_id = ${memberId} and b.starts_at >= ${istAt(day, 0).toISOString()}::timestamptz and b.starts_at < ${istAt(addDays(day, 1), 0).toISOString()}::timestamptz`);
  return n + 1;
}

/** Books for a family member; links the booking to their record; applies the record-sharing choice. */
export async function createHealthBooking(raw: unknown, actor: HealthActor, now: Date = new Date()): Promise<CreatedBooking & { tokenNumber: number | null }> {
  await requireHealthEnabled();
  const input = healthBookingInput.parse(raw);
  const patient = await requirePatientAccess(input.patientId, actor);
  await assertBookable(input.serviceId, input.memberId);
  let suggestion: typeof healthSuggestions.$inferSelect | null = null;
  if (input.suggestionId) {
    [suggestion] = await db.select().from(healthSuggestions).where(eq(healthSuggestions.id, input.suggestionId));
    if (!suggestion || suggestion.patientId !== patient.id) throw notFound("Suggestion");
  }
  const age = ageText(patient.dateOfBirth, now);
  const created = await createBooking(
    {
      serviceId: input.serviceId,
      memberId: input.memberId ?? null,
      mode: input.mode,
      start: input.start,
      visitorName: patient.fullName,
      visitorPhone: patient.phone ?? null,
      visitorEmail: patient.email ?? null,
      visitorAge: age?.endsWith(" y") ? Number(age.slice(0, -2)) : age ? 0 : null,
      note: input.reason ?? null,
      visitAddress: input.visitAddress ?? null,
      visitLatitude: input.visitLatitude ?? null,
      visitLongitude: input.visitLongitude ?? null,
      paymentMode: input.paymentMode ?? null,
      consent: true,
    },
    actor,
    now,
  );
  const b = created.booking;
  const members = await db.select({ memberId: consultBookingMembers.memberId }).from(consultBookingMembers).where(eq(consultBookingMembers.bookingId, b.id));
  const [settings] = await db.select().from(healthClinicSettings).where(eq(healthClinicSettings.shopId, b.shopId));
  const token = settings?.tokenMode && members[0] ? await nextToken(members[0].memberId, b.startsAt) : null;
  // Follow-up if this doctor saw the patient within the clinic's follow-up window.
  const [recent] = members.length
    ? await db
        .select({ id: healthConsultations.id })
        .from(healthConsultations)
        .where(and(eq(healthConsultations.patientId, patient.id), inArray(healthConsultations.memberId, members.map((m) => m.memberId)), gte(healthConsultations.startedAt, new Date(now.getTime() - (settings?.followUpDays ?? 7) * 86_400_000))))
        .limit(1)
    : [];
  await db.transaction(async (tx) => {
    await tx.insert(healthAppointmentLinks).values({
      bookingId: b.id,
      patientId: patient.id,
      shareRecords: input.shareRecords,
      visitType: recent ? "FOLLOW_UP" : "NEW",
      reason: input.reason ?? null,
      tokenNumber: token,
      referralSuggestionId: suggestion?.type === "DOCTOR_REFERRAL" ? suggestion.id : null,
      sourceSuggestionId: suggestion?.id ?? null,
    });
    if (input.shareRecords !== "OFF") await applyBookingShareChoice(patient.id, members.map((m) => m.memberId), b.id, input.shareRecords, actor, tx);
    if (suggestion?.type === "DOCTOR_REFERRAL" && suggestion.shareRecords) await applyBookingShareChoice(patient.id, members.map((m) => m.memberId), b.id, "ON", actor, tx);
    if (suggestion) await tx.update(healthSuggestions).set({ status: "BOOKED", linkedBookingId: b.id, bookedAt: now }).where(eq(healthSuggestions.id, suggestion.id));
    await addTimeline(tx, {
      patientId: patient.id,
      occurredAt: b.startsAt,
      kind: "APPOINTMENT",
      title: `${b.serviceName} booked`,
      summary: `${b.mode === "VIDEO" ? "Video consultation" : b.mode === "HOME_VISIT" ? "Home visit" : "Clinic visit"}${token ? `, token ${token}` : ""}. Booking ${b.bookingNumber}.`,
      providerShopId: b.shopId,
      providerMemberId: members[0]?.memberId ?? null,
      refType: "booking",
      refId: b.id,
      meta: { bookingNumber: b.bookingNumber, status: b.status },
    });
    await publishHealthEvent({ name: "appointment.booked", userIds: patientAudience(patient), shopId: b.shopId, subjectId: b.id, payload: { bookingId: b.id, status: b.status, token } }, tx);
    if (suggestion) await publishHealthEvent({ name: "suggestion.booked", userIds: patientAudience(patient), shopId: b.shopId, subjectId: suggestion.id, payload: { suggestionId: suggestion.id, bookingId: b.id } }, tx);
  });
  // Home-care visits and Prime analytics / pay-per-booking hang off the new booking (never block it).
  try {
    await (await import("./care")).onHealthBookingCreated(b, patient);
    await (await import("./prime")).onHealthBookingCreated(b);
  } catch (error) {
    console.error("[health] booking follow-ups failed", b.id, error);
  }
  return { ...created, tokenNumber: token };
}

/** The check-in QR the patient shows at the clinic: GKH:<booking>:<code>. */
export async function checkInQrPayload(bookingId: string, actor: HealthActor): Promise<string> {
  const [b] = await db.select().from(consultBookings).where(eq(consultBookings.id, bookingId));
  if (!b) throw notFound("Booking");
  const [link] = await db.select().from(healthAppointmentLinks).where(eq(healthAppointmentLinks.bookingId, b.id));
  if (b.customerId !== actor.id) {
    if (!link) throw notFound("Booking");
    await requirePatientAccess(link.patientId, actor);
  }
  return `GKH:${b.id}:${completionCode(b.id, b.otpSalt ?? "")}`;
}

/* ------------------------------------------------------------ the clinic's day */

export interface TodayRow {
  bookingId: string;
  bookingNumber: string;
  startsAt: Date;
  endsAt: Date;
  status: string;
  mode: string;
  patientId: string | null;
  patientName: string;
  age: string | null;
  gender: string | null;
  visitType: string;
  reason: string | null;
  paymentStatus: string;
  paymentMode: string;
  feePaise: number;
  arrivedAt: Date | null;
  calledAt: Date | null;
  tokenNumber: number | null;
  queueOrder: number | null;
  memberId: string;
  memberName: string;
  walkIn: boolean;
  consultationId: string | null;
  consultationStatus: string | null;
  prescriptionId: string | null;
  referralNote: string | null;
  meetingUrl: string | null;
}

/** Today (or any day) for a clinic: everyone booked, in queue order, with check-in and payment state. */
export async function clinicDay(shopId: string, actor: HealthActor, dateKey: string = istDateKey(new Date()), memberFilter?: string | null): Promise<TodayRow[]> {
  const access = await requireFirmAccess(shopId, actor, "bookings");
  const from = istAt(dateKey, 0);
  const to = istAt(addDays(dateKey, 1), 0);
  const rows = await db
    .select({ b: consultBookings, bm: consultBookingMembers, memberName: consultMembers.name, link: healthAppointmentLinks, p: healthPatients, c: healthConsultations })
    .from(consultBookings)
    .innerJoin(consultBookingMembers, eq(consultBookingMembers.bookingId, consultBookings.id))
    .innerJoin(consultMembers, eq(consultMembers.id, consultBookingMembers.memberId))
    .leftJoin(healthAppointmentLinks, eq(healthAppointmentLinks.bookingId, consultBookings.id))
    .leftJoin(healthPatients, eq(healthPatients.id, healthAppointmentLinks.patientId))
    .leftJoin(healthConsultations, eq(healthConsultations.bookingId, consultBookings.id))
    .where(
      and(
        eq(consultBookings.shopId, shopId),
        gte(consultBookings.startsAt, from),
        lt(consultBookings.startsAt, to),
        inArray(consultBookings.status, ["CONFIRMED", "PENDING_APPROVAL", "PENDING_PAYMENT", "COMPLETED", "NO_SHOW", "CANCELLED"]),
        access.role === "MEMBER" && access.memberId ? eq(consultBookingMembers.memberId, access.memberId) : memberFilter ? eq(consultBookingMembers.memberId, memberFilter) : undefined,
      ),
    )
    .orderBy(asc(consultBookings.startsAt));
  const consultationIds = rows.map((r) => r.c?.id).filter((v): v is string => Boolean(v));
  const rxs = consultationIds.length ? await db.select({ id: healthPrescriptions.id, consultationId: healthPrescriptions.consultationId }).from(healthPrescriptions).where(and(inArray(healthPrescriptions.consultationId, consultationIds), eq(healthPrescriptions.status, "ISSUED"))) : [];
  const referralIds = rows.map((r) => r.link?.referralSuggestionId).filter((v): v is string => Boolean(v));
  const referrals = referralIds.length ? await db.select({ id: healthSuggestions.id, details: healthSuggestions.details }).from(healthSuggestions).where(inArray(healthSuggestions.id, referralIds)) : [];
  const out = rows.map((r) => ({
    bookingId: r.b.id,
    bookingNumber: r.b.bookingNumber,
    startsAt: r.b.startsAt,
    endsAt: r.b.endsAt,
    status: r.b.status,
    mode: r.b.mode,
    patientId: r.p?.id ?? null,
    patientName: r.p?.fullName ?? r.b.visitorName,
    age: r.p ? ageText(r.p.dateOfBirth) : r.b.visitorAge != null ? `${r.b.visitorAge} y` : null,
    gender: r.p?.gender ?? null,
    visitType: r.link?.visitType ?? "NEW",
    reason: r.link?.reason ?? r.b.customerNote,
    paymentStatus: r.b.paymentStatus,
    paymentMode: r.b.paymentMode,
    feePaise: r.b.feePaise,
    arrivedAt: r.b.arrivedAt,
    calledAt: r.link?.calledAt ?? null,
    tokenNumber: r.link?.tokenNumber ?? null,
    queueOrder: r.link?.queueOrder ?? null,
    memberId: r.bm.memberId,
    memberName: r.memberName,
    walkIn: r.link?.walkIn ?? false,
    consultationId: r.c?.id ?? null,
    consultationStatus: r.c?.status ?? null,
    prescriptionId: rxs.find((x) => x.consultationId === r.c?.id)?.id ?? null,
    // The referred doctor sees the referral note when the patient books (never any money).
    referralNote: r.link?.referralSuggestionId ? String((referrals.find((x) => x.id === r.link!.referralSuggestionId)?.details as { note?: string; text?: string } | undefined)?.note ?? (referrals.find((x) => x.id === r.link!.referralSuggestionId)?.details as { text?: string } | undefined)?.text ?? "") : null,
    meetingUrl: r.b.meetingUrl,
  }));
  // Queue order: an explicit order first, then token, then time.
  return out.sort((a, b) => (a.queueOrder ?? 1e9) - (b.queueOrder ?? 1e9) || (a.tokenNumber ?? 1e9) - (b.tokenNumber ?? 1e9) || a.startsAt.getTime() - b.startsAt.getTime());
}

/** Calls the next patient (or a given one): marks called, publishes queue.updated (patients' queue screens move). */
export async function callPatient(shopId: string, bookingId: string, actor: HealthActor, now: Date = new Date()): Promise<void> {
  await requireFirmAccess(shopId, actor, "bookings");
  const [b] = await db.select().from(consultBookings).where(eq(consultBookings.id, bookingId));
  if (!b || b.shopId !== shopId) throw notFound("Booking");
  await db.update(healthAppointmentLinks).set({ calledAt: now }).where(eq(healthAppointmentLinks.bookingId, bookingId));
  await publishHealthEvent({ name: "queue.updated", shopId, userIds: [b.customerId], subjectId: bookingId, payload: { calledBookingId: bookingId } });
}

/** Saves a new queue order (booking ids, first = next). */
export async function reorderQueue(shopId: string, bookingIds: string[], actor: HealthActor): Promise<void> {
  await requireFirmAccess(shopId, actor, "bookings");
  const rows = await db.select({ id: consultBookings.id, shopId: consultBookings.shopId, customerId: consultBookings.customerId }).from(consultBookings).where(inArray(consultBookings.id, bookingIds));
  if (rows.some((r) => r.shopId !== shopId)) throw forbidden("Those bookings are not at this clinic.");
  await db.transaction(async (tx) => {
    for (const [i, id] of bookingIds.entries()) await tx.update(healthAppointmentLinks).set({ queueOrder: i + 1 }).where(eq(healthAppointmentLinks.bookingId, id));
  });
  await publishHealthEvent({ name: "queue.updated", shopId, userIds: rows.map((r) => r.customerId), payload: { reordered: bookingIds.length } });
}

export interface QueuePosition {
  tokenNumber: number | null;
  nowServing: number | null;
  ahead: number;
  status: string;
}

/** The patient's live queue position for a booking today. */
export async function queuePosition(bookingId: string, actor: HealthActor): Promise<QueuePosition> {
  const [b] = await db.select().from(consultBookings).where(eq(consultBookings.id, bookingId));
  if (!b) throw notFound("Booking");
  const [link] = await db.select().from(healthAppointmentLinks).where(eq(healthAppointmentLinks.bookingId, bookingId));
  if (b.customerId !== actor.id) {
    if (!link) throw notFound("Booking");
    await requirePatientAccess(link.patientId, actor);
  }
  const [bm] = await db.select({ memberId: consultBookingMembers.memberId }).from(consultBookingMembers).where(eq(consultBookingMembers.bookingId, b.id));
  const day = istDateKey(b.startsAt);
  const rows = bm
    ? await db
        .select({ id: consultBookings.id, status: consultBookings.status, startsAt: consultBookings.startsAt, token: healthAppointmentLinks.tokenNumber, calledAt: healthAppointmentLinks.calledAt, order: healthAppointmentLinks.queueOrder, completedAt: consultBookings.completedAt })
        .from(consultBookings)
        .innerJoin(consultBookingMembers, eq(consultBookingMembers.bookingId, consultBookings.id))
        .leftJoin(healthAppointmentLinks, eq(healthAppointmentLinks.bookingId, consultBookings.id))
        .where(and(eq(consultBookingMembers.memberId, bm.memberId), gte(consultBookings.startsAt, istAt(day, 0)), lt(consultBookings.startsAt, istAt(addDays(day, 1), 0)), inArray(consultBookings.status, ["CONFIRMED", "COMPLETED"])))
    : [];
  const sorted = rows.sort((x, y) => (x.order ?? 1e9) - (y.order ?? 1e9) || (x.token ?? 1e9) - (y.token ?? 1e9) || x.startsAt.getTime() - y.startsAt.getTime());
  const called = sorted.filter((r) => r.calledAt).sort((x, y) => y.calledAt!.getTime() - x.calledAt!.getTime());
  const idx = sorted.findIndex((r) => r.id === b.id);
  const ahead = sorted.slice(0, Math.max(0, idx)).filter((r) => r.status === "CONFIRMED" && !r.calledAt).length;
  return { tokenNumber: link?.tokenNumber ?? null, nowServing: called[0]?.token ?? null, ahead, status: b.status };
}

export const walkInInput = z.object({
  memberId: z.string().uuid(),
  serviceId: z.string().uuid(),
  /** The patient's GoKesari mobile number or e-mail (they sign in with it to see their record). */
  contact: z.string().trim().min(5).max(200),
  patientName: z.string().trim().min(2).max(120),
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullish(),
  reason: z.string().trim().max(1000).nullish(),
});

/**
 * A walk-in, or a booking made by the clinic on a patient's behalf: the earliest free time today with the
 * doctor, booked for the GoKesari account with that mobile number / e-mail, token assigned.
 */
export async function addWalkIn(shopId: string, raw: unknown, actor: HealthActor, now: Date = new Date()): Promise<{ bookingId: string; tokenNumber: number | null; start: string }> {
  const input = walkInInput.parse(raw);
  await requireFirmAccess(shopId, actor, "bookings");
  const contact = input.contact.toLowerCase();
  const digits = contact.replace(/\D/g, "").slice(-10);
  const [u] = await db
    .select({ id: users.id, role: users.role, name: users.name })
    .from(users)
    .where(contact.includes("@") ? eq(sql`lower(${users.email})`, contact) : sql`right(regexp_replace(coalesce(${users.phone}, ''), '\\D', '', 'g'), 10) = ${digits}`)
    .limit(1);
  if (!u) throw validationFailed("No GoKesari account has that mobile number / e-mail. Ask the patient to sign in to GoKesari once (one-time code), then add them.", { fields: { contact: "Not found." } });
  const slots = await publicAvailability({ serviceId: input.serviceId, memberId: input.memberId, from: istDateKey(now), days: 1 }, now);
  const first = Object.values(slots.days).flat().sort((x, y) => x.start.localeCompare(y.start))[0];
  if (!first) throw conflict("No free time is left today with this doctor. Add a later booking from the calendar, or free a slot.");
  const patientActor: HealthActor = { id: u.id, role: u.role, name: u.name };
  // The patient's record: an existing one with that name under their account, else a new one.
  const family = await db.select().from(healthPatients).where(and(eq(healthPatients.accountUserId, u.id), isNull(healthPatients.hiddenAt)));
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
  let patient = family.find((p) => norm(p.fullName) === norm(input.patientName)) ?? null;
  if (!patient) {
    const self = family.find((p) => p.relation === "SELF");
    [patient] = await db
      .insert(healthPatients)
      .values({ accountUserId: u.id, linkedUserId: self ? null : u.id, relation: self ? "OTHER" : "SELF", fullName: input.patientName, dateOfBirth: input.dateOfBirth ?? null, recordStartAt: now })
      .returning();
  }
  // A walk-in pays at the counter (an online-only service cannot take walk-ins: createBooking refuses it).
  const created = await createBooking({ serviceId: input.serviceId, memberId: input.memberId, mode: "IN_PERSON", start: first.start, visitorName: patient.fullName, note: input.reason ?? null, paymentMode: "PAY_AT_VISIT", consent: true }, patientActor, now);
  const b = created.booking;
  await db.update(consultBookings).set({ bookedBy: actor.id }).where(eq(consultBookings.id, b.id));
  const token = await nextToken(input.memberId, b.startsAt);
  await db.insert(healthAppointmentLinks).values({ bookingId: b.id, patientId: patient.id, reason: input.reason ?? null, tokenNumber: token, walkIn: true }).onConflictDoNothing();
  await addTimeline(db, { patientId: patient.id, occurredAt: b.startsAt, kind: "APPOINTMENT", title: `${b.serviceName} (walk-in)`, summary: `Token ${token}. Booking ${b.bookingNumber}.`, providerShopId: shopId, providerMemberId: input.memberId, refType: "booking", refId: b.id });
  await publishHealthEvent({ name: "appointment.booked", userIds: patientAudience(patient), shopId, subjectId: b.id, payload: { bookingId: b.id, walkIn: true, token } });
  return { bookingId: b.id, tokenNumber: token, start: first.start };
}

/** Bookings the patient has through Health (for My Health → Appointments). */
export async function patientAppointments(patientId: string, actor: HealthActor) {
  const p = await requirePatientAccess(patientId, actor);
  return db
    .select({ b: consultBookings, link: healthAppointmentLinks })
    .from(healthAppointmentLinks)
    .innerJoin(consultBookings, eq(consultBookings.id, healthAppointmentLinks.bookingId))
    .where(eq(healthAppointmentLinks.patientId, p.id))
    .orderBy(sql`${consultBookings.startsAt} desc`)
    .limit(200);
}
