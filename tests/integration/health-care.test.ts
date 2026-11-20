/**
 * GoKesari Health — home care (docs/health/, owner brief §2.6 / §4.2), against real PostgreSQL:
 *   - provider profile, ID card number, police verification by staff, search shows verified providers only
 *   - book (package of sessions) → accept → on the way (distance / ETA) → OTP check-in (wrong codes counted
 *     and locked) → OTP check-out with notes and vitals → visit note in the record + timeline → booking
 *     completed → package progress → rating
 *   - the provider sees shared records only when the patient shared them (and every look is logged)
 *   - SOS: SMS to the emergency contact, an urgent support ticket, a live event
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { addDays, istAt, istDateKey } from "@/lib/consult/time";
import { db } from "@/server/db";
import {
  consultBookings,
  consultCategories,
  healthAccessLog,
  healthCarePackages,
  healthCareVisits,
  healthDocuments,
  healthEvents,
  healthTimeline,
  outboundTestMessages,
  supportTickets,
} from "@/server/db/schema";
import { RULES } from "@/server/config/rules";
import type { ConsultActor } from "@/server/consult/access";
import { verifyProfile } from "@/server/consult/admin";
import { ensureProfile, publishProfile, saveMember, saveService, setMemberHours, updateProfile, uploadMemberDocument } from "@/server/consult/setup";
import {
  bookCareVisit,
  careEarnings,
  careInbox,
  careSos,
  careVisitForPatient,
  careVisitForProvider,
  careVisitNote,
  checkInVisit,
  checkOutVisit,
  decideCareVisit,
  pendingCareProviders,
  publicIdCard,
  rateCareVisit,
  saveCareProviderProfile,
  searchCareProviders,
  setPoliceVerification,
  startOnTheWay,
  updateVisitLocation,
  visitCode,
} from "@/server/health/care";
import { acceptHealthNotice, updatePatientProfile } from "@/server/health/patients";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { createShop, createUser, resetDatabase } from "../helpers/fixtures";

const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF");
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: "00:00", end: "23:59" }));
const HOME = { lat: 18.5204, lng: 73.8567 };

let admin: ConsultActor;
let owner: ConsultActor;
let customer: ConsultActor;
let other: ConsultActor;
let shopId: string;
let nurseMemberId: string;
let serviceId: string;
const actorOf = (u: { id: string; role: string; name?: string | null }): ConsultActor => ({ id: u.id, role: u.role as ConsultActor["role"], name: u.name ?? null });
const tomorrowAt = (hhmm: string) => istAt(addDays(istDateKey(new Date()), 1), Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)));
const minutes = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);

async function rules(over: Record<string, unknown> = {}) {
  await setRule("consultBooking", { ...RULES.consultBooking.defaults, enabled: true }, admin);
  await setRule("health", { ...RULES.health.defaults, enabled: true, ...over }, admin);
  await setRule("helpdesk", { ...RULES.helpdesk.defaults, enabled: true }, admin);
  clearRuleCache();
}

async function verifiedNurse() {
  await saveCareProviderProfile({ memberId: nurseMemberId, providerKind: "INDIVIDUAL", gender: "FEMALE", registrationBody: "Maharashtra Nursing Council", registrationNumber: "MNC-7788", servicePincodes: ["411001"], serviceRadiusKm: 15 }, owner);
  await setPoliceVerification(nurseMemberId, "VERIFIED", admin);
}

async function patient() {
  const self = await acceptHealthNotice(customer);
  return updatePatientProfile(self.id, { fullName: "Asha Patil", dateOfBirth: "1950-05-01", gender: "FEMALE", allergies: ["Penicillin"], conditions: ["Diabetes"], emergencyName: "Ravi Patil", emergencyPhone: "9822012345", emergencyRelation: "Son" }, customer);
}

async function book(patientId: string, over: Record<string, unknown> = {}) {
  return bookCareVisit(
    { patientId, serviceId, memberId: nurseMemberId, mode: "HOME_VISIT", start: tomorrowAt("10:00").toISOString(), instructions: "Insulin injection and dressing", shareRecords: "OFF", paymentMode: "PAY_AT_VISIT", visitAddress: "12 MG Road, Pune 411001", visitLatitude: HOME.lat, visitLongitude: HOME.lng, consent: true, ...over },
    customer,
  );
}

beforeEach(async () => {
  await resetDatabase();
  await db.execute(sql`delete from platform_settings where key in ('consultBooking', 'health', 'helpdesk')`);
  admin = actorOf(await createUser({ role: "ADMIN" }));
  owner = actorOf(await createUser({ role: "SHOP_OWNER", name: "Sunita Care" }));
  customer = actorOf(await createUser({ role: "CUSTOMER", name: "Asha Patil" }));
  other = actorOf(await createUser({ role: "CUSTOMER", name: "Ravi" }));
  await rules();
  const shop = await createShop(owner.id, { name: "Sunita Home Nursing", shopType: "DOCTOR_CLINIC", latitude: 18.53, longitude: 73.85 });
  shopId = shop.id;
  await ensureProfile(shopId, owner);
  await updateProfile(shopId, { displayName: "Sunita Home Nursing", headline: "Nursing at home", minNoticeMinutes: 0, manualApproval: true }, owner);
  const [nurse] = await db.select().from(consultCategories).where(eq(consultCategories.slug, "home-nurse"));
  const view = await db.execute<{ id: string }>(sql`select id from consult_members where shop_id = ${shopId} and is_owner`);
  nurseMemberId = view[0].id;
  await saveMember(shopId, { id: nurseMemberId, name: "Sunita Kale", categoryIds: [nurse.id], languages: ["Marathi", "Hindi"], experienceYears: 8, registrationNumber: "MNC-7788", registrationBody: "Maharashtra Nursing Council" }, owner);
  await setMemberHours(shopId, nurseMemberId, EVERY_DAY, owner);
  serviceId = (await saveService(shopId, { name: "Nursing visit (1 hour)", durationMinutes: 60, modes: ["HOME_VISIT"], categoryId: nurse.id, feeType: "FIXED", feeRupees: 800, payOnline: true, payAtVisit: true }, owner)).id;
  await uploadMemberDocument(shopId, nurseMemberId, { name: "mnc.pdf", bytes: PDF }, owner);
  const live = await publishProfile(shopId, owner);
  await verifyProfile(live.id, { decision: "VERIFIED", members: [{ id: nurseMemberId, decision: "VERIFIED" }] }, admin);
});

describe("provider profile, ID card and verification", () => {
  it("gives an ID card number, waits for police verification, then lists the provider", async () => {
    const profile = await saveCareProviderProfile({ memberId: nurseMemberId, gender: "FEMALE", registrationBody: "Maharashtra Nursing Council", registrationNumber: "MNC-7788" }, owner);
    expect(profile.idCardNumber).toMatch(/^GKC-\d{4}-\d{5}$/);
    expect(profile.policeVerification).toBe("PENDING");
    expect((await pendingCareProviders()).map((p) => p.memberId)).toContain(nurseMemberId);
    // Not verified by the police yet: hidden from search; the public card says not verified.
    expect((await searchCareProviders({ category: "home-nurse" })).results).toHaveLength(0);
    expect(await publicIdCard(profile.idCardNumber)).toMatchObject({ name: "Sunita Kale", verified: false });
    await expect(setPoliceVerification(nurseMemberId, "VERIFIED", owner)).rejects.toThrow();
    await setPoliceVerification(nurseMemberId, "VERIFIED", admin);
    const found = await searchCareProviders({ category: "home-nurse", lat: HOME.lat, lng: HOME.lng, gender: "FEMALE", setting: "HOME" });
    expect(found.results).toHaveLength(1);
    expect(found.results[0].providers[0]).toMatchObject({ memberId: nurseMemberId, policeVerified: true, documentVerified: true });
    expect((await searchCareProviders({ category: "home-nurse", gender: "MALE" })).results).toHaveLength(0);
    expect(await publicIdCard(profile.idCardNumber)).toMatchObject({ verified: true, policeVerified: true });
  });

  it("needs the registration for a nursing profile and refuses other people", async () => {
    await expect(saveCareProviderProfile({ memberId: nurseMemberId }, owner)).rejects.toThrow(/registration/i);
    await expect(saveCareProviderProfile({ memberId: nurseMemberId, registrationBody: "X", registrationNumber: "Y" }, other)).rejects.toThrow();
  });

  it("does not book an unverified provider", async () => {
    const p = await patient();
    await expect(book(p.id)).rejects.toThrow(/not verified/);
  });
});

describe("a home visit from booking to rating", () => {
  it("runs the whole visit with OTP check-in / check-out and records the visit note", async () => {
    await verifiedNurse();
    const p = await patient();
    const created = await book(p.id, { sessions: 3 });
    expect(created.visitId).toBeTruthy();
    const visitId = created.visitId!;
    const [visit] = await db.select().from(healthCareVisits).where(eq(healthCareVisits.id, visitId));
    expect(visit).toMatchObject({ status: "SCHEDULED", memberId: nurseMemberId, shareRecords: false, sessionNo: 1 });
    const [pkg] = await db.select().from(healthCarePackages).where(eq(healthCarePackages.id, visit.packageId!));
    expect(pkg).toMatchObject({ sessionsTotal: 3, sessionsDone: 0, status: "ACTIVE" });
    expect(created.booking.status).toBe("PENDING_APPROVAL");

    // The provider's inbox shows it; the provider accepts.
    const inbox = await careInbox(shopId, owner);
    expect(inbox.rows.map((r) => r.visitId)).toContain(visitId);
    await decideCareVisit(visitId, true, owner, null);
    const start = tomorrowAt("10:00");

    // On the way, with location: the patient sees distance and ETA, and the check-in code.
    await startOnTheWay(visitId, { latitude: 18.55, longitude: 73.86 }, owner, minutes(start, -30));
    await updateVisitLocation(visitId, { latitude: 18.53, longitude: 73.857 }, owner, minutes(start, -20));
    const seen = await careVisitForPatient(visitId, customer, minutes(start, -20));
    expect(seen.visit.status).toBe("ON_THE_WAY");
    expect(seen.live?.distanceKm).toBeGreaterThan(0);
    expect(seen.live?.etaMinutes).toBeGreaterThan(0);
    expect(seen.provider.idCard?.idCardNumber).toMatch(/^GKC-/);
    expect(seen.codes.checkIn).toBe(visitCode(visitId, visit.otpSalt, "in"));
    expect(seen.codes.checkOut).toBeNull();

    // A wrong code is counted; the right one starts the visit.
    await expect(checkInVisit(visitId, "0000" === seen.codes.checkIn ? "1111" : "0000", owner, minutes(start, -5))).rejects.toThrow(/not right/);
    expect((await db.select().from(healthCareVisits).where(eq(healthCareVisits.id, visitId)))[0].otpAttempts).toBe(1);
    await checkInVisit(visitId, seen.codes.checkIn, owner, minutes(start, -5));
    const during = await careVisitForPatient(visitId, customer, minutes(start, 10));
    expect(during.visit.status).toBe("IN_PROGRESS");
    expect(during.codes.checkOut).toBe(visitCode(visitId, visit.otpSalt, "out"));

    // Check-out with the second code, notes and vitals.
    const done = await checkOutVisit(visitId, { code: during.codes.checkOut, notes: "Insulin 10 units given. Dressing changed; wound clean.", vitals: { bpSystolic: 130, bpDiastolic: 85, pulse: 76, bloodSugar: 180 } }, owner, minutes(start, 65));
    expect(done.visit.status).toBe("COMPLETED");
    expect(done.bookingCompleted).toBe(true);
    const [doc] = await db.select().from(healthDocuments).where(eq(healthDocuments.id, done.documentId));
    expect(doc).toMatchObject({ patientId: p.id, source: "PROVIDER", kind: "VISIT_NOTE", careVisitId: visitId, contentType: "application/pdf" });
    const note = await careVisitNote(visitId, customer);
    expect(note.data.subarray(0, 5).toString()).toBe("%PDF-");
    const timeline = await db.select().from(healthTimeline).where(and(eq(healthTimeline.patientId, p.id), eq(healthTimeline.kind, "CARE_VISIT")));
    expect(timeline).toHaveLength(1);
    const [b] = await db.select().from(consultBookings).where(eq(consultBookings.id, created.booking.id));
    expect(b.status).toBe("COMPLETED");
    expect((await db.select().from(healthCarePackages).where(eq(healthCarePackages.id, pkg.id)))[0].sessionsDone).toBe(1);
    const events = await db.select({ name: healthEvents.name }).from(healthEvents).where(eq(healthEvents.subjectId, visitId));
    expect(events.map((e) => e.name)).toEqual(expect.arrayContaining(["care_booking.created", "care_booking.accepted", "care_booking.provider_on_the_way", "care_booking.checked_in", "care_booking.checked_out", "care_booking.completed"]));

    // Rating, and the next session of the package is offered.
    const after = await careVisitForPatient(visitId, customer, minutes(start, 70));
    expect(after.can.rate).toBe(true);
    expect(after.package).toMatchObject({ sessionsTotal: 3, sessionsDone: 1, canBookNext: true });
    expect(after.visit.notes).toContain("Insulin");
    await rateCareVisit(visitId, { rating: 5, review: "Very gentle and on time" }, customer);
    expect((await db.select().from(consultBookings).where(eq(consultBookings.id, created.booking.id)))[0].rating).toBe(5);

    // The next session joins the same package.
    const next = await book(p.id, { packageId: pkg.id, start: istAt(addDays(istDateKey(new Date()), 2), 10 * 60).toISOString() });
    expect((await db.select().from(healthCareVisits).where(eq(healthCareVisits.id, next.visitId!)))[0]).toMatchObject({ packageId: pkg.id, sessionNo: 2 });

    // Earnings list (pay at visit: nothing online yet, so no payout line).
    const earnings = await careEarnings(shopId, owner, { toKey: addDays(istDateKey(new Date()), 3) });
    expect(earnings.rows.map((r) => r.bookingNumber)).toContain(b.bookingNumber);
  });

  it("locks the code after too many wrong tries", async () => {
    await rules({ careOtpMaxAttempts: 2 });
    await verifiedNurse();
    const p = await patient();
    const { visitId } = await book(p.id);
    await decideCareVisit(visitId!, true, owner, null);
    const start = tomorrowAt("10:00");
    const [v] = await db.select().from(healthCareVisits).where(eq(healthCareVisits.id, visitId!));
    const right = visitCode(v.id, v.otpSalt, "in");
    const wrong = right === "0000" ? "1111" : "0000";
    await expect(checkInVisit(visitId!, wrong, owner, start)).rejects.toThrow(/1 tries left/);
    await expect(checkInVisit(visitId!, wrong, owner, start)).rejects.toThrow(/No tries left/);
    await expect(checkInVisit(visitId!, right, owner, start)).rejects.toThrow(/Too many wrong codes/);
  });
});

describe("records and privacy", () => {
  it("shows the patient's records only when shared for the booking, and logs the look", async () => {
    await verifiedNurse();
    const p = await patient();
    const unshared = await book(p.id, { shareRecords: "OFF" });
    const view1 = await careVisitForProvider(unshared.visitId!, owner);
    expect(view1.sharedRecords).toBeNull();
    expect(view1.instructions).toBe("Insulin injection and dressing");
    expect(view1.booking.visitAddress).toContain("MG Road");
    const careLooks = () => db.select().from(healthAccessLog).where(and(eq(healthAccessLog.patientId, p.id), eq(healthAccessLog.objectType, "care_visit")));
    expect(await careLooks()).toHaveLength(0);

    const shared = await book(p.id, { shareRecords: "ON", start: tomorrowAt("15:00").toISOString() });
    const view2 = await careVisitForProvider(shared.visitId!, owner);
    expect(view2.sharedRecords).toMatchObject({ allergies: ["Penicillin"], conditions: ["Diabetes"] });
    const log = await careLooks();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ action: "VIEW", objectType: "care_visit", objectId: shared.visitId });

    // Nobody else sees the visit (neither side).
    await expect(careVisitForProvider(shared.visitId!, other)).rejects.toThrow();
    await expect(careVisitForPatient(shared.visitId!, other)).rejects.toThrow();
    // The customer is not the provider.
    await expect(careVisitForProvider(shared.visitId!, customer)).rejects.toThrow();
  });
});

describe("SOS", () => {
  it("texts the emergency contact, opens an urgent support ticket and tells the practice", async () => {
    await verifiedNurse();
    const p = await patient();
    const { visitId, booking } = await book(p.id);
    await decideCareVisit(visitId!, true, owner, null);
    const start = tomorrowAt("10:00");
    const [v] = await db.select().from(healthCareVisits).where(eq(healthCareVisits.id, visitId!));
    await checkInVisit(visitId!, visitCode(v.id, v.otpSalt, "in"), owner, start);
    const result = await careSos(visitId!, { latitude: HOME.lat, longitude: HOME.lng }, customer, minutes(start, 20));
    expect(result.smsSent).toBe(true);
    expect(result.ticketNumber).toBeTruthy();
    const [ticket] = await db.select().from(supportTickets).where(eq(supportTickets.ticketNumber, result.ticketNumber!));
    expect(ticket).toMatchObject({ priority: "URGENT", shopId });
    const sms = await db.select().from(outboundTestMessages).where(eq(outboundTestMessages.purpose, "health-care-sos"));
    expect(sms.some((m) => m.body.includes(booking.bookingNumber) && m.toAddress.includes("9822012345"))).toBe(true);
    const events = await db.select({ name: healthEvents.name }).from(healthEvents).where(and(eq(healthEvents.subjectId, visitId!), eq(healthEvents.name, "care_booking.sos")));
    expect(events).toHaveLength(1);
    expect((await db.select().from(healthCareVisits).where(eq(healthCareVisits.id, visitId!)))[0].sosAt).not.toBeNull();
  });
});
