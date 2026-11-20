/**
 * Consultant appointments: making and changing bookings
 * (docs/consult-booking-2026-11).
 *
 * Double booking cannot happen:
 *   1. every write that takes calendar time locks the members' rows
 *      (SELECT … FOR UPDATE, in id order), releases lapsed holds, and checks
 *      the time again from the database — never trusting what a browser sent;
 *   2. consult_booking_members' exclusion constraint refuses two active rows
 *      of one member whose times overlap (unless they share a group session
 *      or a multi-person slot, whose capacity step 1 checks under the lock).
 *
 * Online payment: the time is held (PENDING_PAYMENT) for
 * rule consultBooking.holdMinutes while the customer pays; the payment
 * intent is created after the hold commits (no gateway call inside a
 * transaction). Capture confirms the booking (payments.ts); a failed or
 * abandoned payment frees the time.
 */
import { randomBytes } from "node:crypto";

import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import { z } from "zod";

import { CONSULT_ACTIVE_STATUSES, CONSULT_CONSENT_VERSION, CONSULT_MODES, type ConsultBookingStatus, type ConsultMode, type ConsultOfflineMethod } from "@/lib/consult/constants";
import { cancellationRefund, customerMayCancel, customerMayReschedule, noShowRefund, type CancelSide, type PolicyShape } from "@/lib/consult/policy";
import { pickMembers, shareKeyFor } from "@/lib/consult/slots";
import { addDays, istAt, istDateKey } from "@/lib/consult/time";
import { AppError, conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { parsePhone } from "@/lib/phone";
import { db, type DbClient } from "@/server/db";
import {
  consultBookingEvents,
  consultBookingMembers,
  consultBookings,
  consultCategories,
  consultMembers,
  consultProfiles,
  consultServices,
  shops,
  supportTickets,
  users,
  type ConsultBooking,
  type ConsultMember,
  type ConsultProfile,
  type ConsultService,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { getRule } from "@/server/services/settings";
import { bookingViewer, requireConsultEnabled, type ConsultActor } from "./access";
import { loadCalendars, membersForService, rulesOf, serviceShape } from "./availability";
import { cancelReminders, scheduleReminders, tellBooking } from "./notify";
import { completionCodeMatches, newOtpSalt } from "./otp";
import { issueReceipt, refundBookingMoney, settleBooking, settleOfflineCommission, startBookingPayment } from "./payments";

const MIN = 60_000;

function pgCode(error: unknown): string | undefined {
  const e = error as { code?: unknown; cause?: { code?: unknown } } | null;
  return String(e?.cause?.code ?? e?.code ?? "") || undefined;
}

const slotTaken = () => conflict("That time was just taken. Please choose another time.", { reason: "SLOT_TAKEN" });

/* ------------------------------------------------------------------ input */

export const bookingInput = z.object({
  serviceId: z.string().uuid(),
  /** Null / absent: any available member of the firm. */
  memberId: z.string().uuid().nullish(),
  mode: z.enum(CONSULT_MODES),
  start: z.string().datetime({ offset: true }),
  attendees: z.number().int().min(1).max(500).default(1),
  visitorName: z.string().trim().min(2, "Enter the visitor's name.").max(120),
  visitorPhone: z.string().trim().max(20).nullish(),
  visitorEmail: z.string().trim().email().max(200).nullish().or(z.literal("")),
  visitorAge: z.number().int().min(0).max(120).nullish(),
  note: z.string().trim().max(2000).nullish(),
  visitAddress: z.string().trim().max(400).nullish(),
  visitLatitude: z.number().min(-90).max(90).nullish(),
  visitLongitude: z.number().min(-180).max(180).nullish(),
  paymentMode: z.enum(["ONLINE", "PAY_AT_VISIT"]).nullish(),
  consent: z.literal(true, { message: "Please agree to share your details with the consultant." }),
});
export type BookingInput = z.input<typeof bookingInput>;

/* -------------------------------------------------------------- helpers */

async function addEvent(
  client: DbClient,
  booking: Pick<ConsultBooking, "id">,
  kind: string,
  input: { from?: string | null; to?: string | null; actor?: ConsultActor | null; note?: string | null; meta?: Record<string, unknown> } = {},
): Promise<void> {
  await client.insert(consultBookingEvents).values({
    bookingId: booking.id,
    kind,
    fromStatus: input.from ?? null,
    toStatus: input.to ?? null,
    actorId: input.actor?.id ?? null,
    actorRole: input.actor?.role ?? (input.actor === null ? "SYSTEM" : null),
    note: input.note?.slice(0, 1000) ?? null,
    meta: input.meta ?? {},
  });
  // GoKesari Health (docs/health/): every booking change refreshes the clinic's and the patient's live
  // screens at once (server-sent events; ids and status only). Inside a transaction it waits for the commit.
  const live = booking as Partial<Pick<ConsultBooking, "shopId" | "customerId">>;
  if (live.shopId) {
    const { pushLiveOnly } = await import("@/server/health/events");
    pushLiveOnly({ name: "appointment.changed", shopId: live.shopId, userIds: [live.customerId], subjectId: booking.id, payload: { kind, to: input.to ?? null }, delayMs: client === db ? 0 : 400 });
  }
}

export function policyOf(p: Pick<ConsultProfile, "freeCancelHours" | "lateCancelRefundPct" | "noShowRefundPct" | "rescheduleMinHours" | "maxReschedules" | "policyNote">) {
  return {
    freeCancelHours: p.freeCancelHours,
    lateCancelRefundPct: p.lateCancelRefundPct,
    noShowRefundPct: p.noShowRefundPct,
    rescheduleMinHours: p.rescheduleMinHours,
    maxReschedules: p.maxReschedules,
    note: p.policyNote,
  };
}

function bookedPolicy(b: ConsultBooking): PolicyShape {
  const p = b.policy as Partial<PolicyShape>;
  return {
    freeCancelHours: p.freeCancelHours ?? 24,
    lateCancelRefundPct: p.lateCancelRefundPct ?? 50,
    noShowRefundPct: p.noShowRefundPct ?? 0,
    rescheduleMinHours: p.rescheduleMinHours ?? 4,
    maxReschedules: p.maxReschedules ?? 2,
  };
}

async function lockMembers(client: DbClient, ids: readonly string[]): Promise<ConsultMember[]> {
  if (!ids.length) return [];
  return client.select().from(consultMembers).where(inArray(consultMembers.id, [...ids])).orderBy(asc(consultMembers.id)).for("update");
}

/** Releases holds of these members whose time ran out (inside the caller's transaction, under the member locks). */
async function expireHoldsFor(client: DbClient, memberIds: readonly string[], now: Date): Promise<string[]> {
  if (!memberIds.length) return [];
  const lapsed = await client
    .selectDistinct({ id: consultBookings.id })
    .from(consultBookings)
    .innerJoin(consultBookingMembers, eq(consultBookingMembers.bookingId, consultBookings.id))
    .where(and(eq(consultBookings.status, "PENDING_PAYMENT"), lt(consultBookings.holdExpiresAt, now), inArray(consultBookingMembers.memberId, [...memberIds]), eq(consultBookingMembers.active, true)));
  for (const { id } of lapsed) await expireOne(client, id, now, "The payment was not completed in time; the time was released.");
  return lapsed.map((l) => l.id);
}

async function expireOne(client: DbClient, bookingId: string, now: Date, note: string): Promise<ConsultBooking | null> {
  const [b] = await client
    .update(consultBookings)
    .set({ status: "EXPIRED", holdExpiresAt: null, updatedAt: now })
    .where(and(eq(consultBookings.id, bookingId), eq(consultBookings.status, "PENDING_PAYMENT")))
    .returning();
  if (!b) return null;
  await client.update(consultBookingMembers).set({ active: false }).where(eq(consultBookingMembers.bookingId, bookingId));
  await addEvent(client, b, "EXPIRED", { from: "PENDING_PAYMENT", to: "EXPIRED", actor: null, note });
  return b;
}

/** The every-minute job: holds whose time ran out are released. */
export async function expireLapsedHolds(now: Date = new Date()): Promise<{ expired: number }> {
  const due = await db
    .select({ id: consultBookings.id })
    .from(consultBookings)
    .where(and(eq(consultBookings.status, "PENDING_PAYMENT"), lt(consultBookings.holdExpiresAt, now)))
    .limit(200);
  let expired = 0;
  for (const { id } of due) {
    const b = await db.transaction((tx) => expireOne(tx, id, now, "The payment was not completed in time; the time was released."));
    if (b) expired += 1;
  }
  return { expired };
}

function newBookingNumber(seq: number, now: Date): string {
  const key = istDateKey(now);
  return `CB${key.slice(2, 4)}${key.slice(5, 7)}-${String(seq).padStart(6, "0")}`;
}

function meetingUrlFor(bookingNumber: string): string {
  return `https://meet.jit.si/GoKesari-${bookingNumber}-${randomBytes(4).toString("hex")}`;
}

async function loadBookable(serviceId: string, client: DbClient = db): Promise<{ service: ConsultService; profile: ConsultProfile; members: ConsultMember[] }> {
  const [row] = await client
    .select({ service: consultServices, profile: consultProfiles, shopStatus: shops.status, shopDeleted: shops.deletedAt })
    .from(consultServices)
    .innerJoin(consultProfiles, eq(consultProfiles.id, consultServices.profileId))
    .innerJoin(shops, eq(shops.id, consultProfiles.shopId))
    .where(eq(consultServices.id, serviceId));
  if (!row || row.service.status !== "ACTIVE") throw notFound("Service");
  if (row.profile.status !== "LIVE" || row.profile.verification === "REJECTED" || row.shopStatus !== "APPROVED" || row.shopDeleted) {
    throw conflict("This consultant is not taking bookings right now.", { reason: "NOT_BOOKABLE" });
  }
  const members = await client.select().from(consultMembers).where(eq(consultMembers.profileId, row.profile.id));
  return { service: row.service, profile: row.profile, members };
}

/* ------------------------------------------------------------------ create */

export interface CreatedBooking {
  booking: ConsultBooking;
  /** Online payment: where to send the customer to pay. */
  checkoutUrl: string | null;
  intentId: string | null;
}

export async function createBooking(raw: unknown, actor: ConsultActor, now: Date = new Date()): Promise<CreatedBooking> {
  await requireConsultEnabled();
  const input = bookingInput.parse(raw);
  const rule = await getRule("consultBooking");
  const { service, profile, members } = await loadBookable(input.serviceId);
  if (!service.modes.includes(input.mode)) throw validationFailed("This service is not offered that way. Choose another mode.");
  if (input.mode === "HOME_VISIT" && !input.visitAddress) throw validationFailed("Enter the address for the home visit.");
  if (service.bookingKind === "GROUP" && input.attendees > service.capacity) throw validationFailed(`At most ${service.capacity} people can join this session.`);
  if (service.bookingKind !== "GROUP" && input.attendees > 10) throw validationFailed("At most 10 people can come to one appointment.");
  const parsedPhone = input.visitorPhone ? parsePhone("+91", input.visitorPhone.replace(/^\+91/, "")) : null;
  if (parsedPhone && !parsedPhone.ok) throw validationFailed("Enter a valid 10-digit mobile number.");
  const phone = parsedPhone?.ok ? parsedPhone.e164 : null;
  const start = new Date(input.start);
  if (Number.isNaN(start.getTime())) throw validationFailed("Choose a time.");
  const startMs = start.getTime();
  const eligible = membersForService(service, members);
  if (input.memberId && !eligible.some((m) => m.id === input.memberId)) throw validationFailed("That consultant does not offer this service.");
  if (!eligible.length) throw conflict("No consultant offers this service right now.");

  // Money.
  const units = service.bookingKind === "GROUP" ? input.attendees : 1;
  const feePaise = service.feePaise * units;
  let paymentMode: "FREE" | "ONLINE" | "PAY_AT_VISIT";
  if (service.feeType === "FREE" || feePaise === 0) paymentMode = "FREE";
  else if (service.feeType === "DEPOSIT") paymentMode = "ONLINE";
  else {
    const wanted = input.paymentMode ?? (service.payOnline ? "ONLINE" : "PAY_AT_VISIT");
    if (wanted === "ONLINE" && !service.payOnline) throw validationFailed("This consultant takes payment at the visit only.");
    if (wanted === "PAY_AT_VISIT" && !service.payAtVisit) throw validationFailed("This consultant asks for payment online when booking.");
    paymentMode = wanted;
  }
  const onlineDue = paymentMode === "ONLINE" ? (service.feeType === "DEPOSIT" ? service.depositPaise * units : feePaise) : 0;
  const [category] = service.categoryId ? await db.select().from(consultCategories).where(eq(consultCategories.id, service.categoryId)) : [];
  const commissionBp = category?.commissionBp ?? rule.defaultCommissionBp;
  const [shop] = await db.select({ gstin: shops.gstin, gstType: shops.gstRegistrationType }).from(shops).where(eq(shops.id, profile.shopId));
  const gstRateBp = shop?.gstType === "REGULAR" && shop.gstin ? service.gstRateBp : 0;
  const [customer] = await db.select({ email: users.email, phone: users.phone }).from(users).where(eq(users.id, actor.id));

  const awaitingPay = paymentMode === "ONLINE";
  const status: ConsultBookingStatus = awaitingPay ? "PENDING_PAYMENT" : profile.manualApproval ? "PENDING_APPROVAL" : "CONFIRMED";
  const paymentStatus = paymentMode === "FREE" ? "NOT_REQUIRED" : paymentMode === "ONLINE" ? "PENDING" : "DUE";

  let booking: ConsultBooking;
  try {
    booking = await db.transaction(async (tx) => {
      const locked = await lockMembers(tx, eligible.map((m) => m.id));
      await expireHoldsFor(tx, locked.map((m) => m.id), now);
      const dayFrom = istAt(istDateKey(start), 0);
      const dayTo = new Date(istAt(addDays(istDateKey(start), 1), 0).getTime() + 12 * 60 * MIN);
      const calendars = await loadCalendars(locked.filter((m) => m.status === "ACTIVE"), dayFrom, dayTo, { client: tx, now });
      const chosen = pickMembers(calendars, serviceShape(service), startMs, rulesOf(profile, now), { memberId: input.memberId, attendees: input.attendees });
      if (!chosen) throw slotTaken();
      const [{ seq }] = await tx.execute<{ seq: number }>(sql`select nextval('consult_booking_number_seq')::int as seq`);
      const number = newBookingNumber(Number(seq), now);
      const endsAt = new Date(startMs + service.durationMinutes * MIN);
      const [created] = await tx
        .insert(consultBookings)
        .values({
          bookingNumber: number,
          shopId: profile.shopId,
          profileId: profile.id,
          serviceId: service.id,
          categoryId: service.categoryId,
          customerId: actor.id,
          bookingKind: service.bookingKind,
          mode: input.mode,
          startsAt: start,
          endsAt,
          status,
          attendees: input.attendees,
          anyMember: !input.memberId,
          visitorName: input.visitorName,
          visitorPhone: phone ?? customer?.phone ?? null,
          visitorEmail: input.visitorEmail || customer?.email || null,
          visitorAge: input.visitorAge ?? null,
          customerNote: input.note ?? null,
          visitAddress: input.mode === "HOME_VISIT" ? input.visitAddress ?? null : null,
          visitLatitude: input.mode === "HOME_VISIT" ? input.visitLatitude ?? null : null,
          visitLongitude: input.mode === "HOME_VISIT" ? input.visitLongitude ?? null : null,
          meetingUrl: input.mode === "VIDEO" ? meetingUrlFor(number) : null,
          serviceName: service.name,
          durationMinutes: service.durationMinutes,
          feeType: service.feeType,
          feePaise,
          onlineDuePaise: onlineDue,
          gstRateBp,
          paymentMode,
          paymentStatus,
          commissionBp,
          policy: policyOf(profile),
          holdExpiresAt: awaitingPay ? new Date(now.getTime() + rule.holdMinutes * MIN) : null,
          otpSalt: newOtpSalt(),
          confirmedAt: status === "CONFIRMED" ? now : null,
          consentAt: now,
          consentVersion: CONSULT_CONSENT_VERSION,
        })
        .returning();
      const byId = new Map(locked.map((m) => [m.id, m]));
      await tx.insert(consultBookingMembers).values(
        chosen.map((memberId) => {
          const m = byId.get(memberId)!;
          return {
            bookingId: created.id,
            memberId,
            startsAt: start,
            blocksUntil: new Date(endsAt.getTime() + m.bufferMinutes * MIN),
            shareKey: shareKeyFor(service, { memberId, maxPerSlot: m.maxPerSlot }, startMs, created.id),
          };
        }),
      );
      await addEvent(tx, created, "CREATED", { to: status, actor, meta: { members: chosen, paymentMode, feePaise, onlineDue } });
      await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.CONSULT_BOOKING_CHANGED, entityType: "consult_booking", entityId: created.id, newValue: { number, status, start, members: chosen, paymentMode, feePaise } }, tx);
      if (status === "CONFIRMED") {
        await scheduleReminders(created, tx, now);
        await tellBooking(created, "CONFIRMED", {}, tx);
      } else if (status === "PENDING_APPROVAL") {
        await tellBooking(created, "PENDING_APPROVAL", {}, tx);
      }
      return created;
    });
  } catch (error) {
    if (pgCode(error) === "23P01") throw slotTaken();
    throw error;
  }

  if (!awaitingPay) return { booking, checkoutUrl: null, intentId: null };
  try {
    const started = await startBookingPayment(booking, "ADVANCE", actor);
    return { booking: started.booking, checkoutUrl: started.checkoutUrl, intentId: started.intentId };
  } catch (error) {
    // The gateway refused (or is not set up): free the time at once.
    await db.transaction((tx) => expireOne(tx, booking.id, new Date(), "Online payment could not be started."));
    throw error;
  }
}

/* ----------------------------------------------------------- shared loads */

async function lockBooking(client: DbClient, bookingId: string): Promise<ConsultBooking> {
  const [b] = await client.select().from(consultBookings).where(eq(consultBookings.id, bookingId)).for("update");
  if (!b) throw notFound("Booking");
  return b;
}

async function loadBooking(bookingId: string): Promise<ConsultBooking> {
  const [b] = await db.select().from(consultBookings).where(eq(consultBookings.id, bookingId));
  if (!b) throw notFound("Booking");
  return b;
}

function sideOf(viewer: "CUSTOMER" | "FIRM" | "STAFF"): CancelSide {
  return viewer === "CUSTOMER" ? "CUSTOMER" : viewer === "STAFF" ? "ADMIN" : "CONSULTANT";
}

async function requireFirmActor(booking: ConsultBooking, actor: ConsultActor) {
  const v = await bookingViewer(booking, actor);
  if (v.viewer === "CUSTOMER" && !v.firm) throw forbidden("Only the consultant can do this.");
  return v.viewer === "CUSTOMER" ? { viewer: "FIRM" as const, firm: v.firm } : v;
}

/* ------------------------------------------------------------------ cancel */

export async function cancelBooking(bookingId: string, actor: ConsultActor, reason: string | null, now: Date = new Date()): Promise<ConsultBooking> {
  const before = await loadBooking(bookingId);
  const { viewer } = await bookingViewer(before, actor);
  const by = sideOf(viewer);
  if (!(CONSULT_ACTIVE_STATUSES as readonly string[]).includes(before.status)) throw conflict("This booking can no longer be cancelled.");
  if (by === "CUSTOMER") {
    const ok = customerMayCancel({ startsAt: before.startsAt, now });
    if (!ok.ok) throw conflict(ok.reason!);
  } else if (!reason?.trim()) throw validationFailed("Give the customer a reason for cancelling.");
  const result = await db.transaction(async (tx) => {
    const b = await lockBooking(tx, bookingId);
    if (!(CONSULT_ACTIVE_STATUSES as readonly string[]).includes(b.status)) throw conflict("This booking can no longer be cancelled.");
    const refund = cancellationRefund(bookedPolicy(b), { paidOnlinePaise: b.paidOnlinePaise, refundedPaise: b.refundPaise, startsAt: b.startsAt, now, by });
    const [updated] = await tx
      .update(consultBookings)
      .set({ status: "CANCELLED", cancelledAt: now, cancelledBy: by, cancelReason: reason?.trim().slice(0, 500) || null, holdExpiresAt: null, updatedAt: now })
      .where(eq(consultBookings.id, b.id))
      .returning();
    await tx.update(consultBookingMembers).set({ active: false }).where(eq(consultBookingMembers.bookingId, b.id));
    await cancelReminders(b.id, tx, now);
    await addEvent(tx, b, "CANCELLED", { from: b.status, to: "CANCELLED", actor, note: reason, meta: { by, refundPaise: refund.refundPaise, pct: refund.pct } });
    let after = updated;
    const refundIds: string[] = [];
    if (refund.refundPaise > 0) {
      const r = await refundBookingMoney(tx, after, refund.refundPaise, `${b.bookingNumber}: ${refund.reason}`, "cancel");
      after = r.booking;
      refundIds.push(...r.refundIds);
    }
    after = await settleBooking(tx, after, now);
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.CONSULT_BOOKING_CHANGED, entityType: "consult_booking", entityId: b.id, previousValue: { status: b.status }, newValue: { status: "CANCELLED", by, refund } }, tx);
    await tellBooking(after, "CANCELLED", { note: refund.refundPaise > 0 ? `${refund.reason}` : reason, by: by === "CUSTOMER" ? "you" : by === "ADMIN" ? "GoKesari" : "the consultant" }, tx);
    if (refund.refundPaise > 0) await tellBooking(after, "REFUND", { amountPaise: refund.refundPaise }, tx);
    return { booking: after, refundIds };
  });
  await submitRefunds(result.refundIds);
  return result.booking;
}

/** Sends recorded refunds to the gateway after the commit; the reconciliation job retries any that fail now. */
async function submitRefunds(ids: readonly string[]): Promise<void> {
  if (!ids.length) return;
  const { submitRefund } = await import("@/server/payments/intents");
  for (const id of ids) await submitRefund(id).catch((e) => console.error("[consult] refund submit deferred to the job", id, e instanceof Error ? e.message : e));
}

/* -------------------------------------------------------------- reschedule */

export const rescheduleInput = z.object({ start: z.string().datetime({ offset: true }), memberId: z.string().uuid().nullish(), note: z.string().trim().max(500).nullish() });

export async function rescheduleBooking(bookingId: string, raw: unknown, actor: ConsultActor, now: Date = new Date()): Promise<ConsultBooking> {
  await requireConsultEnabled();
  const input = rescheduleInput.parse(raw);
  const before = await loadBooking(bookingId);
  const { viewer } = await bookingViewer(before, actor);
  if (before.status !== "CONFIRMED" && before.status !== "PENDING_APPROVAL") throw conflict("Only an upcoming booking can be moved.");
  if (viewer === "CUSTOMER") {
    const ok = customerMayReschedule(bookedPolicy(before), { startsAt: before.startsAt, now, rescheduleCount: before.rescheduleCount });
    if (!ok.ok) throw conflict(ok.reason!);
  }
  const start = new Date(input.start);
  if (start.getTime() === before.startsAt.getTime() && !input.memberId) throw validationFailed("Choose a different time.");
  const [service] = await db.select().from(consultServices).where(eq(consultServices.id, before.serviceId));
  const [profile] = await db.select().from(consultProfiles).where(eq(consultProfiles.id, before.profileId));
  const members = await db.select().from(consultMembers).where(eq(consultMembers.profileId, before.profileId));
  const eligible = membersForService(service, members);
  const current = await db.select({ memberId: consultBookingMembers.memberId }).from(consultBookingMembers).where(and(eq(consultBookingMembers.bookingId, before.id), eq(consultBookingMembers.active, true)));
  // Keep the same consultant unless the booking was "any member" or the firm reassigns.
  const keep = !before.anyMember && viewer === "CUSTOMER" && service.bookingKind !== "TEAM" ? current[0]?.memberId ?? null : null;
  const wantMember = input.memberId ?? keep;
  if (input.memberId && !eligible.some((m) => m.id === input.memberId)) throw validationFailed("That consultant does not offer this service.");
  try {
    return await db.transaction(async (tx) => {
      const b = await lockBooking(tx, bookingId);
      if (b.status !== "CONFIRMED" && b.status !== "PENDING_APPROVAL") throw conflict("Only an upcoming booking can be moved.");
      const locked = await lockMembers(tx, [...new Set([...eligible.map((m) => m.id), ...current.map((c) => c.memberId)])]);
      await expireHoldsFor(tx, locked.map((m) => m.id), now);
      await tx.update(consultBookingMembers).set({ active: false }).where(eq(consultBookingMembers.bookingId, b.id));
      const dayFrom = istAt(istDateKey(start), 0);
      const dayTo = new Date(istAt(addDays(istDateKey(start), 1), 0).getTime() + 12 * 60 * MIN);
      const calendars = await loadCalendars(locked.filter((m) => m.status === "ACTIVE" && eligible.some((e) => e.id === m.id)), dayFrom, dayTo, { client: tx, now, excludeBookingId: b.id });
      // The consultant may move a booking inside the notice period; the customer may not.
      const chosen = pickMembers(calendars, serviceShape(service), start.getTime(), rulesOf(profile, now), { memberId: wantMember, attendees: b.attendees, ignoreRules: viewer !== "CUSTOMER" && start.getTime() > now.getTime() });
      if (!chosen) throw slotTaken();
      const endsAt = new Date(start.getTime() + b.durationMinutes * MIN);
      const byId = new Map(locked.map((m) => [m.id, m]));
      await tx.insert(consultBookingMembers).values(
        chosen.map((memberId) => ({
          bookingId: b.id,
          memberId,
          startsAt: start,
          blocksUntil: new Date(endsAt.getTime() + (byId.get(memberId)?.bufferMinutes ?? 0) * MIN),
          shareKey: shareKeyFor(service, { memberId, maxPerSlot: byId.get(memberId)?.maxPerSlot ?? 1 }, start.getTime(), b.id),
        })),
      );
      const [updated] = await tx
        .update(consultBookings)
        .set({ startsAt: start, endsAt, rescheduleCount: b.rescheduleCount + 1, rescheduledFrom: b.startsAt, arrivedAt: null, updatedAt: now })
        .where(eq(consultBookings.id, b.id))
        .returning();
      if (updated.status === "CONFIRMED") await scheduleReminders(updated, tx, now);
      await addEvent(tx, b, "RESCHEDULED", { from: b.status, to: b.status, actor, note: input.note, meta: { from: b.startsAt, to: start, members: chosen, by: viewer } });
      await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.CONSULT_BOOKING_CHANGED, entityType: "consult_booking", entityId: b.id, previousValue: { startsAt: b.startsAt }, newValue: { startsAt: start, members: chosen } }, tx);
      await tellBooking(updated, "RESCHEDULED", { note: input.note ?? (viewer === "CUSTOMER" ? "Moved by the customer." : "Moved by the consultant.") }, tx);
      return updated;
    });
  } catch (error) {
    if (pgCode(error) === "23P01") throw slotTaken();
    throw error;
  }
}

/** Moves a firm's booking to another member at the same time (firm owner's side-by-side view). */
export async function reassignBooking(bookingId: string, memberId: string, actor: ConsultActor): Promise<ConsultBooking> {
  const b = await loadBooking(bookingId);
  return rescheduleBooking(bookingId, { start: b.startsAt.toISOString(), memberId, note: "Assigned to another consultant of the firm." }, actor);
}

/* ------------------------------------------------------- consultant actions */

export async function decideBooking(bookingId: string, accept: boolean, actor: ConsultActor, reason: string | null, now: Date = new Date()): Promise<ConsultBooking> {
  const before = await loadBooking(bookingId);
  await requireFirmActor(before, actor);
  if (before.status !== "PENDING_APPROVAL") throw conflict("This booking is not waiting for your decision.");
  if (!accept && !reason?.trim()) throw validationFailed("Give the customer a reason.");
  const result = await db.transaction(async (tx) => {
    const b = await lockBooking(tx, bookingId);
    if (b.status !== "PENDING_APPROVAL") throw conflict("This booking is not waiting for your decision.");
    if (accept) {
      const [u] = await tx.update(consultBookings).set({ status: "CONFIRMED", confirmedAt: now, updatedAt: now }).where(eq(consultBookings.id, b.id)).returning();
      await scheduleReminders(u, tx, now);
      await addEvent(tx, b, "ACCEPTED", { from: b.status, to: "CONFIRMED", actor });
      await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.CONSULT_BOOKING_CHANGED, entityType: "consult_booking", entityId: b.id, previousValue: { status: b.status }, newValue: { status: "CONFIRMED" } }, tx);
      await tellBooking(u, "CONFIRMED", {}, tx);
      return { booking: u, refundIds: [] as string[] };
    }
    const [u] = await tx
      .update(consultBookings)
      .set({ status: "REJECTED", cancelledAt: now, cancelledBy: "CONSULTANT", cancelReason: reason!.trim().slice(0, 500), updatedAt: now })
      .where(eq(consultBookings.id, b.id))
      .returning();
    await tx.update(consultBookingMembers).set({ active: false }).where(eq(consultBookingMembers.bookingId, b.id));
    await addEvent(tx, b, "REJECTED", { from: b.status, to: "REJECTED", actor, note: reason });
    let after = u;
    const refundIds: string[] = [];
    const refundable = b.paidOnlinePaise - b.refundPaise;
    if (refundable > 0) {
      const r = await refundBookingMoney(tx, after, refundable, `${b.bookingNumber}: declined by the consultant`, "reject");
      after = r.booking;
      refundIds.push(...r.refundIds);
    }
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.CONSULT_BOOKING_CHANGED, entityType: "consult_booking", entityId: b.id, previousValue: { status: b.status }, newValue: { status: "REJECTED", refundPaise: refundable } }, tx);
    await tellBooking(after, "REJECTED", { note: reason }, tx);
    if (refundable > 0) await tellBooking(after, "REFUND", { amountPaise: refundable }, tx);
    return { booking: after, refundIds };
  });
  await submitRefunds(result.refundIds);
  return result.booking;
}

export async function markArrived(bookingId: string, actor: ConsultActor, now: Date = new Date()): Promise<ConsultBooking> {
  const before = await loadBooking(bookingId);
  await requireFirmActor(before, actor);
  if (before.status !== "CONFIRMED") throw conflict("Only a confirmed booking can be marked arrived.");
  if (now.getTime() < before.startsAt.getTime() - 4 * 60 * MIN) throw conflict("The visitor can be marked arrived on the day of the appointment.");
  return db.transaction(async (tx) => {
    const [u] = await tx.update(consultBookings).set({ arrivedAt: now, updatedAt: now }).where(and(eq(consultBookings.id, bookingId), eq(consultBookings.status, "CONFIRMED"))).returning();
    if (!u) throw conflict("Only a confirmed booking can be marked arrived.");
    await addEvent(tx, u, "ARRIVED", { actor });
    return u;
  });
}

/** Whether completing this booking needs the customer's code. */
export async function completionNeedsCode(b: Pick<ConsultBooking, "profileId" | "mode">): Promise<boolean> {
  const rule = await getRule("consultBooking");
  const [p] = await db.select({ otp: consultProfiles.completionOtp }).from(consultProfiles).where(eq(consultProfiles.id, b.profileId));
  return Boolean(p?.otp) && (rule.completionOtpModes as readonly ConsultMode[]).includes(b.mode);
}

export async function completeBooking(bookingId: string, actor: ConsultActor, code: string | null, now: Date = new Date()): Promise<ConsultBooking> {
  const before = await loadBooking(bookingId);
  const { viewer } = await requireFirmActor(before, actor);
  if (before.status !== "CONFIRMED") throw conflict("Only a confirmed booking can be completed.");
  if (now.getTime() < before.startsAt.getTime() - 15 * MIN) throw conflict("An appointment can be completed from 15 minutes before its start.");
  const rule = await getRule("consultBooking");
  const needsCode = viewer !== "STAFF" && (await completionNeedsCode(before));
  if (needsCode) {
    if (before.otpAttempts >= rule.otpMaxAttempts) throw conflict("Too many wrong codes. Ask GoKesari support to complete this booking.", { reason: "OTP_LOCKED" });
    if (!code || !completionCodeMatches(before.id, before.otpSalt, code)) {
      await db.update(consultBookings).set({ otpAttempts: sql`${consultBookings.otpAttempts} + 1`, updatedAt: now }).where(eq(consultBookings.id, before.id));
      await db.insert(consultBookingEvents).values({ bookingId: before.id, kind: "OTP_WRONG", actorId: actor.id, actorRole: actor.role });
      const left = rule.otpMaxAttempts - before.otpAttempts - 1;
      throw new AppError("VALIDATION_FAILED", left > 0 ? `That code is not right. ${left} tries left. Ask the customer for the code shown on their booking.` : "That code is not right. No tries left.", { reason: "OTP_WRONG", left });
    }
  }
  return db.transaction(async (tx) => {
    const b = await lockBooking(tx, bookingId);
    if (b.status !== "CONFIRMED") throw conflict("Only a confirmed booking can be completed.");
    const [u] = await tx.update(consultBookings).set({ status: "COMPLETED", completedAt: now, holdExpiresAt: null, updatedAt: now }).where(eq(consultBookings.id, b.id)).returning();
    await cancelReminders(b.id, tx, now);
    await addEvent(tx, b, "COMPLETED", { from: b.status, to: "COMPLETED", actor, meta: { withCode: needsCode } });
    let after = await settleBooking(tx, u, now);
    if (after.paidOfflinePaise > 0) after = await settleOfflineCommission(tx, after, now);
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.CONSULT_BOOKING_CHANGED, entityType: "consult_booking", entityId: b.id, previousValue: { status: b.status }, newValue: { status: "COMPLETED", withCode: needsCode } }, tx);
    await tellBooking(after, "COMPLETED", {}, tx);
    return after;
  });
}

export async function markNoShow(bookingId: string, actor: ConsultActor, now: Date = new Date()): Promise<ConsultBooking> {
  const before = await loadBooking(bookingId);
  await requireFirmActor(before, actor);
  if (before.status !== "CONFIRMED") throw conflict("Only a confirmed booking can be marked as a no-show.");
  if (now.getTime() < before.startsAt.getTime()) throw conflict("A no-show can be marked only after the appointment time.");
  const result = await db.transaction(async (tx) => {
    const b = await lockBooking(tx, bookingId);
    if (b.status !== "CONFIRMED") throw conflict("Only a confirmed booking can be marked as a no-show.");
    const refund = noShowRefund(bookedPolicy(b), b.paidOnlinePaise, b.refundPaise);
    const [u] = await tx.update(consultBookings).set({ status: "NO_SHOW", updatedAt: now }).where(eq(consultBookings.id, b.id)).returning();
    await tx.update(consultBookingMembers).set({ active: false }).where(eq(consultBookingMembers.bookingId, b.id));
    await cancelReminders(b.id, tx, now);
    await addEvent(tx, b, "NO_SHOW", { from: b.status, to: "NO_SHOW", actor, meta: { refundPaise: refund.refundPaise } });
    let after = u;
    const refundIds: string[] = [];
    if (refund.refundPaise > 0) {
      const r = await refundBookingMoney(tx, after, refund.refundPaise, `${b.bookingNumber}: ${refund.reason}`, "no-show");
      after = r.booking;
      refundIds.push(...r.refundIds);
    }
    after = await settleBooking(tx, after, now);
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.CONSULT_BOOKING_CHANGED, entityType: "consult_booking", entityId: b.id, previousValue: { status: b.status }, newValue: { status: "NO_SHOW", refund } }, tx);
    await tellBooking(after, "NO_SHOW", { note: refund.refundPaise > 0 ? refund.reason : null }, tx);
    if (refund.refundPaise > 0) await tellBooking(after, "REFUND", { amountPaise: refund.refundPaise }, tx);
    return { booking: after, refundIds };
  });
  await submitRefunds(result.refundIds);
  return result.booking;
}

export async function setPrivateNote(bookingId: string, note: string, actor: ConsultActor): Promise<ConsultBooking> {
  const before = await loadBooking(bookingId);
  await requireFirmActor(before, actor);
  const [u] = await db.update(consultBookings).set({ privateNote: note.trim().slice(0, 4000) || null, updatedAt: new Date() }).where(eq(consultBookings.id, bookingId)).returning();
  await db.insert(consultBookingEvents).values({ bookingId, kind: "PRIVATE_NOTE", actorId: actor.id, actorRole: actor.role });
  return u;
}

export async function setMeetingUrl(bookingId: string, url: string, actor: ConsultActor): Promise<ConsultBooking> {
  const before = await loadBooking(bookingId);
  await requireFirmActor(before, actor);
  if (before.mode !== "VIDEO") throw conflict("Only a video appointment has a meeting link.");
  const parsed = z.string().trim().url().max(500).safeParse(url);
  if (!parsed.success || !/^https:\/\//i.test(parsed.data)) throw validationFailed("Enter the meeting link (https://…).");
  const [u] = await db.update(consultBookings).set({ meetingUrl: parsed.data, updatedAt: new Date() }).where(eq(consultBookings.id, bookingId)).returning();
  await db.insert(consultBookingEvents).values({ bookingId, kind: "MEETING_LINK", actorId: actor.id, actorRole: actor.role, note: "Meeting link changed." });
  if (u.status === "CONFIRMED") await tellBooking(u, "RESCHEDULED", { note: `New meeting link: ${u.meetingUrl}` });
  return u;
}

export const offlinePaymentInput = z.object({ method: z.enum(["CASH", "UPI", "CARD", "OTHER"]), amountRupees: z.number().min(0).max(10_000_000).nullish() });

/** "Pay at visit": the consultant records the money taken at the counter; a receipt is issued. */
export async function markOfflinePaid(bookingId: string, raw: unknown, actor: ConsultActor, now: Date = new Date()): Promise<ConsultBooking> {
  const input = offlinePaymentInput.parse(raw);
  const before = await loadBooking(bookingId);
  await requireFirmActor(before, actor);
  if (["CANCELLED", "REJECTED", "EXPIRED", "PENDING_PAYMENT"].includes(before.status)) throw conflict("This booking has no payment to record.");
  const due = Math.max(0, before.feePaise - before.paidOnlinePaise - before.paidOfflinePaise);
  if (due === 0) throw conflict("Nothing is due on this booking.");
  const amount = input.amountRupees != null ? Math.round(input.amountRupees * 100) : due;
  if (amount <= 0 || amount > due) throw validationFailed(`Enter up to ${(due / 100).toFixed(2)} rupees.`);
  return db.transaction(async (tx) => {
    const b = await lockBooking(tx, bookingId);
    const stillDue = Math.max(0, b.feePaise - b.paidOnlinePaise - b.paidOfflinePaise);
    if (amount > stillDue) throw conflict("This payment was already recorded.");
    const paidOffline = b.paidOfflinePaise + amount;
    const paymentStatus = b.paidOnlinePaise + paidOffline >= b.feePaise ? "PAID" : b.paymentStatus;
    const [u] = await tx
      .update(consultBookings)
      .set({ paidOfflinePaise: paidOffline, paymentStatus, offlineMethod: input.method as ConsultOfflineMethod, offlineMarkedBy: actor.id, offlineMarkedAt: now, updatedAt: now })
      .where(eq(consultBookings.id, b.id))
      .returning();
    let after = await issueReceipt(tx, u, now);
    await addEvent(tx, b, "PAID_OFFLINE", { actor, meta: { amountPaise: amount, method: input.method } });
    if (after.status === "COMPLETED") after = await settleOfflineCommission(tx, after, now);
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.CONSULT_BOOKING_PAYMENT, entityType: "consult_booking", entityId: b.id, newValue: { offline: amount, method: input.method, receipt: after.receiptNumber } }, tx);
    await tellBooking(after, "PAYMENT_RECEIVED", { amountPaise: amount }, tx);
    return after;
  });
}

/** The customer pays the balance of an advance online. */
export async function payBalanceOnline(bookingId: string, actor: ConsultActor) {
  await requireConsultEnabled();
  const b = await loadBooking(bookingId);
  if (b.customerId !== actor.id) throw notFound("Booking");
  if (b.status !== "CONFIRMED" && b.status !== "PENDING_APPROVAL" && b.status !== "COMPLETED") throw conflict("This booking has no balance to pay online.");
  const due = b.feePaise - b.paidOnlinePaise - b.paidOfflinePaise;
  if (due <= 0) throw conflict("Nothing is due on this booking.");
  return startBookingPayment(b, "BALANCE", actor);
}

/** The customer retries the online payment of a held booking (the hold must still be running). */
export async function retryBookingPayment(bookingId: string, actor: ConsultActor) {
  await requireConsultEnabled();
  const b = await loadBooking(bookingId);
  if (b.customerId !== actor.id) throw notFound("Booking");
  if (b.status !== "PENDING_PAYMENT" || !b.holdExpiresAt || b.holdExpiresAt.getTime() < Date.now()) throw conflict("This time is no longer held. Please book again.");
  return startBookingPayment(b, "ADVANCE", actor);
}

export const rateInput = z.object({ rating: z.number().int().min(1).max(5), review: z.string().trim().max(1000).nullish() });

export async function rateBooking(bookingId: string, raw: unknown, actor: ConsultActor): Promise<ConsultBooking> {
  const input = rateInput.parse(raw);
  const b = await loadBooking(bookingId);
  if (b.customerId !== actor.id) throw notFound("Booking");
  if (b.status !== "COMPLETED") throw conflict("You can rate an appointment once it is completed.");
  if (b.rating) throw conflict("You already rated this appointment.");
  return db.transaction(async (tx) => {
    const [u] = await tx
      .update(consultBookings)
      .set({ rating: input.rating, review: input.review ?? null, ratedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(consultBookings.id, b.id), sql`${consultBookings.rating} IS NULL`))
      .returning();
    if (!u) throw conflict("You already rated this appointment.");
    await tx.execute(sql`
      update consult_profiles p set
        rating_count = s.n,
        rating_avg_x100 = s.avg_x100,
        updated_at = now()
      from (select count(*)::int as n, coalesce(round(avg(rating) * 100), 0)::int as avg_x100 from consult_bookings where profile_id = ${b.profileId} and rating is not null) s
      where p.id = ${b.profileId}
    `);
    await tx.insert(consultBookingEvents).values({ bookingId: b.id, kind: "RATED", actorId: actor.id, actorRole: actor.role, meta: { rating: input.rating } });
    return u;
  });
}

export const disputeInput = z.object({ reason: z.string().trim().min(10, "Tell us what went wrong (at least 10 characters).").max(2000) });

/** A dispute opens a help-desk ticket (category BOOKING) linked to the firm; both sides and support are told. */
export async function raiseDispute(bookingId: string, raw: unknown, actor: ConsultActor): Promise<{ booking: ConsultBooking; ticketId: string; ticketNumber: string }> {
  const input = disputeInput.parse(raw);
  const b = await loadBooking(bookingId);
  if (b.customerId !== actor.id) throw notFound("Booking");
  if (b.ticketId) throw conflict("A dispute is already open for this booking.");
  if (!["CONFIRMED", "COMPLETED", "NO_SHOW", "CANCELLED", "REJECTED"].includes(b.status)) throw conflict("This booking cannot be disputed.");
  const { createTicket } = await import("@/server/aftercare/support-tickets");
  const ticket = await createTicket(
    { category: "BOOKING", subject: `Booking ${b.bookingNumber}: ${b.serviceName}`.slice(0, 200), description: `${input.reason}\n\nBooking ${b.bookingNumber}, ${b.startsAt.toISOString()} (${b.mode}). Status ${b.status}. Paid online ₹${(b.paidOnlinePaise / 100).toFixed(2)}, at visit ₹${(b.paidOfflinePaise / 100).toFixed(2)}, refunded ₹${(b.refundPaise / 100).toFixed(2)}.`, priority: "HIGH" },
    actor,
  );
  const [u] = await db.transaction(async (tx) => {
    await tx.update(supportTickets).set({ shopId: b.shopId }).where(eq(supportTickets.id, ticket.id));
    const rows = await tx.update(consultBookings).set({ ticketId: ticket.id, updatedAt: new Date() }).where(eq(consultBookings.id, b.id)).returning();
    await tx.insert(consultBookingEvents).values({ bookingId: b.id, kind: "DISPUTE", actorId: actor.id, actorRole: actor.role, note: input.reason.slice(0, 1000), meta: { ticketId: ticket.id, ticketNumber: ticket.ticketNumber } });
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.CONSULT_BOOKING_CHANGED, entityType: "consult_booking", entityId: b.id, newValue: { dispute: ticket.ticketNumber } }, tx);
    await tellBooking(rows[0], "DISPUTE", { note: ` Ticket ${ticket.ticketNumber}.` }, tx);
    return rows;
  });
  return { booking: u, ticketId: ticket.id, ticketNumber: ticket.ticketNumber };
}

/** Staff cancel any booking (full refund), e.g. after a dispute. */
export async function staffCancel(bookingId: string, actor: ConsultActor, reason: string): Promise<ConsultBooking> {
  return cancelBooking(bookingId, actor, reason);
}

export { expireOne as expireBookingHold, lockMembers, expireHoldsFor, addEvent as addBookingEvent };
