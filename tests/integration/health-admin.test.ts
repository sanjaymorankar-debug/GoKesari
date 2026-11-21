/**
 * GoKesari Health — admin and operator tools (owner brief §6, §7), against real PostgreSQL and through
 * the real route handlers (/api/admin/health, /api/health/export):
 *   - customers and shop owners get 403 on every admin view and action; signed-out callers 401
 *   - operators verify medical / equipment stores and see the operator tabs only; they cannot break glass
 *   - doctor and home-care verification queues (doctor details, certificates, police verification)
 *   - break-glass: admins only, a reason of 20+ characters, BREAK_GLASS in the patient's access log,
 *     an audit row and a mandatory notice to the account holder
 *   - reports, access log and audit rows carry no clinical text
 *   - drug master CSV import (update + add + rules), ICD-10 import, equipment master CRUD
 *   - DPDP: the patient downloads their own data only; staff close the request
 */
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | { user: { id: string; email: string; name: string | null; image: string | null; role: UserRole; status: "ACTIVE" } },
}));

vi.mock("@/server/auth", () => ({
  auth: async () => state.session,
  handlers: {},
  signIn: async () => {},
  signOut: async () => {},
}));

import { GET as adminGet, POST as adminPost } from "@/app/api/admin/health/route";
import { GET as exportGet } from "@/app/api/health/export/route";
import { addDays, istAt, istDateKey } from "@/lib/consult/time";
import { resetRateLimits } from "@/server/api/rate-limit";
import { RULES } from "@/server/config/rules";
import type { ConsultActor } from "@/server/consult/access";
import { verifyProfile } from "@/server/consult/admin";
import { ensureProfile, publishProfile, saveMember, saveService, setMemberHours, updateProfile, uploadMemberDocument } from "@/server/consult/setup";
import { db } from "@/server/db";
import {
  auditLogs,
  consultCategories,
  healthAccessLog,
  healthCareProviderProfiles,
  healthDataRequests,
  healthDrugMaster,
  healthEquipmentListings,
  healthEquipmentMaster,
  healthEquipmentStoreProfiles,
  healthEvents,
  healthIcd10,
  healthPharmacyProfiles,
  notifications,
} from "@/server/db/schema";
import { doctorStatus } from "@/server/health/access";
import { healthAdminTabs } from "@/server/health/admin";
import { createHealthBooking } from "@/server/health/booking";
import { saveConsultationDraft, startConsultation } from "@/server/health/consultations";
import { saveDoctorProfile } from "@/server/health/doctors";
import { saveDrug } from "@/server/health/drugs";
import { acceptHealthNotice, addFamilyMember, requestDataAction, updatePatientProfile } from "@/server/health/patients";
import { issuePrescription } from "@/server/health/prescriptions";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { call } from "../helpers/http";
import { createShop, createUser, resetDatabase } from "../helpers/fixtures";

const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF");
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: "00:00", end: "23:59" }));
const API = "/api/admin/health";
const CLINICAL = ["Fever", "fever", "Asthma", "Penicillin", "body ache", "Paracetamol", "Plenty of fluids", "Asha Patil"];

type U = { id: string; email: string; name: string | null; role: UserRole };
let admin: U;
let operator: U;
let owner: U;
let customer: U;
let customer2: U;
const actor = (u: U): ConsultActor => ({ id: u.id, role: u.role, name: u.name });
const signIn = (u: U | null) => {
  state.session = u ? { user: { id: u.id, email: u.email, name: u.name, image: null, role: u.role, status: "ACTIVE" } } : null;
};
const get = (u: U | null, query: string) => {
  signIn(u);
  return call(adminGet, `${API}?${query}`);
};
const post = (u: U | null, body: Record<string, unknown>) => {
  signIn(u);
  return call(adminPost, API, { method: "POST", body });
};
const uniq = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

async function rules(over: Record<string, unknown> = {}) {
  await setRule("consultBooking", { ...RULES.consultBooking.defaults, enabled: true }, actor(admin));
  await setRule("health", { ...RULES.health.defaults, enabled: true, freeListingManualApproval: false, ...over }, actor(admin));
  clearRuleCache();
}

/** A clinic with one doctor (general physician) whose certificate is uploaded and practice published (PENDING). */
async function clinic() {
  const shop = await createShop(owner.id, { name: "Mehta Clinic", shopType: "DOCTOR_CLINIC", latitude: 18.5204, longitude: 73.8567 });
  await ensureProfile(shop.id, actor(owner));
  await updateProfile(shop.id, { displayName: "Mehta Family Clinic", headline: "General physician", minNoticeMinutes: 0 }, actor(owner));
  const [gp] = await db.select().from(consultCategories).where(eq(consultCategories.slug, "general-physician"));
  const view = await db.execute<{ id: string }>(sql`select id from consult_members where shop_id = ${shop.id} and is_owner`);
  const doctorMemberId = view[0].id;
  await saveMember(shop.id, { id: doctorMemberId, name: "Dr Anil Mehta", categoryIds: [gp.id], languages: ["English"], registrationNumber: "MMC-12345", registrationBody: "Maharashtra Medical Council" }, actor(owner));
  await setMemberHours(shop.id, doctorMemberId, EVERY_DAY, actor(owner));
  const serviceId = (await saveService(shop.id, { name: "Consultation", durationMinutes: 15, modes: ["IN_PERSON"], categoryId: gp.id, feeType: "FREE" }, actor(owner))).id;
  await uploadMemberDocument(shop.id, doctorMemberId, { name: "mmc.pdf", bytes: PDF }, actor(owner));
  const profile = await publishProfile(shop.id, actor(owner));
  await saveDoctorProfile(doctorMemberId, { fullName: "Anil Mehta", qualifications: "MBBS, MD (Medicine)", specialties: ["General Medicine"], council: "Maharashtra Medical Council", registrationNumber: "MMC-12345", registrationYear: 2008 }, actor(owner));
  return { shopId: shop.id, profileId: profile.id, doctorMemberId, serviceId, gpId: gp.id };
}

/** A completed consultation with a prescription (diagnosis "Fever, unspecified") for the customer's own record. */
async function consultedPatient() {
  const c = await clinic();
  await verifyProfile(c.profileId, { decision: "VERIFIED", members: [{ id: c.doctorMemberId, decision: "VERIFIED" }] }, actor(admin));
  const self = await acceptHealthNotice(actor(customer));
  await updatePatientProfile(self.id, { fullName: "Asha Patil", dateOfBirth: "1990-05-01", gender: "FEMALE", bloodGroup: "B+", allergies: ["Penicillin"], conditions: ["Asthma"] }, actor(customer));
  const start = istAt(addDays(istDateKey(new Date()), 1), 10 * 60);
  const created = await createHealthBooking({ patientId: self.id, serviceId: c.serviceId, memberId: c.doctorMemberId, mode: "IN_PERSON", start: start.toISOString(), reason: "Fever for 3 days", shareRecords: "OFF", consent: true }, actor(customer));
  const consult = await startConsultation({ memberId: c.doctorMemberId, bookingId: created.booking.id }, actor(owner));
  await saveConsultationDraft(consult.id, { vitals: { pulse: 78, temperatureC: 38.2 }, chiefComplaints: "Fever, body ache", diagnoses: [{ code: "R50.9", text: "Fever, unspecified" }], advice: "Plenty of fluids" }, actor(owner));
  const [para] = await db.select().from(healthDrugMaster).where(and(eq(healthDrugMaster.genericName, "Paracetamol"), eq(healthDrugMaster.strength, "500 mg")));
  const issued = await issuePrescription(consult.id, { items: [{ drugId: para.id, genericName: "Paracetamol", dose: "1 tablet", frequency: "1-1-1", timing: "AFTER_FOOD", durationDays: 3 }], suggestions: [{ type: "FOLLOW_UP", followUpDate: addDays(istDateKey(new Date()), 7) }] }, actor(owner));
  return { ...c, patientId: self.id, bookingId: created.booking.id, prescriptionId: issued.prescription.id };
}

beforeEach(async () => {
  state.session = null;
  resetRateLimits();
  await resetDatabase();
  await db.execute(sql`delete from platform_settings where key in ('consultBooking', 'health')`);
  admin = await createUser({ role: "ADMIN", name: "Admin" });
  operator = await createUser({ role: "OPERATOR", name: "Opal Operator" });
  owner = await createUser({ role: "SHOP_OWNER", name: "Dr Anil Mehta" });
  customer = await createUser({ role: "CUSTOMER", name: "Asha Patil" });
  customer2 = await createUser({ role: "CUSTOMER", name: "Ravi" });
  await rules();
});

describe("who may use the Health admin API", () => {
  const VIEWS = ["view=providers", "view=specialties", "view=providers&kind=CARE", `view=documents&member=${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}`, "view=stores", "view=stores&kind=EQUIPMENT", `view=legal&shopId=${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}`, "view=drugs", "view=careCategories", "view=equipment", "view=settings", "view=report", "view=accessLog", "view=audit", "view=dataRequests"];
  const ACTIONS = ["decideProvider", "police", "decideStore", "drug", "importDrugs", "importIcd", "equipment", "deleteEquipment", "findPatient", "breakGlass", "dataRequest"];

  it("gives customers and shop owners 403 on every view and action, and signed-out callers 401", async () => {
    for (const who of [customer, owner]) {
      for (const v of VIEWS) expect((await get(who, v)).status, `${who.role} GET ${v}`).toBe(403);
      for (const a of ACTIONS) expect((await post(who, { action: a, patientId: customer.id, reason: "x".repeat(30) })).status, `${who.role} POST ${a}`).toBe(403);
    }
    expect((await get(null, "view=providers")).status).toBe(401);
    expect((await post(null, { action: "breakGlass" })).status).toBe(401);
  });

  it("offers operators the operator tabs only; admins see everything", () => {
    expect(healthAdminTabs(operator)).toEqual(["verify", "specialties", "drugs", "lists", "reports", "logs", "requests"]);
    expect(healthAdminTabs(admin)).toEqual(["verify", "specialties", "drugs", "lists", "prime", "settings", "reports", "logs", "breakglass", "requests", "support"]);
    expect(healthAdminTabs(customer)).toEqual([]);
    expect(healthAdminTabs(owner)).toEqual([]);
  });

  it("lists every medical practitioner by Health group, consultant and shop categories side by side (0160)", async () => {
    const res = await get(operator, "view=specialties");
    expect(res.status).toBe(200);
    type Group = { key: string; specialties: { slug: string; inDoctorSearch: boolean }[]; shopCategories: { name: string }[] };
    const groups = new Map((res.body.groups as Group[]).map((g) => [g.key, g]));
    expect([...groups.keys()]).toEqual(expect.arrayContaining(["general", "specialists", "women-child", "dental", "eye-ent", "mind", "therapy", "ayush", "diagnostics", "animal", "home-care"]));
    const specialists = groups.get("specialists")!;
    expect(specialists.specialties.map((s) => s.slug)).toEqual(expect.arrayContaining(["cardiologist", "neurologist", "nephrologist", "dermatologist", "orthopaedic"]));
    expect(specialists.specialties.find((s) => s.slug === "cardiologist")?.inDoctorSearch).toBe(true);
    expect(specialists.shopCategories.map((c) => c.name)).toEqual(expect.arrayContaining(["Cardiologist", "Nephrologist", "Dermatologist"]));
    // Speech therapists need an RCI registration, not a medical one: listed under Therapy, not on "Find a doctor".
    expect(groups.get("therapy")!.specialties.find((s) => s.slug === "speech-therapist")?.inDoctorSearch).toBe(false);
    expect(groups.get("home-care")!.specialties.map((s) => s.slug)).toContain("home-nurse");
  });
});

describe("store verification by an operator", () => {
  it("verifies a medical store (reason needed to reject), tells the owner, and cannot break glass or read settings", async () => {
    const shop = await createShop(owner.id, { name: "Kesari Medicals", shopType: "PHARMACY" });
    await db.insert(healthPharmacyProfiles).values({ shopId: shop.id, drugLicenceNumber: "MH-PUN-20B-12345", pharmacistName: "R. Joshi", pharmacistRegistrationNumber: "PCI-778899", pharmacyCouncil: "Maharashtra State Pharmacy Council" });
    const queue = await get(operator, "view=stores&kind=PHARMACY");
    expect(queue.status).toBe(200);
    expect(queue.body.stores).toHaveLength(1);
    expect(queue.body.stores[0]).toMatchObject({ shopId: shop.id, verification: "PENDING" });
    expect(queue.body.stores[0].details.map((d: { value: string }) => d.value)).toContain("MH-PUN-20B-12345");
    expect((await get(operator, `view=legal&shopId=${shop.id}`)).status).toBe(200);

    expect((await post(operator, { action: "decideStore", kind: "PHARMACY", shopId: shop.id, decision: "REJECTED" })).status).toBe(422);
    const ok = await post(operator, { action: "decideStore", kind: "PHARMACY", shopId: shop.id, decision: "VERIFIED" });
    expect(ok.status).toBe(200);
    const [row] = await db.select().from(healthPharmacyProfiles).where(eq(healthPharmacyProfiles.shopId, shop.id));
    expect(row).toMatchObject({ verification: "VERIFIED", verifiedBy: operator.id });
    expect(row.verifiedAt).toBeInstanceOf(Date);
    expect(await db.select().from(healthEvents).where(and(eq(healthEvents.name, "provider.verified"), eq(healthEvents.shopId, shop.id)))).toHaveLength(1);
    expect(await db.select().from(notifications).where(and(eq(notifications.userId, owner.id), eq(notifications.type, "health.verification")))).toHaveLength(1);
    expect(await db.select().from(auditLogs).where(and(eq(auditLogs.action, "health.provider_verified"), eq(auditLogs.entityId, shop.id)))).toHaveLength(1);
    expect((await get(operator, "view=stores&kind=PHARMACY")).body.stores).toHaveLength(0); // no longer pending
    expect((await get(operator, "view=stores&kind=PHARMACY&status=VERIFIED")).body.stores).toHaveLength(1);

    // Equipment stores: rejected with a note.
    const eq2 = await createShop(owner.id, { name: "Care Rentals", shopType: "MEDICAL_EQUIPMENT" });
    await db.insert(healthEquipmentStoreProfiles).values({ shopId: eq2.id, rentalTerms: "Weekly rent, deposit refunded on return." });
    expect((await post(operator, { action: "decideStore", kind: "EQUIPMENT", shopId: eq2.id, decision: "REJECTED", note: "Upload the shop's trade licence." })).status).toBe(200);
    const [es] = await db.select().from(healthEquipmentStoreProfiles).where(eq(healthEquipmentStoreProfiles.shopId, eq2.id));
    expect(es).toMatchObject({ verification: "REJECTED", verificationNote: "Upload the shop's trade licence." });
    expect(await db.select().from(healthEvents).where(and(eq(healthEvents.name, "provider.rejected"), eq(healthEvents.shopId, eq2.id)))).toHaveLength(1);

    // Operators never break glass and do not see the settings tab.
    const self = await acceptHealthNotice(actor(customer));
    expect((await post(operator, { action: "breakGlass", patientId: self.id, reason: "Patient collapsed at the clinic, need allergy list" })).status).toBe(403);
    expect((await post(operator, { action: "findPatient", q: customer.email })).status).toBe(403);
    expect((await get(operator, "view=settings")).status).toBe(403);
    expect(await db.select().from(healthAccessLog).where(eq(healthAccessLog.patientId, self.id))).toHaveLength(0);
  });
});

describe("doctor and home-care verification", () => {
  it("shows the doctor's registration details and certificates, and approval makes the doctor verified for Health", async () => {
    const c = await clinic();
    expect((await doctorStatus(c.doctorMemberId)).verified).toBe(false);
    const queue = await get(admin, "view=providers&kind=DOCTOR");
    expect(queue.status).toBe(200);
    expect(queue.body.providers).toHaveLength(1);
    const card = queue.body.providers[0];
    expect(card).toMatchObject({ profileId: c.profileId, verification: "PENDING" });
    expect(card.members[0]).toMatchObject({ id: c.doctorMemberId, docStatus: "SUBMITTED", documents: 1, doctor: { fullName: "Anil Mehta", council: "Maharashtra Medical Council", registrationNumber: "MMC-12345", registrationYear: 2008 } });
    const docs = await get(admin, `view=documents&member=${c.doctorMemberId}`);
    expect(docs.body.documents).toHaveLength(1);
    expect(docs.body.documents[0].fileName).toBe("mmc.pdf");
    expect((await get(admin, "view=providers&kind=CARE")).body.providers).toHaveLength(0); // a GP is not home care

    expect((await post(operator, { action: "decideProvider", kind: "DOCTOR", profileId: c.profileId, decision: "REJECTED", memberIds: [c.doctorMemberId] })).status).toBe(422);
    const res = await post(operator, { action: "decideProvider", kind: "DOCTOR", profileId: c.profileId, decision: "VERIFIED", memberIds: [c.doctorMemberId] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ verification: "VERIFIED", members: 1 });
    expect((await doctorStatus(c.doctorMemberId)).verified).toBe(true);
    expect(await db.select().from(healthEvents).where(and(eq(healthEvents.name, "provider.verified"), eq(healthEvents.subjectId, c.profileId)))).toHaveLength(1);
    expect(await db.select().from(notifications).where(and(eq(notifications.userId, owner.id), eq(notifications.type, "health.verification")))).toHaveLength(1);
    expect((await get(admin, "view=providers&kind=DOCTOR")).body.providers).toHaveLength(0);
    expect((await get(admin, "view=providers&kind=DOCTOR&status=VERIFIED")).body.providers).toHaveLength(1);
  });

  it("lists home-care providers with their details and records police verification", async () => {
    const c = await clinic();
    const [nurse] = await db.select().from(consultCategories).where(eq(consultCategories.slug, "home-nurse"));
    const member = await saveMember(c.shopId, { name: "Sister Mary", categoryIds: [nurse.id], languages: ["English"] }, actor(owner));
    await db.insert(healthCareProviderProfiles).values({ memberId: member.id, shopId: c.shopId, gender: "FEMALE", careCategories: ["home-nurse"], idCardNumber: `GKC-${uniq()}`, policeVerification: "PENDING", servicePincodes: ["411001"] });
    const queue = await get(operator, "view=providers&kind=CARE&status=ALL");
    expect(queue.body.providers).toHaveLength(1);
    expect(queue.body.providers[0].members.map((m: { name: string }) => m.name)).toEqual(["Sister Mary"]);
    expect(queue.body.providers[0].members[0].care).toMatchObject({ policeVerification: "PENDING", servicePincodes: ["411001"] });
    expect((await post(operator, { action: "police", memberId: member.id, status: "SOMETHING" })).status).toBe(422);
    const res = await post(operator, { action: "police", memberId: member.id, status: "VERIFIED" });
    expect(res.status).toBe(200);
    const [cp] = await db.select().from(healthCareProviderProfiles).where(eq(healthCareProviderProfiles.memberId, member.id));
    expect(cp.policeVerification).toBe("VERIFIED");
    expect(await db.select().from(auditLogs).where(and(eq(auditLogs.action, "health.provider_verified"), eq(auditLogs.entityType, "health_care_provider")))).toHaveLength(1);
  });
});

describe("break-glass", () => {
  it("needs an admin, the rule and a 20-character reason; logs BREAK_GLASS, audits and tells the account holder", async () => {
    const self = await acceptHealthNotice(actor(customer));
    await updatePatientProfile(self.id, { fullName: "Asha Patil", dateOfBirth: "1990-05-01", allergies: ["Penicillin"], conditions: ["Asthma"] }, actor(customer));
    const child = await addFamilyMember({ fullName: "Riya Patil", relation: "CHILD", dateOfBirth: "2018-03-01", dependent: true }, actor(customer));

    // Finding by the account's e-mail shows initials only.
    const found = await post(admin, { action: "findPatient", q: customer.email });
    expect(found.status).toBe(200);
    expect(found.body.patients.map((p: { id: string }) => p.id).sort()).toEqual([self.id, child.patient.id].sort());
    expect(found.body.patients.find((p: { id: string }) => p.id === self.id)).toMatchObject({ initials: "A.P.", relation: "SELF", birthYear: "1990" });
    expect(JSON.stringify(found.body)).not.toMatch(/Asha|Asthma|Penicillin/);

    const reason = "Patient brought unconscious to the ER; need allergies now";
    expect((await post(admin, { action: "breakGlass", patientId: self.id, reason: "Emergency" })).status).toBe(422);
    await rules({ breakGlassEnabled: false });
    expect((await post(admin, { action: "breakGlass", patientId: self.id, reason })).status).toBe(403);
    expect(await db.select().from(healthAccessLog).where(eq(healthAccessLog.action, "BREAK_GLASS"))).toHaveLength(0);
    await rules();

    const res = await post(admin, { action: "breakGlass", patientId: self.id, reason });
    expect(res.status).toBe(200);
    expect(res.body.patient).toMatchObject({ id: self.id, fullName: "Asha Patil", allergies: ["Penicillin"], conditions: ["Asthma"] });
    expect(new Date(res.body.expiresAt).getTime() - new Date(res.body.openedAt).getTime()).toBe(30 * 60_000);
    expect(res.body.timeline.length).toBeGreaterThan(0);

    const logs = await db.select().from(healthAccessLog).where(and(eq(healthAccessLog.patientId, self.id), eq(healthAccessLog.action, "BREAK_GLASS")));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ actorUserId: admin.id, actorRole: "ADMIN", reason, objectType: "patient" });
    const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.action, "health.break_glass"), eq(auditLogs.entityId, self.id)));
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0].newValue)).not.toContain("unconscious"); // the reason stays in the access log
    const told = await db.select().from(notifications).where(and(eq(notifications.userId, customer.id), eq(notifications.type, "health.break_glass")));
    expect(told).toHaveLength(1);
    expect(told[0].body).not.toMatch(/Asthma|Penicillin/);
    expect(await db.select().from(healthEvents).where(and(eq(healthEvents.name, "record.accessed"), eq(healthEvents.subjectId, self.id)))).toHaveLength(1);

    // Every open is a new, logged open.
    expect((await post(admin, { action: "breakGlass", patientId: self.id, reason })).status).toBe(200);
    expect(await db.select().from(healthAccessLog).where(and(eq(healthAccessLog.patientId, self.id), eq(healthAccessLog.action, "BREAK_GLASS")))).toHaveLength(2);

    // The access log tab: admins see the reason, operators only that one was recorded.
    const asAdmin = await get(admin, "view=accessLog&action=BREAK_GLASS");
    expect(asAdmin.body.rows[0]).toMatchObject({ patientId: self.id, patient: "A.P.", reason, hasReason: true });
    const asOperator = await get(operator, "view=accessLog&action=BREAK_GLASS");
    expect(asOperator.body.rows[0]).toMatchObject({ patient: "A.P.", reason: null, hasReason: true });
  });
});

describe("reports and logs are metadata only", () => {
  it("counts bookings and prescriptions without any diagnosis, complaint, condition or medicine text", async () => {
    const p = await consultedPatient();
    await post(admin, { action: "breakGlass", patientId: p.patientId, reason: "Patient collapsed at home, family asked for help" });
    const today = istDateKey(new Date());
    for (const granularity of ["day", "week", "month"]) {
      const r = await get(operator, `view=report&granularity=${granularity}&from=${addDays(today, -1)}&to=${addDays(today, 2)}`);
      expect(r.status).toBe(200);
      const text = JSON.stringify(r.body);
      for (const s of CLINICAL) expect(text, `${granularity} report contains "${s}"`).not.toContain(s);
      const table = (key: string) => r.body.tables.find((t: { key: string }) => t.key === key);
      expect(table("bookings").rows.at(-1).slice(0, 2)).toEqual(["Total", 1]);
      expect(table("prescriptions").rows.at(-1).slice(0, 3)).toEqual(["Total", 1, 0]);
      expect(table("consents").rows.at(-1)[1]).toBeGreaterThanOrEqual(1); // the My Health notice
    }
    for (const who of [admin, operator]) {
      const log = await get(who, "view=accessLog");
      expect(log.status).toBe(200);
      expect(log.body.rows.length).toBeGreaterThan(0);
      const audit = await get(who, "view=audit");
      expect(audit.body.rows.some((a: { action: string }) => a.action === "health.prescription_issued")).toBe(true);
      for (const s of CLINICAL) {
        expect(JSON.stringify(log.body), `access log contains "${s}"`).not.toContain(s);
        expect(JSON.stringify(audit.body), `audit contains "${s}"`).not.toContain(s);
      }
    }
    const csvMissing = await get(operator, "view=report&from=2026-12-31&to=2026-01-01");
    expect(csvMissing.status).toBe(422);
  });
});

describe("drug master and lists", () => {
  it("imports a medicines CSV: updates the same medicine, adds new ones, applies the Schedule X rule and reports bad lines", async () => {
    const tag = uniq();
    const generic = `Testocillin ${tag}`;
    try {
      const existing = await saveDrug({ genericName: generic, brandName: "TestBrand", strength: "250 mg", form: "CAPSULE", schedule: "H", rxRequired: true, teleList: "A", onlineSaleAllowed: true }, actor(admin));
      const csv = [
        "generic_name,brand_name,strength,form,schedule,rx_required,tele_list,online_sale_allowed,manufacturer",
        `${generic},TestBrand,250 mg,CAPSULE,H1,yes,B,yes,Test Labs`,
        `Testamol ${tag},Testamol,650 mg,TABLET,OTC,no,O,yes,Test Labs`,
        `"Testazepam ${tag}, slow",Testcalm,5 mg,TABLET,X,yes,A,yes,Test Labs`,
        `Testbottle ${tag},,10 ml,BOTTLE,H,yes,A,yes,`,
      ].join("\n");
      const res = await post(operator, { action: "importDrugs", csv });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ added: 2, updated: 1 });
      expect(res.body.errors).toHaveLength(1);
      const [updated] = await db.select().from(healthDrugMaster).where(eq(healthDrugMaster.id, existing.id));
      expect(updated).toMatchObject({ schedule: "H1", teleList: "B", manufacturer: "Test Labs" });
      const [x] = await db.select().from(healthDrugMaster).where(eq(healthDrugMaster.genericName, `Testazepam ${tag}, slow`));
      expect(x).toMatchObject({ schedule: "X", teleList: "PROHIBITED", onlineSaleAllowed: false });
      const list = await get(operator, `view=drugs&q=${encodeURIComponent(tag)}`);
      expect(list.body.drugs).toHaveLength(3);
      expect(list.body.stats.drugs).toBeGreaterThanOrEqual(3);
      // Add / edit through the API.
      const saved = await post(operator, { action: "drug", drug: { id: existing.id, genericName: generic, brandName: "TestBrand", strength: "250 mg", form: "CAPSULE", schedule: "H", rxRequired: true, teleList: "A", onlineSaleAllowed: false } });
      expect(saved.body.drug).toMatchObject({ id: existing.id, onlineSaleAllowed: false });
      // ICD-10.
      const icd = await post(operator, { action: "importIcd", csv: `code,title,chapter\nU99.T${tag.slice(0, 3).toUpperCase().replace(/[^A-Z0-9]/g, "Z")},"Test code, ${tag}",XXII\nnot-a-code,Nothing` });
      expect(icd.body).toEqual({ added: 1 });
    } finally {
      await db.delete(healthDrugMaster).where(like(healthDrugMaster.genericName, `%${tag}%`));
      await db.delete(healthIcd10).where(like(healthIcd10.title, `%${tag}%`));
    }
  });

  it("keeps the equipment master: add, edit, duplicate short name refused, delete only when no store lists it", async () => {
    const tag = uniq();
    const ids: string[] = [];
    try {
      const added = await post(operator, { action: "equipment", item: { name: `Test walker ${tag}`, category: "Mobility" } });
      expect(added.status).toBe(200);
      const item = added.body.item;
      ids.push(item.id);
      expect(item).toMatchObject({ slug: `test-walker-${tag}`, status: "ACTIVE", rxRequired: false });
      expect((await get(operator, "view=equipment")).body.items.some((i: { id: string }) => i.id === item.id)).toBe(true);
      const edited = await post(operator, { action: "equipment", item: { id: item.id, name: `Test walker ${tag}`, slug: item.slug, category: "Walking aids", rxRequired: true, status: "INACTIVE", sortOrder: 5 } });
      expect(edited.body.item).toMatchObject({ category: "Walking aids", rxRequired: true, status: "INACTIVE", sortOrder: 5 });
      expect((await post(operator, { action: "equipment", item: { name: "Another", slug: item.slug } })).status).toBe(409);
      // Listed by a store: delete refused.
      const shop = await createShop(owner.id, { name: "Care Rentals", shopType: "MEDICAL_EQUIPMENT" });
      const [listing] = await db.insert(healthEquipmentListings).values({ shopId: shop.id, masterId: item.id, name: "Walker" }).returning();
      expect((await post(operator, { action: "deleteEquipment", id: item.id })).status).toBe(409);
      await db.delete(healthEquipmentListings).where(eq(healthEquipmentListings.id, listing.id));
      expect((await post(operator, { action: "deleteEquipment", id: item.id })).status).toBe(200);
      expect(await db.select().from(healthEquipmentMaster).where(eq(healthEquipmentMaster.id, item.id))).toHaveLength(0);
      expect((await get(operator, "view=careCategories")).body.categories.map((c: { name: string }) => c.name)).toEqual(expect.arrayContaining(["Nurse (home care)", "Physiotherapist"]));
    } finally {
      if (ids.length) await db.delete(healthEquipmentMaster).where(inArray(healthEquipmentMaster.id, ids));
    }
  });
});

describe("DPDP data requests", () => {
  it("lets the patient download only their own account's data, and staff close the request", async () => {
    const self = await acceptHealthNotice(actor(customer));
    const child = await addFamilyMember({ fullName: "Riya Patil", relation: "CHILD", dateOfBirth: "2018-03-01", dependent: true }, actor(customer));
    const other = await acceptHealthNotice(actor(customer2));
    const request = await requestDataAction("EXPORT", actor(customer), "Please send everything");

    signIn(null);
    expect((await call(exportGet, "/api/health/export")).status).toBe(401);
    signIn(customer);
    const exp = await call(exportGet, "/api/health/export");
    expect(exp.status).toBe(200);
    expect(exp.body.format).toBe("gokesari-health-export-v1");
    expect(exp.body.patients.map((p: { id: string }) => p.id).sort()).toEqual([self.id, child.patient.id].sort());
    expect(JSON.stringify(exp.body)).not.toContain(other.id);
    expect(exp.body.consents.some((c: { kind: string }) => c.kind === "HEALTH_NOTICE")).toBe(true);
    expect(exp.body.dataRequests).toHaveLength(1);
    expect(await db.select().from(healthAccessLog).where(and(eq(healthAccessLog.action, "EXPORT"), inArray(healthAccessLog.patientId, [self.id, child.patient.id])))).toHaveLength(2);

    const list = await get(operator, "view=dataRequests");
    expect(list.body.requests).toHaveLength(1);
    expect(list.body.requests[0]).toMatchObject({ id: request.id, kind: "EXPORT", status: "OPEN", userId: customer.id, patients: 2 });
    expect((await post(operator, { action: "dataRequest", id: request.id, decision: "REJECTED" })).status).toBe(422);
    expect((await post(operator, { action: "dataRequest", id: request.id, decision: "DONE" })).status).toBe(200);
    const [row] = await db.select().from(healthDataRequests).where(eq(healthDataRequests.id, request.id));
    expect(row.status).toBe("DONE");
    expect(row.completedAt).toBeInstanceOf(Date);
    expect(await db.select().from(notifications).where(and(eq(notifications.userId, customer.id), eq(notifications.title, "Your health data request")))).toHaveLength(1);
    expect((await post(operator, { action: "dataRequest", id: request.id, decision: "DONE" })).status).toBe(409);
    expect((await get(operator, "view=dataRequests")).body.requests).toHaveLength(0);
    expect((await get(operator, "view=dataRequests&status=ALL")).body.requests).toHaveLength(1);
  });
});
