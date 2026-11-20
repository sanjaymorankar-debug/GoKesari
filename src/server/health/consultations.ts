/**
 * GoKesari Health: the consultation (the doctor's pad) — started from a booking (or a walk-in booked on
 * the patient's behalf), saved as a draft while the doctor types, and closed by issuing the prescription
 * (prescriptions.ts). The patient summary shows the doctor's own history with the patient always, and
 * other providers' records only while the patient's consent is active — every such look is logged.
 */
import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";

import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { bmiOf } from "@/lib/health/constants";
import { completionCodeMatches } from "@/server/consult/otp";
import { addBookingEvent, markArrived } from "@/server/consult/bookings";
import { db, type DbClient } from "@/server/db";
import {
  consultBookingEvents,
  consultBookingMembers,
  consultBookings,
  consultMembers,
  healthAppointmentLinks,
  healthConsultations,
  healthDocuments,
  healthPatients,
  healthPrescriptionItems,
  healthPrescriptions,
  healthTimeline,
  type ConsultBooking,
  type HealthConsultation,
  type HealthPatient,
} from "@/server/db/schema";
import { doctorLabel, firmUserIds, logRecordAccess, patientAudience, recordConsentFor, requireDoctorContext, requireVerifiedDoctor, sameDoctorMemberIds, type HealthActor } from "./access";
import { publishHealthEvent } from "./events";
import { addTimeline } from "./timeline";

/* ------------------------------------------------------------ patient for a booking */

/**
 * The patient a booking is for. Health bookings carry an appointment link; a plain consultant booking
 * (booked from /consult) is linked now: the customer's own record when the visitor is the customer, else
 * a family record under the customer's account named as the visitor.
 */
export async function ensurePatientForBooking(booking: ConsultBooking, client: DbClient = db): Promise<HealthPatient> {
  const [link] = await client.select().from(healthAppointmentLinks).where(eq(healthAppointmentLinks.bookingId, booking.id));
  if (link) {
    const [p] = await client.select().from(healthPatients).where(eq(healthPatients.id, link.patientId));
    if (p) return p;
  }
  const family = await client.select().from(healthPatients).where(and(eq(healthPatients.accountUserId, booking.customerId), isNull(healthPatients.hiddenAt)));
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
  let patient = family.find((p) => norm(p.fullName) === norm(booking.visitorName)) ?? null;
  if (!patient) {
    const self = family.find((p) => p.relation === "SELF") ?? null;
    if (self && (!booking.visitorName || norm(self.fullName).includes(norm(booking.visitorName).slice(0, 4)))) patient = self;
  }
  if (!patient) {
    const [created] = await client
      .insert(healthPatients)
      .values({
        accountUserId: booking.customerId,
        relation: family.length ? "OTHER" : "SELF",
        linkedUserId: family.length ? null : booking.customerId,
        fullName: booking.visitorName,
        phone: booking.visitorPhone,
        email: booking.visitorEmail,
        dateOfBirth: booking.visitorAge != null ? `${new Date().getUTCFullYear() - booking.visitorAge}-01-01` : null,
        recordStartAt: booking.createdAt,
      })
      .onConflictDoNothing()
      .returning();
    patient = created ?? (await client.select().from(healthPatients).where(and(eq(healthPatients.accountUserId, booking.customerId), eq(healthPatients.relation, "SELF"))))[0];
  }
  await client.insert(healthAppointmentLinks).values({ bookingId: booking.id, patientId: patient.id, reason: booking.customerNote }).onConflictDoNothing();
  return patient;
}

/* ------------------------------------------------------------ check-in */

/**
 * Reception / doctor checks the patient in by scanning the booking QR (it carries the booking's
 * completion code) or typing the 4-digit code. Marks the booking arrived and remembers that the code
 * was checked, so issuing the prescription can complete the booking without asking again.
 */
export async function checkInBooking(bookingId: string, code: string | null, actor: HealthActor, now: Date = new Date()): Promise<{ bookingId: string; withCode: boolean }> {
  const [b] = await db.select().from(consultBookings).where(eq(consultBookings.id, bookingId));
  if (!b) throw notFound("Booking");
  let withCode = false;
  if (code) {
    const raw = code.trim();
    // QR payload: GKH:<bookingId>:<code>
    const m = raw.match(/^GKH:([0-9a-f-]{36}):(\d{4,6})$/i);
    const entered = m ? m[2] : raw;
    if (m && m[1] !== bookingId) throw validationFailed("This QR code is for a different booking.");
    if (!completionCodeMatches(b.id, b.otpSalt, entered)) throw validationFailed("That code is not right. Ask the patient for the code on their booking.", { fields: { code: "Wrong code." } });
    withCode = true;
  }
  if (!b.arrivedAt) await markArrived(bookingId, actor, now);
  await db.transaction(async (tx) => {
    await addBookingEvent(tx, b, "CHECKED_IN", { actor, meta: { withCode } });
    const patient = await ensurePatientForBooking(b, tx);
    await publishHealthEvent({ name: "appointment.checked_in", shopId: b.shopId, userIds: patientAudience(patient), subjectId: b.id, payload: { bookingId: b.id, withCode } }, tx);
  });
  return { bookingId, withCode };
}

/** Finds the booking for a scanned QR / typed code at a clinic (reception screen). */
export async function findBookingByQr(shopId: string, payload: string): Promise<string | null> {
  const m = payload.trim().match(/^GKH:([0-9a-f-]{36}):(\d{4,6})$/i);
  if (!m) return null;
  const [b] = await db.select({ id: consultBookings.id, shopId: consultBookings.shopId }).from(consultBookings).where(eq(consultBookings.id, m[1]));
  return b && b.shopId === shopId ? b.id : null;
}

export async function checkedInWithCode(bookingId: string, client: DbClient = db): Promise<boolean> {
  const rows = await client
    .select({ meta: consultBookingEvents.meta })
    .from(consultBookingEvents)
    .where(and(eq(consultBookingEvents.bookingId, bookingId), eq(consultBookingEvents.kind, "CHECKED_IN")));
  return rows.some((r) => (r.meta as { withCode?: boolean } | null)?.withCode === true);
}

/* ------------------------------------------------------------ start / save */

export const startInput = z.object({
  memberId: z.string().uuid(),
  bookingId: z.string().uuid().nullish(),
});

export async function startConsultation(raw: unknown, actor: HealthActor, now: Date = new Date()): Promise<HealthConsultation> {
  const input = startInput.parse(raw);
  const ctx = await requireVerifiedDoctor(input.memberId, actor);
  if (!input.bookingId) throw validationFailed("Open the consultation from the patient's booking (add a walk-in first).");
  const [b] = await db.select().from(consultBookings).where(eq(consultBookings.id, input.bookingId));
  if (!b || b.shopId !== ctx.shopId) throw notFound("Booking");
  const [assigned] = await db
    .select({ id: consultBookingMembers.id })
    .from(consultBookingMembers)
    .where(and(eq(consultBookingMembers.bookingId, b.id), eq(consultBookingMembers.memberId, ctx.memberId)));
  if (!assigned) throw forbidden("This booking is with another doctor.");
  if (!["CONFIRMED", "COMPLETED"].includes(b.status)) throw conflict("Only a confirmed appointment can be consulted.");
  const [existing] = await db.select().from(healthConsultations).where(eq(healthConsultations.bookingId, b.id));
  if (existing) return existing;
  return db.transaction(async (tx) => {
    const patient = await ensurePatientForBooking(b, tx);
    const [link] = await tx.select().from(healthAppointmentLinks).where(eq(healthAppointmentLinks.bookingId, b.id));
    const memberIds = await sameDoctorMemberIds(ctx.memberId, tx);
    const [prior] = await tx
      .select({ id: healthConsultations.id })
      .from(healthConsultations)
      .where(and(eq(healthConsultations.patientId, patient.id), inArray(healthConsultations.memberId, memberIds), eq(healthConsultations.status, "COMPLETED")))
      .limit(1);
    const [c] = await tx
      .insert(healthConsultations)
      .values({
        bookingId: b.id,
        shopId: ctx.shopId,
        memberId: ctx.memberId,
        doctorUserId: actor.id,
        patientId: patient.id,
        mode: b.mode,
        visitType: link?.visitType === "FOLLOW_UP" || prior ? "FOLLOW_UP" : "NEW",
        chiefComplaints: link?.reason ?? b.customerNote ?? null,
        startedAt: now,
      })
      .onConflictDoNothing()
      .returning();
    if (!c) {
      const [again] = await tx.select().from(healthConsultations).where(eq(healthConsultations.bookingId, b.id));
      return again;
    }
    await publishHealthEvent({ name: "consultation.started", shopId: ctx.shopId, userIds: patientAudience(patient), subjectId: c.id, payload: { bookingId: b.id, consultationId: c.id } }, tx);
    return c;
  });
}

const vitalsInput = z
  .object({
    bpSystolic: z.number().int().min(50).max(300).nullish(),
    bpDiastolic: z.number().int().min(20).max(200).nullish(),
    pulse: z.number().int().min(20).max(250).nullish(),
    temperatureC: z.number().min(30).max(45).nullish(),
    spo2: z.number().int().min(40).max(100).nullish(),
    weightKg: z.number().min(0.3).max(400).nullish(),
    heightCm: z.number().min(20).max(260).nullish(),
    respiratoryRate: z.number().int().min(4).max(80).nullish(),
    bloodSugar: z.number().min(10).max(1500).nullish(),
  })
  .partial();

export const draftInput = z.object({
  vitals: vitalsInput.default({}),
  chiefComplaints: z.string().trim().max(2000).nullish(),
  history: z.string().trim().max(4000).nullish(),
  examination: z.string().trim().max(4000).nullish(),
  diagnoses: z.array(z.object({ code: z.string().trim().max(10).nullish(), text: z.string().trim().min(2).max(300) })).max(20).default([]),
  investigations: z.array(z.object({ name: z.string().trim().min(2).max(200), note: z.string().trim().max(300).nullish(), homeCollection: z.boolean().optional() })).max(30).default([]),
  advice: z.string().trim().max(4000).nullish(),
  followUpDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullish(),
});
export type DraftInput = z.input<typeof draftInput>;

export async function loadConsultationForDoctor(consultationId: string, actor: HealthActor, client: DbClient = db): Promise<HealthConsultation> {
  const [c] = await client.select().from(healthConsultations).where(eq(healthConsultations.id, consultationId));
  if (!c) throw notFound("Consultation");
  await requireDoctorContext(c.memberId, actor, client);
  return c;
}

export async function saveConsultationDraft(consultationId: string, raw: unknown, actor: HealthActor, now: Date = new Date()): Promise<HealthConsultation> {
  const input = draftInput.parse(raw);
  const c = await loadConsultationForDoctor(consultationId, actor);
  if (c.status !== "IN_PROGRESS") throw conflict("This consultation is closed. Amend the prescription instead.");
  const vitals = { ...input.vitals, bmi: bmiOf(input.vitals.weightKg, input.vitals.heightCm) };
  const [u] = await db
    .update(healthConsultations)
    .set({
      vitals,
      chiefComplaints: input.chiefComplaints ?? null,
      history: input.history ?? null,
      examination: input.examination ?? null,
      diagnoses: input.diagnoses.map((d) => ({ code: d.code ?? null, text: d.text })),
      investigations: input.investigations,
      advice: input.advice ?? null,
      followUpDate: input.followUpDate ?? null,
      updatedAt: now,
    })
    .where(eq(healthConsultations.id, c.id))
    .returning();
  return u;
}

/* ------------------------------------------------------------ patient summary */

export interface PatientSummary {
  patient: Pick<HealthPatient, "id" | "fullName" | "dateOfBirth" | "gender" | "bloodGroup" | "allergies" | "conditions" | "currentMedicines" | "abhaNumber">;
  age: string | null;
  ownVisits: { id: string; date: Date; diagnoses: string; rxNumber: string | null; prescriptionId: string | null }[];
  currentMedicines: { name: string; dose: string; until: string; doctor: string }[];
  consent: { allowed: boolean; mode: string };
  /** Only when consent is active: other providers' timeline and documents (logged). */
  others: { id: string; at: Date; kind: string; title: string; summary: string | null; provider: string | null }[] | null;
  documents: { id: string; title: string; kind: string; source: string; date: string | null }[] | null;
}

export function ageText(dob: string | null, now: Date = new Date()): string | null {
  if (!dob) return null;
  const d = new Date(`${dob}T00:00:00Z`);
  let years = now.getUTCFullYear() - d.getUTCFullYear();
  const m = now.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < d.getUTCDate())) years -= 1;
  if (years >= 2) return `${years} y`;
  const months = Math.max(0, (now.getUTCFullYear() - d.getUTCFullYear()) * 12 + now.getUTCMonth() - d.getUTCMonth());
  return `${months} m`;
}

export async function patientSummary(consultationId: string, actor: HealthActor, ip?: string | null, now: Date = new Date()): Promise<PatientSummary> {
  const c = await loadConsultationForDoctor(consultationId, actor);
  const [p] = await db.select().from(healthPatients).where(eq(healthPatients.id, c.patientId));
  if (!p) throw notFound("Patient");
  const memberIds = await sameDoctorMemberIds(c.memberId);
  const own = await db
    .select({ id: healthConsultations.id, date: healthConsultations.startedAt, diagnoses: healthConsultations.diagnoses, rxNumber: healthPrescriptions.rxNumber, prescriptionId: healthPrescriptions.id })
    .from(healthConsultations)
    .leftJoin(healthPrescriptions, and(eq(healthPrescriptions.consultationId, healthConsultations.id), eq(healthPrescriptions.status, "ISSUED")))
    .where(and(eq(healthConsultations.patientId, p.id), inArray(healthConsultations.memberId, memberIds), ne(healthConsultations.id, c.id)))
    .orderBy(desc(healthConsultations.startedAt))
    .limit(30);
  // Current medicines from any GoKesari prescription still running are a safety item (allergy /
  // duplicate checks): shown for the doctor's own prescriptions always, for others only with consent.
  const consent = await recordConsentFor(p.id, memberIds, db, now);
  const today = now.toISOString().slice(0, 10);
  const meds = await db
    .select({ name: healthPrescriptionItems.genericName, brand: healthPrescriptionItems.brandName, strength: healthPrescriptionItems.strength, dose: healthPrescriptionItems.dose, frequency: healthPrescriptionItems.frequency, days: healthPrescriptionItems.durationDays, issuedAt: healthPrescriptions.issuedAt, memberId: healthPrescriptions.memberId, doctor: consultMembers.name })
    .from(healthPrescriptionItems)
    .innerJoin(healthPrescriptions, eq(healthPrescriptions.id, healthPrescriptionItems.prescriptionId))
    .innerJoin(consultMembers, eq(consultMembers.id, healthPrescriptions.memberId))
    .where(and(eq(healthPrescriptions.patientId, p.id), eq(healthPrescriptions.status, "ISSUED")));
  const current = meds
    .filter((m) => consent.allowed || memberIds.includes(m.memberId))
    .map((m) => ({ ...m, until: new Date(m.issuedAt.getTime() + m.days * 86_400_000).toISOString().slice(0, 10) }))
    .filter((m) => m.until >= today)
    .map((m) => ({ name: [m.brand ?? m.name, m.strength].filter(Boolean).join(" "), dose: `${m.dose} ${m.frequency}`, until: m.until, doctor: m.doctor }));
  let others: PatientSummary["others"] = null;
  let documents: PatientSummary["documents"] = null;
  if (consent.allowed) {
    const rows = await db
      .select()
      .from(healthTimeline)
      .where(and(eq(healthTimeline.patientId, p.id), isNull(healthTimeline.hiddenAt), sql`(${healthTimeline.providerMemberId} is null or ${healthTimeline.providerMemberId} not in ${memberIds})`))
      .orderBy(desc(healthTimeline.occurredAt))
      .limit(100);
    others = rows.map((r) => ({ id: r.id, at: r.occurredAt, kind: r.kind, title: r.title, summary: r.summary, provider: r.providerName }));
    const docs = await db
      .select({ id: healthDocuments.id, title: healthDocuments.title, kind: healthDocuments.kind, source: healthDocuments.source, date: healthDocuments.documentDate })
      .from(healthDocuments)
      .where(and(eq(healthDocuments.patientId, p.id), isNull(healthDocuments.hiddenAt)))
      .orderBy(desc(healthDocuments.createdAt))
      .limit(50);
    documents = docs;
    await logRecordAccess({ patientId: p.id, actor, actorLabel: await doctorLabel(c.memberId), actorRole: "DOCTOR", action: "VIEW", objectType: "earlier_records", objectId: c.id, reason: consent.mode === "ALWAYS" ? "Sharing allowed (always)" : "Sharing allowed for this visit", ipAddress: ip ?? null });
    await publishHealthEvent({ name: "record.accessed", userIds: patientAudience(p), subjectId: p.id, payload: { by: "DOCTOR", memberId: c.memberId } });
  }
  return {
    patient: { id: p.id, fullName: p.fullName, dateOfBirth: p.dateOfBirth, gender: p.gender, bloodGroup: p.bloodGroup, allergies: p.allergies, conditions: p.conditions, currentMedicines: p.currentMedicines, abhaNumber: p.abhaNumber },
    age: ageText(p.dateOfBirth, now),
    ownVisits: own.map((o) => ({ id: o.id, date: o.date, diagnoses: (o.diagnoses ?? []).map((d) => d.text).join("; "), rxNumber: o.rxNumber, prescriptionId: o.prescriptionId })),
    currentMedicines: current,
    consent: { allowed: consent.allowed, mode: consent.mode },
    others,
    documents,
  };
}

/** Records a consultation in the patient's timeline (called when the prescription is issued). */
export async function timelineForConsultation(client: DbClient, c: HealthConsultation, providerName: string): Promise<void> {
  const diag = (c.diagnoses ?? []).map((d) => d.text).join("; ");
  await addTimeline(client, {
    patientId: c.patientId,
    occurredAt: c.startedAt,
    kind: "CONSULTATION",
    title: `Consultation with ${providerName}`,
    summary: diag ? `Diagnosis: ${diag}` : c.chiefComplaints,
    providerName,
    providerMemberId: c.memberId,
    providerShopId: c.shopId,
    refType: "consultation",
    refId: c.id,
    meta: { mode: c.mode, visitType: c.visitType, followUpDate: c.followUpDate },
  });
}

export { firmUserIds };
