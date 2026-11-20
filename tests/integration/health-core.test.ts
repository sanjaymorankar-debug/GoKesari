/**
 * GoKesari Health core (docs/health/), against real PostgreSQL:
 *   - the My Health notice, profile, family (dependent at once, adult by one-time code)
 *   - unverified doctors cannot be booked or prescribe; verified ones can
 *   - booking for a family member → consultation → issue: number, PDF, hash, QR verification,
 *     timeline (consultation, prescription, suggestions), e-mail with the PDF queued, booking completed
 *   - amend: new version, old one superseded, both kept
 *   - telemedicine rules (prohibited / List B by video), allergy warnings
 *   - consent: other providers' records only while consent is active; every look in the access log
 *   - records views, uploads, share links, live events
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { addDays, istAt, istDateKey } from "@/lib/consult/time";
import { db } from "@/server/db";
import {
  consultBookings,
  consultCategories,
  documentEmails,
  healthAccessLog,
  healthConsents,
  healthDrugMaster,
  healthEvents,
  healthPatients,
  healthPrescriptionItems,
  healthPrescriptions,
  healthTimeline,
} from "@/server/db/schema";
import { RULES } from "@/server/config/rules";
import type { ConsultActor } from "@/server/consult/access";
import { verifyProfile } from "@/server/consult/admin";
import { completionCode } from "@/server/consult/otp";
import { ensureProfile, publishProfile, saveMember, saveService, setMemberHours, updateProfile, uploadMemberDocument } from "@/server/consult/setup";
import { renderDocumentAttachments } from "@/server/documents/email";
import { doctorStatus } from "@/server/health/access";
import { checkInQrPayload, clinicDay, createHealthBooking, queuePosition } from "@/server/health/booking";
import { accessLogFor, revokeConsent, setDoctorConsent } from "@/server/health/consent";
import { checkInBooking, patientSummary, saveConsultationDraft, startConsultation } from "@/server/health/consultations";
import { saveDoctorProfile } from "@/server/health/doctors";
import { subscribeHealth, type HealthLiveEvent } from "@/server/health/events";
import { acceptHealthNotice, addFamilyMember, confirmFamilyLink, listFamily, updatePatientProfile } from "@/server/health/patients";
import { amendPrescription, issuePrescription, prescriptionPdf, prescriptionView, verifyPrescription } from "@/server/health/prescriptions";
import { createShareLink, openShareLink, recordByProvider, recordDocuments, recordMedicines, recordPdf, recordTimeline, uploadPatientDocument } from "@/server/health/records";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { createShop, createUser, resetDatabase } from "../helpers/fixtures";

const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF");
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: "00:00", end: "23:59" }));

let admin: ConsultActor;
let owner: ConsultActor;
let customer: ConsultActor;
let other: ConsultActor;
let shopId: string;
let doctorMemberId: string;
let svcInPerson: string;
let svcVideo: string;
const actorOf = (u: { id: string; role: string; name?: string | null }): ConsultActor => ({ id: u.id, role: u.role as ConsultActor["role"], name: u.name ?? null });
const tomorrowAt = (hhmm: string) => istAt(addDays(istDateKey(new Date()), 1), Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3))).toISOString();

async function rules() {
  await setRule("consultBooking", { ...RULES.consultBooking.defaults, enabled: true }, admin);
  // Instant booking for the test clinic (a Free listing otherwise gets requests to confirm; covered in health-prime).
  await setRule("health", { ...RULES.health.defaults, enabled: true, freeListingManualApproval: false }, admin);
  clearRuleCache();
}

async function verifiedDoctor() {
  await uploadMemberDocument(shopId, doctorMemberId, { name: "mmc.pdf", bytes: PDF }, owner);
  const live = await publishProfile(shopId, owner);
  await verifyProfile(live.id, { decision: "VERIFIED", members: [{ id: doctorMemberId, decision: "VERIFIED" }] }, admin);
  await saveDoctorProfile(doctorMemberId, { fullName: "Anil Mehta", qualifications: "MBBS, MD (Medicine)", specialties: ["General Medicine"], council: "Maharashtra Medical Council", registrationNumber: "MMC-12345", registrationYear: 2008 }, owner);
}

async function patientWithBooking(mode: "IN_PERSON" | "VIDEO" = "IN_PERSON", start = tomorrowAt("10:00")) {
  const self = await acceptHealthNotice(customer);
  await updatePatientProfile(self.id, { fullName: "Asha Patil", dateOfBirth: "1990-05-01", gender: "FEMALE", bloodGroup: "B+", allergies: ["Penicillin"], conditions: ["Asthma"] }, customer);
  const created = await createHealthBooking({ patientId: self.id, serviceId: mode === "VIDEO" ? svcVideo : svcInPerson, memberId: doctorMemberId, mode, start, reason: "Fever for 3 days", shareRecords: "OFF", consent: true }, customer);
  return { patient: self, booking: created.booking };
}

async function issueBasic(consultationId: string, extra: Record<string, unknown> = {}) {
  await saveConsultationDraft(consultationId, { vitals: { bpSystolic: 120, bpDiastolic: 80, pulse: 78, temperatureC: 38.2, weightKg: 60, heightCm: 160 }, chiefComplaints: "Fever, body ache", diagnoses: [{ code: "R50.9", text: "Fever, unspecified" }], investigations: [{ name: "CBC" }], advice: "Plenty of fluids", followUpDate: addDays(istDateKey(new Date()), 7) }, owner);
  const [para] = await db.select().from(healthDrugMaster).where(and(eq(healthDrugMaster.genericName, "Paracetamol"), eq(healthDrugMaster.strength, "500 mg")));
  return issuePrescription(
    consultationId,
    {
      items: [{ drugId: para.id, genericName: "Paracetamol", dose: "1 tablet", frequency: "1-1-1", timing: "AFTER_FOOD", durationDays: 3 }],
      suggestions: [
        { type: "LAB_TEST", tests: ["CBC", "Dengue NS1"], homeCollection: true },
        { type: "FOLLOW_UP", followUpDate: addDays(istDateKey(new Date()), 7) },
      ],
      ...extra,
    },
    owner,
  );
}

beforeEach(async () => {
  await resetDatabase();
  await db.execute(sql`delete from platform_settings where key in ('consultBooking', 'health')`);
  admin = actorOf(await createUser({ role: "ADMIN" }));
  owner = actorOf(await createUser({ role: "SHOP_OWNER", name: "Dr Anil Mehta" }));
  customer = actorOf(await createUser({ role: "CUSTOMER", name: "Asha Patil" }));
  other = actorOf(await createUser({ role: "CUSTOMER", name: "Ravi" }));
  await rules();
  const shop = await createShop(owner.id, { name: "Mehta Clinic", shopType: "DOCTOR_CLINIC", latitude: 18.5204, longitude: 73.8567 });
  shopId = shop.id;
  await ensureProfile(shopId, owner);
  await updateProfile(shopId, { displayName: "Mehta Family Clinic", headline: "General physician", minNoticeMinutes: 0 }, owner);
  const [gp] = await db.select().from(consultCategories).where(eq(consultCategories.slug, "general-physician"));
  const view = await db.execute<{ id: string }>(sql`select id from consult_members where shop_id = ${shopId} and is_owner`);
  doctorMemberId = view[0].id;
  await saveMember(shopId, { id: doctorMemberId, name: "Dr Anil Mehta", categoryIds: [gp.id], languages: ["English", "Marathi"], registrationNumber: "MMC-12345", registrationBody: "Maharashtra Medical Council" }, owner);
  await setMemberHours(shopId, doctorMemberId, EVERY_DAY, owner);
  svcInPerson = (await saveService(shopId, { name: "Consultation", durationMinutes: 15, modes: ["IN_PERSON"], categoryId: gp.id, feeType: "FREE" }, owner)).id;
  svcVideo = (await saveService(shopId, { name: "Video consult", durationMinutes: 15, modes: ["VIDEO"], categoryId: gp.id, feeType: "FREE" }, owner)).id;
});

describe("patient record start, profile and family", () => {
  it("records the notice with the exact text, starts the record, and keeps family records apart", async () => {
    const self = await acceptHealthNotice(customer);
    expect(self.relation).toBe("SELF");
    const [notice] = await db.select().from(healthConsents).where(and(eq(healthConsents.patientId, self.id), eq(healthConsents.kind, "HEALTH_NOTICE")));
    expect(notice.textSnapshot).toMatch(/Your rights/);
    // Idempotent.
    expect((await acceptHealthNotice(customer)).id).toBe(self.id);
    const child = await addFamilyMember({ fullName: "Riya Patil", relation: "CHILD", dateOfBirth: "2018-03-01", dependent: true }, customer);
    expect(child.patient.linkStatus).toBe("ACTIVE");
    const mother = await addFamilyMember({ fullName: "Sunita Patil", relation: "PARENT", dependent: false, phone: "9800000001" }, customer);
    expect(mother.patient.linkStatus).toBe("PENDING_APPROVAL");
    await expect(confirmFamilyLink(mother.patient.id, "000000", customer)).rejects.toThrow(/not right/);
    const linked = await confirmFamilyLink(mother.patient.id, mother.devCode!, customer);
    expect(linked.linkStatus).toBe("ACTIVE");
    expect((await listFamily(customer)).map((p) => p.fullName)).toEqual(expect.arrayContaining(["Asha Patil", "Riya Patil", "Sunita Patil"]));
    // Another user cannot open these records.
    await expect(recordTimeline(child.patient.id, other)).rejects.toThrow(/not found/i);
  });
});

describe("verification gate", () => {
  it("refuses bookings and prescriptions for an unverified doctor", async () => {
    await uploadMemberDocument(shopId, doctorMemberId, { name: "mmc.pdf", bytes: PDF }, owner);
    await publishProfile(shopId, owner); // listed, but not verified by GoKesari yet
    expect((await doctorStatus(doctorMemberId)).verified).toBe(false);
    const self = await acceptHealthNotice(customer);
    await expect(createHealthBooking({ patientId: self.id, serviceId: svcInPerson, memberId: doctorMemberId, mode: "IN_PERSON", start: tomorrowAt("10:00"), consent: true }, customer)).rejects.toThrow(/not verified/);
    await expect(startConsultation({ memberId: doctorMemberId, bookingId: "00000000-0000-0000-0000-000000000000" }, owner)).rejects.toThrow(/verified doctors/);
  });
});

describe("consultation and e-prescription", () => {
  beforeEach(verifiedDoctor);

  it("books, checks in with the QR code, issues: PDF, number, QR verification, timeline, e-mail, booking completed — and shows in Today", async () => {
    const live: HealthLiveEvent[] = [];
    const unsubscribe = subscribeHealth({ userId: owner.id, shopIds: [shopId] }, (e) => live.push(e));
    const { patient, booking } = await patientWithBooking("IN_PERSON", new Date(Date.now() + 5 * 60_000).toISOString().replace(/\.\d+Z$/, ".000Z"));
    // The clinic's Today list shows the booking with patient details (and its live stream was told).
    const today = await clinicDay(shopId, owner, istDateKey(booking.startsAt));
    expect(today.find((r) => r.bookingId === booking.id)).toMatchObject({ patientName: "Asha Patil", visitType: "NEW", reason: "Fever for 3 days" });
    await new Promise((r) => setTimeout(r, 600));
    expect(live.some((e) => e.name === "appointment.booked" || e.name === "appointment.changed")).toBe(true);
    // Check-in by the patient's QR.
    const qr = await checkInQrPayload(booking.id, customer);
    expect(qr).toBe(`GKH:${booking.id}:${completionCode(booking.id, booking.otpSalt!)}`);
    await expect(checkInBooking(booking.id, `GKH:${booking.id}:0000`, owner)).rejects.toThrow(/not right/);
    await checkInBooking(booking.id, qr, owner);
    const c = await startConsultation({ memberId: doctorMemberId, bookingId: booking.id }, owner);
    expect(c.patientId).toBe(patient.id);
    const t0 = Date.now();
    const issued = await issueBasic(c.id);
    expect(Date.now() - t0).toBeLessThan(30_000);
    expect(issued.prescription.rxNumber).toMatch(/^RX-\d{4}-\d{6}$/);
    expect(issued.bookingCompleted).toBe(true);
    const [b] = await db.select().from(consultBookings).where(eq(consultBookings.id, booking.id));
    expect(b.status).toBe("COMPLETED");
    // PDF: complete, hash recorded, e-mailed as an attachment.
    const { pdf } = await prescriptionPdf(issued.prescription.id, customer, "DOWNLOAD");
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    const [rx] = await db.select().from(healthPrescriptions).where(eq(healthPrescriptions.id, issued.prescription.id));
    expect(rx.pdfHash).toHaveLength(64);
    const [mail] = await db.select().from(documentEmails).where(and(eq(documentEmails.docType, "HEALTH_PRESCRIPTION"), eq(documentEmails.docId, rx.id)));
    expect(mail.userId).toBe(customer.id);
    const attached = await renderDocumentAttachments("HEALTH_PRESCRIPTION", rx.id);
    expect(attached?.attachments[0].contentType).toBe("application/pdf");
    // Timeline, by-provider and medicines views.
    const kinds = (await recordTimeline(patient.id, customer)).map((r) => r.kind);
    expect(kinds).toEqual(expect.arrayContaining(["APPOINTMENT", "CONSULTATION", "PRESCRIPTION", "SUGGESTION"]));
    const groups = await recordByProvider(patient.id, customer);
    expect(groups[0].name).toBe("Dr Anil Mehta");
    const meds = await recordMedicines(patient.id, customer);
    expect(meds[0]).toMatchObject({ generic: "Paracetamol", quantity: 9, current: true });
    // QR verification: anyone learns it is genuine; the patient also sees the medicines.
    const pub = await verifyPrescription(rx.verificationToken, null);
    expect(pub).toMatchObject({ valid: true, status: "VALID", registration: "MMC-12345 (Maharashtra Medical Council)" });
    expect(pub.details).toBeNull();
    expect((await verifyPrescription(rx.verificationToken, customer)).details?.items[0]).toMatch(/Paracetamol/);
    expect((await verifyPrescription(rx.verificationToken, other)).details).toBeNull();
    // Strangers cannot open it.
    await expect(prescriptionView(rx.id, other)).rejects.toThrow(/not found/i);
    await new Promise((r) => setTimeout(r, 50));
    expect((await db.select().from(healthEvents).where(and(eq(healthEvents.name, "prescription.issued"), eq(healthEvents.subjectId, rx.id)))).length).toBe(1);
    unsubscribe();
  });

  it("issues once, then amends as a new version with a reason, keeping both", async () => {
    const { booking } = await patientWithBooking();
    const c = await startConsultation({ memberId: doctorMemberId, bookingId: booking.id }, owner);
    const issued = await issueBasic(c.id);
    await expect(issuePrescription(c.id, { items: [] , suggestions: [{ type: "FOLLOW_UP" }] }, owner)).rejects.toThrow(/already issued/);
    const [para] = await db.select().from(healthDrugMaster).where(and(eq(healthDrugMaster.genericName, "Paracetamol"), eq(healthDrugMaster.strength, "650 mg")));
    await expect(amendPrescription(issued.prescription.id, { items: [] }, owner)).rejects.toThrow();
    const v2 = await amendPrescription(issued.prescription.id, { reason: "Higher strength needed", items: [{ drugId: para.id, genericName: "Paracetamol", dose: "1 tablet", frequency: "1-0-1", durationDays: 5 }] }, owner);
    expect(v2.prescription).toMatchObject({ rxNumber: issued.prescription.rxNumber, version: 2, amendReason: "Higher strength needed" });
    const both = await db.select().from(healthPrescriptions).where(eq(healthPrescriptions.rxNumber, issued.prescription.rxNumber));
    expect(both.map((r) => r.status).sort()).toEqual(["ISSUED", "SUPERSEDED"]);
    expect((await verifyPrescription(both.find((r) => r.version === 1)!.verificationToken, null)).status).toBe("SUPERSEDED");
    const view = await prescriptionView(v2.prescription.id, customer);
    expect(view.versions).toHaveLength(2);
  });

  it("applies the telemedicine lists and allergy warnings", async () => {
    const { booking, patient } = await patientWithBooking("VIDEO");
    const c = await startConsultation({ memberId: doctorMemberId, bookingId: booking.id }, owner);
    const [alpra] = await db.select().from(healthDrugMaster).where(eq(healthDrugMaster.genericName, "Alprazolam"));
    const [metformin] = await db.select().from(healthDrugMaster).where(eq(healthDrugMaster.genericName, "Metformin"));
    await expect(issuePrescription(c.id, { items: [{ drugId: alpra.id, genericName: "Alprazolam", dose: "1 tablet", frequency: "0-0-1", durationDays: 5 }] }, owner)).rejects.toThrow(/prohibited/);
    await expect(issuePrescription(c.id, { items: [{ drugId: metformin.id, genericName: "Metformin", dose: "1 tablet", frequency: "1-0-1", durationDays: 30 }] }, owner)).rejects.toThrow(/List B/);
    // Allergy (penicillin → amoxicillin is not a name match; record an exact allergy to test the warning).
    await updatePatientProfile(patient.id, { fullName: "Asha Patil", allergies: ["Amoxicillin"] }, customer);
    const [amox] = await db.select().from(healthDrugMaster).where(and(eq(healthDrugMaster.genericName, "Amoxicillin"), eq(healthDrugMaster.form, "CAPSULE")));
    const item = { drugId: amox.id, genericName: "Amoxicillin", dose: "1 capsule", frequency: "1-1-1", durationDays: 5 };
    await expect(issuePrescription(c.id, { items: [item] }, owner)).rejects.toThrow(/review the warnings/);
    const ok = await issuePrescription(c.id, { items: [item], acknowledgeWarnings: true }, owner);
    expect(ok.warnings[0].kind).toBe("ALLERGY");
    const [line] = await db.select().from(healthPrescriptionItems).where(eq(healthPrescriptionItems.prescriptionId, ok.prescription.id));
    expect(line.quantity).toBe(15);
  });
});

describe("consent and the access log", () => {
  beforeEach(verifiedDoctor);

  it("shows other providers' records only while consent is active, and logs each look", async () => {
    const { booking, patient } = await patientWithBooking();
    // An earlier record from elsewhere: a report the patient uploaded.
    await uploadPatientDocument(patient.id, { title: "Blood test 2025", kind: "LAB_REPORT", documentDate: "2025-12-01", providerName: "City Lab" }, { name: "cbc.pdf", bytes: PDF }, customer);
    const c = await startConsultation({ memberId: doctorMemberId, bookingId: booking.id }, owner);
    const closed = await patientSummary(c.id, owner);
    expect(closed.patient.allergies).toEqual(["Penicillin"]);
    expect(closed.others).toBeNull();
    expect(closed.documents).toBeNull();
    const consentId = await setDoctorConsent({ patientId: patient.id, memberId: doctorMemberId, mode: "ALWAYS" }, customer);
    const open = await patientSummary(c.id, owner);
    expect(open.documents?.[0].title).toBe("Blood test 2025");
    const log = await accessLogFor(patient.id, customer);
    expect(log.some((l) => l.action === "VIEW" && l.objectType === "earlier_records" && /Dr Anil Mehta/.test(l.actorLabel))).toBe(true);
    await revokeConsent(consentId, customer);
    expect((await patientSummary(c.id, owner)).others).toBeNull();
    expect((await db.select().from(healthAccessLog).where(and(eq(healthAccessLog.patientId, patient.id), eq(healthAccessLog.action, "CONSENT_REVOKED")))).length).toBe(1);
  });

  it("shares one item by an expiring link and exports the whole record", async () => {
    const { booking, patient } = await patientWithBooking();
    const c = await startConsultation({ memberId: doctorMemberId, bookingId: booking.id }, owner);
    const issued = await issueBasic(c.id);
    const link = await createShareLink(patient.id, "PRESCRIPTION", issued.prescription.id, customer);
    const token = link.url.split("/").pop()!;
    const opened = await openShareLink(token);
    expect(opened.contentType).toBe("application/pdf");
    await expect(openShareLink(token, null, new Date(Date.now() + 100 * 3_600_000))).rejects.toThrow(/not found/i);
    const full = await recordPdf(patient.id, customer);
    expect(full.pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect((await recordDocuments(patient.id, customer)).length).toBe(0);
    expect((await accessLogFor(patient.id, customer)).map((l) => l.action)).toEqual(expect.arrayContaining(["SHARE", "VIEW", "EXPORT"]));
  });
});

describe("token clinics", () => {
  beforeEach(verifiedDoctor);

  it("gives tokens in booking order and shows the queue position", async () => {
    await db.execute(sql`insert into health.clinic_settings (shop_id, token_mode) values (${shopId}, true)`);
    const self = await acceptHealthNotice(customer);
    const a = await createHealthBooking({ patientId: self.id, serviceId: svcInPerson, memberId: doctorMemberId, mode: "IN_PERSON", start: tomorrowAt("10:00"), consent: true }, customer);
    const otherSelf = await acceptHealthNotice(other);
    const b = await createHealthBooking({ patientId: otherSelf.id, serviceId: svcInPerson, memberId: doctorMemberId, mode: "IN_PERSON", start: tomorrowAt("10:30"), consent: true }, other);
    expect([a.tokenNumber, b.tokenNumber]).toEqual([1, 2]);
    expect(await queuePosition(b.booking.id, other)).toMatchObject({ tokenNumber: 2, ahead: 1 });
    const rows = await db.select().from(healthTimeline).where(eq(healthTimeline.patientId, otherSelf.id));
    expect(rows[0].summary).toMatch(/token 2/);
    const [p] = await db.select().from(healthPatients).where(eq(healthPatients.id, otherSelf.id));
    expect(p.relation).toBe("SELF");
  });
});
