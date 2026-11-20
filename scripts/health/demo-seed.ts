/**
 * Local / staging demo data for GoKesari Health (docs/health/): run AFTER scripts/consult-demo-seed.ts.
 * Verifies the Mehta clinic, fills the doctors' registration details, starts the demo customer's record with a
 * family, books an appointment, consults and issues a prescription with suggestions — through the real services.
 *   node --import tsx scripts/health/demo-seed.ts [customer-email] [admin-email]
 * Never run against production.
 */
import { and, eq, sql } from "drizzle-orm";

import { addDays, istAt, istDateKey } from "@/lib/consult/time";
import { RULES } from "@/server/config/rules";
import { verifyProfile } from "@/server/consult/admin";
import { db } from "@/server/db";
import { consultMembers, consultProfiles, consultServices, healthDrugMaster, shops, users } from "@/server/db/schema";
import { createHealthBooking } from "@/server/health/booking";
import { checkInBooking, saveConsultationDraft, startConsultation } from "@/server/health/consultations";
import { saveDoctorProfile } from "@/server/health/doctors";
import { acceptHealthNotice, addFamilyMember, listFamily, updatePatientProfile } from "@/server/health/patients";
import { issuePrescription } from "@/server/health/prescriptions";
import { completionCode } from "@/server/consult/otp";
import { setRule } from "@/server/services/settings";

async function main() {
  if (process.env.AUTH_URL?.includes("gokesari.com") && !process.env.AUTH_URL.includes("test.")) throw new Error("Demo data is for local / test databases only.");
  const customerEmail = process.argv[2] ?? "customer@example.com";
  const adminEmail = process.argv[3] ?? "admin@example.com";
  const [adminUser] = await db.select().from(users).where(eq(users.email, adminEmail));
  const [cust] = await db.select().from(users).where(eq(users.email, customerEmail));
  if (!adminUser || !cust) throw new Error("Run scripts/consult-demo-seed.ts first.");
  const admin = { id: adminUser.id, role: "ADMIN" as const, name: adminUser.name };
  const customer = { id: cust.id, role: cust.role, name: cust.name };
  await setRule("consultBooking", { ...RULES.consultBooking.defaults, enabled: true, reminderHours: [24, 2] }, admin);
  await setRule("health", { ...RULES.health.defaults, enabled: true }, admin);

  const [shop] = await db.select().from(shops).where(eq(shops.slug, "mehta-family-clinic"));
  const owner = { id: shop.ownerId, role: "SHOP_OWNER" as const, name: "Dr Anil Mehta" };
  await db.update(consultProfiles).set({ minNoticeMinutes: 0 }).where(eq(consultProfiles.shopId, shop.id));
  const [profile] = await db.select().from(consultProfiles).where(eq(consultProfiles.shopId, shop.id));
  const members = await db.select().from(consultMembers).where(eq(consultMembers.shopId, shop.id));
  await verifyProfile(profile.id, { decision: "VERIFIED", members: members.map((m) => ({ id: m.id, decision: "VERIFIED" })) }, admin);
  const anil = members.find((m) => m.isOwner)!;
  const neha = members.find((m) => !m.isOwner)!;
  await saveDoctorProfile(anil.id, { fullName: "Anil Mehta", qualifications: "MBBS, MD (Medicine)", specialties: ["General Medicine", "Diabetes"], council: "Maharashtra Medical Council", registrationNumber: "MMC-2008-12345", registrationYear: 2008 }, owner);
  await saveDoctorProfile(neha.id, { fullName: "Neha Rao", qualifications: "MBBS, DCH", specialties: ["Paediatrics"], council: "Maharashtra Medical Council", registrationNumber: "MMC-2015-55555", registrationYear: 2015 }, owner);

  const self = await acceptHealthNotice(customer);
  await updatePatientProfile(self.id, { fullName: cust.name ?? "Asha Patil", dateOfBirth: "1988-04-12", gender: "FEMALE", bloodGroup: "B+", allergies: ["Penicillin"], conditions: ["Asthma"], emergencyName: "Rahul Patil", emergencyPhone: "9800000002", emergencyRelation: "Husband" }, customer);
  const family = await listFamily(customer);
  if (!family.some((p) => p.relation === "CHILD")) await addFamilyMember({ fullName: "Riya Patil", relation: "CHILD", dateOfBirth: "2018-03-01", gender: "FEMALE", dependent: true }, customer);

  const [svc] = await db.select().from(consultServices).where(and(eq(consultServices.shopId, shop.id), eq(consultServices.name, "General consultation")));
  const day = istDateKey(new Date());
  const now = new Date();
  const mins = Math.ceil(((now.getTime() + 330 * 60_000) % 86_400_000) / 60_000 / 15) * 15 + 15;
  const start = istAt(mins < 21 * 60 ? day : addDays(day, 1), mins < 21 * 60 && mins >= 9 * 60 ? mins : 10 * 60);
  const booked = await createHealthBooking({ patientId: self.id, serviceId: svc.id, memberId: anil.id, mode: "IN_PERSON", start: start.toISOString(), reason: "Fever and cough for 3 days", shareRecords: "ASK", paymentMode: "PAY_AT_VISIT", consent: true }, customer);
  await checkInBooking(booked.booking.id, completionCode(booked.booking.id, booked.booking.otpSalt ?? ""), owner).catch(() => undefined);
  const c = await startConsultation({ memberId: anil.id, bookingId: booked.booking.id }, owner);
  await saveConsultationDraft(c.id, { vitals: { bpSystolic: 118, bpDiastolic: 76, pulse: 92, temperatureC: 38.4, spo2: 97, weightKg: 62, heightCm: 160 }, chiefComplaints: "Fever and dry cough for 3 days", examination: "Throat congested, chest clear", diagnoses: [{ code: "J06.9", text: "Acute upper respiratory infection, unspecified" }], investigations: [{ name: "CBC" }], advice: "Warm fluids, rest. Steam inhalation twice a day.", followUpDate: addDays(day, 5) }, owner);
  const drug = async (g: string, s: string) => (await db.select().from(healthDrugMaster).where(and(eq(healthDrugMaster.genericName, g), eq(healthDrugMaster.strength, s))))[0];
  const para = await drug("Paracetamol", "650 mg");
  const cet = await drug("Levocetirizine", "5 mg");
  const rx = await issuePrescription(
    c.id,
    {
      items: [
        { drugId: para.id, genericName: "Paracetamol", strength: "650 mg", dose: "1 tablet", frequency: "1-1-1", timing: "AFTER_FOOD", durationDays: 3, instructions: "Only if temperature above 100°F", instructionsLocal: "बुखार 100°F से ज़्यादा हो तभी लें" },
        { drugId: cet.id, genericName: "Levocetirizine", strength: "5 mg", dose: "1 tablet", frequency: "0-0-1", timing: "BEDTIME", durationDays: 5 },
      ],
      suggestions: [
        { type: "LAB_TEST", tests: ["CBC"], homeCollection: true },
        { type: "FOLLOW_UP", followUpDate: addDays(day, 5) },
        { type: "DOCTOR_REFERRAL", specialty: "Pulmonologist", note: "If cough persists beyond 2 weeks", urgency: "ROUTINE", printOnRx: true },
      ],
    },
    owner,
  );
  const [{ n }] = await db.execute<{ n: number }>(sql`select count(*)::int as n from health.timeline where patient_id = ${self.id}`);
  console.log(`Health demo ready. Customer ${customerEmail}: record with ${n} items; prescription ${rx.prescription.rxNumber} (${rx.prescription.id}). Doctor: ${shop.ownerId}.`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
