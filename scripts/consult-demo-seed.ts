/**
 * Local / staging demo data for consultant appointments (docs/consult-booking-2026-11): a two-doctor clinic
 * and a CA firm, live and bookable, through the real services. Usage (local DB only):
 *   node --import tsx scripts/consult-demo-seed.ts <owner-email> [<admin-email>]
 * Never run against production.
 */
import { eq, sql } from "drizzle-orm";

import { db } from "@/server/db";
import { consultCategories, consultMembers, shops, users } from "@/server/db/schema";
import { RULES } from "@/server/config/rules";
import { ensureProfile, publishProfile, saveMember, saveService, setMemberHours, updateProfile, uploadMemberDocument } from "@/server/consult/setup";
import { setRule } from "@/server/services/settings";

const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF");
const WEEK = [1, 2, 3, 4, 5, 6, 0].flatMap((weekday) => [
  { weekday, start: "09:00", end: "13:00" },
  { weekday, start: "16:00", end: "21:00" },
]);

async function user(email: string, role: "ADMIN" | "CUSTOMER" | "SHOP_OWNER", name: string) {
  const [u] = await db.select().from(users).where(eq(users.email, email));
  if (u) return u;
  const [created] = await db.insert(users).values({ email, role, name, phone: "98" + String(Date.now()).slice(-8) }).returning();
  return created;
}

async function firm(ownerEmail: string, name: string, slug: string, lat: number, lng: number, admin: { id: string; role: "ADMIN" }) {
  if (process.env.AUTH_URL?.includes("gokesari.com")) throw new Error("Demo data is for local databases only.");
  const owner = await user(ownerEmail, "SHOP_OWNER", name + " owner");
  let [shop] = await db.select().from(shops).where(eq(shops.slug, slug));
  if (!shop) {
    [shop] = await db
      .insert(shops)
      .values({ ownerId: owner.id, name, slug, ownerName: owner.name ?? name, phone: "9999999999", addressLine1: "12 FC Road", area: "Shivajinagar", city: "Pune", pincode: "411005", shopType: "CONSULTANT_FIRM", status: "APPROVED", latitude: String(lat), longitude: String(lng), deliveryAvailable: false })
      .returning();
  }
  const actor = { id: owner.id, role: "SHOP_OWNER" as const };
  await ensureProfile(shop.id, actor);
  return { shop, owner, actor };
}

async function main() {
  const adminEmail = process.argv[3] ?? "admin@example.com";
  const adminUser = await user(adminEmail, "ADMIN", "Local Admin");
  const admin = { id: adminUser.id, role: "ADMIN" as const };
  await setRule("consultBooking", { ...RULES.consultBooking.defaults, enabled: true }, admin);
  await user("customer@example.com", "CUSTOMER", "Asha Customer");
  const cat = async (slug: string) => (await db.select().from(consultCategories).where(eq(consultCategories.slug, slug)))[0];

  const clinic = await firm(process.argv[2] ?? "clinic@example.com", "Mehta Family Clinic", "mehta-family-clinic", 18.5308, 73.8475, admin);
  await updateProfile(clinic.shop.id, { displayName: "Mehta Family Clinic", headline: "Family physicians · Shivajinagar", about: "General physician and paediatric care. Walk-in and video consultations.", minNoticeMinutes: 30 }, clinic.actor);
  const [ownerMember] = await db.select().from(consultMembers).where(sql`${consultMembers.shopId} = ${clinic.shop.id} and ${consultMembers.isOwner}`);
  const gp = await cat("general-physician");
  const paed = await cat("paediatrician");
  await saveMember(clinic.shop.id, { id: ownerMember.id, name: "Dr Anil Mehta", title: "General Physician", qualifications: "MBBS, MD", experienceYears: 18, languages: ["English", "Hindi", "Marathi"], categoryIds: [gp.id], registrationNumber: "MMC-2008-12345", registrationBody: "Maharashtra Medical Council", color: "#c2410c" }, clinic.actor);
  const neha = await saveMember(clinic.shop.id, { name: "Dr Neha Rao", title: "Paediatrician", qualifications: "MBBS, DCH", experienceYears: 9, languages: ["English", "Kannada", "Hindi"], categoryIds: [paed.id], registrationNumber: "MMC-2015-55555", registrationBody: "Maharashtra Medical Council", color: "#0f766e" }, clinic.actor);
  for (const m of [ownerMember.id, neha.id]) {
    await setMemberHours(clinic.shop.id, m, WEEK, clinic.actor);
    await uploadMemberDocument(clinic.shop.id, m, { name: "registration.pdf", bytes: PDF }, clinic.actor);
  }
  const existing = await db.execute<{ n: number }>(sql`select count(*)::int as n from consult_services where shop_id = ${clinic.shop.id}`);
  if (!Number(existing[0].n)) {
    await saveService(clinic.shop.id, { name: "General consultation", categoryId: gp.id, durationMinutes: 15, feeType: "FIXED", feeRupees: 400, modes: ["IN_PERSON", "VIDEO"], payOnline: true, payAtVisit: true }, clinic.actor);
    await saveService(clinic.shop.id, { name: "Child check-up", categoryId: paed.id, durationMinutes: 20, feeType: "FIXED", feeRupees: 500, modes: ["IN_PERSON"], memberIds: [neha.id], payOnline: true, payAtVisit: true }, clinic.actor);
    await saveService(clinic.shop.id, { name: "Minor procedure", categoryId: gp.id, durationMinutes: 45, feeType: "DEPOSIT", feeRupees: 2000, depositRupees: 500, modes: ["IN_PERSON"] }, clinic.actor);
    await saveService(clinic.shop.id, { name: "Diabetes diet workshop", categoryId: gp.id, durationMinutes: 60, feeType: "FIXED", feeRupees: 200, bookingKind: "GROUP", capacity: 10, modes: ["IN_PERSON", "VIDEO"], memberIds: [ownerMember.id], payOnline: true, payAtVisit: true }, clinic.actor);
    await saveService(clinic.shop.id, { name: "Joint case review", categoryId: gp.id, durationMinutes: 30, feeType: "FREE", bookingKind: "TEAM", requiredMembers: 2, modes: ["IN_PERSON"] }, clinic.actor);
  }
  await publishProfile(clinic.shop.id, clinic.actor);

  const ca = await firm("ca.firm@example.com", "Kulkarni & Associates", "kulkarni-associates", 18.5167, 73.8414, admin);
  await updateProfile(ca.shop.id, { displayName: "Kulkarni & Associates, Chartered Accountants", headline: "GST, income tax and company law", minNoticeMinutes: 60, manualApproval: true }, ca.actor);
  const [caOwner] = await db.select().from(consultMembers).where(sql`${consultMembers.shopId} = ${ca.shop.id} and ${consultMembers.isOwner}`);
  const icai = await cat("chartered-accountant");
  await saveMember(ca.shop.id, { id: caOwner.id, name: "CA Prakash Kulkarni", title: "Partner", qualifications: "FCA", experienceYears: 22, languages: ["English", "Marathi"], categoryIds: [icai.id], registrationNumber: "ICAI-102938", registrationBody: "ICAI" }, ca.actor);
  await setMemberHours(ca.shop.id, caOwner.id, WEEK, ca.actor);
  await uploadMemberDocument(ca.shop.id, caOwner.id, { name: "icai.pdf", bytes: PDF }, ca.actor);
  const caExisting = await db.execute<{ n: number }>(sql`select count(*)::int as n from consult_services where shop_id = ${ca.shop.id}`);
  if (!Number(caExisting[0].n)) {
    await saveService(ca.shop.id, { name: "Tax consultation", categoryId: icai.id, durationMinutes: 30, feeType: "FIXED", feeRupees: 1000, modes: ["IN_PERSON", "VIDEO", "PHONE"], payOnline: true, payAtVisit: false, gstRatePct: 18 }, ca.actor);
  }
  await publishProfile(ca.shop.id, ca.actor);
  console.log("Demo consultants ready: /consult/mehta-family-clinic, /consult/kulkarni-associates");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
